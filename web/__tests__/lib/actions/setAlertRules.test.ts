/** @jest-environment node */

/**
 * Unit tests for `setAlertRules` action core (security-boundary-migration
 * wave 3.11).
 */

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockGet = jest.fn().mockResolvedValue({ exists: false, data: () => undefined });
const mockEmitMutation = jest.fn();
const mockAlertsDoc = { set: mockSet, get: mockGet };
const mockSettingsCollection = { doc: jest.fn(() => mockAlertsDoc) };
const mockSiteDoc = { collection: jest.fn(() => mockSettingsCollection) };
const mockSitesCollection = { doc: jest.fn(() => mockSiteDoc) };

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: jest.fn((name: string) => {
      if (name !== 'sites') throw new Error(`unexpected collection ${name}`);
      return mockSitesCollection;
    }),
  }),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { UserActor } from '@/lib/capabilities';
import {
  AlertRulesValidationError,
  setAlertRules,
  type AlertRuleInput,
} from '@/lib/actions/setAlertRules.server';

const actor: UserActor = {
  type: 'user',
  userId: 'user-superadmin',
  role: 'superadmin',
  siteRoles: {},
};

const AUDIT_ACTOR = 'user:user-superadmin';

const validRule: AlertRuleInput = {
  id: 'rule-1',
  name: '  high cpu  ',
  metric: '  cpu_percent  ',
  operator: '>',
  value: 90,
  severity: 'warning',
  channels: ['email', 'webhook'],
  enabled: true,
  cooldownMinutes: 30,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('setAlertRules', () => {
  it('replaces the rules array with merge semantics', async () => {
    const result = await setAlertRules(
      { actor, siteId: 'site-a', auditActor: AUDIT_ACTOR },
      { rules: [validRule] },
    );

    expect(result).toEqual({ siteId: 'site-a', ruleCount: 1 });
    expect(mockSitesCollection.doc).toHaveBeenCalledWith('site-a');
    expect(mockSiteDoc.collection).toHaveBeenCalledWith('settings');
    expect(mockSettingsCollection.doc).toHaveBeenCalledWith('alerts');
    expect(mockSet).toHaveBeenCalledWith(
      {
        rules: [
          {
            ...validRule,
            name: 'high cpu',
            metric: 'cpu_percent',
          },
        ],
      },
      { merge: true },
    );
  });

  it('accepts an empty rules array', async () => {
    const result = await setAlertRules({ actor, siteId: 'site-a', auditActor: AUDIT_ACTOR }, { rules: [] });

    expect(result.ruleCount).toBe(0);
    expect(mockSet).toHaveBeenCalledWith({ rules: [] }, { merge: true });
  });

  it('rejects invalid site ids and duplicate rule ids', async () => {
    await expect(
      setAlertRules({ actor, siteId: 'bad site id', auditActor: AUDIT_ACTOR }, { rules: [] }),
    ).rejects.toMatchObject({ field: 'siteId' });

    await expect(
      setAlertRules(
        { actor, siteId: 'site-a', auditActor: AUDIT_ACTOR },
        { rules: [{ ...validRule }, { ...validRule }] },
      ),
    ).rejects.toMatchObject({ field: 'rules' });
  });

  it('emits a site_mutated audit with verb=alert_rules.update and the rule-id diff', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ rules: [{ id: 'rule-1' }, { id: 'rule-gone' }] }),
    });

    await setAlertRules(
      { actor, siteId: 'site-a', auditActor: AUDIT_ACTOR },
      { rules: [validRule, { ...validRule, id: 'rule-new' }] },
    );

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId: 'site-a',
      actor: AUDIT_ACTOR,
      targetId: 'site-a',
      attributes: {
        verb: 'alert_rules.update',
        endpoint: 'alerts',
        method: 'PUT',
        ruleCount: 2,
        addedRuleIds: ['rule-new'],
        removedRuleIds: ['rule-gone'],
      },
    });
  });

  it('names the default rule as removed when a site that never saved rules saves without it', async () => {
    await setAlertRules({ actor, siteId: 'site-a', auditActor: AUDIT_ACTOR }, { rules: [validRule] });

    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          addedRuleIds: ['rule-1'],
          removedRuleIds: ['default-low-disk'],
        }),
      }),
    );
  });

  it('still emits the audit when the previous rules cannot be read', async () => {
    mockGet.mockRejectedValueOnce(new Error('read_failed'));

    await setAlertRules(
      { actor, siteId: 'site-a', auditActor: AUDIT_ACTOR },
      { rules: [validRule] },
    );

    // The write must not be affected by an audit-detail read failure.
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_mutated',
        attributes: {
          verb: 'alert_rules.update',
          endpoint: 'alerts',
          method: 'PUT',
          ruleCount: 1,
        },
      }),
    );
  });

  it.each([
    ['operator', { operator: '!=' }],
    ['severity', { severity: 'urgent' }],
    ['channels', { channels: ['sms'] }],
    ['enabled', { enabled: 'true' }],
    ['cooldownMinutes', { cooldownMinutes: -1 }],
  ])('rejects invalid %s', async (_label, patch) => {
    await expect(
      setAlertRules(
        { actor, siteId: 'site-a', auditActor: AUDIT_ACTOR },
        { rules: [{ ...validRule, ...patch } as unknown as AlertRuleInput] },
      ),
    ).rejects.toBeInstanceOf(AlertRulesValidationError);
  });
});
