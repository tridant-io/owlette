/** @jest-environment node */

/**
 * GET /api/agent/site — the only path from a paired agent to its site metadata
 * (rules scope the agent to its machine subtree). Two asserted properties: the
 * site comes from the token's `site_id` claim, never the request; and the
 * response projects `name` plus a timezone that is spoken ONLY for a site whose
 * `schedulesFollowSiteTime` is explicitly `true` — handing a timezone to an
 * agent flips schedule evaluation from machine-local to site time for every
 * process on every machine at that site.
 *
 * The flag-off cases below are the negative controls for that gate. They stand
 * in for the whole installed base: until a site opts in, this endpoint must
 * behave exactly as it did before site time existed.
 *
 * `keepAwake` is the inverse default: on unless `settings/display` says an
 * explicit `false`, so every case that never seeds that document expects `true`.
 */

import { createMockRequest } from '../helpers/utils';

const mockVerifyIdToken = jest.fn();
const mockSiteGet = jest.fn();
const mockDoc = jest.fn();
const mockCollection = jest.fn();
const mockSettingsCollection = jest.fn();
const mockSettingsDoc = jest.fn();
const mockDisplayGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  }),
  getAdminDb: () => ({
    collection: (...args: unknown[]) => mockCollection(...args),
  }),
}));
jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { GET } from '@/app/api/agent/site/route';

function request(headers: Record<string, string> = {}) {
  return createMockRequest('http://localhost/api/agent/site', { method: 'GET', headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDisplayGet.mockResolvedValue({ exists: false, data: () => undefined });
  mockSettingsDoc.mockReturnValue({ get: (...args: unknown[]) => mockDisplayGet(...args) });
  mockSettingsCollection.mockReturnValue({
    doc: (...args: unknown[]) => mockSettingsDoc(...args),
  });
  mockDoc.mockReturnValue({
    get: (...args: unknown[]) => mockSiteGet(...args),
    collection: (...args: unknown[]) => mockSettingsCollection(...args),
  });
  mockCollection.mockReturnValue({ doc: (...args: unknown[]) => mockDoc(...args) });
});

describe('GET /api/agent/site', () => {
  it('returns the site name for a valid agent token, read via the site_id claim', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      role: 'agent',
      site_id: 'site-a',
      machine_id: 'TEC-A4D',
    });
    mockSiteGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        name: 'TEC',
        timezone: 'America/Los_Angeles',
        schedulesFollowSiteTime: true,
      }),
    });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      name: 'TEC',
      timezone: 'America/Los_Angeles',
      roostEnabled: null,
      keepAwake: true,
    });
    // The site is the token's, not the caller's to choose.
    expect(mockCollection).toHaveBeenCalledWith('sites');
    expect(mockDoc).toHaveBeenCalledWith('site-a');
  });

  describe('the timezone gate', () => {
    /** Seed one site document and read the projected body back. */
    async function bodyForSite(site: Record<string, unknown>) {
      mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
      mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => site });
      const res = await GET(request({ Authorization: 'Bearer agent-token' }));
      expect(res.status).toBe(200);
      return res.json();
    }

    // NEGATIVE CONTROL — every site that predates the opt-in. No flag on the
    // document means schedules stay on machine clocks, so the agent must not
    // learn the timezone even though the site has one.
    it('withholds the timezone from a site that was never asked (flag absent)', async () => {
      expect(
        await bodyForSite({
          name: 'TEC',
          timezone: 'America/Los_Angeles',
          owner: 'user-1',
          billingState: 'active',
        }),
      ).toEqual({ name: 'TEC', timezone: null, roostEnabled: null, keepAwake: true });
    });

    // NEGATIVE CONTROL — the touring escape hatch. An explicit decline is as
    // binding as never having been asked.
    it('withholds the timezone from a site that declined site time (flag false)', async () => {
      expect(
        await bodyForSite({
          name: 'TEC',
          timezone: 'America/Los_Angeles',
          schedulesFollowSiteTime: false,
        }),
      ).toEqual({ name: 'TEC', timezone: null, roostEnabled: null, keepAwake: true });
    });

    it('returns the timezone once the site opted in (flag true)', async () => {
      expect(
        await bodyForSite({
          name: 'TEC',
          timezone: 'America/Los_Angeles',
          schedulesFollowSiteTime: true,
        }),
      ).toEqual({
        name: 'TEC',
        timezone: 'America/Los_Angeles',
        roostEnabled: null,
        keepAwake: true,
      });
    });

    it('returns timezone: null when the site opted in but has no timezone', async () => {
      expect(
        await bodyForSite({ name: 'TEC', schedulesFollowSiteTime: true }),
      ).toEqual({ name: 'TEC', timezone: null, roostEnabled: null, keepAwake: true });
    });

    it('treats a blank timezone as no timezone rather than shipping an empty string', async () => {
      expect(
        await bodyForSite({ name: 'TEC', timezone: '   ', schedulesFollowSiteTime: true }),
      ).toEqual({ name: 'TEC', timezone: null, roostEnabled: null, keepAwake: true });
    });

    it('trims surrounding whitespace off the opted-in timezone', async () => {
      expect(
        await bodyForSite({
          name: 'TEC',
          timezone: '  America/Los_Angeles  ',
          schedulesFollowSiteTime: true,
        }),
      ).toEqual({
        name: 'TEC',
        timezone: 'America/Los_Angeles',
        roostEnabled: null,
        keepAwake: true,
      });
    });

    // Only the boolean `true` opens the gate: a truthy string from a hand-edited
    // document must not be mistaken for consent.
    it('ignores a truthy non-boolean flag value', async () => {
      expect(
        await bodyForSite({
          name: 'TEC',
          timezone: 'America/Los_Angeles',
          schedulesFollowSiteTime: 'true',
        }),
      ).toEqual({ name: 'TEC', timezone: null, roostEnabled: null, keepAwake: true });
    });
  });

  describe('the roost kill switch', () => {
    async function bodyForSite(site: Record<string, unknown>) {
      mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
      mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => site });
      const res = await GET(request({ Authorization: 'Bearer agent-token' }));
      expect(res.status).toBe(200);
      return res.json();
    }

    const BASE = { name: 'TEC', owner: 'user-1', billingState: 'active' };

    // The whole reason this field is on the projection. An agent cannot read
    // `sites/{siteId}` — the rules scope it to its machine subtree — so before
    // this it read the switch through a method that did not exist, swallowed the
    // error, and cached the fail-open. The switch had never once been observed.
    it('passes an engaged kill switch through to the agent', async () => {
      expect(await bodyForSite({ ...BASE, roostEnabled: false })).toEqual({
        name: 'TEC',
        timezone: null,
        roostEnabled: false,
        keepAwake: true,
      });
    });

    it('passes an explicitly enabled switch through as true', async () => {
      expect(await bodyForSite({ ...BASE, roostEnabled: true })).toEqual({
        name: 'TEC',
        timezone: null,
        roostEnabled: true,
        keepAwake: true,
      });
    });

    // Absent must stay distinguishable from false: the agent's helper fails OPEN
    // on a missing field, so collapsing null to false here would halt roost work
    // on every site that has never touched the switch.
    it('reports null, not false, when the site has never set the flag', async () => {
      expect(await bodyForSite(BASE)).toEqual({
        name: 'TEC',
        timezone: null,
        roostEnabled: null,
        keepAwake: true,
      });
    });

    it('ignores a truthy non-boolean flag value', async () => {
      expect(await bodyForSite({ ...BASE, roostEnabled: 'yes' })).toEqual({
        name: 'TEC',
        timezone: null,
        roostEnabled: null,
        keepAwake: true,
      });
    });
  });

  describe('keep screens awake', () => {
    /** Seed `settings/display` (null = no document) and read `keepAwake` back. */
    async function keepAwakeFor(display: Record<string, unknown> | null) {
      mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
      mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => ({ name: 'TEC' }) });
      mockDisplayGet.mockResolvedValueOnce(
        display ? { exists: true, data: () => display } : { exists: false, data: () => undefined },
      );
      const res = await GET(request({ Authorization: 'Bearer agent-token' }));
      expect(res.status).toBe(200);
      return (await res.json()).keepAwake;
    }

    it('reads the setting from settings/display under the token site', async () => {
      await keepAwakeFor(null);

      expect(mockDoc).toHaveBeenCalledWith('site-a');
      expect(mockSettingsCollection).toHaveBeenCalledWith('settings');
      expect(mockSettingsDoc).toHaveBeenCalledWith('display');
    });

    // Default on (owner, 2026-10-03): every site that never touched the switch
    // keeps its screens awake.
    it('is true when the site has no display settings document', async () => {
      expect(await keepAwakeFor(null)).toBe(true);
    });

    it('is true when the document exists without the field', async () => {
      expect(await keepAwakeFor({ updatedAt: 1 })).toBe(true);
    });

    it('is false when the site switched it off', async () => {
      expect(await keepAwakeFor({ keepAwake: false })).toBe(false);
    });

    it('is true when the site switched it on', async () => {
      expect(await keepAwakeFor({ keepAwake: true })).toBe(true);
    });

    // Only the boolean `false` switches it off: a hand-edited string must not
    // turn a site's screens off.
    it('ignores a falsy non-boolean value', async () => {
      expect(await keepAwakeFor({ keepAwake: 'false' })).toBe(true);
    });

    // A failed read must not project the default: that would switch a site that
    // turned it off back on. The agent keeps its last value on a non-200.
    it('fails the request rather than defaulting when the settings read throws', async () => {
      mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
      mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => ({ name: 'TEC' }) });
      mockDisplayGet.mockRejectedValueOnce(new Error('backend unavailable'));

      const res = await GET(request({ Authorization: 'Bearer agent-token' }));

      expect(res.status).toBe(500);
    });
  });

  it('ignores a siteId supplied in the query string', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => ({ name: 'TEC' }) });

    const req = createMockRequest('http://localhost/api/agent/site?siteId=site-victim', {
      method: 'GET',
      headers: { Authorization: 'Bearer agent-token' },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockDoc).toHaveBeenCalledWith('site-a');
    expect(mockDoc).not.toHaveBeenCalledWith('site-victim');
  });

  it('returns name: null when the site has no name set', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => ({ name: '   ' }) });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: null, timezone: null, roostEnabled: null, keepAwake: true });
  });

  it('trims surrounding whitespace off the stored name', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => ({ name: '  TEC  ' }) });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(await res.json()).toEqual({ name: 'TEC', timezone: null, roostEnabled: null, keepAwake: true });
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body.title).toBe('unauthorized');
  });

  it('returns 401 when the bearer token does not verify', async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error('token expired'));

    const res = await GET(request({ Authorization: 'Bearer stale-token' }));

    expect(res.status).toBe(401);
    expect(mockSiteGet).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-agent (dashboard user) token', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'user-1' });

    const res = await GET(request({ Authorization: 'Bearer user-token' }));

    expect(res.status).toBe(403);
    expect(mockSiteGet).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.detail).toMatch(/agent token required/i);
  });

  it('returns 403 for an agent token with no site_id claim', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', machine_id: 'TEC-A4D' });

    const res = await GET(request({ Authorization: 'Bearer claimless-token' }));

    expect(res.status).toBe(403);
    expect(mockSiteGet).not.toHaveBeenCalled();
  });

  it('returns 404 when the claimed site document no longer exists', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-deleted' });
    mockSiteGet.mockResolvedValueOnce({ exists: false, data: () => undefined });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.title).toBe('not found');
  });

  it('returns 500 problem+json when the firestore read throws', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockRejectedValueOnce(new Error('backend unavailable'));

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(res.status).toBe(500);
  });
});
