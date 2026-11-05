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
const mockUsersDoc = jest.fn(() => ({ get: mockUserDocGet }));

const mockDb = {
  collection: (name: string) => {
    if (name === 'sites') {
      return { doc: () => ({ get: mockSiteDocGet }) };
    }
    if (name === 'users') {
      return {
        where: () => ({ get: mockUsersWhereGet }),
        doc: mockUsersDoc,
      };
    }
    throw new Error(`unexpected collection: ${name}`);
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
  getAdminAuth: () => ({ getUserByEmail: mockGetUserByEmail }),
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

const mockLoggerWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

const ADMIN_EMAIL = 'admin@owlette.test';

let getSiteAlertRecipients: typeof import('@/lib/adminUtils.server').getSiteAlertRecipients;
let getUserAlertRecipient: typeof import('@/lib/adminUtils.server').getUserAlertRecipient;
let createPlanMemo: typeof import('@/lib/planPause.server').createPlanMemo;

beforeAll(async () => {
  // ADMIN_EMAIL is read at module load from ADMIN_EMAIL_DEV — set it first.
  process.env.ADMIN_EMAIL_DEV = ADMIN_EMAIL;
  ({ getSiteAlertRecipients, getUserAlertRecipient } = await import('@/lib/adminUtils.server'));
  ({ createPlanMemo } = await import('@/lib/planPause.server'));
});

beforeEach(() => {
  // Default scenario: empty recipient set -> fallback fires.
  mockSiteDocGet.mockReset().mockResolvedValue({ data: () => ({}) }); // no owner
  mockUsersWhereGet.mockReset().mockResolvedValue({ docs: [] }); // no members
  mockUserDocGet
    .mockReset()
    .mockResolvedValue({ data: () => ({ email: ADMIN_EMAIL, preferences: { mutedMachines: ['TEC-A4D'] } }) });
  mockGetUserByEmail.mockReset().mockResolvedValue({ uid: 'admin-uid' });
  mockUsersDoc.mockClear(); // keep impl, clear recorded calls
  mockGetEntitlements.mockReset();
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

  it('returns no one, and never the ADMIN_EMAIL fallback, when the payer has no control', async () => {
    mockGetEntitlements.mockResolvedValue(ent('0'));

    expect(await getSiteAlertRecipients('site-1', 'healthAlerts')).toEqual([]);
    expect(mockGetEntitlements).toHaveBeenCalledWith('owner-uid');
    // the site read is reused for the payer; nobody is enumerated.
    expect(mockSiteDocGet).toHaveBeenCalledTimes(1);
    expect(mockUsersWhereGet).not.toHaveBeenCalled();
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "alerts paused: the site's plan has no remote control",
      expect.objectContaining({ data: { siteId: 'site-1', filterPreference: 'healthAlerts' } }),
    );
  });

  it('enumerates as before when the payer has control', async () => {
    mockGetEntitlements.mockResolvedValue(ent('1'));

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');
    expect(recipients.map((r) => r.userId)).toEqual(['u1', 'owner-uid']);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('makes no plan read when enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    mockSiteDocGet.mockResolvedValue({ data: () => ({}) }); // no owner, so no owner read either

    const recipients = await getSiteAlertRecipients('site-1', 'healthAlerts');
    expect(recipients.map((r) => r.userId)).toEqual(['u1']);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(mockSiteDocGet).toHaveBeenCalledTimes(1);
    expect(mockUsersDoc).not.toHaveBeenCalled();
  });

  it('resolves the payer once across a batch sharing a memo', async () => {
    mockGetEntitlements.mockResolvedValue(ent('0'));
    const memo = createPlanMemo();

    await getSiteAlertRecipients('site-1', 'healthAlerts', memo);
    await getSiteAlertRecipients('site-2', 'healthAlerts', memo);

    expect(mockGetEntitlements).toHaveBeenCalledTimes(1);
    expect(mockUsersDoc).toHaveBeenCalledTimes(1);
  });
});

describe('getSiteAlertRecipients — ADMIN_EMAIL fallback', () => {
  it("carries the admin's own muted-machines into the fallback recipient", async () => {
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(mockGetUserByEmail).toHaveBeenCalledWith(ADMIN_EMAIL);
    // users/{auth uid}, not users/{email}: doc(ADMIN_EMAIL) must not pass here.
    expect(mockUsersDoc).toHaveBeenCalledWith('admin-uid');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'] },
    ]);
  });

  it('fails open to empty mutes when ADMIN_EMAIL maps to no Auth user', async () => {
    mockGetUserByEmail.mockRejectedValue(new Error('auth/user-not-found'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
  });

  it('ignores a deleted admin doc and fails open (still delivers)', async () => {
    mockUserDocGet.mockResolvedValue({
      data: () => ({ deletedAt: 1700000000000, preferences: { mutedMachines: ['TEC-A4D'] } }),
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
    ]);
  });

  it('does NOT hit the fallback (or read admin mutes) when a real recipient exists', async () => {
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'u1', data: () => ({ email: 'u1@owlette.test', preferences: { mutedMachines: ['OTHER-1'] } }) }],
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'u1', email: 'u1@owlette.test', ccEmails: [], mutedMachines: ['OTHER-1'] },
    ]);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  it('fails open (delivers, no mutes) when recipient enumeration throws — even if the admin muted the machine', async () => {
    // A transient enumeration error is not "genuinely empty": mutes are not
    // applied, so the alert is delivered rather than suppressed.
    mockSiteDocGet.mockRejectedValue(new Error('firestore unavailable'));
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
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
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
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
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: [] },
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
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'] },
    ]);
  });

  it('treats a DELETED member as orphan -> fallback still fires', async () => {
    mockUsersWhereGet.mockResolvedValue({
      docs: [{ id: 'm1', data: () => ({ email: 'gone@owlette.test', deletedAt: 1700000000000, preferences: {} }) }],
    });
    const recipients = await getSiteAlertRecipients('default_site', 'thresholdAlerts');
    expect(recipients).toEqual([
      { userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines: ['TEC-A4D'] },
    ]);
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
