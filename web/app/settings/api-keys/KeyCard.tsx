'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertTriangle,
  ChevronRight,
  KeyRound,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { EXPIRATION_WARNING_MS } from '@/lib/apiKeyTypes';
import type { ApiKeyListItem, ApiKeyScope } from '@/lib/apiKeyTypes';

export type { ApiKeyListItem } from '@/lib/apiKeyTypes';

/**
 * One key, as a collapsible row. Name, state and the three dates stay on the
 * row; prefix and scope summary open on demand. The old layout spent ~7rem on
 * the prefix and ~7.5rem on three always-visible buttons, leaving the name
 * under 100px inside the account-settings dialog.
 *
 * Folding the actions into one overflow menu also fixed an alignment bug: three
 * buttons on an active row versus one on an expired row is an 80px swing, taken
 * out of the only flexible column, so no two rows agreed on column positions.
 */

function formatDate(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function summarizeScopes(scopes: ApiKeyScope[] | null): string {
  if (!scopes || scopes.length === 0) return 'legacy (full access)';
  const permSet = new Set<string>();
  for (const s of scopes) for (const p of s.permissions) permSet.add(p);
  const perms = Array.from(permSet).sort().join(', ');
  const resources = Array.from(new Set(scopes.map((s) => s.resource))).sort().join('/');
  return `${resources} · ${perms}`;
}

function keyStatusAt(
  k: ApiKeyListItem,
  now: number,
): {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'muted';
} {
  // Revoked first, mirroring the auth path's own precedence: revokedAt is
  // checked before retiresAt and expiresAt, so a key that is both revoked and
  // expired is rejected as revoked. Any other order would label a deliberately
  // killed key by whatever else happened to it since.
  if (k.revoked) return { label: 'revoked', tone: 'muted' };
  if (k.expired) return { label: 'expired', tone: 'error' };
  if (k.retired) return { label: 'retired', tone: 'muted' };
  if (k.rotatedAt && k.retiresAt && k.retiresAt > now) {
    return { label: 'rotated (grace)', tone: 'warn' };
  }
  if (
    typeof k.expiresAt === 'number' &&
    k.expiresAt - now < EXPIRATION_WARNING_MS
  ) {
    return { label: 'expiring soon', tone: 'warn' };
  }
  return { label: 'active', tone: 'ok' };
}

function formatRelativeAt(ms: number | null, now: number): string {
  if (!ms) return 'never';
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(ms);
}

interface Props {
  apiKey: ApiKeyListItem;
  onRotated: (raw: string, newKeyId: string) => void;
  onRevoked: () => void;
  onEditScopes: (apiKey: ApiKeyListItem) => void;
  /** True while this row's scope editor is open directly beneath it. */
  editing: boolean;
  /** Date.now() from the parent's tick — injected to keep the render pure. */
  now: number;
}

export function KeyCard({ apiKey, onRotated, onRevoked, onEditScopes, editing, now }: Props) {
  const [rotating, setRotating] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const status = keyStatusAt(apiKey, now);
  const daysUntilExpiry =
    typeof apiKey.expiresAt === 'number'
      ? Math.max(1, Math.ceil((apiKey.expiresAt - now) / (24 * 60 * 60 * 1000)))
      : null;
  // The server 409s rotate and edit on a terminal key. Revoke stays, which is
  // why an expired row still has a menu — but a revoked key has nothing left to
  // do, so it gets no control at all.
  const actionable =
    !apiKey.revoked && !apiKey.expired && !apiKey.retired && !apiKey.rotatedAt;

  async function handleRotate() {
    setRotating(true);
    try {
      const res = await fetch(`/api/keys/${apiKey.id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success('key rotated — old key works for 24h');
        onRotated(data.key, data.keyId);
      } else {
        toast.error(data.detail || data.error || 'rotation failed');
      }
    } catch {
      toast.error('rotation failed');
    }
    setRotating(false);
  }

  async function handleRevoke() {
    setRevoking(true);
    try {
      const res = await fetch(`/api/keys/${apiKey.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('key revoked');
        onRevoked();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.detail || data.error || 'revoke failed');
      }
    } catch {
      toast.error('revoke failed');
    }
    setRevoking(false);
    setConfirmRevoke(false);
  }

  return (
    <div
      className={
        editing
          ? 'rounded-md rounded-b-none border border-b-0 border-accent-cyan/50 bg-card/50 px-3 py-2 space-y-2'
          : 'rounded-md border border-border bg-card/50 px-3 py-2 space-y-2'
      }
    >
      {/* Fixed tracks for the date columns so they land at the same x on every
          row; the name is the only flexible one. Stacking each label over its
          value is what stops the dates truncating. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(6rem,1fr)_5.25rem_5.25rem_5.25rem_auto]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'hide' : 'show'} details for ${apiKey.name}`}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>

        <div className="flex min-w-0 items-center gap-2">
          {/* p.font-medium is load-bearing: rowFor() in api-keys-states.spec.ts
              locates the row by it. */}
          <p className="min-w-0 truncate text-sm text-foreground font-medium">
            {apiKey.name || '(unnamed key)'}
          </p>
          {/* Only legacy `test` keys get a badge — live is the only environment
              minted now, so a "live" badge everywhere is noise. A lingering test
              key authenticates identically, so it stays called out. */}
          {apiKey.environment === 'test' && (
            <Badge
              variant="outline"
              className="border-warning/50 text-warning text-xs flex-shrink-0"
            >
              legacy test
            </Badge>
          )}
          <Badge
            variant="outline"
            className={
              status.tone === 'ok'
                ? 'border-success/50 text-success text-xs flex-shrink-0'
                : status.tone === 'warn'
                  ? 'border-warning/50 text-warning text-xs flex-shrink-0'
                  : status.tone === 'error'
                    ? 'border-danger/50 text-danger text-xs flex-shrink-0'
                    : 'border-border text-muted-foreground text-xs flex-shrink-0'
            }
          >
            {status.label}
          </Badge>
        </div>

        <div className="hidden min-w-0 sm:block">
          <div className="text-[11px] leading-tight text-muted-foreground/80">created</div>
          <div className="text-xs leading-tight text-muted-foreground tabular-nums">
            {formatDate(apiKey.createdAt)}
          </div>
        </div>

        <div className="hidden min-w-0 sm:block">
          <div className="text-[11px] leading-tight text-muted-foreground/80">last used</div>
          <div className="text-xs leading-tight text-muted-foreground tabular-nums">
            {formatRelativeAt(apiKey.lastUsedAt, now)}
          </div>
        </div>

        <div className="hidden min-w-0 sm:block">
          <div
            className={`text-[11px] leading-tight ${
              apiKey.expired ? 'text-danger' : 'text-muted-foreground/80'
            }`}
          >
            {apiKey.expired ? 'expired' : apiKey.retired ? 'retired' : 'expires'}
          </div>
          <div
            className={`text-xs leading-tight tabular-nums ${
              apiKey.expired ? 'text-danger' : 'text-muted-foreground'
            }`}
          >
            {formatDate(apiKey.retired ? apiKey.retiresAt : apiKey.expiresAt)}
          </div>
        </div>

        {/* A revoked key is terminal in every direction — rotate and edit 409,
            and revoking it again is a no-op — so the whole action cell goes
            away rather than offering a button that cannot change anything. */}
        {apiKey.revoked ? null : confirmRevoke ? (
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-xs text-danger">revoke?</span>
            <Button
              type="button"
              size="sm"
              variant="ghost-destructive"
              onClick={handleRevoke}
              disabled={revoking}
              className="h-7 px-2 text-xs cursor-pointer"
            >
              {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'yes'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRevoke(false)}
              disabled={revoking}
              className="h-7 px-2 text-xs text-muted-foreground cursor-pointer"
            >
              no
            </Button>
          </div>
        ) : !actionable ? (
          <Button
            type="button"
            size="sm"
            variant="ghost-destructive"
            onClick={() => setConfirmRevoke(true)}
            aria-label={`revoke ${apiKey.name}`}
            className="h-7 w-7 justify-self-end p-0 cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`actions for ${apiKey.name}`}
                className="h-7 w-7 justify-self-end p-0 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {rotating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MoreHorizontal className="h-3.5 w-3.5" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => onEditScopes(apiKey)} className="cursor-pointer">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {editing ? 'close editor' : 'edit scopes'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={handleRotate}
                disabled={rotating}
                className="cursor-pointer"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                rotate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setConfirmRevoke(true)}
                variant="destructive"
                className="cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {expanded && (
        <div className="space-y-1 pl-8 pt-1">
          <code className="block truncate font-mono text-xs text-muted-foreground">
            {apiKey.keyPrefix || 'owk_'}•••
          </code>
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <KeyRound className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <span className="min-w-0 break-words">{summarizeScopes(apiKey.scopes)}</span>
          </div>
          {/* Where the sm:-hidden date columns surface on a phone. */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground sm:hidden">
            <span>created {formatDate(apiKey.createdAt)}</span>
            <span>last used {formatRelativeAt(apiKey.lastUsedAt, now)}</span>
            <span>
              {apiKey.expired ? 'expired' : apiKey.retired ? 'retired' : 'expires'}{' '}
              {formatDate(apiKey.retired ? apiKey.retiresAt : apiKey.expiresAt)}
            </span>
          </div>
        </div>
      )}

      {status.tone === 'warn' && status.label === 'expiring soon' && daysUntilExpiry !== null && (
        <div className="flex items-center gap-2 pl-8 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          this key expires in {daysUntilExpiry} day(s). rotate it soon.
        </div>
      )}
      {status.label === 'rotated (grace)' && apiKey.retiresAt && (
        <div className="flex items-center gap-2 pl-8 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          old key stops working {formatDate(apiKey.retiresAt)}
        </div>
      )}
    </div>
  );
}
