'use client';

/**
 * Chronological version list for a roost, mounted in the expanded roost-row
 * panel. Fetches `GET /api/roosts/{id}/versions` on mount and on demand (after
 * a rollback or push), newest first, with a "+ new version" button that opens
 * the push modal pre-populated with the roost's locked fields.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VersionRow, type VersionSummary } from './VersionRow';
import { firestoreTsToMs, type FirestoreTs } from '@/hooks/useFirestore';

interface VersionHistoryProps {
  roostId: string;
  siteId: string;
  currentVersionId: string | null;
  /** Opens the parent's "+ new version" push modal pre-populated for this roost. */
  onNewVersion: () => void;
  /** Monotonic refresh token — bump to force a re-fetch (upload, edit). */
  refreshKey?: number;
  /**
   * When the API returns no versions but the roost has a current-version
   * pointer, synthesize one row from the roost's denormalised metadata. Covers
   * legacy roosts predating the version-subcollection backfill, which would
   * otherwise read "no versions yet" despite having content.
   */
  currentVersionNumber?: number | null;
  roostTotalFiles?: number;
  roostTotalSize?: number;
  roostCreatedAt?: FirestoreTs;
  roostCreatedBy?: string;
}

const PAGE_LIMIT = 20;

export function VersionHistory({
  roostId,
  siteId,
  currentVersionId,
  onNewVersion,
  refreshKey,
  currentVersionNumber,
  roostTotalFiles,
  roostTotalSize,
  roostCreatedAt,
  roostCreatedBy,
}: VersionHistoryProps) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Local re-fetch trigger — bumped by a child after rollback / edit.
  const [localRefreshKey, setLocalRefreshKey] = useState(0);

  const fetchVersions = useCallback(async () => {
    if (!siteId || !roostId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ siteId, limit: String(PAGE_LIMIT) });
      const res = await fetch(
        `/api/roosts/${encodeURIComponent(roostId)}/versions?${qs}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? body.title ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { versions?: unknown };
      const raw = Array.isArray(body.versions) ? body.versions : [];
      const parsed: VersionSummary[] = raw.map((v) => {
        const o = v as Record<string, unknown>;
        return {
          versionId: typeof o.versionId === 'string' ? o.versionId : '',
          versionNumber:
            typeof o.versionNumber === 'number' ? o.versionNumber : null,
          description:
            typeof o.description === 'string' ? o.description : null,
          versionUrl: typeof o.versionUrl === 'string' ? o.versionUrl : null,
          createdAt:
            typeof o.createdAt === 'string' ? o.createdAt : null,
          createdBy: typeof o.createdBy === 'string' ? o.createdBy : null,
          totalSize: typeof o.totalSize === 'number' ? o.totalSize : 0,
          totalFiles: typeof o.totalFiles === 'number' ? o.totalFiles : 0,
          parentVersionId:
            typeof o.parentVersionId === 'string' ? o.parentVersionId : null,
        };
      });
      setVersions(parsed.filter((v) => v.versionId.length > 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load versions');
    } finally {
      setLoading(false);
    }
  }, [siteId, roostId]);

  useEffect(() => {
    void fetchVersions();
  }, [fetchVersions, refreshKey, localRefreshKey]);

  const onChanged = useCallback(() => {
    setLocalRefreshKey((k) => k + 1);
  }, []);

  // Placeholder row from denormalised roost metadata when the API has nothing
  // but the roost clearly has content. The trailing `:fallback` versionId lets
  // renderers detect it and can't collide with a content-addressed id.
  const displayVersions = useMemo<VersionSummary[]>(() => {
    if (versions.length > 0) return versions;
    if (!currentVersionId) return [];
    const createdAtMs = roostCreatedAt ? firestoreTsToMs(roostCreatedAt) : null;
    const createdAtIso = createdAtMs ? new Date(createdAtMs).toISOString() : null;
    return [
      {
        versionId: currentVersionId,
        versionNumber: currentVersionNumber ?? 1,
        description: null,
        versionUrl: null,
        createdAt: createdAtIso,
        createdBy: roostCreatedBy ?? null,
        totalSize: roostTotalSize ?? 0,
        totalFiles: roostTotalFiles ?? 0,
        parentVersionId: null,
      },
    ];
  }, [
    versions,
    currentVersionId,
    currentVersionNumber,
    roostCreatedAt,
    roostCreatedBy,
    roostTotalFiles,
    roostTotalSize,
  ]);

  const [open, setOpen] = useState(true);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>version history</span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewVersion}
          className="h-7 px-2 text-xs border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer"
        >
          <Plus className="h-3 w-3 mr-1" />
          new version
        </Button>
      </div>

      {!open ? null : loading && displayVersions.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          loading versions…
        </div>
      ) : error ? (
        <p className="px-3 py-2 text-xs text-danger/80">
          couldn&apos;t load versions — {error}
        </p>
      ) : displayVersions.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground italic">
          no versions yet
        </p>
      ) : (
        <div className="space-y-1.5">
          {displayVersions.map((v) => (
            <VersionRow
              key={v.versionId}
              version={v}
              roostId={roostId}
              siteId={siteId}
              isCurrent={v.versionId === currentVersionId}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default VersionHistory;
