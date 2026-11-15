'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityRow, ActivityView } from '@/lib/activity/types';

/**
 * The activity feed for the superadmin page, through `/api/admin/activity` on
 * the signed-in session. A page can come back with no rows and a token, so
 * `hasMore` follows the token alone.
 */

export type { ActivityRow, ActivityView };

const PAGE_SIZE = 50;

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? body.error ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Lists activity newest first for one view, optionally one user and one site, a page at a time. */
export function useActivity({ view, userId, siteId }: { view: ActivityView; userId?: string; siteId?: string }) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [nextPageToken, setNextPageToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // bumped per first-page load, so a page for an earlier filter never lands
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (pageToken: string) => {
      const params = new URLSearchParams({ view, page_size: String(PAGE_SIZE) });
      if (userId) params.set('user', userId);
      if (siteId) params.set('site', siteId);
      if (pageToken) params.set('page_token', pageToken);
      const response = await fetch(`/api/admin/activity?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'failed to load activity'));
      const body = (await response.json()) as { rows?: ActivityRow[]; next_page_token?: string };
      return {
        rows: Array.isArray(body.rows) ? body.rows : [],
        nextPageToken: body.next_page_token ?? '',
      };
    },
    [view, userId, siteId],
  );

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const page = await fetchPage('');
      if (request !== generation.current) return;
      setRows(page.rows);
      setNextPageToken(page.nextPageToken);
      setError(null);
    } catch (err) {
      if (request !== generation.current) return;
      console.error('Error fetching activity:', err);
      setError(errorMessage(err, 'failed to load activity'));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken || loadingMore) return;
    const request = generation.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextPageToken);
      if (request !== generation.current) return;
      setRows((prev) => [...prev, ...page.rows]);
      setNextPageToken(page.nextPageToken);
      setError(null);
    } catch (err) {
      if (request !== generation.current) return;
      console.error('Error fetching more activity:', err);
      setError(errorMessage(err, 'failed to load activity'));
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, nextPageToken, loadingMore]);

  return {
    rows,
    loading,
    loadingMore,
    error,
    hasMore: nextPageToken !== '',
    loadMore,
    refresh,
  };
}
