/**
 * @jest-environment jsdom
 *
 * `useSiteMembers` and `useMemberCandidates`, the fetch-based owners of the
 * members and member-candidates routes. a user may read only their own member
 * row, so there is no listener path to test: every assertion here is about
 * request shape, problem+json surfacing, the inert (no siteId) state, and the
 * staleness guard on a site switch.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useMemberCandidates,
  useSiteMembers,
  SiteMemberApiError,
  type SiteMember,
  type UpdateSiteMemberInput,
} from '@/hooks/useSiteMembers';
import type { MemberCandidate } from '@/lib/memberCandidates';

const OWNER: SiteMember = {
  uid: 'owner-uid',
  email: 'owner@example.com',
  role: 'owner',
  globalRole: 'admin',
  displayName: 'Owner',
  swoop: null,
};

const MEMBER: SiteMember = {
  uid: 'member-uid',
  email: 'member@example.com',
  role: 'member',
  globalRole: 'member',
  displayName: null,
  swoop: null,
};

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function lastUrl(mock: jest.Mock): string {
  return String(mock.mock.calls[mock.mock.calls.length - 1]?.[0]);
}

const fetchMock = jest.fn();
let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('useSiteMembers', () => {
  it('loads the member list for the given site', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ members: [OWNER, MEMBER] }));

    const { result } = renderHook(() => useSiteMembers('site-a'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([OWNER, MEMBER]);
    expect(result.current.error).toBeNull();
    expect(lastUrl(fetchMock)).toBe('/api/sites/site-a/members');
  });

  it('tolerates a response without a members array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    const { result } = renderHook(() => useSiteMembers('site-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("carries each member's swoop mode as the route returns it", async () => {
    const controller: SiteMember = {
      ...MEMBER,
      uid: 'controller-uid',
      swoop: 'control',
    };
    const heldBack: SiteMember = {
      ...MEMBER,
      uid: 'held-back-uid',
      role: 'admin',
      swoop: 'none',
    };
    fetchMock.mockResolvedValue(
      jsonResponse({ members: [OWNER, controller, heldBack] }),
    );

    const { result } = renderHook(() => useSiteMembers('site-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members.map((m) => [m.uid, m.swoop])).toEqual([
      ['owner-uid', null],
      ['controller-uid', 'control'],
      ['held-back-uid', 'none'],
    ]);
  });

  it('surfaces the problem+json detail when the list request fails', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { title: 'forbidden', detail: 'you are not an admin of this site' },
        { ok: false, status: 403 },
      ),
    );

    const { result } = renderHook(() => useSiteMembers('site-a'));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe('you are not an admin of this site');
    expect(result.current.members).toEqual([]);
    // Errors must not leave the page spinning forever.
    expect(result.current.loading).toBe(false);
  });

  it('falls back to a generic message when the error body carries none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));

    const { result } = renderHook(() => useSiteMembers('site-a'));
    await waitFor(() => expect(result.current.error).toBe('failed to load members'));
  });

  it('is inert without a siteId — no fetch, empty list, not loading', async () => {
    const { result } = renderHook(() => useSiteMembers(null));

    expect(result.current.members).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      result.current.addMember({ email: 'a@example.com', role: 'member' }),
    ).rejects.toThrow('no site selected');
    await expect(result.current.removeMember('member-uid')).rejects.toThrow(
      'no site selected',
    );
    await expect(
      result.current.updateMember('member-uid', { swoop: 'control' }),
    ).rejects.toThrow('no site selected');
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches when the siteId changes', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse({ members: url.includes('site-b') ? [MEMBER] : [OWNER] }),
    );

    const { result, rerender } = renderHook(
      ({ siteId }: { siteId: string }) => useSiteMembers(siteId),
      { initialProps: { siteId: 'site-a' } },
    );
    await waitFor(() => expect(result.current.members).toEqual([OWNER]));

    rerender({ siteId: 'site-b' });
    await waitFor(() => expect(result.current.members).toEqual([MEMBER]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('addMember', () => {
    function mockAddOk() {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse({
              uid: 'member-uid',
              siteId: 'site-a',
              requestedRole: 'member',
              roleHonored: true,
              globalRole: 'member',
            })
          : jsonResponse({ members: [MEMBER] }),
      );
    }

    it('posts email + role with an Idempotency-Key, returns the body, and refetches', async () => {
      const addBody = {
        uid: 'member-uid',
        siteId: 'site-a',
        requestedRole: 'admin',
        roleHonored: false,
        globalRole: 'member',
      };
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse(addBody)
          : jsonResponse({ members: [MEMBER] }),
      );

      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      let returned: unknown;
      await act(async () => {
        returned = await result.current.addMember({
          email: 'member@example.com',
          role: 'admin',
        });
      });

      // POST, then the refetch.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const post = fetchMock.mock.calls[0];
      expect(post[0]).toBe('/api/sites/site-a/members');
      const init = post[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        email: 'member@example.com',
        role: 'admin',
      });
      const headers = init.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      expect(headers['Idempotency-Key']).toEqual(expect.any(String));
      expect(headers['Idempotency-Key'].length).toBeGreaterThan(0);

      // roleHonored:false must reach the caller so the page can explain it.
      expect(returned).toEqual(addBody);
      expect(fetchMock.mock.calls[1][0]).toBe('/api/sites/site-a/members');
      expect((fetchMock.mock.calls[1][1] as RequestInit | undefined)?.method).toBeUndefined();
    });

    it('adds by uid, posting no email and no swoop', async () => {
      mockAddOk();
      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      await act(async () => {
        await result.current.addMember({ uid: 'member-uid', role: 'member' });
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        uid: 'member-uid',
        role: 'member',
      });
    });

    it('posts the swoop mode when one is given', async () => {
      mockAddOk();
      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      await act(async () => {
        await result.current.addMember({
          email: 'member@example.com',
          role: 'member',
          swoop: 'control',
        });
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual({
        email: 'member@example.com',
        role: 'member',
        swoop: 'control',
      });
    });

    it('rejects with the problem detail and does not refetch on failure', async () => {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse(
              { detail: 'user nobody@example.com not found' },
              { ok: false, status: 404 },
            )
          : jsonResponse({ members: [] }),
      );

      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      await expect(
        result.current.addMember({ email: 'nobody@example.com', role: 'member' }),
      ).rejects.toThrow('user nobody@example.com not found');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // The page distinguishes "no such account" from every other add failure by
    // status, so the status must survive the throw — prose is not the contract.
    it('rejects with a SiteMemberApiError carrying the HTTP status', async () => {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse(
              { detail: 'user nobody@example.com not found' },
              { ok: false, status: 404 },
            )
          : jsonResponse({ members: [] }),
      );

      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const err = await result.current
        .addMember({ email: 'nobody@example.com', role: 'member' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(SiteMemberApiError);
      expect((err as SiteMemberApiError).status).toBe(404);
      expect((err as SiteMemberApiError).name).toBe('SiteMemberApiError');
      expect((err as SiteMemberApiError).message).toBe(
        'user nobody@example.com not found',
      );
    });

    // A 403 must not be mistaken for the not-found branch.
    it('carries a non-404 status through unchanged', async () => {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse(
              { detail: 'site not found or you lack access' },
              { ok: false, status: 403 },
            )
          : jsonResponse({ members: [] }),
      );

      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const err = await result.current
        .addMember({ email: 'someone@example.com', role: 'member' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect((err as SiteMemberApiError).status).toBe(403);
    });
  });

  describe('removeMember', () => {
    const removeBody = {
      siteId: 'site-a',
      uid: 'member-uid',
      wasMember: true,
      talonCount: 2,
      reassignedTalonIds: ['talon-1', 'talon-2'],
    };

    function mockRemoveOk() {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'DELETE'
          ? jsonResponse(removeBody)
          : jsonResponse({ members: [OWNER] }),
      );
    }

    it('deletes with an Idempotency-Key, returns the body, and refetches', async () => {
      mockRemoveOk();
      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      let returned: unknown;
      await act(async () => {
        returned = await result.current.removeMember('member-uid');
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/api/sites/site-a/members/member-uid',
      );
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('DELETE');
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toEqual(expect.any(String));
      expect(returned).toEqual(removeBody);
    });

    it('omits talonSuccessorUid when none is given', async () => {
      mockRemoveOk();
      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      await act(async () => {
        await result.current.removeMember('member-uid');
      });
      expect(String(fetchMock.mock.calls[0][0])).not.toContain(
        'talonSuccessorUid',
      );
    });

    it('adds talonSuccessorUid as a query param when given', async () => {
      mockRemoveOk();
      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      await act(async () => {
        await result.current.removeMember('member-uid', 'successor-uid');
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/api/sites/site-a/members/member-uid?talonSuccessorUid=successor-uid',
      );
    });

    it('rejects with the problem detail when the owner cannot be removed', async () => {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'DELETE'
          ? jsonResponse(
              {
                title: 'cannot remove site owner',
                detail: 'the site owner cannot be removed via this endpoint',
                code: 'cannot_remove_owner',
              },
              { ok: false, status: 409 },
            )
          : jsonResponse({ members: [OWNER] }),
      );

      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const err = await result.current.removeMember('owner-uid').then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SiteMemberApiError);
      expect((err as SiteMemberApiError).status).toBe(409);
      expect((err as SiteMemberApiError).code).toBe('cannot_remove_owner');
      expect((err as SiteMemberApiError).message).toBe(
        'the site owner cannot be removed via this endpoint',
      );
    });
  });

  describe('updateMember', () => {
    const updateBody = {
      siteId: 'site-a',
      uid: 'member-uid',
      role: 'member',
      swoop: 'control',
    };

    function mockUpdateOk() {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? jsonResponse(updateBody)
          : jsonResponse({ members: [MEMBER] }),
      );
    }

    it('patches with an Idempotency-Key, returns the body, and refetches', async () => {
      mockUpdateOk();
      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      let returned: unknown;
      await act(async () => {
        returned = await result.current.updateMember('member-uid', {
          swoop: 'control',
        });
      });

      // PATCH, then the refetch.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/api/sites/site-a/members/member-uid',
      );
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('PATCH');
      const headers = init.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      expect(headers['Idempotency-Key']).toMatch(
        /^site-member-access-member-uid-/,
      );
      expect(returned).toEqual(updateBody);
      expect(fetchMock.mock.calls[1][0]).toBe('/api/sites/site-a/members');
      expect(
        (fetchMock.mock.calls[1][1] as RequestInit | undefined)?.method,
      ).toBeUndefined();
    });

    // a null swoop is a value, not an absence: it puts them back on their role's default
    it.each<[UpdateSiteMemberInput, Record<string, unknown>]>([
      [{ role: 'admin' }, { role: 'admin' }],
      [{ swoop: null }, { swoop: null }],
      [{ role: 'member', swoop: 'view' }, { role: 'member', swoop: 'view' }],
      [{ role: undefined, swoop: 'none' }, { swoop: 'none' }],
    ])('sends exactly the fields given in %p', async (patch, sent) => {
      mockUpdateOk();
      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      await act(async () => {
        await result.current.updateMember('member-uid', patch);
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(init.body))).toEqual(sent);
    });

    it('rejects a refused change with its status and code, and does not refetch', async () => {
      const detail =
        "the owner's role and swoop come with ownership; transfer ownership instead";
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? jsonResponse(
              {
                title: "cannot change the site owner's role",
                detail,
                code: 'cannot_change_owner_role',
              },
              { ok: false, status: 409 },
            )
          : jsonResponse({ members: [OWNER] }),
      );

      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockClear();

      const err = await result.current
        .updateMember('owner-uid', { swoop: 'none' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(SiteMemberApiError);
      expect((err as SiteMemberApiError).status).toBe(409);
      expect((err as SiteMemberApiError).code).toBe('cannot_change_owner_role');
      expect((err as SiteMemberApiError).message).toBe(detail);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to a generic message, with no code, when the error body carries none', async () => {
      fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? jsonResponse({}, { ok: false, status: 500 })
          : jsonResponse({ members: [MEMBER] }),
      );

      const { result } = renderHook(() => useSiteMembers('site-a'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const err = await result.current
        .updateMember('member-uid', { role: 'admin' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect((err as SiteMemberApiError).status).toBe(500);
      expect((err as SiteMemberApiError).message).toBe(
        'failed to change their access',
      );
      expect((err as SiteMemberApiError).code).toBeUndefined();
    });
  });

  it('does not let a late response for the previous site clobber the newer one', async () => {
    const slowSiteA = deferred<Response>();
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('site-a')
        ? slowSiteA.promise
        : jsonResponse({ members: [MEMBER] }),
    );

    const { result, rerender } = renderHook(
      ({ siteId }: { siteId: string }) => useSiteMembers(siteId),
      { initialProps: { siteId: 'site-a' } },
    );

    // Switch before site-a ever settles.
    rerender({ siteId: 'site-b' });
    await waitFor(() => expect(result.current.members).toEqual([MEMBER]));

    await act(async () => {
      slowSiteA.resolve(jsonResponse({ members: [OWNER] }));
      await slowSiteA.promise;
    });

    expect(result.current.members).toEqual([MEMBER]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('useMemberCandidates', () => {
  const ALICE: MemberCandidate = {
    uid: 'alice-uid',
    email: 'alice@example.com',
    displayName: 'Alice',
  };

  const BOB: MemberCandidate = {
    uid: 'bob-uid',
    email: null,
    displayName: 'Bob',
  };

  it('loads the people who can be added to the given site', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [ALICE, BOB] }));

    const { result } = renderHook(() => useMemberCandidates('site-a'));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.candidates).toEqual([ALICE, BOB]);
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastUrl(fetchMock)).toBe('/api/sites/site-a/member-candidates');
  });

  it('tolerates a response without a candidates array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    const { result } = renderHook(() => useMemberCandidates('site-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.candidates).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces the problem detail, and stops loading, when the request fails', async () => {
    const detail =
      'listing member candidates requires the SITE_MEMBER_MANAGE capability on this site';
    fetchMock.mockResolvedValue(
      jsonResponse(
        { title: 'forbidden', detail, code: 'site_member_manage_required' },
        { ok: false, status: 403 },
      ),
    );

    const { result } = renderHook(() => useMemberCandidates('site-a'));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe(detail);
    expect(result.current.candidates).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('falls back to a generic message when the error body carries none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));

    const { result } = renderHook(() => useMemberCandidates('site-a'));
    await waitFor(() => expect(result.current.error).toBe('failed to load people'));
  });

  it('is inert without a siteId: no fetch, no people, not loading', () => {
    const { result } = renderHook(() => useMemberCandidates(undefined));

    expect(result.current.candidates).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let a late response for the previous site clobber the newer one', async () => {
    const slowSiteA = deferred<Response>();
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('site-a')
        ? slowSiteA.promise
        : jsonResponse({ candidates: [BOB] }),
    );

    const { result, rerender } = renderHook(
      ({ siteId }: { siteId: string }) => useMemberCandidates(siteId),
      { initialProps: { siteId: 'site-a' } },
    );

    // switch before site-a ever settles
    rerender({ siteId: 'site-b' });
    await waitFor(() => expect(result.current.candidates).toEqual([BOB]));

    await act(async () => {
      slowSiteA.resolve(jsonResponse({ candidates: [ALICE] }));
      await slowSiteA.promise;
    });

    expect(result.current.candidates).toEqual([BOB]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
