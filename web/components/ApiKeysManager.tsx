'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { CopyButton } from '@/components/CopyButton';
import { ChevronRight, Key, KeyRound, Loader2, Plus, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useApiKeys, type CreateKeyInput, type UpdateKeyInput } from '@/hooks/useApiKeys';
import type { ApiKeyListItem } from '@/lib/apiKeyTypes';
import { ApiKeyCreateForm } from '@/components/ApiKeyCreateForm';
import { ApiKeyScopeEditor } from '@/components/ApiKeyScopeEditor';
import { KeyCard } from '@/app/settings/api-keys/KeyCard';

/**
 * One panel for api keys, mounted in both places keys are managed.
 *
 * The account-settings dialog and /settings/api-keys were one feature plus a degraded
 * copy: the dialog could create-with-preset and revoke but not set a ttl, build custom
 * scopes, rotate, or show what a key was scoped to — so the capable half lived on the
 * page nobody could find. `compact` only trims chrome for the dialog; behaviour is
 * identical in both.
 *
 * KeyCard is rendered rather than reimplemented: six e2e specs bind to its DOM shape
 * (`div.rounded-md.border`, `p.font-medium`, `[data-slot="badge"]`, the lucide icons, a
 * `code` holding the prefix). Restyling it is a separate change from moving it.
 */

interface Props {
  /** Trim page-level chrome for embedding in the settings dialog. */
  compact?: boolean;
}

export function ApiKeysManager({ compact = false }: Props) {
  const { keys, loading, refresh, createKey, updateKey } = useApiKeys();
  const [creating, setCreating] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  // One clock for the whole list so two rows can't disagree about "expiring soon".
  const [now] = useState(() => Date.now());

  // Pre-expand when there is nothing to look at — an empty list with a
  // collapsed form is a dead end.
  const showForm = creating;

  // Revoke became a soft delete, so this list only ever grows. The split is
  // client-side on purpose: filtering revoked keys out of GET /api/keys would
  // throw away the auditability the soft delete was made for.
  const activeKeys = keys.filter((k) => !k.revoked);
  const revokedKeys = keys.filter((k) => k.revoked);

  async function handleCreate(input: CreateKeyInput) {
    try {
      const created = await createKey(input);
      setRevealedKey(created.key);
      setCreating(false);
      toast.success('api key created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to create key');
    }
  }

  async function handleUpdate(keyId: string, input: UpdateKeyInput) {
    try {
      await updateKey(keyId, input);
      setEditingKeyId(null);
      toast.success('key updated — new scopes apply immediately');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'failed to update key');
    }
  }

  function renderKeyRow(k: ApiKeyListItem) {
    return (
      <div key={k.id}>
        <KeyCard
          apiKey={k}
          now={now}
          editing={editingKeyId === k.id}
          // KeyCard owns the rotate/revoke requests and hands back the
          // raw value; the panel only reveals it and resyncs the list.
          onRotated={(raw) => {
            setRevealedKey(raw);
            refresh().catch(() => {});
          }}
          onRevoked={() => {
            if (editingKeyId === k.id) setEditingKeyId(null);
            refresh().catch(() => {});
          }}
          onEditScopes={(target) => {
            // Only one form open at a time — the create form and an
            // editor side by side both claim to be "the" scope picker.
            setCreating(false);
            setEditingKeyId((current) => (current === target.id ? null : target.id));
          }}
        />
        {editingKeyId === k.id && (
          <ApiKeyScopeEditor
            apiKey={k}
            onSubmit={(input) => handleUpdate(k.id, input)}
            onCancel={() => setEditingKeyId(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'}>
      {!compact && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
              <Key className="h-5 w-5" />
              api keys
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              scoped tokens for automating pushes, rollbacks, and deploys against the roost api.
            </p>
          </div>
        </div>
      )}

      {/* Fed by create AND rotate — both return a raw value shown exactly once.
          Markup deliberately matches what the specs bind to: the banner copy,
          a [data-slot="card"] ancestor, and the code/CopyButton flex pair. */}
      {revealedKey && (
        <Card className="border-accent-cyan/50 bg-accent-cyan/5 p-4 relative">
          <button
            type="button"
            onClick={() => setRevealedKey(null)}
            className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
            aria-label="dismiss"
          >
            <X className="h-4 w-4" />
          </button>
          <p className="text-sm text-accent-cyan font-medium pr-6 mb-2">
            key issued — copy it now. it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-background border border-border rounded px-3 py-2 text-foreground font-mono break-all select-all">
              {revealedKey}
            </code>
            <CopyButton
              value={revealedKey}
              className="h-9 border-border text-accent-cyan hover:bg-muted"
            />
          </div>
        </Card>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-foreground">your keys</Label>
          {!showForm && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setEditingKeyId(null);
                setCreating(true);
              }}
              className="cursor-pointer"
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> create key
            </Button>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> loading keys…
          </div>
        ) : keys.length === 0 ? (
          <Card className="border-border bg-card/50 p-8 text-center space-y-3">
            <KeyRound className="h-8 w-8 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm text-foreground">no api keys yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                create a scoped key to start automating against the roost api.
              </p>
            </div>
            {!showForm && (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setEditingKeyId(null);
                  setCreating(true);
                }}
                className="cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> create your first key
              </Button>
            )}
          </Card>
        ) : (
          <div className="cascade-rows space-y-2">
            {activeKeys.map(renderKeyRow)}

            {activeKeys.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">
                every key on this account has been revoked.
              </p>
            )}

            {revokedKeys.length > 0 && (
              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowRevoked((v) => !v)}
                  aria-expanded={showRevoked}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${showRevoked ? 'rotate-90' : ''}`}
                  />
                  {showRevoked ? 'hide' : 'show'} revoked ({revokedKeys.length})
                </button>
                {showRevoked && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground/70">
                      revoked keys stop working immediately. they stay listed so a request made
                      with one is still traceable to the key it came from.
                    </p>
                    {revokedKeys.map(renderKeyRow)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {showForm && (
        <div className="space-y-2">
          <Label className="text-foreground">create key</Label>
          <ApiKeyCreateForm onSubmit={handleCreate} onCancel={() => setCreating(false)} />
        </div>
      )}
    </div>
  );
}
