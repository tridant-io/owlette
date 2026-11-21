'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityRow, ActivityView } from '@/lib/activity/types';
import { getDateRange, type DatePreset } from '@/lib/dateRange';

/**
 * The activity feed for the superadmin page, through `/api/admin/activity` on
 * the signed-in session. A page can come back short or empty with a token, so a
 * load reads on until it has a page of rows and `hasMore` follows the token alone.
 */

export type { ActivityRow, ActivityView };

const PAGE_SIZE = 50;
// a filter that hides most rows, or a stretch of hidden rows longer than one request scans,
// comes back as short or empty pages, so a load reads on until it has a page of rows, up to
// this many requests. each scans up to 3,200 rows per source, so this bounds a load's cost
const MAX_PAGES_PER_LOAD = 5;

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

/**
 * Lists activity newest first for one view, optionally some users, some sites and a date range,
 * a page at a time. The range is resolved per request, so the last hour stays the last hour.
 */
export function useActivity({
  view,
  userIds = [],
  siteIds = [],
  datePreset = 'all',
  dateFrom,
  dateTo,
}: {
  view: ActivityView;
  userIds?: readonly string[];
  siteIds?: readonly string[];
  datePreset?: DatePreset;
  dateFrom?: string;
  dateTo?: string;
}) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [nextPageToken, setNextPageToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // bumped per first-page load, so a page for an earlier filter never lands
  const generation = useRef(0);

  // a string, so a render that passes new lists of the same ids is the same request
  const scope = new URLSearchParams({ view, page_size: String(PAGE_SIZE) });
  for (const id of userIds) scope.append('user', id);
  for (const id of siteIds) scope.append('site', id);
  const query = scope.toString();

  const fetchPage = useCallback(
    async (pageToken: string) => {
      const params = new URLSearchParams(query);
      const { from, to } = getDateRange(datePreset, dateFrom, dateTo);
      if (from) params.set('since', String(from.getTime()));
      if (to) params.set('until', String(to.getTime()));
      if (pageToken) params.set('page_token', pageToken);
      const response = await fetch(`/api/admin/activity?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'failed to load activity'));
      const body = (await response.json()) as { rows?: ActivityRow[]; next_page_token?: string };
      return {
        rows: Array.isArray(body.rows) ? body.rows : [],
        nextPageToken: body.next_page_token ?? '',
      };
    },
    [query, datePreset, dateFrom, dateTo],
  );

  const fetchRows = useCallback(
    async (pageToken: string, request: number) => {
      let page = await fetchPage(pageToken);
      const rows = [...page.rows];
      for (
        let read = 1;
        read < MAX_PAGES_PER_LOAD && rows.length < PAGE_SIZE && page.nextPageToken && request === generation.current;
        read += 1
      ) {
        page = await fetchPage(page.nextPageToken);
        rows.push(...page.rows);
      }
      return { rows, nextPageToken: page.nextPageToken };
    },
    [fetchPage],
  );

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const page = await fetchRows('', request);
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
  }, [fetchRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken || loadingMore) return;
    const request = generation.current;
    setLoadingMore(true);
    try {
      const page = await fetchRows(nextPageToken, request);
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
  }, [fetchRows, nextPageToken, loadingMore]);

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
