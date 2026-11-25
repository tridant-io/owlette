'use client';

/**
 * One row of the roost panel's version history: number, relative timestamp,
 * click-to-edit description, and a menu with rollback / copy id / view files /
 * diff. Description editing is the inline-textarea pattern — blur or ⌘+Enter
 * PATCHes /api/roosts/{id}/versions/{versionId}, Esc cancels.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Copy, FileText, GitCompare, History, MoreVertical, Pencil } from 'lucide-react';
import { toast } from '@/lib/toast';
import { formatBytes } from '@/lib/preUploadCheck';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import ConfirmDialog from '@/components/ConfirmDialog';

const MAX_DESCRIPTION_LENGTH = 500;

export interface VersionSummary {
  versionId: string;
  versionNumber: number | null;
  description: string | null;
  versionUrl: string | null;
  createdAt: string | null;
  createdBy: string | null;
  totalSize: number;
  totalFiles: number;
  parentVersionId: string | null;
}

interface VersionRowProps {
  version: VersionSummary;
  roostId: string;
  siteId: string;
  isCurrent: boolean;
  /** Called after a successful rollback so the parent re-fetches. */
  onChanged: () => void;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const delta = Date.now() - t;
  const sec = Math.max(0, Math.floor(delta / 1000));
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(mo / 12);
  return `${yr}y ago`;
}

export function VersionRow({
  version,
  roostId,
  siteId,
  isCurrent,
  onChanged,
}: VersionRowProps) {
  const [confirmRollbackOpen, setConfirmRollbackOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(version.description ?? '');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Resync the draft when the prop changes under a mounted, non-editing row.
  useEffect(() => {
    if (!editing) setDraft(version.description ?? '');
  }, [version.description, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const numberLabel =
    version.versionNumber !== null ? `#${version.versionNumber}` : version.versionId.slice(0, 8);

  const handleCopyId = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(version.versionId);
        toast.success('version id copied');
      } else {
        toast.error(`couldn't copy — version id: ${version.versionId}`);
      }
    } catch {
      toast.error(`couldn't copy — version id: ${version.versionId}`);
    }
  };

  const handleRollback = async () => {
    const target =
      version.versionNumber !== null ? version.versionNumber : version.versionId;
    try {
      const res = await fetch(
        `/api/roosts/${encodeURIComponent(roostId)}/rollback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId, targetVersion: target }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const detail = body.detail ?? body.title ?? `HTTP ${res.status}`;
        toast.error('rollback failed', { description: detail });
        return;
      }
      toast.success(`rolled back to ${numberLabel}`);
      onChanged();
    } catch (err) {
      toast.error('rollback failed', {
        description: err instanceof Error ? err.message : 'network error',
      });
    }
  };

  const saveDescription = async () => {
    const trimmed = draft.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    // No-op when unchanged — otherwise every blur costs a request.
    if (next === (version.description ?? null)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(version.versionId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId, description: next }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const detail = body.detail ?? body.title ?? `HTTP ${res.status}`;
        toast.error('save failed', { description: detail });
        return;
      }
      toast.success('description saved');
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error('save failed', {
        description: err instanceof Error ? err.message : 'network error',
      });
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    setDraft(version.description ?? '');
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void saveDescription();
    }
  };

  return (
    <div
      data-testid="roost-version-row"
      data-version-id={version.versionId}
      data-version-number={version.versionNumber ?? ''}
      data-current-version={isCurrent ? 'true' : 'false'}
      className="flex items-center gap-3 px-3 py-2 rounded border border-border/40 bg-background/50"
    >
      <div className="flex items-center gap-2 flex-shrink-0">
        {isCurrent && (
          <span
            aria-label="current version"
            title="current version"
            className="inline-block h-2 w-2 rounded-full bg-success"
          />
        )}
        <span className="text-foreground font-mono text-xs select-text leading-none">
          {numberLabel}
        </span>
      </div>

      <span className="flex-shrink-0 text-[11px] text-muted-foreground tabular-nums leading-none">
        {relativeTime(version.createdAt)}
      </span>

      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) =>
              setDraft(e.target.value.slice(0, MAX_DESCRIPTION_LENGTH))
            }
            onBlur={() => void saveDescription()}
            onKeyDown={handleKeyDown}
            placeholder="what changed? (e.g. 'fixed broken video')"
            rows={2}
            disabled={saving}
            className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent-cyan resize-y disabled:opacity-50"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="block w-full text-left text-sm hover:text-accent-cyan transition-colors cursor-text"
            aria-label="edit description"
          >
            {version.description ? (
              <span className="text-foreground select-text">
                {version.description}
              </span>
            ) : (
              <span className="text-muted-foreground italic">(no description)</span>
            )}
          </button>
        )}
      </div>

      {(version.totalFiles > 0 || version.totalSize > 0) && (
        <span className="flex-shrink-0 text-[11px] text-muted-foreground tabular-nums leading-none">
          {version.totalFiles > 0 && (
            <>
              {version.totalFiles.toLocaleString()} file{version.totalFiles === 1 ? '' : 's'}
            </>
          )}
          {version.totalFiles > 0 && version.totalSize > 0 && ' · '}
          {version.totalSize > 0 && formatBytes(version.totalSize)}
        </span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="version actions"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => setEditing(true)}
            className="cursor-pointer"
          >
            <Pencil className="h-3.5 w-3.5 mr-2" />
            edit description
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isCurrent}
            onClick={() => setConfirmRollbackOpen(true)}
            className="cursor-pointer"
          >
            <History className="h-3.5 w-3.5 mr-2" />
            rollback to this version
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleCopyId} className="cursor-pointer">
            <Copy className="h-3.5 w-3.5 mr-2" />
            copy version id
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              window.open(
                `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(version.versionId)}/files?siteId=${encodeURIComponent(siteId)}`,
                '_blank',
                'noopener',
              );
            }}
            className="cursor-pointer"
          >
            <FileText className="h-3.5 w-3.5 mr-2" />
            view files
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isCurrent}
            onClick={() => {
              window.open(
                `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(version.versionId)}/diff?siteId=${encodeURIComponent(siteId)}&against=current`,
                '_blank',
                'noopener',
              );
            }}
            className="cursor-pointer"
          >
            <GitCompare className="h-3.5 w-3.5 mr-2" />
            diff against current
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmRollbackOpen}
        onOpenChange={setConfirmRollbackOpen}
        title="rollback?"
        description={`this will flip machines back to ${numberLabel} — agents pull within 10 seconds.`}
        confirmText="rollback"
        cancelText="cancel"
        onConfirm={() => {
          void handleRollback();
        }}
      />
    </div>
  );
}

export default VersionRow;
