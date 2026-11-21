/**
 * @jest-environment node
 */

import { Timestamp } from 'firebase-admin/firestore';
import { fromChangeDoc, fromDecisionDoc, fromFindingDoc } from '@/lib/activity/rows';

const doc = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });

function change(actor: string, extra: Record<string, unknown> = {}, kind = 'user_mutated', siteId = 'site-a') {
  return doc('h1', {
    event: { kind, siteId, actor, occurredAt: 1000, target: 'u9', attributes: { verb: 'promoted', endpoint: '/x', ...extra } },
    recordedAt: 1234,
    hash: 'h1',
  });
}

describe('fromChangeDoc', () => {
  it('maps a user actor, action, time and details', () => {
    expect(fromChangeDoc(change('user:u1'))).toEqual({
      id: 'change:h1',
      kind: 'change',
      at: 1234,
      actor: { type: 'user', id: 'u1' },
      siteId: 'site-a',
      action: 'user_mutated:promoted',
      outcome: null,
      target: { id: 'u9' },
      details: { verb: 'promoted', endpoint: '/x', hash: 'h1' },
    });
  });

  it('maps api key and machine actors; anything else is unknown', () => {
    expect(fromChangeDoc(change('apiKey:k1')).actor).toEqual({ type: 'api_key', id: 'k1' });
    expect(fromChangeDoc(change('machine:m1')).actor).toEqual({ type: 'machine', id: 'm1' });
    expect(fromChangeDoc(change('service:cron')).actor).toEqual({ type: 'unknown', id: 'service:cron' });
    expect(fromChangeDoc(change('bare-uid')).actor).toEqual({ type: 'unknown', id: 'bare-uid' });
  });

  it('maps a system job, and a change hoot made for a user, which carries via hoot', () => {
    expect(fromChangeDoc(change('system:talon_runner')).actor).toEqual({ type: 'system', id: 'talon_runner' });
    const viaHoot = fromChangeDoc(change('cortex:user_u1'));
    expect(viaHoot.actor).toEqual({ type: 'user', id: 'u1' });
    expect(viaHoot.details.via).toBe('hoot');
    expect(fromChangeDoc(change('user:u1')).details.via).toBeUndefined();
  });

  it('nulls the site for _platform', () => {
    expect(fromChangeDoc(change('user:u1', {}, 'user_mutated', '_platform')).siteId).toBeNull();
  });

  it('names a machine command by its command type', () => {
    const row = fromChangeDoc(change('user:u1', { commandType: 'reboot_machine', verb: undefined }, 'machine_command_dispatched'));
    expect(row.action).toBe('machine_command_dispatched:reboot_machine');
  });
});

describe('fromDecisionDoc', () => {
  const base = {
    correlationId: 'c1',
    actor: { type: 'user', userId: 'u1', role: 'admin' },
    capability: 'MACHINE_REMOVE',
    target: { kind: 'machine', id: 'm1', machineId: 'm1' },
    outcome: 'deny',
    denyReason: 'not_a_member',
    metadata: { route: '/api/x' },
    timestamp: Timestamp.fromMillis(5000),
  };

  it('maps a refused row', () => {
    expect(fromDecisionDoc(doc('d1', base), 'decision', 'site-a')).toEqual({
      id: 'decision:d1',
      kind: 'refused',
      at: 5000,
      actor: { type: 'user', id: 'u1' },
      siteId: 'site-a',
      action: 'MACHINE_REMOVE',
      outcome: 'deny',
      reason: 'not_a_member',
      target: { kind: 'machine', id: 'm1', machineId: 'm1' },
      details: { route: '/api/x', correlationId: 'c1', target: base.target },
    });
  });

  it('falls back to errorCode for the reason', () => {
    const row = fromDecisionDoc(doc('d1', { ...base, outcome: 'error', denyReason: undefined, errorCode: 'boom' }), 'decision', null);
    expect(row.reason).toBe('boom');
  });

  it('maps api key, machine and system actors', () => {
    const actor = (a: unknown) => fromDecisionDoc(doc('d', { ...base, actor: a }), 'decision', null).actor;
    expect(actor({ type: 'user', userId: 'u1', apiKeyId: 'k1', role: 'admin' })).toEqual({ type: 'api_key', id: 'k1' });
    expect(actor({ type: 'machine', siteId: 's', machineId: 'm1' })).toEqual({ type: 'machine', id: 'm1' });
    expect(actor({ type: 'system', name: 'swoop_host' })).toEqual({ type: 'system', id: 'swoop_host' });
  });

  it('names the person a system row is about when the host supplied a uid', () => {
    const host = { ...base, actor: { type: 'system', name: 'swoop_host' }, metadata: { event: 'input_not_permitted', uid: 'u7' } };
    expect(fromDecisionDoc(doc('d', host), 'decision', 'site-a').subject).toEqual({ type: 'user', id: 'u7' });
    expect(fromDecisionDoc(doc('d', { ...host, metadata: {} }), 'decision', 'site-a').subject).toBeUndefined();
    const user = { ...base, metadata: { uid: 'u7' } };
    expect(fromDecisionDoc(doc('d', user), 'decision', 'site-a').subject).toBeUndefined();
  });

  it('maps a sign-in row with its network', () => {
    const row = fromDecisionDoc(
      doc('s1', {
        correlationId: 'c2',
        actor: { type: 'user', userId: 'u1', role: 'superadmin' },
        capability: 'AUTH_SIGN_IN',
        target: { kind: 'user', id: 'u1' },
        outcome: 'allow',
        metadata: { event: 'sign_in', method: 'password', network: { key: 'as123', prefix: '203.0.113.0/24', viaEdge: true } },
        timestamp: Timestamp.fromMillis(7000),
      }),
      'platform',
      null,
    );
    expect(row).toMatchObject({
      id: 'platform:s1',
      kind: 'sign_in',
      action: 'sign_in',
      outcome: 'allow',
      siteId: null,
      at: 7000,
      network: { key: 'as123', prefix: '203.0.113.0/24' },
    });
    expect(row.reason).toBeUndefined();
  });

  it('keeps the actor role in a sign-in row details', () => {
    const row = fromDecisionDoc(doc('s3', { ...base, capability: 'AUTH_SIGN_IN', actor: { type: 'user', userId: 'u1', role: 'superadmin' } }), 'platform', null);
    expect(row.details.role).toBe('superadmin');
  });

  it('is a sign-in even when denied, and names the second factor', () => {
    const row = fromDecisionDoc(doc('s2', { ...base, capability: 'AUTH_SECOND_FACTOR' }), 'platform', null);
    expect(row).toMatchObject({ kind: 'sign_in', action: 'second_factor', outcome: 'deny', reason: 'not_a_member' });
  });
});

describe('fromFindingDoc', () => {
  it.each([
    [{ actor: 'apiKey:k1' }, { type: 'api_key', id: 'k1' }],
    [{ actor: 'machine:m1' }, { type: 'machine', id: 'm1' }],
    [{ actor: 'system:talon_runner' }, { type: 'system', id: 'talon_runner' }],
    [{ userId: 'u1' }, { type: 'user', id: 'u1' }],
  ])('reads the actor of subject %j', (subject, actor) => {
    expect(fromFindingDoc(doc('f2', { rule: 'destructive_burst', subject, detectedAt: 1 })).actor).toEqual(actor);
  });

  it('maps a finding, ordering by detectedAt', () => {
    const row = fromFindingDoc(
      doc('f1', {
        rule: 'mfa_removed',
        severity: 'high',
        title: 'mfa removed',
        summary: 'a user lost mfa',
        subject: { userId: 'u1', siteId: 'site-a' },
        at: 900,
        facts: [{ label: 'who', value: 'u1' }],
        rowIds: ['change:h1'],
        detectedAt: 1500,
        emailedAt: 1600,
        digestedAt: null,
      }),
    );
    expect(row).toMatchObject({
      id: 'finding:f1',
      kind: 'flagged',
      at: 1500,
      actor: { type: 'user', id: 'u1' },
      siteId: 'site-a',
      action: 'mfa_removed',
      outcome: null,
      severity: 'high',
    });
    expect(row.details).toMatchObject({
      title: 'mfa removed',
      rowIds: ['change:h1'],
      rowsAt: 900,
      emailedAt: 1600,
      digestedAt: null,
    });
  });
});
