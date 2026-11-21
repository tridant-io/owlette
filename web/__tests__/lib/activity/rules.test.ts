/**
 * @jest-environment node
 */

import {
  DESTRUCTIVE_BURST,
  REFUSAL_BURST,
  SECOND_FACTOR_BURST,
  WINDOW_MS,
  evaluateRules,
  type RuleInput,
} from '@/lib/activity/rules';
import type { ActivityRow } from '@/lib/activity/types';

const T0 = 1_000 * WINDOW_MS; // a bucket boundary

let n = 0;
function row(over: Partial<ActivityRow>): ActivityRow {
  n += 1;
  return {
    id: `change:r${n}`,
    kind: 'change',
    at: T0,
    actor: { type: 'user', id: 'u1' },
    siteId: 'site-a',
    action: 'x',
    outcome: null,
    details: {},
    ...over,
  };
}

const run = (rows: ActivityRow[], over: Partial<RuleInput> = {}) =>
  evaluateRules({ rows, knownNetworks: {}, hasHistory: {}, siteRoles: {}, ...over });

const many = (count: number, make: (i: number) => Partial<ActivityRow>) =>
  Array.from({ length: count }, (_, i) => row({ at: T0 + i * 1000, ...make(i) }));

describe('single-row rules', () => {
  it('superadmin_promoted fires only for a promotion to superadmin', () => {
    const hit = row({ action: 'user_mutated:promoted', details: { from: 'member', to: 'superadmin' }, target: { id: 'u9' } });
    const miss = row({ action: 'user_mutated:promoted', details: { to: 'admin' } });
    const out = run([hit, miss]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: `superadmin_promoted:${hit.id}`,
      rule: 'superadmin_promoted',
      severity: 'high',
      title: 'superadmin promoted',
      summary: 'u1 made u9 a superadmin.',
      rowIds: [hit.id],
    });
    expect(run([miss, hit])[0].id).toBe(out[0].id);
  });

  it('mfa_removed fires for a disable and a forced reset', () => {
    const a = row({ action: 'user_mutated:mfa_disabled', target: { id: 'u9' } });
    const b = row({ action: 'user_mutated:mfa_force_reset', target: { id: 'u8' } });
    const out = run([a, b, row({ action: 'user_mutated:demoted' })]);
    expect(out.map((f) => [f.id, f.title, f.summary])).toEqual([
      [`mfa_removed:${a.id}`, '2fa removed', 'u1 turned off 2fa for u9.'],
      [`mfa_removed:${b.id}`, '2fa removed', 'u1 force-reset 2fa for u8.'],
    ]);
  });

  it('site_deleted needs an allowed platform SITE_DELETE row', () => {
    const hit = row({ id: 'platform:d1', kind: 'refused', siteId: null, action: 'SITE_DELETE', outcome: 'allow', target: { id: 's1' } });
    const denied = row({ kind: 'refused', action: 'SITE_DELETE', outcome: 'deny' });
    const out = run([hit, denied]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'site_deleted:platform:d1',
      severity: 'high',
      title: 'site deleted',
      summary: 'u1 deleted site s1.',
    });
  });

  it('ownership_transferred and user_deleted are digest findings', () => {
    const o = row({ action: 'site_member_mutated:ownership_transferred', target: { id: 'u2' } });
    const d = row({ action: 'user_mutated:soft_deleted', target: { id: 'u3' } });
    const out = run([o, d]);
    expect(out.map((f) => [f.id, f.severity, f.title, f.summary])).toEqual([
      [`ownership_transferred:${o.id}`, 'digest', 'site ownership transferred', 'u1 transferred ownership of site site-a to u2.'],
      [`user_deleted:${d.id}`, 'digest', 'user deleted', 'u1 deleted the account u3.'],
    ]);
    expect(run([d, o]).map((f) => f.id).sort()).toEqual(out.map((f) => f.id).sort());
  });

  it('ids never contain a slash', () => {
    const r = row({ id: 'change:a/b', action: 'user_mutated:mfa_disabled' });
    expect(run([r])[0].id).toBe('mfa_removed:change:a_b');
  });
});

describe('second_factor_burst', () => {
  const fail = (i: number) => ({ kind: 'sign_in' as const, action: 'second_factor', outcome: 'deny' as const, at: T0 + i * 1000 });

  it('fires at the threshold', () => {
    const out = run(many(SECOND_FACTOR_BURST, fail));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: `second_factor_burst:u1:${1000}`,
      severity: 'high',
      title: 'second factor burst',
      summary: '5 failed sign-in or second-factor attempts for u1 within 15 minutes.',
    });
  });

  it('stays quiet one under, or when spread wider than the window', () => {
    expect(run(many(SECOND_FACTOR_BURST - 1, fail))).toEqual([]);
    expect(run(many(SECOND_FACTOR_BURST, (i) => ({ ...fail(i), at: T0 + i * WINDOW_MS })))).toEqual([]);
  });

  it('does not count passed second factors', () => {
    const passed = (i: number) => ({ ...fail(i), outcome: 'allow' as const });
    expect(run(many(SECOND_FACTOR_BURST, passed))).toEqual([]);
  });

  it('keeps its id when a later scan sees more rows', () => {
    const rows = many(SECOND_FACTOR_BURST, fail);
    const later = [...rows, row({ ...fail(7) })];
    expect(run(later).map((f) => f.id)).toEqual(run(rows).map((f) => f.id));
  });
});

describe('destructive_burst', () => {
  const kill = (i: number) => ({ action: 'machine_command_dispatched:reboot_machine', at: T0 + i * 1000 });

  it('fires at the threshold across the destructive verbs', () => {
    const actions = ['machine.remove', 'uninstall', 'uninstall_software', 'member_removed', 'agent_token.revoke'];
    const out = run(many(DESTRUCTIVE_BURST, (i) => ({ action: `x:${actions[i]}` })));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'destructive_burst:user:u1:1000',
      severity: 'high',
      title: 'destructive burst',
      summary: 'u1 made 5 destructive changes within 15 minutes.',
    });
  });

  it('counts a site delete and a user soft delete, but not a bare deleted verb elsewhere', () => {
    expect(run(many(5, (i) => ({ action: i < 4 ? 'user_mutated:soft_deleted' : 'site_mutated:deleted' }))).filter((f) => f.rule === 'destructive_burst')).toHaveLength(1);
    expect(run(many(5, () => ({ action: 'process_mutated:deleted' }))).filter((f) => f.rule === 'destructive_burst')).toEqual([]);
  });

  it("counts a machine moved out of a site once, not the move's request, mint or arrival rows", () => {
    const burst = (verb: string) =>
      run(many(DESTRUCTIVE_BURST, () => ({ action: `site_mutated:${verb}` }))).filter((f) => f.rule === 'destructive_burst');
    expect(burst('machine.move_out')).toHaveLength(1);
    for (const verb of [
      'machine.move_request',
      'machine.move_mint',
      'machine.move_in',
      'machine.move',
      'machine.move_cancel',
      'machine.move_refused',
    ]) {
      expect(burst(verb)).toEqual([]);
    }
  });

  it('stays quiet one under, and does not mix actors', () => {
    expect(run(many(DESTRUCTIVE_BURST - 1, kill))).toEqual([]);
    expect(run(many(DESTRUCTIVE_BURST, (i) => ({ ...kill(i), actor: { type: 'user', id: `u${i % 2}` } })))).toEqual([]);
  });

  it('keeps its id across overlapping scans', () => {
    const rows = many(DESTRUCTIVE_BURST, kill);
    expect(run([...rows, row(kill(9))]).map((f) => f.id)).toEqual(run(rows).map((f) => f.id));
  });
});

describe('burst subjects', () => {
  const kill = (i: number) => ({ action: 'machine_command_dispatched:reboot_machine', at: T0 + i * 1000 });
  const subjectOf = (actor: ActivityRow['actor']) =>
    run(many(DESTRUCTIVE_BURST, (i) => ({ ...kill(i), actor })))[0].subject;

  it('names a user by userId, so the user filter finds it', () => {
    expect(subjectOf({ type: 'user', id: 'u1' })).toMatchObject({ userId: 'u1' });
  });

  it('names every other actor in the string form the change rows use', () => {
    expect(subjectOf({ type: 'api_key', id: 'k1' })).toMatchObject({ actor: 'apiKey:k1' });
    expect(subjectOf({ type: 'machine', id: 'm1' })).toMatchObject({ actor: 'machine:m1' });
    expect(subjectOf({ type: 'system', id: 'talon_runner' })).toMatchObject({ actor: 'system:talon_runner' });
  });

  it('does the same for a refusal burst and a single-row finding', () => {
    const refuse = (i: number) => ({ kind: 'refused' as const, action: 'MACHINE_REMOVE', outcome: 'deny' as const, reason: 'not_a_member', at: T0 + i * 1000 });
    const key = { type: 'api_key' as const, id: 'k1' };
    expect(run(many(REFUSAL_BURST, (i) => ({ ...refuse(i), actor: key })))[0].subject).toMatchObject({ actor: 'apiKey:k1' });
    const out = run([row({ action: 'user_mutated:mfa_disabled', actor: key, target: { id: 'u9' } })]);
    expect(out[0].subject).toMatchObject({ actor: 'apiKey:k1' });
  });
});

describe('refusal_burst', () => {
  const refuse = (i: number) => ({ kind: 'refused' as const, action: 'MACHINE_REMOVE', outcome: 'deny' as const, reason: 'not_a_member', at: T0 + i * 1000 });

  it('fires at the threshold as a digest', () => {
    const out = run(many(REFUSAL_BURST, refuse));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'refusal_burst:user:u1:1000',
      severity: 'digest',
      title: 'refusal burst',
      summary: 'u1 was refused 20 times within 15 minutes.',
    });
  });

  it('stays quiet one under, and ignores rate limits, plan locks and auth rows', () => {
    expect(run(many(REFUSAL_BURST - 1, refuse))).toEqual([]);
    expect(run(many(REFUSAL_BURST, (i) => ({ ...refuse(i), reason: i % 2 ? 'rate_limited' : 'plan_locked' })))).toEqual([]);
    expect(run(many(REFUSAL_BURST, (i) => ({ ...refuse(i), kind: 'sign_in' as const, action: 'sign_in' }))).filter((f) => f.rule === 'refusal_burst')).toEqual([]);
  });

  it('keeps its id across overlapping scans', () => {
    const rows = many(REFUSAL_BURST, refuse);
    expect(run([...rows, row(refuse(25))]).map((f) => f.id)).toEqual(run(rows).map((f) => f.id));
  });
});

describe('new_network_sign_in', () => {
  const signIn = (key: string, role = 'member', uid = 'u1') =>
    row({ kind: 'sign_in', action: 'sign_in', outcome: 'allow', actor: { type: 'user', id: uid }, network: { key, prefix: null }, details: { role } });
  const history = { hasHistory: { u1: true }, knownNetworks: { u1: ['asn:1'] } };

  it('is high for a superadmin on an unseen network', () => {
    const r = signIn('asn:2', 'superadmin');
    const out = run([r], history);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'new_network_sign_in:u1:asn:2',
      severity: 'high',
      title: 'sign-in from a new network',
      summary: 'u1 signed in from a network they have not used before.',
    });
    expect(run([r, signIn('asn:2', 'superadmin')], history)).toHaveLength(1);
  });

  it('is a digest for a site owner or admin, and silent for anyone else', () => {
    const r = signIn('asn:2');
    expect(run([r], { ...history, siteRoles: { u1: 'owner' } })[0].severity).toBe('digest');
    expect(run([r], { ...history, siteRoles: { u1: 'admin' } })[0].severity).toBe('digest');
    expect(run([r], { ...history, siteRoles: { u1: 'member' } })).toEqual([]);
    expect(run([r], { ...history, siteRoles: { u1: null } })).toEqual([]);
  });

  it('never fires for a known network, an unknown network, no history, or a denied sign-in', () => {
    const sa = (key: string) => signIn(key, 'superadmin');
    expect(run([sa('asn:1')], history)).toEqual([]);
    expect(run([sa('unknown')], history)).toEqual([]);
    expect(run([sa('asn:2')], { ...history, hasHistory: { u1: false } })).toEqual([]);
    expect(run([sa('asn:2')], { knownNetworks: {} })).toEqual([]);
    expect(run([{ ...sa('asn:2'), outcome: 'deny' }], history)).toEqual([]);
    expect(run([{ ...sa('asn:2'), action: 'second_factor' }], history)).toEqual([]);
  });
});

describe('labels', () => {
  const labels = { u1: 'ann@example.test', u9: 'bob@example.test' };

  it('prints emails in summaries and facts, keeps uids in ids and subject, and falls back to the uid', () => {
    const hit = row({ action: 'user_mutated:promoted', details: { to: 'superadmin' }, target: { id: 'u9' } });
    const [f] = run([hit], { labels });
    expect(f.summary).toBe('ann@example.test made bob@example.test a superadmin.');
    expect(f.facts).toEqual([
      { label: 'by', value: 'ann@example.test' },
      { label: 'user', value: 'bob@example.test' },
      { label: 'from', value: 'unknown' },
    ]);
    expect(f.subject).toMatchObject({ userId: 'u1' });
    expect(f.id).toBe(`superadmin_promoted:${hit.id}`);
    expect(run([hit], { labels: { u9: 'bob@example.test' } })[0].summary).toBe('u1 made bob@example.test a superadmin.');
  });

  it('labels the user in a second factor burst', () => {
    const rows = many(SECOND_FACTOR_BURST, () => ({ kind: 'sign_in', action: 'second_factor', outcome: 'deny' }));
    const [f] = run(rows, { labels });
    expect(f.summary).toContain('for ann@example.test within');
    expect(f.facts[0]).toEqual({ label: 'user', value: 'ann@example.test' });
    expect(f.subject).toEqual({ userId: 'u1' });
  });
});
