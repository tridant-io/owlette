/**
 * @jest-environment node
 *
 * a superadmin reaches every site without a member row. there they read, see no
 * screen, and change only an allowlisted few things (adr 0021). this calls every
 * write verb of every route under `app/api/sites/[siteId]/`, found by walking the
 * tree and reading each module's exports, plus the two site changes that sit
 * outside it (pairing a machine, hoot's key provisioning), as such a superadmin,
 * and expects 403 members_only from each but the allowlist. a new route fails
 * closed at the shared gates, or fails here.
 *
 * the auth layer is real: only the session (`resolveAuth`, `requireSession`) and
 * firestore are faked, so the decision comes from the gates themselves.
 */
import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  withScope: jest.fn(),
}));

/** one site, one superadmin, and a member row only when a test writes one. */
const mockDocs: Record<string, Record<string, unknown>> = {};

function mockFakeDb() {
  const snap = (p: string) => ({
    exists: Object.prototype.hasOwnProperty.call(mockDocs, p),
    id: p.split('/').pop(),
    ref: docRef(p),
    data: () => mockDocs[p],
    get: (field: string) => mockDocs[p]?.[field],
  });
  const emptyQuery = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const op of ['where', 'orderBy', 'limit', 'select', 'startAfter', 'offset']) q[op] = () => q;
    q.get = async () => ({ empty: true, size: 0, docs: [], forEach: () => undefined });
    q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) });
    return q;
  };
  function docRef(p: string): Record<string, unknown> {
    return {
      id: p.split('/').pop(),
      path: p,
      get: async () => snap(p),
      set: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
      create: async () => undefined,
      collection: (c: string) => collRef(`${p}/${c}`),
    };
  }
  function collRef(p: string): Record<string, unknown> {
    return { ...emptyQuery(), path: p, doc: (id = 'auto-id') => docRef(`${p}/${id}`) };
  }
  const writes = { set: () => writes, update: () => writes, delete: () => writes, create: () => writes };
  return {
    collection: (c: string) => collRef(c),
    collectionGroup: () => emptyQuery(),
    doc: (p: string) => docRef(p),
    getAll: async (...refs: Array<{ path: string }>) => refs.map((r) => snap(r.path)),
    batch: () => ({ ...writes, commit: async () => undefined }),
    bulkWriter: () => ({ ...writes, close: async () => undefined }),
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({ ...writes, get: async (r: { path: string }) => snap(r.path), getAll: async (...refs: Array<{ path: string }>) => refs.map((r) => snap(r.path)) }),
  };
}

jest.mock('@/lib/firebase-admin', () => {
  const db = mockFakeDb();
  return {
    getAdminDb: jest.fn(() => db),
    getAdminAuth: jest.fn(() => ({
      verifyIdToken: jest.fn().mockRejectedValue(new Error('not an id token')),
      getUser: jest.fn().mockRejectedValue(new Error('no user')),
      getUserByEmail: jest.fn().mockRejectedValue(new Error('no user')),
    })),
    getAdminStorage: jest.fn(() => {
      throw new Error('no storage in this test');
    }),
  };
});

jest.mock('@/lib/securityConfig.server', () => ({
  ...jest.requireActual('@/lib/securityConfig.server'),
  securityConfig: {
    read: jest.fn(async () => ({ capability_enforcement: true, rate_limit_enforcement: false, lastReadAt: 0 })),
  },
}));

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: jest.fn(async () => ({ userId: 'super-uid', keyContext: null })),
    requireSession: jest.fn(async () => 'super-uid'),
    requireSessionOrIdToken: jest.fn(async () => 'super-uid'),
  };
});

// the per-ip limiters fail closed with no redis; the gates under test sit behind them
jest.mock('@/lib/withRateLimit', () => ({
  ...jest.requireActual('@/lib/withRateLimit'),
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/idempotency', () => ({
  ...jest.requireActual('@/lib/idempotency'),
  withIdempotency: jest.fn((_req: unknown, _ctx: unknown, _raw: unknown, fn: () => unknown) => fn()),
}));

const WEB_ROOT = path.resolve(__dirname, '..', '..');
const SITE_ROOT = path.join(WEB_ROOT, 'app', 'api', 'sites', '[siteId]');
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * what a superadmin without a member row may change on a site, as `<METHOD> <route>`
 * under `app/api/sites/[siteId]/`. every other write there answers 403 members_only.
 * the commands route and the process verbs queue only executeMachineCommand's
 * non-member types (pinned below). adding themselves to a site goes through the
 * platform's assign-sites, outside this tree.
 */
const ALLOWLIST: readonly string[] = [
  'POST agent-tokens/revoke',
  'POST deployments/[deploymentId]/cancel',
  'POST machines/[machineId]/commands',
  'POST machines/[machineId]/processes/[processId]/kill',
  'POST machines/[machineId]/processes/[processId]/restart',
  'POST machines/[machineId]/processes/[processId]/start',
  'POST machines/[machineId]/processes/[processId]/stop',
  'DELETE machines/[machineId]/reboot-pending',
  'POST machines/[machineId]/swoop/kill',
  'POST machines/[machineId]/swoop/sessions/[sessionId]/kick',
];

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `__`-prefixed dirs are transient fixtures other suites write mid-run
    if (entry.name.startsWith('__')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRouteFiles(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

type RouteHandler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<NextResponse>;

interface WriteRoute {
  key: string;
  route: string;
  method: (typeof WRITE_METHODS)[number];
  handler: RouteHandler;
}

const SITE_ID = 'site-a';

function paramsFor(route: string): Record<string, string> {
  const params: Record<string, string> = { siteId: SITE_ID };
  for (const match of route.matchAll(/\[([A-Za-z]+)\]/g)) params[match[1]] = `${match[1].toLowerCase()}-0001`;
  return params;
}

function urlFor(route: string, params: Record<string, string>): string {
  const filled = route.replace(/\[([A-Za-z]+)\]/g, (_, name: string) => params[name]);
  return `http://localhost/api/sites/${SITE_ID}${filled ? `/${filled}` : ''}`;
}

function writeRoutes(): WriteRoute[] {
  const out: WriteRoute[] = [];
  for (const file of walkRouteFiles(SITE_ROOT).sort()) {
    const route = path.relative(SITE_ROOT, path.dirname(file)).split(path.sep).join('/');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const method of WRITE_METHODS) {
      if (typeof mod[method] !== 'function') continue;
      out.push({ key: `${method} ${route || '.'}`, route, method, handler: mod[method] as RouteHandler });
    }
  }
  return out;
}

async function call(route: WriteRoute, body: unknown = {}): Promise<{ status: number; code: unknown }> {
  const params = paramsFor(route.route);
  const req = new NextRequest(urlFor(route.route, params), {
    method: route.method,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-0001' },
    body: JSON.stringify(body),
  });
  const res = await route.handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  let parsed: { code?: unknown } = {};
  try {
    parsed = JSON.parse(text) as { code?: unknown };
  } catch {
    // a non-json answer has no code, which is what the allowlist asserts
  }
  return { status: res.status, code: parsed.code };
}

function seedSite(memberRole: 'admin' | null): void {
  for (const key of Object.keys(mockDocs)) delete mockDocs[key];
  mockDocs[`sites/${SITE_ID}`] = { name: 'site a', owner: 'owner-uid' };
  mockDocs['users/super-uid'] = { role: 'superadmin', email: 'super@example.test', sites: [] };
  if (memberRole) mockDocs[`sites/${SITE_ID}/members/super-uid`] = { role: memberRole, status: 'active' };
}

const routes = writeRoutes();
const byKey = new Map(routes.map((r) => [r.key, r]));

beforeEach(() => seedSite(null));

describe('a superadmin without a member row changes a site only through the allowlist', () => {
  it('finds the routes it guards', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('names only routes that exist', () => {
    for (const key of ALLOWLIST) expect(byKey.has(key)).toBe(true);
  });

  it.each(routes.filter((r) => !ALLOWLIST.includes(r.key)).map((r) => [r.key, r] as const))(
    'refuses %s with 403 members_only',
    async (_key, route) => {
      await expect(call(route)).resolves.toEqual({ status: 403, code: 'members_only' });
    },
  );

  it.each(ALLOWLIST.map((key) => [key] as const))('admits %s past the member gate', async (key) => {
    const body = key.endsWith('/commands') ? { type: 'reboot_machine' } : {};
    const { code } = await call(byKey.get(key)!, body);
    expect(code).not.toBe('members_only');
  });
});

describe('the commands route queues only the non-member command types', () => {
  const commands = () => byKey.get('POST machines/[machineId]/commands')!;

  it.each([
    [{ type: 'shutdown_machine' }],
    [{ type: 'set_launch_mode', params: { process_name: 'touchdesigner', mode: 'off' } }],
    [{ type: 'capture_screenshot' }],
    [{ type: 'mcp_tool_call', params: { tool_name: 'capture_screenshot', tool_params: {} } }],
    [{ type: 'mcp_tool_call', params: { tool_name: 'clean_disk_space', tool_params: {} } }],
    [{ type: 'mcp_tool_call', params: { tool_name: 'run_powershell', tool_params: { script: 'whoami' } } }],
  ])('refuses %j', async (body) => {
    await expect(call(commands(), body)).resolves.toEqual({ status: 403, code: 'members_only' });
  });

  it.each([
    [{ type: 'reboot_machine' }],
    [{ type: 'cancel_reboot' }],
    [{ type: 'kill_process', params: { process_name: 'touchdesigner' } }],
    [{ type: 'start_process', params: { process_name: 'touchdesigner' } }],
    [{ type: 'stop_process', params: { process_name: 'touchdesigner' } }],
    [{ type: 'mcp_tool_call', params: { tool_name: 'get_system_info', tool_params: {} } }],
  ])('admits %j', async (body) => {
    const { code } = await call(commands(), body);
    expect(code).not.toBe('members_only');
  });
});

describe('the site changes outside the site tree refuse them too', () => {
  it('pairing a machine onto the site', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { POST } = require('@/app/api/agent/auth/device-code/authorize/route') as { POST: RouteHandler };
    const req = new NextRequest('http://localhost/api/agent/auth/device-code/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairPhrase: 'able-about-above', siteId: SITE_ID }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'members_only' });
  });

  it("provisioning hoot's key to a machine", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { POST } = require('@/app/api/hoot/provision-key/route') as { POST: RouteHandler };
    const req = new NextRequest('http://localhost/api/hoot/provision-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: SITE_ID, machineId: 'machineid-0001', apiKey: 'sk-test' }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'members_only' });
  });
});

describe('a superadmin with a member row is not refused as a non-member', () => {
  beforeEach(() => seedSite('admin'));

  it.each(['PATCH fleet-settings', 'POST talons/[talonId]/test', 'POST machines/[machineId]/processes'].map((k) => [k] as const))(
    '%s',
    async (key) => {
      const { code } = await call(byKey.get(key)!);
      expect(code).not.toBe('members_only');
    },
  );
});
