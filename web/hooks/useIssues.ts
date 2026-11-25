'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IssueStatus } from '@/lib/issues';
import type { Issue } from '@/lib/issues.server';

/**
 * Issues for the superadmin pages, through `/api/admin/issues` on the signed-in
 * session. Errors carry the route's problem detail ("issue not found"), which is
 * written for people.
 */

export type { Issue, IssueStatus };

const PAGE_SIZE = 20;

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

function issuePath(idOrNumber: string | number): string {
  return `/api/admin/issues/${encodeURIComponent(String(idOrNumber))}`;
}

/** Lists issues newest first, optionally one status only, a page at a time. */
export function useIssues({ status }: { status?: IssueStatus } = {}) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [nextPageToken, setNextPageToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // bumped per first-page load, so a page for an earlier filter never lands
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (pageToken: string) => {
      const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (status) params.set('status', status);
      if (pageToken) params.set('page_token', pageToken);
      const response = await fetch(`/api/admin/issues?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'failed to load issues'));
      const body = (await response.json()) as { issues?: Issue[]; next_page_token?: string };
      return {
        issues: Array.isArray(body.issues) ? body.issues : [],
        nextPageToken: body.next_page_token ?? '',
      };
    },
    [status],
  );

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const page = await fetchPage('');
      if (request !== generation.current) return;
      setIssues(page.issues);
      setNextPageToken(page.nextPageToken);
      setError(null);
    } catch (err) {
      if (request !== generation.current) return;
      console.error('Error fetching issues:', err);
      setError(errorMessage(err, 'failed to load issues'));
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
      setIssues((prev) => [...prev, ...page.issues]);
      setNextPageToken(page.nextPageToken);
      setError(null);
    } catch (err) {
      if (request !== generation.current) return;
      console.error('Error fetching more issues:', err);
      setError(errorMessage(err, 'failed to load issues'));
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, nextPageToken, loadingMore]);

  return {
    issues,
    loading,
    loadingMore,
    error,
    hasMore: nextPageToken !== '',
    loadMore,
    refresh,
  };
}

/** Sets an issue's triage status, with an optional note, and returns the updated issue. */
export async function setIssueStatus(
  idOrNumber: string | number,
  status: IssueStatus,
  note?: string,
): Promise<Issue> {
  const response = await fetch(issuePath(idOrNumber), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(note === undefined ? { status } : { status, note }),
  });
  if (!response.ok) throw new Error(await readApiError(response, 'failed to update issue status'));
  return (await response.json()) as Issue;
}

/** Reads one issue by number or doc id; `setStatus` updates it in place. */
export function useIssue(idOrNumber: string | number | null) {
  const key = idOrNumber === null ? null : String(idOrNumber);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [loading, setLoading] = useState(key !== null);
  const [error, setError] = useState<string | null>(null);
  // bumped per read and per status set, so an older answer never overwrites a newer one
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (key === null) return;
    const request = ++generation.current;
    // a reload keeps the issue it shows; a different issue starts blank
    setIssue((prev) => (prev && (prev.id === key || String(prev.number) === key) ? prev : null));
    setLoading(true);
    try {
      const response = await fetch(issuePath(key), { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'failed to load issue'));
      const body = (await response.json()) as Issue;
      if (request !== generation.current) return;
      setIssue(body);
      setError(null);
    } catch (err) {
      if (request !== generation.current) return;
      console.error('Error fetching issue:', err);
      setIssue(null);
      setError(errorMessage(err, 'failed to load issue'));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setStatus = useCallback(
    async (status: IssueStatus, note?: string): Promise<Issue> => {
      if (key === null) throw new Error('no issue selected');
      const updated = await setIssueStatus(key, status, note);
      generation.current++;
      setIssue(updated);
      setLoading(false);
      setError(null);
      return updated;
    },
    [key],
  );

  return { issue, loading, error, refresh, setStatus };
}
