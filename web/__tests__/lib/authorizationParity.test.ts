/** @jest-environment node */

/**
 * CHARACTERIZATION MATRIX — `dev/active/per-site-roles` Wave 1, Task 1.1.
 *
 * Owlette gates site-scoped routes through TWO independent authorization
 * paths that were written separately and have drifted:
 *
 *   A. `authorizedSiteHandler`  (web/lib/authorizedHandler.server.ts) — 46 routes
 *   B. `requireSiteAuthAndScope` (web/app/api/_shared.ts)             — 35 routes
 *
 * Wave 1 collapses both onto one decision core. This file pins what they do
 * TODAY, divergences included, so the refactor has a contract to answer to.
 * It is deliberately written against the REAL decision logic: only the
 * identity edge (`resolveAuth`) and side-effect sinks (audit, rate limit,
 * security config) are stubbed. `assertUserHasSiteAccess`, `assertUserDataActive`
 * and the siteId validation all run for real — mocking those would pin the
 * mock rather than the system, and they are exactly where the drift lives.
 *
 * Both divergences this file was written to pin are now CLOSED by Wave 1 task
 * 1.3, and the blocks below record what they were:
 *   1. DELETED USER   — path A answered 403 `user_inactive`, path B collapsed it
 *                       into 404. Both answer 403.
 *   2. MALFORMED ID   — path B answered 400, path A had no shape check and
 *                       answered 404 (or 503 for ids the SDK rejects outright).
 *                       Both answer 400, and both authenticate first.
 *
 * They were rewritten rather than deleted, which is the rule: a divergence test
 * that stops holding is evidence the contract moved, and the new contract needs
 * pinning in its place.
 */

import type { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Controllable data layer. Both paths read `users/{uid}` and `sites/{siteId}`.
// ---------------------------------------------------------------------------

const store = {
  users: new Map<string, Record<string, unknown> | null>(),
  sites: new Map<string, Record<string, unknown> | null>(),
  /** `sites/{siteId}/members/{uid}`, keyed `${siteId}/${uid}`. THE grant. */
  members: new Map<string, Record<string, unknown> | null>(),
};

/** Give `uid` standing on `siteId`, as `membership.server.ts` writes it. */
function grant(
  siteId: string,
  uid: string,
  role: 'owner' | 'admin' | 'member',
  machineIds?: string[],
): void {
  store.members.set(`${siteId}/${uid}`, {
    uid,
    role,
    status: 'active',
    addedAt: new Date(0),
    addedBy: 'system:test',
    ...(machineIds ? { machineIds } : {}),
  });
}

/** Reads recorded per document path, so we can pin the read COST of each path. */
const reads: string[] = [];

function snapshot(id: string, data: Record<string, unknown> | null) {
  return { exists: data !== null, id, data: () => data ?? undefined };
}

function resolveDoc(path: string) {
  reads.push(path);
  const segments = path.split('/').filter(Boolean);
  // TOP-LEVEL DOCUMENTS ONLY — exactly two segments. Destructuring the first
  // two segments of ANY path would make `sites/{id}/members/{uid}` resolve to
  // the SITE document, so a Wave 4 membership-subcollection read would silently
  // answer with unrelated data and this matrix would pass while testing nothing.
  // Anything deeper is reported as non-existent, which fails loudly instead.
  // `sites/{siteId}/members/{uid}` — resolved explicitly, never by falling back
  // to a shorter prefix, or a membership read would answer with the SITE
  // document and this matrix would pass while testing nothing.
  if (segments.length === 4 && segments[0] === 'sites' && segments[2] === 'members') {
    return snapshot(segments[3], store.members.get(`${segments[1]}/${segments[3]}`) ?? null);
  }
  if (segments.length !== 2) return snapshot(segments[segments.length - 1] ?? 'unknown', null);
  const [collection, id] = segments;
  if (collection === 'users') return snapshot(id, store.users.get(id) ?? null);
  if (collection === 'sites') return snapshot(id, store.sites.get(id) ?? null);
  return snapshot(id, null);
}

function buildDoc(path: string): Record<string, unknown> {
  return {
    get: () => Promise.resolve(resolveDoc(path)),
    set: () => Promise.resolve(),
    update: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    collection: (sub: string) => buildCollection(`${path}/${sub}`),
  };
}

function buildCollection(name: string): Record<string, unknown> {
  return {
    doc: (id?: string) => buildDoc(`${name}/${id ?? 'auto'}`),
    where: function () { return this; },
    orderBy: function () { return this; },
    limit: function () { return this; },
    get: () => Promise.resolve({ docs: [], empty: true }),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => buildCollection(name),
    // Present so this matrix still passes after Task 1.2 collapses the
    // separate reads into one batched round trip.
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((r) => r.get())),
    batch: () => ({
      set: () => {},
      update: () => {},
      delete: () => {},
      commit: () => Promise.resolve(),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: () => {},
        update: () => {},
        delete: () => {},
      }),
  }),
  getAdminAuth: () => ({}),
}));

// ---------------------------------------------------------------------------
// Identity edge. The ONLY part of apiAuth we stub — everything else is real.
// ---------------------------------------------------------------------------

type AuthShape = { userId: string; keyContext: unknown };

let resolveAuthResult: AuthShape = { userId: 'uid_alice', keyContext: null };
let resolveAuthThrows: { status: number; message: string; code?: string } | null = null;

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: jest.fn(async () => {
      if (resolveAuthThrows) {
        throw new actual.ApiAuthError(resolveAuthThrows.status, resolveAuthThrows.message, {
          code: resolveAuthThrows.code,
        });
      }
      return resolveAuthResult;
    }),
  };
});

// ---------------------------------------------------------------------------
// Side-effect sinks. None of these participate in the allow/deny decision,
// except the allow-audit's 503-on-failure, which is pinned in
// authorizedHandler.test.ts rather than here.
// ---------------------------------------------------------------------------

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
      lastUpdated: 0,
      expiresAt: 0,
    }),
  },
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: async () => ({ ok: true }),
  rateLimitHeaders: () => ({}),
  CAPABILITY_RATE_LIMITS: {},
  API_KEY_RATE_LIMITS: {},
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: () => 'corr_test',
  writeAuditEntry: async () => {},
  writeAuditEntryBlocking: async () => {},
  writeGlobalAuditEntryBlocking: async () => {},
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: () => {},
  emitMutation: () => {},
  scopeFingerprint: () => 'fp',
}));

jest.mock('@/lib/securityBoundaryMetrics.server', () => ({
  emitSecurityBoundaryMetric: () => {},
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// ---------------------------------------------------------------------------

import { NextResponse } from 'next/server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { requireMachineAuthAndScope, requireSiteAuthAndScope } from '@/app/api/_shared';
import { Capability } from '@/lib/capabilities';

const SITE = 'site-a';
const ALICE = 'uid_alice';
const MACHINE = 'm1';

/** A NextRequest good enough for every path: headers + nextUrl.pathname. */
function makeRequest(pathname = `/api/sites/${SITE}/thing`): NextRequest {
  return {
    headers: new Headers(),
    nextUrl: { pathname, searchParams: new URLSearchParams() },
    url: `https://example.test${pathname}`,
    method: 'GET',
  } as unknown as NextRequest;
}

function machinePath(siteId: string, machineId: string): string {
  return `/api/sites/${siteId}/machines/${machineId}/thing`;
}

/** Wildcard-scoped api-key context — scope never answers the request. */
function wildcardKey() {
  return {
    keyId: 'key_test',
    environment: 'live',
    expiresAt: Date.now() + 60_000,
    isLegacy: false,
    scopes: [
      { resource: 'site', id: '*', permissions: ['read', 'write', 'deploy', 'rollback', 'admin'] },
    ],
  };
}

/** An api-key context holding only `read`, for the without-scope leg. */
function readOnlyKey() {
  return {
    keyId: 'key_readonly',
    environment: 'live',
    expiresAt: Date.now() + 60_000,
    isLegacy: false,
    scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
  };
}

// --- path A driver ----------------------------------------------------------

async function runPathA(
  siteId: string,
  opts: { capability?: Capability; apiKeyPermission?: 'read' | 'write'; machineId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = authorizedSiteHandler({
    // MACHINE_VIEW is the read-class site-scoped capability EVERY role holds
    // (capabilities.ts MEMBER_CAPABILITIES), so it isolates the access decision
    // from the capability decision — which is what this matrix is measuring.
    capability: opts.capability ?? Capability.MACHINE_VIEW,
    siteIdParam: 'path',
    apiKeyPermission: opts.apiKeyPermission ?? 'read',
  })(async () => NextResponse.json({ ok: true }));

  // path A′: the same wrapper on a machine route, where params carry the machineId
  const { machineId } = opts;
  const res = machineId === undefined
    ? await route(makeRequest(), { params: Promise.resolve({ siteId }) })
    : await route(makeRequest(machinePath(siteId, machineId)), {
        params: Promise.resolve({ siteId, machineId }),
      });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Problem bodies carry a per-response requestId; drop it to compare shapes. */
function withoutRequestId(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = body;
  return rest;
}

// --- path B driver ----------------------------------------------------------

async function runPathB(
  siteId: string,
  permission: 'read' | 'write' = 'read',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await requireSiteAuthAndScope(makeRequest(), siteId, permission);
  if (!result.ok) {
    return { status: result.response.status, body: await result.response.json().catch(() => ({})) };
  }
  return { status: 200, body: { ok: true } };
}

// --- path C driver ----------------------------------------------------------

async function runPathC(
  siteId: string,
  machineId: string,
  permission: 'read' | 'write' = 'read',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await requireMachineAuthAndScope(
    makeRequest(machinePath(siteId, machineId)),
    siteId,
    machineId,
    permission,
  );
  if (!result.ok) {
    return { status: result.response.status, body: await result.response.json().catch(() => ({})) };
  }
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  store.users.clear();
  store.sites.clear();
  reads.length = 0;
  resolveAuthThrows = null;
  resolveAuthResult = { userId: ALICE, keyContext: null };

  store.members.clear();
  store.sites.set(SITE, { owner: ALICE, name: 'Site A' });
  store.users.set(ALICE, { role: 'admin', sites: [SITE] });
  grant(SITE, ALICE, 'admin');
});

describe('authorization parity — shared behaviour (both paths must agree)', () => {
  it('allows an authenticated member of the site', async () => {
    expect((await runPathA(SITE)).status).toBe(200);
    expect((await runPathB(SITE)).status).toBe(200);
  });

  it('allows a superadmin who is not a member', async () => {
    store.users.set(ALICE, { role: 'superadmin', sites: [] });
    store.sites.set(SITE, { owner: 'someone_else' });
    store.members.clear();

    expect((await runPathA(SITE)).status).toBe(200);
    expect((await runPathB(SITE)).status).toBe(200);
  });

  it('allows the site owner, whose global role grants nothing', async () => {
    store.users.set(ALICE, { role: 'member', sites: [] });
    store.sites.set(SITE, { owner: ALICE });
    grant(SITE, ALICE, 'owner');

    expect((await runPathA(SITE)).status).toBe(200);
    expect((await runPathB(SITE)).status).toBe(200);
  });

  it('rejects an unauthenticated caller with 401', async () => {
    resolveAuthThrows = { status: 401, message: 'no session' };

    expect((await runPathA(SITE)).status).toBe(401);
    expect((await runPathB(SITE)).status).toBe(401);
  });

  it('collapses "site does not exist" into 404 without leaking existence', async () => {
    store.sites.delete(SITE);

    const a = await runPathA(SITE);
    const b = await runPathB(SITE);

    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    // Neither may distinguish "missing" from "forbidden" in the body.
    expect(String(b.body.detail)).toBe('site not found or no access');
  });

  it('collapses "member of no such site" into the SAME 404 as a missing site', async () => {
    store.users.set(ALICE, { role: 'member', sites: ['other-site'] });
    store.sites.set(SITE, { owner: 'someone_else' });
    store.members.clear();

    const denied = await runPathB(SITE);
    store.sites.delete(SITE);
    const missing = await runPathB(SITE);

    // The anti-enumeration property: identical status AND identical body,
    // modulo the per-response requestId.
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(withoutRequestId(denied.body)).toEqual(withoutRequestId(missing.body));
  });
});

describe('authorization parity — api-key scope', () => {
  it('allows an api-key holding the required permission', async () => {
    resolveAuthResult = { userId: ALICE, keyContext: wildcardKey() };

    expect((await runPathA(SITE)).status).toBe(200);
    expect((await runPathB(SITE)).status).toBe(200);
  });

  it('refuses an api-key missing the required permission with 403', async () => {
    resolveAuthResult = { userId: ALICE, keyContext: readOnlyKey() };

    const a = await runPathA(SITE, {
      capability: Capability.SITE_MEMBER_MANAGE,
      apiKeyPermission: 'write',
    });
    const b = await runPathB(SITE, 'write');

    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
  });
});

describe('CONVERGENCE 1 — an inactive caller is 403 on BOTH paths', () => {
  // WAS A DIVERGENCE until Wave 1 task 1.3. Path A answered 403 user_inactive;
  // path B collapsed it into the generic 404 "site not found or no access".
  // Both now answer 403.
  //
  // The masking exists to stop a stranger enumerating sites. It has no job to do
  // once the caller has authenticated and it is their OWN account that is gone —
  // a 404 there sends them hunting for a missing site instead of a disabled
  // login. Note this covers a MISSING user document as well as a soft-deleted
  // one, so an api key whose owner was hard-deleted also moved 404 -> 403.
  beforeEach(() => {
    store.users.set(ALICE, { role: 'admin', sites: [SITE], deletedAt: Date.now() });
  });

  it('path A answers 403', async () => {
    expect((await runPathA(SITE)).status).toBe(403);
  });

  it('path B answers 403 too', async () => {
    expect((await runPathB(SITE)).status).toBe(403);
  });

  it('the two paths now AGREE', async () => {
    const a = await runPathA(SITE);
    const b = await runPathB(SITE);
    expect(a.status).toBe(b.status);
  });

  it('still masks a genuine no-access caller as 404 on both', async () => {
    // The distinction that matters: inactive is disclosed (403), non-membership
    // is not (404). Without this, "unify on 403" could quietly disclose site
    // existence to anyone who asks.
    store.users.set(ALICE, { role: 'member', sites: [] });
    store.sites.set(SITE, { owner: 'someone_else' });
    store.members.clear();
    expect((await runPathA(SITE)).status).toBe(404);
    expect((await runPathB(SITE)).status).toBe(404);
  });
});

describe('CONVERGENCE 2 — a malformed siteId is 400 on BOTH paths', () => {
  const MALFORMED = 'not a valid site id!';

  // WAS A DIVERGENCE until Wave 1 task 1.3. Path B validated the shape and
  // answered 400; path A had no check, so the raw value went to Firestore, the
  // read simply MISSED, and the caller got 404 for input that was never a valid
  // id. Worse, for ids the SDK rejects client-side (containing '/', or the
  // reserved __.*__ form) the read THREW and path A answered 503 — three
  // different answers for one class of bad input.
  it('path A answers 400', async () => {
    const a = await runPathA(MALFORMED);
    expect(a.status).toBe(400);
    expect(String(a.body.detail)).toBe('invalid siteId format');
  });

  it('path B answers 400', async () => {
    const b = await runPathB(MALFORMED);
    expect(b.status).toBe(400);
    expect(String(b.body.detail)).toBe('invalid siteId format');
  });

  it('the two paths now AGREE', async () => {
    const a = await runPathA(MALFORMED);
    const b = await runPathB(MALFORMED);
    expect(a.status).toBe(b.status);
    expect(withoutRequestId(a.body)).toEqual(withoutRequestId(b.body));
  });

  it('an id the Firestore SDK rejects outright is ALSO 400, not 503', async () => {
    // Path A used to hand this straight to the SDK, which throws client-side on
    // a '/' in a document id; the wrapper caught it and answered 503 — a server
    // error for input the caller supplied, and it short-circuited before any
    // audit row was written.
    expect((await runPathA('has/slash')).status).toBe(400);
    expect((await runPathB('has/slash')).status).toBe(400);
  });

  it('UNAUTHENTICATED callers get 401 on both, not 400 — auth outranks shape', async () => {
    // Path B validated BEFORE resolving auth, so a stranger could learn whether
    // an id was well-formed without proving anything. Both now authenticate
    // first and reveal nothing.
    resolveAuthThrows = { status: 401, message: 'no session' };
    expect((await runPathA(MALFORMED)).status).toBe(401);
    expect((await runPathB(MALFORMED)).status).toBe(401);
  });
});

describe('machine scope — every gate holds a scoped member to their machines', () => {
  // path A′ is the wrapper on a machine route, path C is requireMachineAuthAndScope.
  // off the scope both answer as for a machine that is not there (ADR 0016), so
  // the bodies must match too, or one gate tells a scoped member the id exists.
  beforeEach(() => {
    store.users.set(ALICE, { role: 'member', sites: [SITE] });
    store.sites.set(SITE, { owner: 'someone_else' });
  });

  it('refuses a scoped member on the no-machine path with the same 403 on A and B', async () => {
    grant(SITE, ALICE, 'member', [MACHINE]);

    const a = await runPathA(SITE);
    const b = await runPathB(SITE);

    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(String(a.body.detail)).toBe('capability not granted');
    expect(withoutRequestId(a.body)).toEqual(withoutRequestId(b.body));
  });

  it('admits a scoped member to a machine in scope on A′ and C', async () => {
    grant(SITE, ALICE, 'member', [MACHINE]);

    expect((await runPathA(SITE, { machineId: MACHINE })).status).toBe(200);
    expect((await runPathC(SITE, MACHINE)).status).toBe(200);
  });

  it('answers a machine out of scope with the same 404 on A′ and C', async () => {
    grant(SITE, ALICE, 'member', ['m2']);

    const a = await runPathA(SITE, { machineId: MACHINE });
    const c = await runPathC(SITE, MACHINE);

    expect(a.status).toBe(404);
    expect(c.status).toBe(404);
    expect(String(a.body.detail)).toBe('machine not found or no access');
    expect(withoutRequestId(a.body)).toEqual(withoutRequestId(c.body));
  });

  it('admits a whole-site member to the machine on A′ and C', async () => {
    grant(SITE, ALICE, 'member');

    expect((await runPathA(SITE, { machineId: MACHINE })).status).toBe(200);
    expect((await runPathC(SITE, MACHINE)).status).toBe(200);
  });
});

describe('read cost — the Task 1.2 improvement, now pinned against regression', () => {
  it('path A reads users/{uid} ONCE (was twice before the decision core)', async () => {
    reads.length = 0;
    await runPathA(SITE);

    const userReads = reads.filter((p) => p === `users/${ALICE}`);
    // BEFORE Task 1.2 this was 2: assertUserHasSiteAccess read the user doc to
    // decide access, then loadUserActor read it again to build the actor.
    // resolveSiteAccess returns both from one getAll. If this goes back to 2,
    // someone has reintroduced a second read on the hot authorization path.
    expect(userReads.length).toBe(1);
  });

  it('path A reads the site document exactly once', async () => {
    reads.length = 0;
    await runPathA(SITE);

    expect(reads.filter((p) => p === `sites/${SITE}`).length).toBe(1);
  });

  it('path B reads users/{uid} once', async () => {
    reads.length = 0;
    await runPathB(SITE);

    expect(reads.filter((p) => p === `users/${ALICE}`).length).toBe(1);
  });
});
