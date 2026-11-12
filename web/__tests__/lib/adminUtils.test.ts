/** @jest-environment node */

/**
 * getSiteAlertRecipients — empty-recipient ADMIN_EMAIL fallback.
 *
 * Regression for the muted-machine alert leak: when a site has zero real
 * recipients (e.g. `default_site`, managed by a superadmin who is neither owner
 * nor member), the synthetic ADMIN_EMAIL fallback must carry the admin's OWN
 * muted machines — an empty list defeats the per-recipient mute guard in every
 * sender and a muted machine emails the admin anyway.
 */

const mockGetUserByEmail = jest.fn();
const mockSiteDocGet = jest.fn();
const mockUsersWhereGet = jest.fn();
const mockUserDocGet = jest.fn();
// Records the id passed to users.doc(...), so a regression to doc(ADMIN_EMAIL)
// instead of doc(adminUser.uid) fails instead of silently passing.
const mockUsersDoc = jest.fn((id: string) => ({ id, get: mockUserDocGet }));
const mockMembersGet = jest.fn();
// users docs that db.getAll returns, by uid; a uid missing here reads as no document
let mockUserDocsById: Record<string, Record<string, unknown>> = {};
const mockGetAll = jest.fn(async (...refs: Array<{ id: string }>) =>
  refs.map((ref) => ({ id: ref.id, data: () => mockUserDocsById[ref.id] })),
);

const mockDb = {
  collection: (name: string) => {
    if (name === 'sites') {
      return {
        doc: () => ({
          get: mockSiteDocGet,
          collection: (sub: string) => {
            if (sub !== 'members') throw new Error(`unexpected subcollection: ${sub}`);
            return { get: mockMembersGet };
          },
        }),
      };
    }
    if (name === 'users') {
      return {
        where: () => ({ get: mockUsersWhereGet }),
        doc: mockUsersDoc,
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
  getAll: mockGetAll,
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
  getAdminAuth: () => ({ getUserByEmail: mockGetUserByEmail }),
}));

const mockGetSiteEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: (siteId: string) => mockGetSiteEntitlements(siteId),
}));

const mockLoggerWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

const ADMIN_EMAIL = 'admin@owlette.test';

let getSiteAlertRecipients: typeof import('@/lib/adminUtils.server').getSiteAlertRecipients;
let getUserAlertRecipient: typeof import('@/lib/adminUtils.server').getUserAlertRecipient;
let recipientWantsMachine: typeof import('@/lib/adminUtils.server').recipientWantsMachine;
let createPlanMemo: typeof import('@/lib/planPause.server').createPlanMemo;

beforeAll(async () => {
  // ADMIN_EMAIL is read at module load from ADMIN_EMAIL_DEV — set it first.
  process.env.ADMIN_EMAIL_DEV = ADMIN_EMAIL;
  ({ getSiteAlertRecipients, getUserAlertRecipient, recipientWantsMachine } = await import('@/lib/adminUtils.server'));
  ({ createPlanMemo } = await import('@/lib/planPause.server'));
});

beforeEach(() => {
  // Default scenario: empty recipient set -> fallback fires.
  mockSiteDocGet.mockReset().mockResolvedValue({ data: () => ({}) }); // no owner
  mockUsersWhereGet.mockReset().mockResolvedValue({ docs: [] }); // no members
  mockMembersGet.mockReset().mockResolvedValue({ docs: [] }); // no member rows
  mockUserDocsById = {};
  mockGetAll.mockClear();
  mockUserDocGet
    .mockReset()
    .mockResolvedValue({ data: () => ({ email: ADMIN_EMAIL, preferences: { mutedMachines: ['TEC-A4D'] } }) });
  mockGetUserByEmail.mockReset().mockResolvedValue({ uid: 'admin-uid' });
  mockUsersDoc.mockClear(); // keep impl, clear recorded calls
  mockGetSiteEntitlements.mockReset();
  mockLoggerWarn.mockReset();
});

/**
 * Plans (plan.md decision 7): no remote control means no alerts. Runs the real
 * resolver; only tridant's answer is mocked.
 */
describe('getSiteAlertRecipients — plan pause', () => {
  const ent = (control: '0' | '1') => ({
    ok: true,
    resolved: control === '1',
    standing: control === '1' ? 'active' : 'expired',
    inGoodStanding: control === '1',
    ent: { 'owlette.control': control },
    epoch: 0,
  });
  const member = { id: 'u1', data: () => ({ email: 'u1@owlette.test', preferences: {} }) };

  beforeEach(() => {
    process.env.PLAN_ENFORCEMENT = 'on';
    process.env.OWLETTE_E2E = '1';
    mockSiteDocGet.mockResolvedValue({ data: () => ({ owner: 'owner-uid' }) });
    mockUsersWhereGet.mockResolvedValue({ docs: [member] });
  });

  afterEach(() => {
    delete process.env.PLAN_ENFORCEMENT;
    delete process.env.OWLETTE_E2E;
  });

  it('returns no one, and never the ADMIN_EMAIL fallback, when the site has no control', async () => {
    mockGetSiteEntitlements.mockResolvedValue(ent('0'));

    expect(await getSiteAlertRecipients('site-1', 'healthAlerts')).toEqual([]);
    expect(mockGetSiteEntitlements).toHaveBeenCalledWith('site-1');
    // the site read is reused for the plan; nobody is enumerated.
    expect(mockSiteDocGet).toHaveBeenCalledTimes(1);
    expect(mockUsersWhereGet).not.toHaveBeenCalled();
    expect(mockMembersGet).not.toHaveBeenCalled();
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "alerts paused: the site's plan has no remote control",
      expect.objectContaining({ data: { siteId: 'site-1', filterPreference: 'healthAlerts' } }),
    );
  });

  it('enumerates as before when the site has control', async () => {
    mockGetSiteEntitlements.mockResolvedValue(ent('1'));

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');
    expect(recipients.map((r) => r.userId)).toEqual(['u1', 'owner-uid']);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('makes no plan read when enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    mockSiteDocGet.mockResolvedValue({ data: () => ({}) }); // no owner, so no owner read either

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');
    expect(recipients.map((r) => r.userId)).toEqual(['u1']);
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
    expect(mockSiteDocGet).toHaveBeenCalledTimes(1);
    expect(mockUsersDoc).not.toHaveBeenCalled();
  });

  it('resolves each site once across a batch sharing a memo', async () => {
    mockGetSiteEntitlements.mockResolvedValue(ent('0'));
    const memo = createPlanMemo();

    await getSiteAlertRecipients('site-1', 'healthAlerts', memo);
    await getSiteAlertRecipients('site-1', 'processAlerts', memo);
    await getSiteAlertRecipients('site-2', 'healthAlerts', memo);

    expect(mockGetSiteEntitlements.mock.calls.map(([siteId]) => siteId)).toEqual(['site-1', 'site-2']);
  });
});

describe('getSiteAlertRecipients — ADMIN_EMAIL fallback', () => {
  it("carries the admin's own muted-machines into the fallback recipient", async () => {
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(mockGetUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL);
    // users/{auth uid}, not users/{email}: doc(ADMIN_EMAIL) must not pass here.
    expect(mockUsersDoc).toHaveBeenCalledWith('admin-uid');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'], machineIds: null },
    ]);
  });

  it('fails open to empty mutes when ADMIN_EMAIL maps to no Auth user', async () => {
    mockGetUserByEmail.mockRejectedValue(new Error('auth/user-not-found'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [], machineIds: null },
    ]);
  });

  it('ignores a deleted admin doc and fails open (still delivers)', async () => {
    mockUserDocGet.mockResolvedValue({
      data: () => ({ deletedAt: 1700000000000, preferences: { mutedMachines: ['TEC-A4D'] } }),
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [], machineIds: null },
    ]);
  });

  it('does NOT hit the fallback (or read admin mutes) when a real recipient exists', async () => {
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'u1', data: () => ({ email: 'u1@owlette.test', preferences: { mutedMachines: ['OTHER-1'] } }) }],
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'u1', email: 'u1@owlette.test', ccEmails: [], mutedMachines: ['OTHER-1'], machineIds: null },
    ]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('fails open (delivers, no mutes) when recipient enumeration throws — even if the admin muted the machine', async () => {
    // A transient enumeration error is not "genuinely empty": mutes are not
    // applied, so the alert is delivered rather than suppressed.
    mockSiteDocGet.mockRejectedValue(new Error('firestore unavailable'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [], machineIds: null },
    ]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('fails open when the admin-doc read throws after getUserByEmail succeeds', async () => {
    // Genuinely empty -> admin lookup runs -> users/{uid} read fails -> inner
    // catch -> empty mutes -> deliver.
    mockGetUserByEmail.mockResolvedValue({ uid: 'admin-uid' });
    mockUserDocGet.mockRejectedValue(new Error('admin doc read failed'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(mockGetUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL);
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [], machineIds: null },
    ]);
  });

  it('fails open when the OWNER doc read throws (inner catch is an enumeration failure)', async () => {
    // Owner but no array-contains members, and the owner-doc read fails: the
    // owner branch must flag enumeration failed so mutes are not applied.
    mockSiteDocGet.mockResolvedValue({ data: () => ({ owner: 'owner-uid' }) });
    mockUsersWhereGet.mockResolvedValue({ docs: [] });
    mockUserDocGet.mockRejectedValue(new Error('owner read failed'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [], machineIds: null },
    ]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('does NOT fall back when a site MEMBER exists but opted out of this alert type', async () => {
    // A real member opted out of thresholdAlerts: the empty set is deliberate and
    // the fallback must not override it (the live default_site scenario).
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'm1', data: () => ({ email: 'member@owlette.test', preferences: { thresholdAlerts: false, mutedMachines: [] } }) }],
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('does NOT fall back when the site OWNER exists but opted out (owner branch)', async () => {
    mockSiteDocGet.mockResolvedValue({ data: () => ({ owner: 'owner-uid' }) });
    mockUsersWhereGet.mockResolvedValue({ docs: [] }); // no array-contains members
    mockUserDocGet.mockResolvedValue({ data: () => ({ email: 'owner@owlette.test', preferences: { thresholdAlerts: false } }) });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('treats a member with NO email as orphan -> fallback still fires (honors admin mutes)', async () => {
    // A member with no email cannot receive alerts, so the site is still orphan
    // and the fallback must fire.
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'm1', data: () => ({ preferences: { mutedMachines: [] } }) }], // no email
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(mockGetUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL);
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'], machineIds: null },
    ]);
  });

  it('treats a DELETED member as orphan -> fallback still fires', async () => {
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'm1', data: () => ({ email: 'gone@owlette.test', deletedAt: 1700000000000, preferences: {} }) }],
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'], machineIds: null },
    ]);
  });
});

/**
 * Machine scope (owner decision 10): recipients come from the member rows as well
 * as the legacy `users.sites[]` array, and each carries its row's machine scope.
 */
describe('getSiteAlertRecipients — machine scope', () => {
  const row = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });
  const user = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });

  it("gives a scoped member's row its machineIds, and a whole-site row and the owner null", async () => {
    mockSiteDocGet.mockResolvedValue({ data: () => ({ owner: 'owner-uid' }) });
    mockMembersGet.mockResolvedValue({
      docs: [
        row('scoped', { status: 'active', role: 'member', machineIds: ['m1'] }),
        row('whole', { status: 'active', role: 'admin' }),
        row('owner-uid', { status: 'active', role: 'owner' }),
      ],
    });
    mockUsersWhereGet.mockResolvedValue({
      docs: [user('scoped', { email: 'scoped@owlette.test' }), user('whole', { email: 'whole@owlette.test' })],
    });
    mockUserDocGet.mockResolvedValue({ data: () => ({ email: 'owner@owlette.test' }) });

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');

    expect(recipients.map((r) => [r.userId, r.machineIds])).toEqual([
      ['scoped', ['m1']],
      ['whole', null],
      ['owner-uid', null],
    ]);
    // the owner came through the owner branch, so getAll reads no one twice
    expect(mockGetAll).not.toHaveBeenCalled();
  });

  it('still mails a scoped member whose users doc has no legacy sites[] entry', async () => {
    mockMembersGet.mockResolvedValue({
      docs: [row('row-only', { status: 'active', role: 'member', machineIds: ['m1'] })],
    });
    mockUserDocsById = { 'row-only': { email: 'row-only@owlette.test', preferences: { mutedMachines: ['m9'] } } };

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');

    expect(recipients).toEqual([
      { userId: 'row-only', email: 'row-only@owlette.test', ccEmails: [], mutedMachines: ['m9'], machineIds: ['m1'] },
    ]);
    expect(mockUsersDoc).toHaveBeenCalledWith('row-only');
  });

  it("applies today's rules to a row-only member: opt-out, deleted and email-less users get nothing", async () => {
    mockMembersGet.mockResolvedValue({
      docs: [
        row('opted-out', { status: 'active', role: 'member' }),
        row('deleted', { status: 'active', role: 'member' }),
        row('no-email', { status: 'active', role: 'member' }),
        row('no-user-doc', { status: 'active', role: 'member' }),
      ],
    });
    mockUserDocsById = {
      'opted-out': { email: 'o@owlette.test', preferences: { healthAlerts: false } },
      deleted: { email: 'd@owlette.test', deletedAt: 1700000000000 },
      'no-email': { preferences: {} },
    };

    // an opted-out member is a real user, so the empty set is deliberate: no fallback
    expect(await getSiteAlertRecipients('site-1', 'healthAlerts')).toEqual([]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('adds no one for an inactive row, or a row with no site role', async () => {
    mockSiteDocGet.mockResolvedValue({ data: () => ({ owner: 'owner-uid' }) });
    mockMembersGet.mockResolvedValue({
      docs: [
        row('removed', { status: 'removed', role: 'member' }),
        row('no-role', { status: 'active', role: 'viewer' }),
      ],
    });
    mockUserDocsById = {
      removed: { email: 'removed@owlette.test' },
      'no-role': { email: 'no-role@owlette.test' },
    };
    mockUserDocGet.mockResolvedValue({ data: () => ({ email: 'owner@owlette.test' }) });

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');

    expect(recipients.map((r) => r.userId)).toEqual(['owner-uid']);
    expect(mockGetAll).not.toHaveBeenCalled();
  });

  it('reads row-only members in chunks of 100', async () => {
    const uids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    mockMembersGet.mockResolvedValue({
      docs: uids.map((uid) => row(uid, { status: 'active', role: 'member' })),
    });
    mockUserDocsById = Object.fromEntries(uids.map((uid) => [uid, { email: `${uid}@owlette.test` }]));

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');

    expect(mockGetAll.mock.calls.map((call) => call.length)).toEqual([100, 50]);
    expect(recipients).toHaveLength(150);
  });

  it('gives only the fallback when the member rows cannot be read, never a scoped member at the whole site', async () => {
    mockMembersGet.mockRejectedValue(new Error('firestore unavailable'));
    mockUsersWhereGet.mockResolvedValue({ docs: [user('scoped', { email: 'scoped@owlette.test' })] });

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');

    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [], machineIds: null },
    ]);
    expect(mockUsersWhereGet).not.toHaveBeenCalled();
  });
});

describe('recipientWantsMachine', () => {
  const recipient = (mutedMachines: string[], machineIds: readonly string[] | null) => ({
    userId: 'u1',
    email: 'u1@owlette.test',
    ccEmails: [],
    mutedMachines,
    machineIds,
  });

  it('lets a mute win, even on a machine in scope', () => {
    expect(recipientWantsMachine(recipient(['m1'], ['m1']), 'm1')).toBe(false);
    expect(recipientWantsMachine(recipient(['m1'], null), 'm1')).toBe(false);
  });

  it('passes a machine the scope covers, and refuses one it does not', () => {
    expect(recipientWantsMachine(recipient([], ['m1']), 'm1')).toBe(true);
    expect(recipientWantsMachine(recipient([], ['m1']), 'm2')).toBe(false);
    expect(recipientWantsMachine(recipient([], []), 'm1')).toBe(false);
  });

  it('reads null as the whole site', () => {
    expect(recipientWantsMachine(recipient([], null), 'any')).toBe(true);
  });

  it('reaches no machine for a recipient built without the field', () => {
    const handBuilt = { userId: 'u1', email: 'u1@owlette.test', ccEmails: [], mutedMachines: [] };
    expect(recipientWantsMachine(handBuilt as unknown as Parameters<typeof recipientWantsMachine>[0], 'any')).toBe(false);
  });
});

/**
 * getUserAlertRecipient — the user-scoped resolver behind api key expiry notices.
 *
 * Deliberately NOT a copy of the site resolver: an api key belongs to one person
 * and no site, so there is no membership enumeration, no ADMIN_EMAIL fallback
 * (which exists for orphan sites and here would mail the admin about a
 * stranger's credential) and no machine mutes.
 */
describe('getUserAlertRecipient', () => {
  const userDoc = (data: Record<string, unknown>, id = 'u1') => ({ id, data: () => data });

  it('returns the user with their cc list, reading the uid off the snapshot', async () => {
    mockUserDocGet.mockResolvedValue(
      userDoc({ email: 'u1@owlette.test', preferences: { alertCcEmails: ['ops@owlette.test'] } })
    );
    await expect(getUserAlertRecipient('u1', 'apiKeyAlerts')).resolves.toEqual({
      userId: 'u1',
      email: 'u1@owlette.test',
      ccEmails: ['ops@owlette.test'],
    });
    expect(mockUsersDoc).toHaveBeenCalledWith('u1');
  });

  it('defaults to enabled when the preference is absent (opt-out model)', async () => {
    mockUserDocGet.mockResolvedValue(userDoc({ email: 'u1@owlette.test' }));
    await expect(getUserAlertRecipient('u1', 'apiKeyAlerts')).resolves.toEqual({
      userId: 'u1',
      email: 'u1@owlette.test',
      ccEmails: [],
    });
  });

  it('returns null when the user opted out', async () => {
    mockUserDocGet.mockResolvedValue(
      userDoc({ email: 'u1@owlette.test', preferences: { apiKeyAlerts: false } })
    );
    await expect(getUserAlertRecipient('u1', 'apiKeyAlerts')).resolves.toBeNull();
  });

  it('returns null for a soft-deleted user', async () => {
    mockUserDocGet.mockResolvedValue(
      userDoc({ email: 'u1@owlette.test', deletedAt: 1700000000000 })
    );
    await expect(getUserAlertRecipient('u1', 'apiKeyAlerts')).resolves.toBeNull();
  });

  it('returns null when the user has no email, and never reaches for ADMIN_EMAIL', async () => {
    mockUserDocGet.mockResolvedValue(userDoc({ preferences: {} }));
    await expect(getUserAlertRecipient('u1', 'apiKeyAlerts')).resolves.toBeNull();
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('returns null for a missing user document', async () => {
    mockUserDocGet.mockResolvedValue({ id: 'u1', data: () => undefined });
    await expect(getUserAlertRecipient('u1', 'apiKeyAlerts')).resolves.toBeNull();
  });

  it('returns null (and does not throw) when the read fails', async () => {
    mockUserDocGet.mockRejectedValue(new Error('firestore unavailable'));
    await expect(getUserAlertRecipient('u1', 'apiKeyAlerts')).resolves.toBeNull();
  });

  it('reports the uid it actually read, so a caller can catch a mismatch', async () => {
    // The cron compares this against the owner uid it derived from the key's
    // document path; returning the argument verbatim would make that check
    // tautological and the cross-user leakage guard worthless.
    mockUserDocGet.mockResolvedValue(userDoc({ email: 'other@owlette.test' }, 'someone-else'));
    await expect(getUserAlertRecipient('u1', 'apiKeyAlerts')).resolves.toEqual({
      userId: 'someone-else',
      email: 'other@owlette.test',
      ccEmails: [],
    });
  });
});
