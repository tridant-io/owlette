/**
 * @jest-environment node
 *
 * Shared helpers in web/app/api/_shared.ts. The auth-mapping branches were once silently
 * broken by reading `err.statusCode` instead of ApiAuthError's `err.status`; this file catches
 * that class of regression.
 */
import { NextRequest } from 'next/server';

// Mock the auth helpers BEFORE importing the module under test so its imports bind to these.
jest.mock('@/lib/apiAuth.server', () => {
  // Must match the real module: `status`, not `statusCode`.
  class ApiAuthError extends Error {
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
    ApiAuthError,
    requireAdminOrIdToken: jest.fn(),
    assertUserHasSiteAccess: jest.fn(),
    requireApiKeyBilling: jest.fn(),
    resolveAuth: jest.fn(),
    // every caller here is a session, which the real requireScope passes too
    requireScope: jest.fn(() => ({ isLegacy: false })),
    auditApiKeyUse: jest.fn(),
  };
});

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// the documents `resolveSiteAccess` reads, by path, for the capability gates
const mockDocs: Record<string, Record<string, unknown>> = {};
const mockVerifyIdToken = jest.fn();
function mockRef(path: string) {
  return {
    get: async () => ({ exists: path in mockDocs, data: () => mockDocs[path] }),
    collection: (sub: string) => ({ doc: (id: string) => mockRef(`${path}/${sub}/${id}`) }),
  };
}
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  getAdminDb: () => ({
    collection: (name: string) => ({ doc: (id: string) => mockRef(`${name}/${id}`) }),
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map((r) => r.get())),
  }),
}));

import {
  ApiAuthError,
  requireAdminOrIdToken,
  assertUserHasSiteAccess,
  resolveAuth,
} from '@/lib/apiAuth.server';
import {
  parseJsonBody,
  validateHashList,
  validateResourceId,
  validateSiteIdBody,
  requireAuthOrProblem,
  requireSiteScope,
  requireSiteAuthAndScope,
  requireSiteMachineAuthAndScope,
  requireMachineAuthAndScope,
  requireRoostAuthAndScope,
  requireChatAuthAndScope,
  requireDistributionManageCapability,
  requireWebhookManageCapability,
  MAX_HASHES_PER_REQUEST,
} from '@/app/api/_shared';

const mockedRequireAuth = requireAdminOrIdToken as jest.MockedFunction<typeof requireAdminOrIdToken>;
const mockedAssertSite = assertUserHasSiteAccess as jest.MockedFunction<typeof assertUserHasSiteAccess>;
const mockedResolveAuth = resolveAuth as jest.MockedFunction<typeof resolveAuth>;

function makeRequest(opts: {
  url?: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
} = {}): NextRequest {
  return new NextRequest(new URL(opts.url ?? 'http://localhost/api/v2/test'), {
    headers: opts.headers,
    method: opts.method ?? 'GET',
    body: opts.body,
  });
}

describe('_shared.ts (v2 route helpers)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });


  describe('requireAuthOrProblem', () => {
    it('returns ok with userId when auth succeeds', async () => {
      mockedRequireAuth.mockResolvedValueOnce('user-abc');
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.userId).toBe('user-abc');
    });

    it('maps ApiAuthError(403) → 403 problemForbidden (NOT 401)', async () => {
      // Regression: err.statusCode (undefined) fell through to 401.
      mockedRequireAuth.mockRejectedValueOnce(new ApiAuthError(403, 'forbidden'));
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
      }
    });

    it('maps ApiAuthError(404) → 404 problemNotFound (NOT 401)', async () => {
      mockedRequireAuth.mockRejectedValueOnce(new ApiAuthError(404, 'site missing'));
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(404);
      }
    });

    it('maps ApiAuthError(401) → 401 problemUnauthorized', async () => {
      mockedRequireAuth.mockRejectedValueOnce(new ApiAuthError(401, 'no token'));
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
      }
    });

    it('does NOT echo err.message in the response (no info leak)', async () => {
      mockedRequireAuth.mockRejectedValueOnce(
        new ApiAuthError(403, 'SECRET internal detail with siteId site_xyz'),
      );
      const req = makeRequest();
      const result = await requireAuthOrProblem(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const body = await result.response.json();
        expect(body.detail ?? '').not.toContain('SECRET');
        expect(body.detail ?? '').not.toContain('site_xyz');
      }
    });

    it('rethrows non-ApiAuthError', async () => {
      mockedRequireAuth.mockRejectedValueOnce(new Error('unrelated'));
      const req = makeRequest();
      await expect(requireAuthOrProblem(req)).rejects.toThrow('unrelated');
    });
  });


  describe('requireSiteScope', () => {
    it('returns null when the user has access', async () => {
      mockedAssertSite.mockResolvedValueOnce({ siteId: 'site_abc', siteData: null, machineIds: null });
      const result = await requireSiteScope('user-1', 'site_abc');
      expect(result).toBeNull();
    });

    it('rejects malformed siteId with 400 (no firestore call)', async () => {
      const result = await requireSiteScope('user-1', '../../etc/passwd');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(400);
      expect(mockedAssertSite).not.toHaveBeenCalled();
    });

    it('collapses 404 (site not found) → 404 problemNotFound (anti-enumeration)', async () => {
      mockedAssertSite.mockRejectedValueOnce(new ApiAuthError(404, 'site not found'));
      const result = await requireSiteScope('user-1', 'site_abc');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(404);
    });

    it('collapses 403 (forbidden) → 404 problemNotFound (anti-enumeration)', async () => {
      // Regression: 403 fell through to problemForbidden(err.message), leaking the message
      // and breaking anti-enumeration.
      mockedAssertSite.mockRejectedValueOnce(new ApiAuthError(403, 'forbidden — siteId site_xyz'));
      const result = await requireSiteScope('user-1', 'site_abc');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(404);
      const body = await result!.json();
      expect(JSON.stringify(body)).not.toContain('site_xyz');
    });

    it('falls back to generic 403 for other ApiAuthError statuses', async () => {
      mockedAssertSite.mockRejectedValueOnce(new ApiAuthError(500, 'INTERNAL SECRET'));
      const result = await requireSiteScope('user-1', 'site_abc');
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
      const body = await result!.json();
      expect(JSON.stringify(body)).not.toContain('SECRET');
    });

    it('rethrows non-ApiAuthError', async () => {
      mockedAssertSite.mockRejectedValueOnce(new Error('unrelated'));
      await expect(requireSiteScope('user-1', 'site_abc')).rejects.toThrow('unrelated');
    });
  });



  describe('validateResourceId', () => {
    it('accepts valid 8-64 char ids', () => {
      expect(validateResourceId('abcd1234', 'roostId')).toBeNull();
      expect(validateResourceId('a-b_c-1234567890', 'roostId')).toBeNull();
    });
    it('rejects too-short', () => {
      const res = validateResourceId('short', 'roostId');
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });
    it('rejects too-long (>64)', () => {
      const res = validateResourceId('a'.repeat(65), 'roostId');
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });
    it('rejects characters outside [A-Za-z0-9_-]', () => {
      expect(validateResourceId('abc/def12345', 'f')).not.toBeNull();
      expect(validateResourceId('abc.def12345', 'f')).not.toBeNull();
      expect(validateResourceId('abc def12345', 'f')).not.toBeNull();
    });
  });


  describe('validateSiteIdBody', () => {
    it('accepts valid siteId strings', () => {
      const r = validateSiteIdBody('site_abc_123');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.siteId).toBe('site_abc_123');
    });
    it('rejects undefined', () => {
      const r = validateSiteIdBody(undefined);
      expect(r.ok).toBe(false);
    });
    it('rejects non-string', () => {
      const r = validateSiteIdBody(123);
      expect(r.ok).toBe(false);
    });
    it('rejects empty string', () => {
      const r = validateSiteIdBody('');
      expect(r.ok).toBe(false);
    });
    it('uses custom field name in error', async () => {
      const r = validateSiteIdBody(undefined, 'query.siteId');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const body = await r.response.json();
        expect(JSON.stringify(body.errors)).toContain('query.siteId');
      }
    });
  });


  describe('validateHashList', () => {
    const validHash = 'a'.repeat(64);

    it('accepts a valid array of sha-256 hex hashes', () => {
      const r = validateHashList([validHash, 'b'.repeat(64)], 'hashes');
      expect(r.ok).toBe(true);
    });

    it('rejects empty array', () => {
      const r = validateHashList([], 'hashes');
      expect(r.ok).toBe(false);
    });

    it('rejects non-array', () => {
      const r = validateHashList('not an array', 'hashes');
      expect(r.ok).toBe(false);
    });

    it('rejects entries that are not 64-char lowercase hex', () => {
      const r = validateHashList([validHash, 'UPPERCASE_HEX_64_BYTES_INVALID', validHash], 'hashes');
      expect(r.ok).toBe(false);
    });

    it('rejects > MAX_HASHES_PER_REQUEST entries', () => {
      const arr = Array(MAX_HASHES_PER_REQUEST + 1).fill(validHash);
      const r = validateHashList(arr, 'hashes');
      expect(r.ok).toBe(false);
    });

    it('accepts exactly MAX_HASHES_PER_REQUEST entries', () => {
      const arr = Array(MAX_HASHES_PER_REQUEST).fill(validHash);
      const r = validateHashList(arr, 'hashes');
      expect(r.ok).toBe(true);
    });
  });


  describe('parseJsonBody', () => {
    it('parses valid json body', async () => {
      const req = makeRequest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"x":1}',
      });
      const r = await parseJsonBody(req);
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.body as { x: number }).x).toBe(1);
    });

    it('returns 400 on invalid json', async () => {
      const req = makeRequest({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid',
      });
      const r = await parseJsonBody(req);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(400);
    });
  });


  describe('machine scope', () => {
    const SITE = 'site_abc';

    function asCaller(machineIds: readonly string[] | null) {
      mockedResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
      mockedAssertSite.mockResolvedValue({ siteId: SITE, siteData: null, machineIds });
    }

    async function refusal(result: { ok: boolean; response?: Response }) {
      expect(result.ok).toBe(false);
      return { status: result.response!.status, body: await result.response!.json() };
    }

    describe('requireSiteAuthAndScope', () => {
      it('refuses a scoped member with 403 by default', async () => {
        asCaller(['m1']);
        const { status, body } = await refusal(await requireSiteAuthAndScope(makeRequest(), SITE, 'read'));
        expect(status).toBe(403);
        expect(body.detail).toBe('capability not granted');
      });

      it('admits a scoped member with machineScope admit, returning their machines', async () => {
        asCaller(['m1']);
        const result = await requireSiteAuthAndScope(makeRequest(), SITE, 'read', { machineScope: 'admit' });
        expect(result.ok && result.machineIds).toEqual(['m1']);
      });

      it('admits a whole-site member by default, with no machine scope', async () => {
        asCaller(null);
        const result = await requireSiteAuthAndScope(makeRequest(), SITE, 'read');
        expect(result.ok).toBe(true);
        expect(result.ok && result.machineIds).toBeNull();
      });
    });

    describe('requireSiteMachineAuthAndScope', () => {
      it('lets a scoped member reach a machine in their machine scope', async () => {
        asCaller(['m1']);
        const result = await requireSiteMachineAuthAndScope(makeRequest(), SITE, 'm1', 'read');
        expect(result.ok && result.machineIds).toEqual(['m1']);
      });

      it('answers 404 for a machine outside their machine scope', async () => {
        asCaller(['m1']);
        const { status, body } = await refusal(
          await requireSiteMachineAuthAndScope(makeRequest(), SITE, 'm2', 'read'),
        );
        expect(status).toBe(404);
        expect(body.detail).toBe('machine not found or no access');
      });
    });

    describe('requireMachineAuthAndScope', () => {
      it('lets a scoped member reach a machine in their machine scope', async () => {
        asCaller(['m1']);
        const result = await requireMachineAuthAndScope(makeRequest(), SITE, 'm1', 'write');
        expect(result.ok && result.machineIds).toEqual(['m1']);
      });

      it('answers 404 for a machine outside their machine scope', async () => {
        asCaller(['m1']);
        const { status, body } = await refusal(
          await requireMachineAuthAndScope(makeRequest(), SITE, 'm2', 'write'),
        );
        expect(status).toBe(404);
        expect(body.detail).toBe('machine not found or no access');
      });

      it("lets m2's agent token through on the short-circuit, before any membership read", async () => {
        mockVerifyIdToken.mockResolvedValueOnce({
          uid: 'agent-m2',
          role: 'agent',
          site_id: SITE,
          machine_id: 'm2',
        });
        const result = await requireMachineAuthAndScope(
          makeRequest({ headers: { authorization: 'Bearer agent-id-token' } }),
          SITE,
          'm2',
          'write',
        );
        expect(result.ok && result.machineIds).toBeNull();
        expect(mockedAssertSite).not.toHaveBeenCalled();
      });
    });

    it('requireRoostAuthAndScope refuses a scoped member a read with 403', async () => {
      asCaller(['m1']);
      const { status, body } = await refusal(
        await requireRoostAuthAndScope(makeRequest(), SITE, 'roost-0001', 'read'),
      );
      expect(status).toBe(403);
      expect(body.detail).toBe('capability not granted');
    });

    it('requireChatAuthAndScope admits a scoped member and returns their machines', async () => {
      asCaller(['m1']);
      const result = await requireChatAuthAndScope(makeRequest(), SITE, 'read');
      expect(result.ok && result.machineIds).toEqual(['m1']);
    });

    describe('requireSiteCapability', () => {
      const session = { userId: 'user-1', keyContext: null };

      function adminRow(extra: Record<string, unknown> = {}) {
        for (const key of Object.keys(mockDocs)) delete mockDocs[key];
        mockDocs[`sites/${SITE}`] = { name: 'site a' };
        mockDocs['users/user-1'] = { role: 'member' };
        mockDocs[`sites/${SITE}/members/user-1`] = { uid: 'user-1', role: 'admin', status: 'active', ...extra };
      }

      it.each([
        ['WEBHOOK_MANAGE', requireWebhookManageCapability],
        ['DISTRIBUTION_MANAGE', requireDistributionManageCapability],
      ])('refuses a scoped admin %s, a site-wide capability', async (_name, gate) => {
        adminRow({ machineIds: ['m1'] });
        const response = await gate(session, SITE);
        expect(response?.status).toBe(403);
        expect((await response!.json()).detail).toBe('capability not granted');
      });

      it('allows a whole-site admin', async () => {
        adminRow();
        expect(await requireWebhookManageCapability(session, SITE)).toBeNull();
      });
    });
  });
});
