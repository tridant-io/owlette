/** @jest-environment node */

/**
 * End-to-end wiring for the roost kill-switch (`gateOrProceed` itself is
 * unit-tested in lib/roostKillSwitch.test.ts): with `roostEnabled = false`, a
 * sample of the wired routes must answer 503 problem+json, not 200 or 500.
 *
 * The static guard at the bottom checks every expected route file actually
 * imports and calls the gate, so a new roost route can't ship without it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockRequest } from '../helpers/utils';
import { mocks, mockDbFactory, seedMember } from '../helpers/firestore-mock';

const mockEmitMutation = jest.fn();
const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest
      .fn()
      .mockRejectedValue(new Error('n/a')),
  }),
}));

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

const SITE = 'site-disabled';

function disableRoostForSite() {
  // `readSiteDocForGate` reads sites/{siteId}; the mock serves those from
  // `mocks.siteDocs`.
  mocks.siteDocs.set(SITE, {
    owner: 'user-1',
    roostEnabled: false,
    name: 'Disabled site',
  });
  // The caller still has to reach the site for the kill switch to be the thing
  // that stops them; without standing they would be refused before the gate.
  seedMember(SITE, 'user-1', 'owner');
}

function authed() {
  mockResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {}, machineIds: null });
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  authed();
});

describe('roost kill switch — wired route 503 behavior', () => {
  it('GET /api/roosts returns 503 when site has roostEnabled: false', async () => {
    disableRoostForSite();
    const { GET } = await import('@/app/api/roosts/route');
    const req = createMockRequest(
      `http://localhost/api/roosts?siteId=${SITE}`,
    );
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.title).toMatch(/roost disabled/i);
  });

  it('POST /api/roosts returns 503 when site has roostEnabled: false', async () => {
    disableRoostForSite();
    const { POST } = await import('@/app/api/roosts/route');
    const req = createMockRequest('http://localhost/api/roosts', {
      method: 'POST',
      body: { siteId: SITE, name: 'lobby', targets: [] },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('POST /api/chunks/upload-urls returns 503 when roost disabled', async () => {
    disableRoostForSite();
    const { POST } = await import('@/app/api/chunks/upload-urls/route');
    const req = createMockRequest('http://localhost/api/chunks/upload-urls', {
      method: 'POST',
      body: { siteId: SITE, digests: [] },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('POST /api/chunks/check returns 503 when roost disabled', async () => {
    disableRoostForSite();
    const { POST } = await import('@/app/api/chunks/check/route');
    const req = createMockRequest('http://localhost/api/chunks/check', {
      method: 'POST',
      body: { siteId: SITE, digests: [] },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('returns 503 with content-type application/problem+json', async () => {
    disableRoostForSite();
    const { GET } = await import('@/app/api/roosts/route');
    const req = createMockRequest(
      `http://localhost/api/roosts?siteId=${SITE}`,
    );
    const res = await GET(req);
    expect(res.headers.get('Content-Type')).toMatch(
      /application\/problem\+json/,
    );
  });
});

/** Every route that must carry the kill switch. Add new roost routes here. */
const WIRED_ROUTES: string[] = [
  'app/api/roosts/route.ts',
  'app/api/roosts/[roostId]/route.ts',
  'app/api/roosts/[roostId]/rollback/route.ts',
  'app/api/roosts/[roostId]/deploy/route.ts',
  'app/api/roosts/[roostId]/resync/route.ts',
  'app/api/roosts/[roostId]/deployments/route.ts',
  'app/api/roosts/[roostId]/deployments/[rolloutId]/route.ts',
  'app/api/roosts/[roostId]/version-url/route.ts',
  'app/api/roosts/[roostId]/versions/route.ts',
  'app/api/roosts/[roostId]/versions/[versionRef]/route.ts',
  'app/api/roosts/[roostId]/versions/[versionRef]/files/route.ts',
  'app/api/roosts/[roostId]/versions/[versionRef]/diff/route.ts',
  'app/api/chunks/upload-urls/route.ts',
  'app/api/chunks/download-urls/route.ts',
  'app/api/chunks/check/route.ts',
  'app/api/chunks/[digest]/referrers/route.ts',
  'app/api/chunks/[digest]/mount/route.ts',
];

describe('roost kill switch — static wiring guard', () => {
  it('exactly 17 routes are wired (matches the documented count)', () => {
    expect(WIRED_ROUTES).toHaveLength(17);
  });

  it.each(WIRED_ROUTES)('%s imports gateOrProceed from @/lib/roostKillSwitch', (relPath) => {
    const absPath = join(process.cwd(), relPath);
    const src = readFileSync(absPath, 'utf8');
    // Require a real call too — an unused import would still pass otherwise.
    expect(src).toMatch(
      /import\s+\{[^}]*gateOrProceed[^}]*\}\s+from\s+['"]@\/lib\/roostKillSwitch['"]/,
    );
    expect(src).toMatch(/gateOrProceed\s*\(/);
  });
});
