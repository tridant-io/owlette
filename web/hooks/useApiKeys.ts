'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ApiKeyListItem, ApiKeyScope } from '@/lib/apiKeyTypes';
import type { ToolTier } from '@/lib/mcp-tools';

/**
 * The single owner of every `/api/keys` request — six inline fetch sites had
 * drifted into inconsistent revoke/sort/validate behaviour.
 *
 * Fetch-based, never a direct Firestore read: `users/{uid}/api_keys` and
 * `api_keys/{keyHash}` are Admin-SDK-only and the client must stay unable to
 * read them.
 */

export interface CreateKeyInput {
  name: string;
  scopes: ApiKeyScope[];
  ttlDays?: number;
  maxToolTier?: ToolTier;
}

/** `scopes` is a full replacement, not a merge — matches the route. */
export interface UpdateKeyInput {
  name?: string;
  scopes?: ApiKeyScope[];
  maxToolTier?: ToolTier;
}

export interface CreatedKey {
  key: string;
  keyId: string;
  name: string;
  keyPrefix: string;
}

interface ApiProblem {
  detail?: string;
  error?: string;
  message?: string;
}

/** Pull the most useful message out of a problem+json body. */
async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as ApiProblem;
  return body.detail || body.error || body.message || fallback;
}

/**
 * Sort rank, lowest first. Revoked outranks expired/retired because the list
 * grows forever now that revoke is a soft delete: revoked rows are the ones the
 * panel folds away behind a disclosure, so they have to land last as a block.
 */
function terminalRank(k: ApiKeyListItem): number {
  if (k.revoked) return 2;
  if (k.expired || k.retired) return 1;
  return 0;
}

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKeyListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/keys');
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to load keys'));
      const data = (await res.json()) as { keys?: ApiKeyListItem[] };
      // Usable keys first, then dead-by-time-passing, then dead-by-decision;
      // sort is stable so the route's createdAt-desc holds inside each rank.
      const rows = data.keys ?? [];
      setKeys([...rows].sort((a, b) => terminalRank(a) - terminalRank(b)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  /** Returns the raw key — shown once, never retrievable again. */
  const createKey = useCallback(
    async (input: CreateKeyInput): Promise<CreatedKey> => {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to create key'));
      const created = (await res.json()) as CreatedKey;
      await refresh();
      return created;
    },
    [refresh],
  );

  /** Returns the new raw key. The predecessor keeps working until its grace window closes. */
  const rotateKey = useCallback(
    async (keyId: string, ttlDays?: number): Promise<CreatedKey> => {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttlDays === undefined ? {} : { ttlDays }),
      });
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to rotate key'));
      const rotated = (await res.json()) as CreatedKey;
      await refresh();
      return rotated;
    },
    [refresh],
  );

  /** Edits an existing key in place. The secret is unchanged, so nothing is returned to reveal. */
  const updateKey = useCallback(
    async (keyId: string, input: UpdateKeyInput): Promise<void> => {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to update key'));
      await refresh();
    },
    [refresh],
  );

  const revokeKey = useCallback(
    async (keyId: string): Promise<void> => {
      const res = await fetch(`/api/keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await problemMessage(res, 'failed to revoke key'));
      // Refetch, not local splice: rotation leaves a predecessor row the
      // server owns.
      await refresh();
    },
    [refresh],
  );

  return { keys, loading, refresh, createKey, rotateKey, updateKey, revokeKey };
}
