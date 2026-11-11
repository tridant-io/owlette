'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemberCandidate } from '@/lib/memberCandidates';
import type { SwoopMode } from '@/lib/swoopMode';

/**
 * the single owner of every `/api/sites/{siteId}/members*` and
 * `/api/sites/{siteId}/member-candidates` request.
 *
 * fetch-based, never a firestore listener: the rules let a user read only their
 * own member row, so a site's roster is readable only through the route.
 */

/**
 * the role stored on the member row. `'superadmin'` is kept for `displayRole`;
 * the route never returns it.
 */
export type SiteMemberRole = 'owner' | 'superadmin' | 'admin' | 'member';

/** The two roles the add endpoint accepts. */
export type AddableSiteMemberRole = 'admin' | 'member';

export interface SiteMember {
  uid: string;
  email: string | null;
  role: SiteMemberRole;
  /**
   * the account's platform role. it grants nothing on this site, so the UI
   * must not decide anything by it.
   */
  globalRole: string;
  displayName: string | null;
  /** their own swoop mode on this site. null means their role decides. */
  swoop: SwoopMode | null;
  /** their machine scope: null for the whole site, else only these machines. */
  machineIds: string[] | null;
}

/**
 * a picked candidate is added by uid, a typed full email by email. without
 * swoop the new row carries no mode, so their role decides. without machineIds
 * they reach the whole site.
 */
export type AddSiteMemberInput = {
  role: AddableSiteMemberRole;
  swoop?: SwoopMode;
  machineIds?: string[];
} & ({ uid: string; email?: undefined } | { email: string; uid?: undefined });

export interface AddSiteMemberResult {
  uid: string;
  siteId: string;
  requestedRole: AddableSiteMemberRole;
  /**
   * false means they were already on the site: nothing was written, and their
   * role and swoop mode are unchanged.
   */
  roleHonored: boolean;
  globalRole: string;
}

export interface UpdateSiteMemberInput {
  role?: AddableSiteMemberRole;
  /** null puts them back on their role's default. */
  swoop?: SwoopMode | null;
  /** null gives them the whole site back. */
  machineIds?: string[] | null;
}

export interface UpdateSiteMemberResult {
  siteId: string;
  uid: string;
  role: AddableSiteMemberRole;
  swoop: SwoopMode | null;
  machineIds: string[] | null;
}

export interface RemoveSiteMemberResult {
  siteId: string;
  uid: string;
  wasMember: boolean;
  /** Talons this user authored on the site, counted before the removal. */
  talonCount: number;
  reassignedTalonIds: string[];
}

interface ApiProblem {
  detail?: string;
  title?: string;
  error?: string;
  message?: string;
  code?: string;
}

/**
 * A non-2xx from one of the members endpoints, carrying the HTTP status.
 *
 * Without the status a caller can only sniff the prose (`/not found/i`), which
 * breaks the moment the route rewords its 404 — and misfires on any other
 * message that happens to contain those words. Mirrors `ApiRequestError` in
 * `useFirestore`; defined here rather than imported so this hook keeps its
 * fetch-only dependency graph.
 */
export class SiteMemberApiError extends Error {
  readonly status: number;
  /** the problem's code, such as `cannot_remove_owner`: branch on it, never on the message. */
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'SiteMemberApiError';
    this.status = status;
    this.code = code;
  }
}

/** non-2xx response -> an error carrying its status, code and best available message. */
async function problemError(
  res: Response,
  fallback: string,
): Promise<SiteMemberApiError> {
  const body = (await res.json().catch(() => ({}))) as ApiProblem;
  const message =
    body.detail || body.title || body.error || body.message || fallback;
  return new SiteMemberApiError(res.status, message, body.code);
}

// Duplicated per-hook rather than shared, matching the other mutation hooks.
function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const EMPTY_MEMBERS: SiteMember[] = [];

interface MembersState {
  members: SiteMember[];
  /** Which site `members`/`error` describe; null before the first settle. */
  loadedSiteId: string | null;
  error: string | null;
}

export interface UseSiteMembersResult {
  members: SiteMember[];
  loading: boolean;
  error: string | null;
  /** Never rejects — a failed refetch lands in `error`. */
  refresh: () => Promise<void>;
  addMember: (input: AddSiteMemberInput) => Promise<AddSiteMemberResult>;
  updateMember: (
    uid: string,
    patch: UpdateSiteMemberInput,
  ) => Promise<UpdateSiteMemberResult>;
  removeMember: (
    uid: string,
    talonSuccessorUid?: string,
  ) => Promise<RemoveSiteMemberResult>;
}

export function useSiteMembers(
  siteId: string | null | undefined,
): UseSiteMembersResult {
  const [state, setState] = useState<MembersState>({
    members: EMPTY_MEMBERS,
    loadedSiteId: null,
    error: null,
  });

  // Monotonic request token. Switching sites (or a manual refresh overlapping an
  // in-flight one) bumps it, so a late response for the previous site is dropped
  // instead of overwriting the newer list — the `loadedSiteId` guard alone would
  // still let the stale settle push the hook back into a loading state.
  const requestSeq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!siteId) return;
    const seq = ++requestSeq.current;
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/members`,
      );
      if (!res.ok) throw await problemError(res, 'failed to load members');
      const data = (await res.json()) as { members?: SiteMember[] };
      if (seq !== requestSeq.current) return;
      setState({
        members: data.members ?? EMPTY_MEMBERS,
        loadedSiteId: siteId,
        error: null,
      });
    } catch (err) {
      if (seq !== requestSeq.current) return;
      // Pin loadedSiteId on the error path too, or `loading` stays true forever
      // and the page renders a permanent spinner instead of its error branch.
      setState({
        members: EMPTY_MEMBERS,
        loadedSiteId: siteId,
        error: err instanceof Error ? err.message : 'failed to load members',
      });
    }
  }, [siteId]);

  useEffect(() => {
    // `refresh` is inert without a siteId and never rejects.
    void refresh();
  }, [refresh]);

  const addMember = useCallback(
    async (input: AddSiteMemberInput): Promise<AddSiteMemberResult> => {
      if (!siteId) throw new Error('no site selected');
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/members`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': makeIdempotencyKey('site-member-add'),
          },
          // stringify drops what is undefined: the identifier not given, an unset swoop and no machine scope
          body: JSON.stringify({
            uid: input.uid,
            email: input.email,
            role: input.role,
            swoop: input.swoop,
            machineIds: input.machineIds,
          }),
        },
      );
      if (!res.ok) throw await problemError(res, 'failed to add member');
      const added = (await res.json()) as AddSiteMemberResult;
      // Refetch rather than splice: the row's derived role and display name come
      // from the user doc, which this response doesn't carry.
      await refresh();
      return added;
    },
    [siteId, refresh],
  );

  const updateMember = useCallback(
    async (
      uid: string,
      patch: UpdateSiteMemberInput,
    ): Promise<UpdateSiteMemberResult> => {
      if (!siteId) throw new Error('no site selected');
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/members/${encodeURIComponent(uid)}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': makeIdempotencyKey(`site-member-access-${uid}`),
          },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) throw await problemError(res, 'failed to change their access');
      const updated = (await res.json()) as UpdateSiteMemberResult;
      await refresh();
      return updated;
    },
    [siteId, refresh],
  );

  const removeMember = useCallback(
    async (
      uid: string,
      talonSuccessorUid?: string,
    ): Promise<RemoveSiteMemberResult> => {
      if (!siteId) throw new Error('no site selected');
      const query = talonSuccessorUid
        ? `?talonSuccessorUid=${encodeURIComponent(talonSuccessorUid)}`
        : '';
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/members/${encodeURIComponent(uid)}${query}`,
        {
          method: 'DELETE',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': makeIdempotencyKey(`site-member-remove-${uid}`),
          },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) throw await problemError(res, 'failed to remove member');
      const removed = (await res.json()) as RemoveSiteMemberResult;
      await refresh();
      return removed;
    },
    [siteId, refresh],
  );

  const matches = !!siteId && state.loadedSiteId === siteId;

  return {
    members: matches ? state.members : EMPTY_MEMBERS,
    loading: !!siteId && !matches,
    error: matches ? state.error : null,
    refresh,
    addMember,
    updateMember,
    removeMember,
  };
}

const EMPTY_CANDIDATES: MemberCandidate[] = [];

interface CandidatesState {
  candidates: MemberCandidate[];
  loadedSiteId: string | null;
  error: string | null;
}

/**
 * the people the add-member dialog may offer for this site. it fetches on mount
 * and when `siteId` changes, and has no refresh: the dialog mounts only while
 * open, so every open is fresh.
 */
export function useMemberCandidates(siteId: string | null | undefined): {
  candidates: MemberCandidate[];
  loading: boolean;
  error: string | null;
} {
  const [state, setState] = useState<CandidatesState>({
    candidates: EMPTY_CANDIDATES,
    loadedSiteId: null,
    error: null,
  });

  // the same request-seq guard and pinned error state as `refresh` above
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!siteId) return;
    const seq = ++requestSeq.current;
    void (async () => {
      try {
        const res = await fetch(
          `/api/sites/${encodeURIComponent(siteId)}/member-candidates`,
        );
        if (!res.ok) throw await problemError(res, 'failed to load people');
        const data = (await res.json()) as { candidates?: MemberCandidate[] };
        if (seq !== requestSeq.current) return;
        setState({
          candidates: data.candidates ?? EMPTY_CANDIDATES,
          loadedSiteId: siteId,
          error: null,
        });
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setState({
          candidates: EMPTY_CANDIDATES,
          loadedSiteId: siteId,
          error: err instanceof Error ? err.message : 'failed to load people',
        });
      }
    })();
  }, [siteId]);

  const matches = !!siteId && state.loadedSiteId === siteId;

  return {
    candidates: matches ? state.candidates : EMPTY_CANDIDATES,
    loading: !!siteId && !matches,
    error: matches ? state.error : null,
  };
}
