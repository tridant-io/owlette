/** @jest-environment node */

/**
 * Unit tests for `authorizedSiteHandler` / `authorizedPlatformHandler` in
 * `web/lib/authorizedHandler.server.ts`: happy path, allow-audit failure → 503,
 * capability + rate-limit kill-switch bypass (and their bypass metadata),
 * the swoop carve-out from the capability one (BYPASS_EXEMPT_CAPABILITIES),
 * api-key scope never bypassed, site-access 404, machine scope (404 off the
 * scope, 403 site-wide, on both sides of the kill switch), capability 403,
 * rate-limit 429, the plan lockout 402, the platform handler's superadmin gate,
 * and the `siteIdParam: 'body'` type error.
 */

import type { NextRequest } from 'next/server';

const setCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];
let setShouldReject: Error | null = null;

let userDoc: { exists: boolean; data: () => unknown } = {
  exists: true,
  data: () => ({ role: 'admin', sites: ['site-a'] }),
};
let siteDoc: { exists: boolean; data: () => unknown } = {
  exists: true,
  data: () => ({ owner: 'uid_alice' }),
};
/** reads of `sites/{siteId}` itself, so the plan step can be held to the one read site access made. */
let siteDocReads = 0;
// `customers/{uid}` for the control-plane billing gate. Absent by default, which
// `resolveBillingState()` reads as 'trialing' — the posture every other test here assumes.
/**
 * `sites/{siteId}/members/{uid}` — the row site access resolves from. Absent by
 * default so a test that wants standing has to say so; the legacy `owner` field
 * on `siteDoc` no longer grants anything.
 */
let memberDoc: { exists: boolean; data: () => unknown } = {
  exists: false,
  data: () => undefined,
};

/** Give the caller per-site standing; `extra` adds fields to the row, such as `swoop`. */
function setMember(role: 'owner' | 'admin' | 'member', extra?: Record<string, unknown>): void {
  memberDoc = {
    exists: true,
    data: () => ({ uid: 'uid_alice', role, status: 'active', addedAt: new Date(0), addedBy: 'system:test', ...extra }),
  };
}

let customerDoc: { exists: boolean; data: () => unknown } = {
  exists: false,
  data: () => undefined,
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    // Batched read used by lib/sitePolicy.server.ts. Real getAll preserves
    // argument order and yields a non-existent snapshot for a missing doc,
    // so delegating to each ref's own get() matches its observable shape.
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((r) => r.get())),
    collection: (top: string) => buildCollection(top),
  }),
}));

function buildCollection(path: string): unknown {
  return {
    doc: (id?: string) => buildDoc(`${path}/${id ?? 'auto'}`),
  };
}

function buildDoc(path: string): unknown {
  return {
    collection: (sub: string) => buildCollection(`${path}/${sub}`),
    get: () => {
      // resolve which doc this is
      if (path.startsWith('users/')) {
        return Promise.resolve(userDoc);
      }
      // Before the generic `sites/` branch: a membership read would otherwise
      // come back as the site document.
      if (/^sites\/[^/]+\/members\//.test(path)) {
        return Promise.resolve(memberDoc);
      }
      if (path.startsWith('sites/')) {
        if (/^sites\/[^/]+$/.test(path)) siteDocReads += 1;
        return Promise.resolve(siteDoc);
      }
      if (path.startsWith('customers/')) {
        return Promise.resolve(customerDoc);
      }
      return Promise.resolve({ exists: false, data: () => undefined });
    },
    set: (payload: Record<string, unknown>) => {
      if (setShouldReject) return Promise.reject(setShouldReject);
      setCalls.push({ path, payload });
      return Promise.resolve();
    },
  };
}

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
    increment: (value: number) => ({ __increment: value }),
  },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}));

let configResult = {
  capability_enforcement: true,
  rate_limit_enforcement: true,
  lastUpdated: 0,
  expiresAt: 0,
};
const securityConfigReadSpy = jest.fn(async () => configResult);
jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: { read: () => securityConfigReadSpy() },
}));

let rateLimitResult: {
  ok: boolean;
  reason?: 'rate_limited';
  retryAfterSec?: number;
  limit?: number;
  remaining?: number;
  resetAtMs?: number;
  rateLimitReason?: string;
} = { ok: true };
const checkRateLimitSpy = jest.fn(async () => rateLimitResult);
jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitSpy(...args),
  rateLimitHeaders: (result: {
    ok: boolean;
    limit?: number;
    remaining?: number;
    resetAtMs?: number;
    retryAfterSec?: number;
    rateLimitReason?: string;
  }) => {
    if (result.limit === undefined) return {};
    const headers: Record<string, string> = {
      'RateLimit-Limit': String(result.limit),
      'RateLimit-Remaining': String(result.remaining ?? 0),
      'RateLimit-Reset': '60',
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining ?? 0),
      'X-RateLimit-Reset': String(result.resetAtMs ?? 0),
    };
    if (!result.ok) {
      headers['Retry-After'] = String(result.retryAfterSec ?? 1);
      headers['Roost-Rate-Limited-Reason'] = result.rateLimitReason ?? 'endpoint-rate';
    }
    return headers;
  },
}));

let resolveAuthResult: { userId: string; keyContext: unknown } = { userId: 'uid_alice', keyContext: null };
let resolveAuthThrows: { status: number; message: string; code?: string; details?: Record<string, unknown> } | null = null;

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthErrorMock extends Error {
    status: number;
    code?: string;
    details?: Record<string, unknown>;
    constructor(
      status: number,
      message: string,
      opts?: { code?: string; details?: Record<string, unknown> },
    ) {
      super(message);
      this.status = status;
      this.code = opts?.code;
      this.details = opts?.details;
    }
  }
  return {
    ApiAuthError: ApiAuthErrorMock,
    resolveAuth: jest.fn(async () => {
      if (resolveAuthThrows) {
        throw new ApiAuthErrorMock(resolveAuthThrows.status, resolveAuthThrows.message, {
          code: resolveAuthThrows.code,
          details: resolveAuthThrows.details,
        });
      }
      return resolveAuthResult;
    }),
    requireScope: jest.fn(),
    // The wrapper emits the api-key audit event since task 1.6; a no-op here
    // because this suite asserts authorization, not audit fan-out.
    auditApiKeyUse: jest.fn(),
    assertUserHasSiteAccess: jest.fn(async () => ({ siteId: 'site-a', siteData: {}, machineIds: null })),
  };
});

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

const warnSpy = jest.fn();
const errorSpy = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => warnSpy(...a),
    error: (...a: unknown[]) => errorSpy(...a),
  },
}));

import { NextResponse } from 'next/server';
import {
  authorizedSiteHandler,
  authorizedPlatformHandler,
  BYPASS_EXEMPT_CAPABILITIES,
  PLAN_GATED_CAPABILITIES,
  type SiteIdSource,
} from '@/lib/authorizedHandler.server';
import {
  ApiAuthError,
  resolveAuth,
  requireScope,
  assertUserHasSiteAccess,
} from '@/lib/apiAuth.server';
import { PLAN_REQUIRED_DETAIL } from '@/lib/plan.server';
import { scopeMatches, type ApiKeyScope } from '@/lib/apiKeyTypes';
import type { Capability } from '@/lib/capabilities';

const resolveAuthMock = resolveAuth as unknown as jest.Mock;
const requireScopeMock = requireScope as unknown as jest.Mock;
const assertUserHasSiteAccessMock = assertUserHasSiteAccess as unknown as jest.Mock;

beforeEach(() => {
  setCalls.length = 0;
  setShouldReject = null;
  warnSpy.mockClear();
  errorSpy.mockClear();
  resolveAuthMock.mockClear();
  requireScopeMock.mockClear();
  assertUserHasSiteAccessMock.mockClear();
  checkRateLimitSpy.mockClear();
  securityConfigReadSpy.mockClear();
  resolveAuthResult = { userId: 'uid_alice', keyContext: null };
  resolveAuthThrows = null;
  rateLimitResult = { ok: true };
  configResult = {
    capability_enforcement: true,
    rate_limit_enforcement: true,
    lastUpdated: 0,
    expiresAt: 0,
  };
  userDoc = { exists: true, data: () => ({ role: 'admin', sites: ['site-a'] }) };
  siteDoc = { exists: true, data: () => ({ owner: 'uid_alice' }) };
  siteDocReads = 0;
  mockGetEntitlements.mockReset();
  // Ownership is a member row now; the `owner` field above grants nothing.
  setMember('admin');
  customerDoc = { exists: false, data: () => undefined };
  requireScopeMock.mockReturnValue({ isLegacy: false });
  assertUserHasSiteAccessMock.mockResolvedValue({ siteId: 'site-a', siteData: {}, machineIds: null });
});

function makeRequest(url = 'http://localhost/api/sites/site-a/test', method = 'POST'): NextRequest {
  // NextRequest requires a fully-formed Request; the wrapper only inspects
  // nextUrl + headers + method, so a stub Request works.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest: NR } = require('next/server');
  return new NR(url, { method });
}

function pathParamsFor(siteId: string): { params: Promise<{ siteId: string }> } {
  return { params: Promise.resolve({ siteId }) };
}

function machineParamsFor(machineId: string): { params: Promise<{ siteId: string; machineId: string }> } {
  return { params: Promise.resolve({ siteId: 'site-a', machineId }) };
}

// authorizedSiteHandler

type SiteHandler = Parameters<ReturnType<typeof authorizedSiteHandler>>[0];
type PlatformHandler = Parameters<ReturnType<typeof authorizedPlatformHandler>>[0];

function makeSiteHandler(impl: (...args: Parameters<SiteHandler>) => ReturnType<SiteHandler>): jest.MockedFunction<SiteHandler> {
  return jest.fn(impl) as unknown as jest.MockedFunction<SiteHandler>;
}

function makePlatformHandler(impl: (...args: Parameters<PlatformHandler>) => ReturnType<PlatformHandler>): jest.MockedFunction<PlatformHandler> {
  return jest.fn(impl) as unknown as jest.MockedFunction<PlatformHandler>;
}

describe('authorizedSiteHandler — happy path', () => {
  it('invokes handler with actor + siteId + correlationId', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = handler.mock.calls[0][1];
    expect(ctx.actor).toEqual({
      type: 'user',
      userId: 'uid_alice',
      role: 'admin',
      siteRoles: { ['site-a']: 'admin' },
      swoopModes: {},
      machineScopes: { ['site-a']: null },
    });
    expect(ctx.siteId).toBe('site-a');
    expect(typeof ctx.correlationId).toBe('string');
    expect(ctx.correlationId).toMatch(/^[0-9a-f]{22}$/);
  });

  it('passes API-key identity into the capability rate-limit actor', async () => {
    resolveAuthResult = {
      userId: 'uid_alice',
      keyContext: { keyId: 'key-a' },
    };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(200);
    expect(checkRateLimitSpy).toHaveBeenCalledTimes(1);
    expect(checkRateLimitSpy.mock.calls[0][0]).toMatchObject({
      type: 'user',
      userId: 'uid_alice',
      apiKeyId: 'key-a',
    });
  });

  it('writes a blocking allow audit before invoking the handler', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    await wrapped(makeRequest(), pathParamsFor('site-a'));
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect(allow).toBeDefined();
    expect(allow!.path.startsWith('sites/site-a/audit_log/')).toBe(true);
    expect(allow!.payload.capability).toBe('MACHINE_EXEC_COMMAND');
  });

  it('adds rate-limit counter headers to allowed responses when available', async () => {
    rateLimitResult = {
      ok: true,
      limit: 60,
      remaining: 59,
      resetAtMs: Date.now() + 60_000,
      rateLimitReason: 'endpoint-rate',
    };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(200);
    expect(res.headers.get('RateLimit-Limit')).toBe('60');
    expect(res.headers.get('RateLimit-Remaining')).toBe('59');
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('reads siteId from query when configured', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'query' })(handler);

    await wrapped(makeRequest('http://localhost/api/x?siteId=site-a'), { params: Promise.resolve({}) });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1].siteId).toBe('site-a');
  });

});

describe('authorizedSiteHandler — allow-audit fail-closed', () => {
  it('returns 503 and does not invoke the handler when the allow audit fails', async () => {
    setShouldReject = new Error('audit firestore down');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('authorizedSiteHandler — kill switches', () => {
  it('capability kill switch off: bypasses cap check and stamps metadata.enforcement_bypassed=capability', async () => {
    configResult = { ...configResult, capability_enforcement: false };
    // With capability_enforcement off, even a member should pass the cap check.
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(200);
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect(allow).toBeDefined();
    const meta = allow!.payload.metadata as Record<string, unknown>;
    expect(meta.enforcement_bypassed).toBe('capability');
    expect(allow!.payload.enforcementBypassed).toBe(true);
  });

  it('rate-limit kill switch off: bypasses rate-limit check and stamps metadata.enforcement_bypassed=rate_limit', async () => {
    configResult = { ...configResult, rate_limit_enforcement: false };
    rateLimitResult = { ok: false, reason: 'rate_limited', retryAfterSec: 30 }; // would otherwise reject
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(200);
    expect(checkRateLimitSpy).not.toHaveBeenCalled();
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    const meta = allow!.payload.metadata as Record<string, unknown>;
    expect(meta.enforcement_bypassed).toBe('rate_limit');
    expect(allow!.payload.enforcementBypassed).toBe(true);
  });

  it('api-key scope check is NEVER bypassed (both kill switches off + read-only key still rejected)', async () => {
    configResult = { capability_enforcement: false, rate_limit_enforcement: false, lastUpdated: 0, expiresAt: 0 };
    requireScopeMock.mockImplementation(() => {
      throw new ApiAuthError(403, 'insufficient scope: requires write on site:site-a', {
        code: 'scope_insufficient',
        details: { resource: 'site', id: 'site-a', permission: 'write' },
      });
    });
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    // a deny audit should be written
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect(deny).toBeDefined();
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('scope_insufficient');
  });
});

describe('authorizedSiteHandler — swoop capabilities are exempt from the capability kill switch', () => {
  it('BYPASS_EXEMPT_CAPABILITIES holds exactly the three swoop capabilities and the fleet grant', () => {
    // SWOOP_SETTINGS_MANAGE belongs here because it is the switch in front of
    // the other two: a bypassable enablement route lets a member turn swoop on
    // and then pass the exempt watch check on merit. FLEET_SETTINGS_MANAGE is
    // the same kind of switch: bypassable, a member could grant a machine
    // commands over the whole site.
    expect([...BYPASS_EXEMPT_CAPABILITIES].sort()).toEqual(
      ['FLEET_SETTINGS_MANAGE', 'MACHINE_REMOTE_CONTROL', 'MACHINE_REMOTE_VIEW', 'SWOOP_SETTINGS_MANAGE'].sort()
    );
  });

  it('MACHINE_CONFIG_WRITE is NOT exempt — the kill switch has to keep the fleet reachable', () => {
    // The reason swoop settings got their own capability instead of joining
    // this set through MACHINE_CONFIG_WRITE: that one also gates process,
    // schedule, display and reboot config, and locking an operator out of those
    // during a matrix misfire is the failure the switch exists to prevent.
    expect(BYPASS_EXEMPT_CAPABILITIES.has('MACHINE_CONFIG_WRITE')).toBe(false);
  });

  it('capability kill switch off: a member is STILL refused SWOOP_SETTINGS_MANAGE', async () => {
    configResult = { ...configResult, capability_enforcement: false };
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    setMember('member');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'SWOOP_SETTINGS_MANAGE', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('capability_missing');
  });

  it('capability kill switch off: a member is STILL refused MACHINE_REMOTE_CONTROL, with a capability_missing deny row', async () => {
    configResult = { ...configResult, capability_enforcement: false };
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    setMember('member');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_REMOTE_CONTROL', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect(deny).toBeDefined();
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('capability_missing');
    expect(setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow')).toBeUndefined();
  });

  it('same switch, same member: an unrelated capability is still waved through', async () => {
    // The control: the kill switch has to keep working for everything else, or
    // the exemption would be a blanket re-enable rather than a carve-out.
    configResult = { ...configResult, capability_enforcement: false };
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    setMember('member');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect((allow!.payload.metadata as Record<string, unknown>).enforcement_bypassed).toBe('capability');
  });

  it('capability kill switch off: a member DOES hold MACHINE_REMOTE_VIEW, and its allow audit claims no bypass', async () => {
    // The exemption re-runs the real check rather than denying outright: a
    // member watches by matrix, and the audit row must not say the capability
    // gate was skipped when it was not.
    configResult = { ...configResult, capability_enforcement: false };
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    setMember('member');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_REMOTE_VIEW', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(200);
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect(allow).toBeDefined();
    expect((allow!.payload.metadata as Record<string, unknown>).enforcement_bypassed).toBeUndefined();
    expect(allow!.payload.enforcementBypassed).toBe(false);
  });
});

// owner rulings 13-14. the mode is read off the member row and holds on both
// sides of the kill switch, because the swoop capabilities are bypass-exempt.
describe.each([
  ['on', true],
  ['off', false],
])("authorizedSiteHandler — a member row's swoop mode, capability enforcement %s", (_label, enforcement) => {
  beforeEach(() => {
    configResult = { ...configResult, capability_enforcement: enforcement };
    userDoc = { exists: true, data: () => ({ role: 'member', sites: [] }) };
  });

  async function call(capability: 'MACHINE_REMOTE_CONTROL' | 'MACHINE_REMOTE_VIEW') {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability, siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    return { res, handler };
  }

  function denyReason(): string | undefined {
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    return (deny?.payload as { denyReason?: string } | undefined)?.denyReason;
  }

  it('refuses an admin held to view MACHINE_REMOTE_CONTROL, with code capability_missing', async () => {
    setMember('admin', { swoop: 'view' });
    const { res, handler } = await call('MACHINE_REMOTE_CONTROL');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'capability_missing', detail: 'capability not granted' });
    expect(handler).not.toHaveBeenCalled();
    expect(denyReason()).toBe('capability_missing');
  });

  it('grants a member set to control MACHINE_REMOTE_CONTROL', async () => {
    setMember('member', { swoop: 'control' });
    const { res, handler } = await call('MACHINE_REMOTE_CONTROL');

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1].actor.swoopModes).toEqual({ ['site-a']: 'control' });
  });

  it('refuses a member set to none MACHINE_REMOTE_VIEW, with code capability_missing', async () => {
    setMember('member', { swoop: 'none' });
    const { res, handler } = await call('MACHINE_REMOTE_VIEW');

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('capability_missing');
    expect(handler).not.toHaveBeenCalled();
    expect(denyReason()).toBe('capability_missing');
  });

  it('positive control: grants an admin with no mode MACHINE_REMOTE_CONTROL', async () => {
    setMember('admin');
    const { res, handler } = await call('MACHINE_REMOTE_CONTROL');

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('authorizedSiteHandler — a swoop mode reaches nothing outside swoop', () => {
  // with the kill switch off this capability bypasses, and a member is waved
  // through ('same switch, same member' above), so the control runs with it on.
  it('positive control: a member set to control is refused MACHINE_EXEC_COMMAND with code forbidden', async () => {
    userDoc = { exists: true, data: () => ({ role: 'member', sites: [] }) };
    setMember('member', { swoop: 'control' });
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'forbidden', detail: 'capability not granted' });
    expect(handler).not.toHaveBeenCalled();
  });
});

// machine scope is part of site access, so it holds on both sides of the kill
// switch: the step runs before the switch is read.
describe.each([
  ['on', true],
  ['off', false],
])('authorizedSiteHandler — machine scope, capability enforcement %s', (_label, enforcement) => {
  beforeEach(() => {
    configResult = { ...configResult, capability_enforcement: enforcement };
    userDoc = { exists: true, data: () => ({ role: 'member', sites: [] }) };
  });

  async function call(
    capability: Capability,
    machineId: string | null,
    extra: { apiKeyScope?: { resource: 'machine'; idParam: string } } = {},
  ) {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability, siteIdParam: 'path', ...extra })(handler);
    const res = machineId === null
      ? await wrapped(makeRequest(), pathParamsFor('site-a'))
      : await wrapped(makeRequest(`http://localhost/api/sites/site-a/machines/${machineId}/test`), machineParamsFor(machineId));
    return { res, handler };
  }

  function deny(): { denyReason?: string; metadata?: Record<string, unknown> } | undefined {
    return setCalls.find((c) => c.payload.outcome === 'deny')?.payload as
      | { denyReason?: string; metadata?: Record<string, unknown> }
      | undefined;
  }

  describe('a scoped member, m1', () => {
    beforeEach(() => setMember('member', { machineIds: ['m1'] }));

    it('runs a MACHINE_VIEW route on m1, on the one site read', async () => {
      const { res, handler } = await call('MACHINE_VIEW', 'm1');

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][1].actor.machineScopes).toEqual({ ['site-a']: ['m1'] });
      expect(siteDocReads).toBe(1);
    });

    it('answers 404 on m2, with a machine_out_of_scope deny row and before the kill switch is read', async () => {
      const { res, handler } = await call('MACHINE_VIEW', 'm2');

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ detail: 'machine not found or no access' });
      expect(handler).not.toHaveBeenCalled();
      expect(deny()).toMatchObject({ denyReason: 'machine_out_of_scope', metadata: { machineId: 'm2' } });
      expect(setCalls.find((c) => c.payload.outcome === 'allow')).toBeUndefined();
      expect(securityConfigReadSpy).not.toHaveBeenCalled();
      expect(siteDocReads).toBe(1);
    });
  });

  describe('a scoped member set to control, m1', () => {
    beforeEach(() => setMember('member', { swoop: 'control', machineIds: ['m1'] }));

    it('runs a MACHINE_REMOTE_CONTROL route on m1', async () => {
      const { res, handler } = await call('MACHINE_REMOTE_CONTROL', 'm1');

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('answers 404 on m2', async () => {
      const { res, handler } = await call('MACHINE_REMOTE_CONTROL', 'm2');

      expect(res.status).toBe(404);
      expect(handler).not.toHaveBeenCalled();
      expect(deny()?.denyReason).toBe('machine_out_of_scope');
    });
  });

  describe('a scoped admin, m1', () => {
    beforeEach(() => setMember('admin', { machineIds: ['m1'] }));

    it('runs MACHINE_EXEC_COMMAND on m1', async () => {
      const { res, handler } = await call('MACHINE_EXEC_COMMAND', 'm1');

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('refuses MACHINE_REMOVE on m1 with 403 forbidden, naming the machine in the deny row', async () => {
      const { res, handler } = await call('MACHINE_REMOVE', 'm1');

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden', detail: 'capability not granted' });
      expect(handler).not.toHaveBeenCalled();
      expect(deny()).toMatchObject({ denyReason: 'machine_scope_site_wide', metadata: { machineId: 'm1' } });
      expect(securityConfigReadSpy).not.toHaveBeenCalled();
    });

    it("refuses SWOOP_SETTINGS_MANAGE on m1 (kill's shape) with code capability_missing", async () => {
      const { res, handler } = await call('SWOOP_SETTINGS_MANAGE', 'm1');

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'capability_missing', detail: 'capability not granted' });
      expect(handler).not.toHaveBeenCalled();
      expect(deny()?.denyReason).toBe('machine_scope_site_wide');
    });

    it.each([
      ['SITE_MEMBER_MANAGE', 'forbidden'],
      ['SWOOP_SETTINGS_MANAGE', 'capability_missing'],
    ] as const)('refuses %s with no machineId with 403 %s', async (capability, code) => {
      const { res, handler } = await call(capability, null);

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe(code);
      expect(handler).not.toHaveBeenCalled();
      expect(deny()?.denyReason).toBe('machine_scope_site_wide');
      expect(deny()?.metadata).not.toHaveProperty('machineId');
    });

    it('with its own api key on machine=*:write: runs on m1 and answers 404 on m2', async () => {
      const scopes: ApiKeyScope[] = [{ resource: 'machine', id: '*', permissions: ['write'] }];
      resolveAuthResult = { userId: 'uid_alice', keyContext: { keyId: 'key-a', scopes } };
      // the real match, so the key admits m2 and only the machine scope refuses it
      requireScopeMock.mockImplementation((_auth, resource, id, permission) => {
        if (!scopeMatches(scopes, resource, id, permission)) {
          throw new ApiAuthError(403, 'insufficient scope', { code: 'scope_insufficient' });
        }
        return { isLegacy: false };
      });
      const apiKeyScope = { resource: 'machine' as const, idParam: 'machineId' };

      const onM1 = await call('MACHINE_EXEC_COMMAND', 'm1', { apiKeyScope });
      expect(onM1.res.status).toBe(200);
      expect(requireScopeMock).toHaveBeenCalledWith(expect.anything(), 'machine', 'm1', 'write');

      const onM2 = await call('MACHINE_EXEC_COMMAND', 'm2', { apiKeyScope });
      expect(onM2.res.status).toBe(404);
      expect(onM2.handler).not.toHaveBeenCalled();
      expect(deny()?.denyReason).toBe('machine_out_of_scope');
    });
  });

  it('a scoped admin set to view is refused MACHINE_REMOTE_CONTROL on m1 by the capability step', async () => {
    setMember('admin', { swoop: 'view', machineIds: ['m1'] });
    const { res, handler } = await call('MACHINE_REMOTE_CONTROL', 'm1');

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('capability_missing');
    expect(handler).not.toHaveBeenCalled();
    expect(deny()?.denyReason).toBe('capability_missing');
  });

  it('a superadmin with no row runs on m2', async () => {
    userDoc = { exists: true, data: () => ({ role: 'superadmin', sites: [] }) };
    memberDoc = { exists: false, data: () => undefined };
    const { res, handler } = await call('MACHINE_EXEC_COMMAND', 'm2');

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a whole-site admin is unchanged: MACHINE_REMOVE on m2 and SITE_MEMBER_MANAGE with no machineId run', async () => {
    setMember('admin');
    const onMachine = await call('MACHINE_REMOVE', 'm2');
    const siteWide = await call('SITE_MEMBER_MANAGE', null);

    expect(onMachine.res.status).toBe(200);
    expect(siteWide.res.status).toBe(200);
    expect(onMachine.handler.mock.calls[0][1].actor.machineScopes).toEqual({ ['site-a']: null });
  });
});

describe('authorizedSiteHandler — machine scope leaves the kill switch intact', () => {
  it('capability kill switch off: a whole-site member still reaches a non-exempt route on a machine', async () => {
    configResult = { ...configResult, capability_enforcement: false };
    userDoc = { exists: true, data: () => ({ role: 'member', sites: [] }) };
    setMember('member');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest('http://localhost/api/sites/site-a/machines/m2/test'), machineParamsFor('m2'));

    expect(res.status).toBe(200);
    const allow = setCalls.find((c) => c.payload.outcome === 'allow');
    expect((allow!.payload.metadata as Record<string, unknown>).enforcement_bypassed).toBe('capability');
  });
});

describe('authorizedSiteHandler — denials', () => {
  // Since Wave 1 Task 1.2 the wrapper resolves access through
  // lib/sitePolicy.server.ts, so these drive the underlying user/site documents
  // instead of stubbing assertUserHasSiteAccess. That is the honest seam: the
  // old stub returned `siteData: {}`, which silently disabled the site-owner
  // short-circuit tested below, letting these cases assert denials that
  // production would NOT produce for a caller who owns the site.
  it('returns 404 when site access fails (collapsed from 403/404)', async () => {
    userDoc = { exists: true, data: () => ({ role: 'member', sites: [] }) };
    siteDoc = { exists: true, data: () => ({ owner: 'uid_bob' }) };
    // No membership row: this is what "no access" looks like now.
    memberDoc = { exists: false, data: () => undefined };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 404, not 403, when the SITE itself is missing (no existence leak)', async () => {
    siteDoc = { exists: false, data: () => undefined };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 403 with code user_inactive when the caller is soft-deleted', async () => {
    userDoc = {
      exists: true,
      data: () => ({ role: 'admin', sites: ['site-a'], deletedAt: 1700000000000 }),
    };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    // 403 rather than the collapsed 404 is THIS wrapper's distinguishing
    // behaviour; `_shared` answers 404 for the same state. Pinned as
    // DIVERGENCE 1 in __tests__/lib/authorizationParity.test.ts.
    expect(res.status).toBe(403);
    // The STATUS carries the distinction, not the body: authErrorToResponse
    // maps this through problemForbidden(), so the internal `user_inactive`
    // code is deliberately not disclosed to the caller.
    expect((await res.json()).code).toBe('forbidden');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 403 when the actor user doc is soft-deleted', async () => {
    userDoc = {
      exists: true,
      data: () => ({
        role: 'admin',
        sites: ['site-a'],
        deletedAt: 1700000000000,
      }),
    };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 403 + deny audit when the capability is missing', async () => {
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    siteDoc = { exists: true, data: () => ({ owner: 'uid_bob' }) };
    // Standing at `member`, so the caller HAS access to the site but not this
    // capability — which is what separates a 403 here from the 404 above. The
    // default fixture grants `admin`, and leaving it would assert nothing.
    setMember('member');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('capability_missing');
  });

  it('returns 429 + deny audit when rate limited', async () => {
    rateLimitResult = {
      ok: false,
      reason: 'rate_limited',
      retryAfterSec: 12,
      limit: 60,
      remaining: 0,
      resetAtMs: Date.now() + 60_000,
      rateLimitReason: 'key-rate',
    };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
    expect(res.headers.get('RateLimit-Limit')).toBe('60');
    expect(res.headers.get('RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('Roost-Rate-Limited-Reason')).toBe('key-rate');
    expect(body).toMatchObject({
      code: 'rate_limited',
      retryAfter: 12,
    });
    expect(handler).not.toHaveBeenCalled();
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('rate_limited');
  });

  it('returns 401 when auth resolution throws unauthorized', async () => {
    resolveAuthThrows = { status: 401, message: 'no session' };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 when siteId is missing from path', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe('authorizedSiteHandler — ownership is a per-site role', () => {
  // Self-serve owners are global role `member` (bootstrapUser) and `/api/sites`
  // POST has no capability gate, so a matrix keyed on the GLOBAL role locked the
  // creator of a site out of every route on it — including DELETE, which is how
  // this surfaced ("capability not granted" on delete site, Davor, 2026-09-04).
  //
  // The fix used to be an ownership short-circuit that read `sites/{id}.owner`
  // and bypassed the matrix. `owner` is a row IN the matrix now, so the grant
  // comes from the matrix itself and the bypass is gone.
  it('grants a site-scoped capability to a global member who OWNS the site', async () => {
    userDoc = { exists: true, data: () => ({ role: 'member', sites: [] }) };
    siteDoc = { exists: true, data: () => ({ owner: 'uid_alice' }) };
    setMember('owner');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'SITE_MEMBER_MANAGE', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
  });

  it('grants SITE_DELETE to the owner and refuses it to a site admin', async () => {
    // The one capability that separates the two rows.
    userDoc = { exists: true, data: () => ({ role: 'member', sites: [] }) };
    siteDoc = { exists: true, data: () => ({ owner: 'uid_alice' }) };

    setMember('owner');
    const ownerHandler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const asOwner = authorizedSiteHandler({ capability: 'SITE_DELETE', siteIdParam: 'path' })(ownerHandler);
    expect((await asOwner(makeRequest(), pathParamsFor('site-a'))).status).toBe(200);

    setMember('admin');
    const adminHandler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const asAdmin = authorizedSiteHandler({ capability: 'SITE_DELETE', siteIdParam: 'path' })(adminHandler);
    expect((await asAdmin(makeRequest(), pathParamsFor('site-a'))).status).toBe(403);
    expect(adminHandler).not.toHaveBeenCalled();
  });

  // Negative control: identical user, membership only at `member`. Without it a
  // blanket allow would pass the tests above just as well.
  it('denies a plain member the same capability', async () => {
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    siteDoc = { exists: true, data: () => ({ owner: 'uid_bob' }) };
    setMember('member');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'SITE_MEMBER_MANAGE', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('the legacy owner field alone grants nothing', async () => {
    // `sites/{siteId}.owner` is no longer read on the auth path. A site pointing
    // at this user with no member row is a repair job, not a grant.
    userDoc = { exists: true, data: () => ({ role: 'member', sites: [] }) };
    siteDoc = { exists: true, data: () => ({ owner: 'uid_alice' }) };
    memberDoc = { exists: false, data: () => undefined };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'SITE_MEMBER_MANAGE', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  // A per-site role covers the site and nothing wider. A platform capability
  // must stay unreachable, or owning a site would confer global admin.
  it('does not let ownership grant a capability that is not site-scoped', async () => {
    userDoc = { exists: true, data: () => ({ role: 'member', sites: ['site-a'] }) };
    siteDoc = { exists: true, data: () => ({ owner: 'uid_alice' }) };
    setMember('owner');
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'GLOBAL_SETTINGS_WRITE', siteIdParam: 'path' })(handler);
    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('authorizedSiteHandler — handler error path', () => {
  it('writes an error audit and re-throws', async () => {
    const handler = makeSiteHandler(async () => {
      throw new Error('boom');
    });
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_EXEC_COMMAND', siteIdParam: 'path' })(handler);

    await expect(wrapped(makeRequest(), pathParamsFor('site-a'))).rejects.toThrow('boom');
    // wait for fire-and-forget error audit to land
    await new Promise((r) => setImmediate(r));
    const errorEntry = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'error');
    expect(errorEntry).toBeDefined();
  });
});

describe('authorizedSiteHandler — plan lockout (plan.md decision 7)', () => {
  const ENV_KEYS = ['PLAN_ENFORCEMENT', 'TRIDANT_API_URL', 'TRIDANT_LICENSE_KEY'] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  const FREE = {
    ok: true,
    resolved: false,
    standing: 'expired',
    inGoodStanding: false,
    ent: {
      'owlette.control': '0',
      'owlette.deployments': '0',
      'owlette.swoop': '0',
      'owlette.talons': '0',
      'owlette.api_keys': '0',
    },
    epoch: 0,
  };
  const CORE = { ...FREE, resolved: true, standing: 'active', ent: { ...FREE.ent, 'owlette.control': '1' } };

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.PLAN_ENFORCEMENT = 'on';
    process.env.TRIDANT_API_URL = 'https://tridant.test';
    process.env.TRIDANT_LICENSE_KEY = 'test-key';
    mockGetEntitlements.mockResolvedValue(FREE);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function rows(outcome: string) {
    return setCalls.filter((c) => (c.payload as { outcome?: string }).outcome === outcome);
  }

  it('maps the capabilities to their tridant keys', () => {
    expect(Object.fromEntries(PLAN_GATED_CAPABILITIES)).toEqual({
      DEPLOYMENT_MANAGE: 'owlette.deployments',
      ALERT_RULES_MANAGE: 'owlette.control',
      MACHINE_REMOTE_CONTROL: 'owlette.swoop',
      MACHINE_REMOTE_VIEW: 'owlette.swoop',
      TALON_MANAGE: 'owlette.talons',
    });
  });

  it('free: refuses a deployment POST with 402 plan_required and a plan_locked deny row', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'DEPLOYMENT_MANAGE', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(402);
    expect(res.headers.get('Content-Type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({
      code: 'plan_required',
      entitlement: 'owlette.deployments',
      upgradeUrl: '/settings/plan',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(mockGetEntitlements).toHaveBeenCalledWith('uid_alice');
    const deny = rows('deny');
    expect(deny).toHaveLength(1);
    expect(deny[0].payload.denyReason).toBe('plan_locked');
    expect(deny[0].payload.metadata).toMatchObject({ method: 'POST', entitlement: 'owlette.deployments' });
    expect(rows('allow')).toHaveLength(0);
    // the payer comes from the site doc site access already read.
    expect(siteDocReads).toBe(1);
  });

  it('free: refuses a talon PATCH on owlette.talons', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'TALON_MANAGE', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(undefined, 'PATCH'), pathParamsFor('site-a'));

    expect(res.status).toBe(402);
    expect((await res.json()).entitlement).toBe('owlette.talons');
    expect(handler).not.toHaveBeenCalled();
  });

  it('free: a DELETE and a GET under a gated capability go through without a plan lookup', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'DEPLOYMENT_MANAGE', siteIdParam: 'path' })(handler);

    expect((await wrapped(makeRequest(undefined, 'DELETE'), pathParamsFor('site-a'))).status).toBe(200);
    expect((await wrapped(makeRequest(undefined, 'GET'), pathParamsFor('site-a'))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('free: a write under an ungated capability goes through', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'MACHINE_CONFIG_WRITE', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(200);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('free: a planExempt route goes through', async () => {
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({
      capability: 'MACHINE_REMOTE_CONTROL',
      siteIdParam: 'path',
      planExempt: true,
    })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(200);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('the capability kill switch does not bypass it', async () => {
    configResult = { ...configResult, capability_enforcement: false, rate_limit_enforcement: false };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'DEPLOYMENT_MANAGE', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
    expect(rows('deny')[0].payload.denyReason).toBe('plan_locked');
  });

  it('runs after rate limiting: a rate-limited caller gets 429 without a plan lookup', async () => {
    rateLimitResult = { ok: false, reason: 'rate_limited', retryAfterSec: 30 };
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'DEPLOYMENT_MANAGE', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(429);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('core: an alert rules write goes through on owlette.control', async () => {
    mockGetEntitlements.mockResolvedValue(CORE);
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'ALERT_RULES_MANAGE', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(undefined, 'PUT'), pathParamsFor('site-a'));

    expect(res.status).toBe(200);
    expect(rows('allow')).toHaveLength(1);
  });

  it.each([
    ['DEPLOYMENT_MANAGE', 'owlette.deployments'],
    ['MACHINE_REMOTE_CONTROL', 'owlette.swoop'],
    ['MACHINE_REMOTE_VIEW', 'owlette.swoop'],
  ] as const)('core: refuses a %s write on the pro key %s', async (capability, entitlement) => {
    mockGetEntitlements.mockResolvedValue(CORE);
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability, siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ entitlement, detail: PLAN_REQUIRED_DETAIL[entitlement] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('pro: a deployment and a swoop write go through', async () => {
    mockGetEntitlements.mockResolvedValue({
      ...CORE,
      ent: { ...CORE.ent, 'owlette.deployments': '1', 'owlette.swoop': '1' },
    });
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    for (const capability of ['DEPLOYMENT_MANAGE', 'MACHINE_REMOTE_CONTROL'] as const) {
      const wrapped = authorizedSiteHandler({ capability, siteIdParam: 'path' })(handler);
      expect((await wrapped(makeRequest(), pathParamsFor('site-a'))).status).toBe(200);
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('enforcement off: a gated write goes through without any plan lookup', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedSiteHandler({ capability: 'DEPLOYMENT_MANAGE', siteIdParam: 'path' })(handler);

    const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

    expect(res.status).toBe(200);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(siteDocReads).toBe(1);
  });

  describe('api keys need owlette.api_keys on every request (plan.md decision 8)', () => {
    beforeEach(() => {
      resolveAuthResult = { userId: 'uid_alice', keyContext: { keyId: 'key-a' } };
    });

    it('free: refuses a key, reads included, with a plan_locked deny row', async () => {
      const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
      const wrapped = authorizedSiteHandler({ capability: 'MACHINE_VIEW', siteIdParam: 'path', apiKeyPermission: 'read' })(handler);

      const res = await wrapped(makeRequest(undefined, 'GET'), pathParamsFor('site-a'));

      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        code: 'plan_required',
        entitlement: 'owlette.api_keys',
        detail: PLAN_REQUIRED_DETAIL['owlette.api_keys'],
      });
      expect(handler).not.toHaveBeenCalled();
      const deny = rows('deny');
      expect(deny).toHaveLength(1);
      expect(deny[0].payload.denyReason).toBe('plan_locked');
      expect(deny[0].payload.metadata).toMatchObject({ method: 'GET', entitlement: 'owlette.api_keys' });
      expect(rows('allow')).toHaveLength(0);
      expect(siteDocReads).toBe(1);
    });

    it('free: a planExempt route still refuses a key', async () => {
      const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
      const wrapped = authorizedSiteHandler({
        capability: 'MACHINE_REMOTE_CONTROL',
        siteIdParam: 'path',
        planExempt: true,
      })(handler);

      const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

      expect(res.status).toBe(402);
      expect((await res.json()).entitlement).toBe('owlette.api_keys');
    });

    it('free: a session on the same read goes through without a plan lookup', async () => {
      resolveAuthResult = { userId: 'uid_alice', keyContext: null };
      const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
      const wrapped = authorizedSiteHandler({ capability: 'MACHINE_VIEW', siteIdParam: 'path', apiKeyPermission: 'read' })(handler);

      const res = await wrapped(makeRequest(undefined, 'GET'), pathParamsFor('site-a'));

      expect(res.status).toBe(200);
      expect(mockGetEntitlements).not.toHaveBeenCalled();
    });

    it('pro: a key goes through, a gated write included, on one plan lookup', async () => {
      mockGetEntitlements.mockResolvedValue({
        ...FREE,
        resolved: true,
        standing: 'active',
        ent: { 'owlette.deployments': '1', 'owlette.api_keys': '1' },
      });
      const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
      const wrapped = authorizedSiteHandler({ capability: 'DEPLOYMENT_MANAGE', siteIdParam: 'path' })(handler);

      const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

      expect(res.status).toBe(200);
      expect(mockGetEntitlements).toHaveBeenCalledTimes(1);
    });

    it('a key on a plan with api keys but not deployments is refused the gated write on owlette.deployments', async () => {
      mockGetEntitlements.mockResolvedValue({ ...FREE, ent: { ...FREE.ent, 'owlette.api_keys': '1' } });
      const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
      const wrapped = authorizedSiteHandler({ capability: 'DEPLOYMENT_MANAGE', siteIdParam: 'path' })(handler);

      const res = await wrapped(makeRequest(), pathParamsFor('site-a'));

      expect(res.status).toBe(402);
      expect((await res.json()).entitlement).toBe('owlette.deployments');
    });

    it('enforcement off: a key goes through without any plan lookup', async () => {
      delete process.env.PLAN_ENFORCEMENT;
      const handler = makeSiteHandler(async () => NextResponse.json({ ok: true }));
      const wrapped = authorizedSiteHandler({ capability: 'MACHINE_VIEW', siteIdParam: 'path', apiKeyPermission: 'read' })(handler);

      const res = await wrapped(makeRequest(undefined, 'GET'), pathParamsFor('site-a'));

      expect(res.status).toBe(200);
      expect(mockGetEntitlements).not.toHaveBeenCalled();
      expect(siteDocReads).toBe(1);
    });
  });
});

// authorizedPlatformHandler

describe('authorizedPlatformHandler', () => {
  beforeEach(() => {
    userDoc = { exists: true, data: () => ({ role: 'superadmin', sites: [] }) };
  });

  it('superadmin succeeds and audits to global path', async () => {
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler({ capability: 'GLOBAL_SETTINGS_WRITE' })(handler);

    const res = await wrapped(makeRequest('http://localhost/api/platform/security/kill-switch', 'POST'));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect(allow).toBeDefined();
    expect(allow!.path.startsWith('global/audit_log/entries/')).toBe(true);
  });

  it('non-superadmin rejected with 403 + deny audit', async () => {
    userDoc = { exists: true, data: () => ({ role: 'admin', sites: [] }) };
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler({ capability: 'GLOBAL_SETTINGS_WRITE' })(handler);

    const res = await wrapped(makeRequest('http://localhost/api/platform/security/kill-switch', 'POST'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    // deny audit landed asynchronously
    await new Promise((r) => setImmediate(r));
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect(deny).toBeDefined();
    expect((deny!.payload as { denyReason?: string }).denyReason).toBe('role_insufficient');
  });

  it('soft-deleted superadmin is rejected with 403 before handler invocation', async () => {
    userDoc = {
      exists: true,
      data: () => ({ role: 'superadmin', sites: [], deletedAt: 1700000000000 }),
    };
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler({ capability: 'GLOBAL_SETTINGS_WRITE' })(handler);

    const res = await wrapped(makeRequest('http://localhost/api/platform/security/kill-switch', 'POST'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 503 when allow audit write fails', async () => {
    setShouldReject = new Error('audit firestore down');
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler({ capability: 'GLOBAL_SETTINGS_WRITE' })(handler);
    const res = await wrapped(makeRequest('http://localhost/api/platform/security/kill-switch', 'POST'));
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it('records the platform sentinel as audit target when no targetIdParam is set', async () => {
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler({ capability: 'GLOBAL_SETTINGS_WRITE' })(handler);

    await wrapped(makeRequest('http://localhost/api/platform/security/kill-switch', 'POST'));
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect((allow!.payload as { target?: { id?: string } }).target?.id).toBe('__platform__');
  });

  it('records the route param as audit target when targetIdParam is set', async () => {
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler<{ uid: string }>({
      capability: 'USER_DELETE',
      targetKind: 'user',
      targetIdParam: 'uid',
    })(handler as Parameters<ReturnType<typeof authorizedPlatformHandler<{ uid: string }>>>[0]);

    const res = await wrapped(makeRequest('http://localhost/api/users/uid_bob', 'DELETE'), {
      params: Promise.resolve({ uid: 'uid_bob' }),
    });
    expect(res.status).toBe(200);
    const allow = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'allow');
    expect((allow!.payload as { target?: { kind?: string; id?: string } }).target).toEqual({
      kind: 'user',
      id: 'uid_bob',
    });
  });

  it('names the target on deny audits too, so blocked deletes are attributable', async () => {
    userDoc = { exists: true, data: () => ({ role: 'admin', sites: [] }) };
    const handler = makePlatformHandler(async () => NextResponse.json({ ok: true }));
    const wrapped = authorizedPlatformHandler<{ uid: string }>({
      capability: 'USER_DELETE',
      targetKind: 'user',
      targetIdParam: 'uid',
    })(handler as Parameters<ReturnType<typeof authorizedPlatformHandler<{ uid: string }>>>[0]);

    const res = await wrapped(makeRequest('http://localhost/api/users/uid_bob', 'DELETE'), {
      params: Promise.resolve({ uid: 'uid_bob' }),
    });
    expect(res.status).toBe(403);
    await new Promise((r) => setImmediate(r));
    const deny = setCalls.find((c) => (c.payload as { outcome?: string }).outcome === 'deny');
    expect((deny!.payload as { target?: { id?: string } }).target?.id).toBe('uid_bob');
  });
});

// typescript: siteIdParam: 'body' must be a build error

describe('typescript: siteIdParam type-system rejection', () => {
  it('only "path" and "query" are valid SiteIdSource values', () => {
    const valid: SiteIdSource[] = ['path', 'query'];
    expect(valid).toEqual(['path', 'query']);

    // Intentionally a type error — ts-expect-error fails if the line is NOT an
    // error (i.e. if someone widens the type to `string`).
    // @ts-expect-error -- 'body' is not assignable to SiteIdSource
    const invalid: SiteIdSource = 'body';
    expect(invalid).toBe('body'); // runtime is unchanged; compile-time is the gate
  });
});
