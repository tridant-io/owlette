'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderSync,
  MoreVertical,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RoostContentsRow } from '@/components/RoostContentsRow';
import { RoostTargetsList } from '@/components/RoostTargetRow';
import { VersionHistory } from '@/components/roost/VersionHistory';
import type { NewVersionContext } from '@/components/ProjectDistributionDialog';
import type { Roost } from '@/hooks/useRoosts';
import type { Machine } from '@/hooks/useFirestore';

interface RoostDetailPanelProps {
  roost: Roost;
  siteId: string;
  siteTimezone?: string;
  timeDisplayMode: string;
  timezone: string;
  timeFormat: '12h' | '24h';
  refreshKey: number;
  /** Full machine list for the site — drives the checkbox-list of targets.
   *  Optional: callers can omit if the targets section isn't expanded by default;
   *  the targets section then renders an empty list until machines are wired in. */
  machines?: Machine[];
  onClose: () => void;
  onNewVersion: (ctx: NewVersionContext) => void;
  onResync: () => void;
  onDelete: () => void;
  onCopyRoostId: () => void;
  onCopyVersionId: () => void;
  headingId?: string;
}

export function RoostDetailPanel({
  roost,
  siteId,
  refreshKey,
  machines,
  onClose,
  onNewVersion,
  onResync,
  onDelete,
  onCopyRoostId,
  onCopyVersionId,
  headingId,
}: RoostDetailPanelProps) {
  const versionLabel =
    roost.currentVersionNumber !== null ? `v${roost.currentVersionNumber}` : null;
  const canResync = !!roost.currentVersionId && roost.targets.length > 0;
  const canCopyVersionId = !!roost.currentVersionId;

  const [targetsOpen, setTargetsOpen] = useState(true);

  // Use `v${currentVersionNumber}` as the version reference. The server
  // accepts `v3` / `#3` aliases — and the raw `currentVersionId` is a
  // content-addressed sha256 hash that the version-files endpoint
  // rejects as malformed. The version number is stable per rollout and
  // flips on rollback, so it doubles as a correct cache key for
  // `useRoostManifestFiles` (a stale `'current'` alias would otherwise
  // hand back the previous version's file list after rollback).
  const versionRef =
    roost.currentVersionNumber !== null
      ? `v${roost.currentVersionNumber}`
      : null;

  return (
    <div id="roost-detail-panel" className="flex flex-col">
      <div className="border-b border-border px-4 py-3 flex items-center gap-3">
        <FolderSync className="h-4 w-4 text-accent-cyan flex-shrink-0" aria-hidden="true" />
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h2
            id={headingId}
            tabIndex={-1}
            className="text-foreground font-medium truncate select-text outline-none"
          >
            {roost.name}
          </h2>
          {versionLabel && (
            <span
              className="flex-shrink-0 rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground tabular-nums"
              aria-label={`current version ${versionLabel}`}
            >
              {versionLabel}
            </span>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="panel actions"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!canResync}
              onClick={() => {
                if (canResync) onResync();
              }}
              className="cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              re-sync targets
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onCopyRoostId}
              className="cursor-pointer"
            >
              <Copy className="h-3.5 w-3.5 mr-2" />
              copy roost id
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canCopyVersionId}
              onClick={() => {
                if (canCopyVersionId) onCopyVersionId();
              }}
              className="cursor-pointer"
            >
              <Copy className="h-3.5 w-3.5 mr-2" />
              copy version id
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="cursor-pointer text-danger focus:text-danger focus:bg-danger-surface"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              delete roost
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="close panel"
          className="h-7 w-7 p-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="px-4 py-4 space-y-4 text-sm">
        {roost.currentVersionDescription && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="w-3.5 flex-shrink-0" aria-hidden="true" />
              <span className="text-sm font-medium text-muted-foreground">
                description
              </span>
            </div>
            <span className="text-xs text-muted-foreground select-text break-all">
              {roost.currentVersionDescription}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 flex-shrink-0" aria-hidden="true" />
            <span className="text-sm font-medium text-muted-foreground">
              extract path
            </span>
          </div>
          <span className="text-xs text-muted-foreground select-text break-all">
            {roost.extractPath || '~/Documents/Owlette/'}
          </span>
        </div>

        <RoostContentsRow
          siteId={siteId}
          roostId={roost.id}
          versionId={versionRef}
          totalFiles={roost.totalFiles}
          totalSize={roost.totalSize}
        />

        <section>
          <div className="flex items-center justify-between gap-2 mb-2">
            <button
              type="button"
              onClick={() => setTargetsOpen((v) => !v)}
              aria-expanded={targetsOpen}
              className="flex items-center gap-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              {targetsOpen ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>targets ({roost.targets.length})</span>
            </button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onResync}
              disabled={!canResync}
              className="h-7 px-2 text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer disabled:cursor-not-allowed"
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              re-sync targets
            </Button>
          </div>
          {targetsOpen && (
            <RoostTargetsList
              siteId={siteId}
              roostId={roost.id}
              currentVersionId={roost.currentVersionId}
              targets={roost.targets}
              machines={machines ?? []}
            />
          )}
        </section>

        <VersionHistory
          roostId={roost.id}
          siteId={siteId}
          currentVersionId={roost.currentVersionId}
          currentVersionNumber={roost.currentVersionNumber}
          roostTotalFiles={roost.totalFiles}
          roostTotalSize={roost.totalSize}
          roostCreatedAt={roost.createdAt}
          roostCreatedBy={roost.createdBy}
          refreshKey={refreshKey}
          onNewVersion={() =>
            onNewVersion({
              roostId: roost.id,
              name: roost.name,
              extractPath: roost.extractPath,
              targets: roost.targets,
              currentVersionNumber: roost.currentVersionNumber,
            })
          }
        />
      </div>
    </div>
  );
}
