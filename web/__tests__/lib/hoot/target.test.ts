/**
 * @jest-environment node
 *
 * The shared hoot target model. What these pin, beyond the plain shapes:
 *
 * - readChatTarget FAILS CLOSED. The reader it replaces (`useHoot.ts`) was
 *   `data.targetMachineId || '__site__'`, so a chat doc it could not understand
 *   dispatched site-wide. The naive reader is reproduced below as the negative
 *   control: on the same malformed docs it yields the site sentinel while
 *   readChatTarget refuses.
 * - The legacy write fields NEVER WIDEN. An old tab still runs that naive
 *   reader, so a subset must leave its first id in `targetMachineId` — the old
 *   tab then narrows to one machine instead of widening to the site.
 * - A one-machine site keeps the single path (`effectiveFanOut`).
 * - normalizeSelection is gated on `loaded`: pruning against a machine list that
 *   has not arrived yet would empty a valid selection.
 */

import {
  MACHINE_ID_RE,
  MAX_TARGET_MACHINES,
  SITE_TARGET_ID,
  approvalResponseIds,
  chatTargetFields,
  effectiveFanOut,
  formatTargetLabel,
  isApprovalResume,
  isValidMachineId,
  neverWidenLegacyMachineId,
  normalizeSelection,
  readChatTarget,
  readHootTurnMetadata,
  toggleAll,
  toggleMachine,
  type HootTarget,
} from '@/lib/hoot/target';

/** The pre-task reader (`useHoot.ts:819-823`) — the negative control. */
function naiveLegacyReader(data: Record<string, unknown>): string {
  return data.targetType === 'site'
    ? SITE_TARGET_ID
    : (typeof data.targetMachineId === 'string' && data.targetMachineId) || SITE_TARGET_ID;
}

describe('isValidMachineId / MACHINE_ID_RE', () => {
  it.each(['kiosk-01', 'KIOSK_01', 'host.local', 'a', 'a'.repeat(64)])(
    'accepts the hostname %s',
    (id) => {
      expect(isValidMachineId(id)).toBe(true);
      expect(MACHINE_ID_RE.test(id)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['a path separator', 'sites/site-A'],
    ['a space', 'kiosk 01'],
    ['over the length cap', 'a'.repeat(65)],
    ['a relative path segment', '.'],
    ['a parent path segment', '..'],
    ['the site sentinel', SITE_TARGET_ID],
    ['a reserved firestore id', '__proto__'],
  ])('rejects %s', (_label, id) => {
    expect(isValidMachineId(id)).toBe(false);
  });

  it.each([[null], [undefined], [42], [['kiosk-01']], [{}]])(
    'rejects the non-string %p',
    (value) => {
      expect(isValidMachineId(value)).toBe(false);
    },
  );
});

describe('readChatTarget', () => {
  it('reads an explicit set from targetMachineIds', () => {
    expect(
      readChatTarget({
        targetType: 'machines',
        targetMachineIds: ['kiosk-01', 'kiosk-02'],
        targetMachineId: 'kiosk-01',
        machineName: 'kiosk-01, kiosk-02',
      }),
    ).toEqual({ ok: true, target: { machineIds: ['kiosk-01', 'kiosk-02'] } });
  });

  it('reads a null targetMachineIds as every machine', () => {
    expect(readChatTarget({ targetType: 'site', targetMachineIds: null })).toEqual({
      ok: true,
      target: { machineIds: null },
    });
  });

  it('dedupes a stored set, keeping first-appearance order', () => {
    expect(readChatTarget({ targetMachineIds: ['b', 'a', 'b'] })).toEqual({
      ok: true,
      target: { machineIds: ['b', 'a'] },
    });
  });

  // The four legacy shapes seeded at e2e/helpers/coverageSeed.ts:189-240, plus the
  // talon chats written by lib/talons/hootOutput.server.ts:282-296.
  it('reads a legacy machine chat (coverageSeed e2e-cortex-user-*)', () => {
    expect(
      readChatTarget({
        userId: 'user-1',
        siteId: 'site-A',
        title: 'Deployment triage',
        category: 'Operations',
        targetType: 'machine',
        targetMachineId: 'e2e-machine',
        machineName: 'e2e-machine',
        source: 'user',
      }),
    ).toEqual({ ok: true, target: { machineIds: ['e2e-machine'] } });
  });

  it('reads a legacy site / autonomous chat (coverageSeed e2e-cortex-auto-*)', () => {
    expect(
      readChatTarget({
        siteId: 'site-A',
        title: 'Nightly auto investigation',
        category: 'Autonomous',
        targetType: 'site',
        targetMachineId: null,
        machineName: 'All Machines',
        source: 'autonomous',
      }),
    ).toEqual({ ok: true, target: { machineIds: null } });
  });

  it('reads a legacy autonomous machine chat (api/hoot/autonomous)', () => {
    expect(
      readChatTarget({
        source: 'autonomous',
        eventId: 'evt-1',
        siteId: 'site-A',
        targetType: 'machine',
        targetMachineId: 'kiosk-01',
        machineName: 'lobby kiosk',
      }),
    ).toEqual({ ok: true, target: { machineIds: ['kiosk-01'] } });
  });

  it.each([
    ['a talon machine chat', { targetType: 'machine', targetMachineId: 'kiosk-01' }, ['kiosk-01']],
    ['a talon site chat', { targetType: 'site', targetMachineId: null }, null],
  ])('reads %s', (_label, fields, expected) => {
    expect(readChatTarget({ source: 'talon', talonId: 't1', ...fields })).toEqual({
      ok: true,
      target: { machineIds: expected },
    });
  });

  it.each([
    ['no target fields at all', {}],
    ['a machine chat with no id', { targetType: 'machine' }],
    ['a machine chat with a null id', { targetType: 'machine', targetMachineId: null }],
    ['a machine chat with a path-traversing id', { targetType: 'machine', targetMachineId: '../x' }],
    ['an unknown targetType', { targetType: 'fleet', targetMachineId: 'kiosk-01' }],
    ['an empty stored set', { targetMachineIds: [] }],
    ['a set with an invalid id', { targetMachineIds: ['kiosk-01', 'a/b'] }],
    ['a non-array set', { targetMachineIds: 'kiosk-01' }],
    ['a set over the cap', { targetMachineIds: Array.from({ length: MAX_TARGET_MACHINES + 1 }, (_v, i) => `m${i}`) }],
  ])('refuses %s', (_label, doc) => {
    expect(readChatTarget(doc)).toEqual({ ok: false });
  });

  it.each([[null], [undefined], ['chat'], [42]])('refuses the non-document %p', (doc) => {
    expect(readChatTarget(doc)).toEqual({ ok: false });
  });

  it('NARROWS a null set that still names a legacy machine (deploy/rollback skew)', () => {
    // An old tab writing the legacy trio over a new-field doc leaves the two
    // halves disagreeing. `null` is the widest value there is, so never-widen
    // takes the single machine the doc still names.
    expect(
      readChatTarget({
        targetType: 'machine',
        targetMachineId: 'kiosk-01',
        targetMachineIds: null,
        machineName: 'kiosk-01',
      }),
    ).toEqual({ ok: true, target: { machineIds: ['kiosk-01'] } });
  });

  it('reads a null set with no legacy machine as every machine', () => {
    expect(readChatTarget({ targetType: 'machine', targetMachineIds: null })).toEqual({
      ok: true,
      target: { machineIds: null },
    });
  });

  it('returns a FRESH refusal each time, so a mutating caller cannot poison later reads', () => {
    const first = readChatTarget({});
    const second = readChatTarget({});
    expect(first).not.toBe(second);

    (first as { ok: boolean }).ok = true;
    expect(readChatTarget({})).toEqual({ ok: false });
  });

  it('does not fall back to a stale targetType when the stored set is corrupt', () => {
    // A corrupt subset beside a leftover `targetType:'site'` must not read back as
    // the whole site — the new field is authoritative once present.
    expect(
      readChatTarget({ targetType: 'site', targetMachineIds: ['kiosk-01', 'a/b'] }),
    ).toEqual({ ok: false });
  });

  it('fails closed where the pre-task reader widened to the site (negative control)', () => {
    const malformed: Record<string, unknown>[] = [
      {},
      { targetType: 'machine' },
      { targetType: 'fleet', targetMachineId: null },
      { targetMachineIds: [] },
    ];

    for (const doc of malformed) {
      expect(naiveLegacyReader(doc)).toBe(SITE_TARGET_ID);
      expect(readChatTarget(doc)).toEqual({ ok: false });
    }
  });
});

describe('chatTargetFields', () => {
  it('writes a site chat', () => {
    expect(chatTargetFields({ machineIds: null })).toEqual({
      targetType: 'site',
      targetMachineIds: null,
      targetMachineId: null,
      machineName: 'All Machines',
    });
  });

  it('writes a single-machine chat, defaulting the label to the id', () => {
    expect(chatTargetFields({ machineIds: ['kiosk-01'] })).toEqual({
      targetType: 'machine',
      targetMachineIds: ['kiosk-01'],
      targetMachineId: 'kiosk-01',
      machineName: 'kiosk-01',
    });
  });

  it('keeps a caller-supplied display name for a single machine', () => {
    expect(chatTargetFields({ machineIds: ['kiosk-01'] }, { label: 'lobby kiosk' }).machineName).toBe(
      'lobby kiosk',
    );
  });

  it('writes a subset as targetType machines with a formatted label', () => {
    expect(chatTargetFields({ machineIds: ['kiosk-01', 'kiosk-02', 'kiosk-03'] })).toEqual({
      targetType: 'machines',
      targetMachineIds: ['kiosk-01', 'kiosk-02', 'kiosk-03'],
      targetMachineId: 'kiosk-01',
      machineName: 'kiosk-01, kiosk-02 +1',
    });
  });

  it("copies the id array rather than aliasing the caller's", () => {
    const target: HootTarget = { machineIds: ['kiosk-01', 'kiosk-02'] };
    const fields = chatTargetFields(target);
    expect(fields.targetMachineIds).not.toBe(target.machineIds);
    expect(fields.targetMachineIds).toEqual(target.machineIds);
  });

  it('NEVER WIDENS: an old tab reading the written doc narrows to one machine', () => {
    const fields = chatTargetFields({ machineIds: ['kiosk-01', 'kiosk-02', 'kiosk-03'] });
    expect(naiveLegacyReader(fields as unknown as Record<string, unknown>)).toBe('kiosk-01');
    expect(naiveLegacyReader(fields as unknown as Record<string, unknown>)).not.toBe(SITE_TARGET_ID);
  });

  it('round-trips through readChatTarget', () => {
    for (const target of [
      { machineIds: null },
      { machineIds: ['kiosk-01'] },
      { machineIds: ['kiosk-01', 'kiosk-02'] },
    ] as HootTarget[]) {
      expect(readChatTarget(chatTargetFields(target))).toEqual({ ok: true, target });
    }
  });

  it('throws rather than persisting an empty selection', () => {
    expect(() => chatTargetFields({ machineIds: [] })).toThrow(/empty machine set/);
  });
});

describe('neverWidenLegacyMachineId', () => {
  it('maps every machine to the site sentinel', () => {
    expect(neverWidenLegacyMachineId({ machineIds: null })).toBe(SITE_TARGET_ID);
  });

  it('narrows a subset to its first id, so old sweep code cannot fire it site-wide', () => {
    expect(neverWidenLegacyMachineId({ machineIds: ['kiosk-02', 'kiosk-03'] })).toBe('kiosk-02');
  });

  it('throws on an empty selection instead of returning the sentinel', () => {
    expect(() => neverWidenLegacyMachineId({ machineIds: [] })).toThrow(/empty machine set/);
  });
});

describe('formatTargetLabel', () => {
  it.each([
    [null, 'all machines'],
    [[], 'no machines'],
    [['kiosk-01'], 'kiosk-01'],
    [['kiosk-01', 'kiosk-02'], 'kiosk-01, kiosk-02'],
    [['kiosk-01', 'kiosk-02', 'kiosk-03', 'kiosk-04', 'kiosk-05'], 'kiosk-01, kiosk-02 +3'],
  ])('labels %p as %s', (ids, expected) => {
    expect(formatTargetLabel(ids)).toBe(expected);
  });
});

describe('effectiveFanOut', () => {
  it('is false for one explicit machine, whatever the site holds', () => {
    expect(effectiveFanOut({ machineIds: ['kiosk-01'] }, 7)).toBe(false);
  });

  it('is true for two or more explicit machines', () => {
    expect(effectiveFanOut({ machineIds: ['kiosk-01', 'kiosk-02'] }, 7)).toBe(true);
  });

  it('keeps a ONE-MACHINE site on the single path when all machines are ticked', () => {
    expect(effectiveFanOut({ machineIds: null }, 1)).toBe(false);
  });

  it('fans out "all machines" on a multi-machine site', () => {
    expect(effectiveFanOut({ machineIds: null }, 3)).toBe(true);
  });

  it('fans out "all machines" on an empty site', () => {
    expect(effectiveFanOut({ machineIds: null }, 0)).toBe(true);
  });
});

describe('normalizeSelection', () => {
  const siteIds = ['kiosk-01', 'kiosk-02', 'kiosk-03'];

  it('returns the input UNCHANGED while the machine list is still loading', () => {
    const selection: HootTarget = { machineIds: ['kiosk-01', 'gone'] };
    expect(normalizeSelection(selection, [], false)).toBe(selection);
    expect(normalizeSelection(selection, siteIds, false)).toBe(selection);
  });

  it('prunes ids that have left the site', () => {
    expect(normalizeSelection({ machineIds: ['kiosk-01', 'retired'] }, siteIds, true)).toEqual({
      machineIds: ['kiosk-01'],
    });
  });

  it('collapses a set covering every site machine to the dynamic "all"', () => {
    expect(normalizeSelection({ machineIds: [...siteIds] }, siteIds, true)).toEqual({
      machineIds: null,
    });
  });

  it('does not widen an empty selection when the site has no machines', () => {
    expect(normalizeSelection({ machineIds: [] }, [], true)).toEqual({ machineIds: [] });
  });

  it('leaves the dynamic "all" alone', () => {
    const selection: HootTarget = { machineIds: null };
    expect(normalizeSelection(selection, siteIds, true)).toBe(selection);
  });

  it('returns the same object when nothing changed, so callers can memoize', () => {
    const selection: HootTarget = { machineIds: ['kiosk-01', 'kiosk-02'] };
    expect(normalizeSelection(selection, siteIds, true)).toBe(selection);
  });

  it('dedupes a repeated id', () => {
    expect(normalizeSelection({ machineIds: ['kiosk-01', 'kiosk-01'] }, siteIds, true)).toEqual({
      machineIds: ['kiosk-01'],
    });
  });
});

describe('toggleMachine / toggleAll', () => {
  const siteIds = ['kiosk-01', 'kiosk-02', 'kiosk-03'];

  it('spells out the rest of the site when one machine is unticked from "all"', () => {
    expect(toggleMachine({ machineIds: null }, 'kiosk-02', siteIds)).toEqual({
      machineIds: ['kiosk-01', 'kiosk-03'],
    });
  });

  it('adds a machine to an explicit set', () => {
    expect(toggleMachine({ machineIds: ['kiosk-01'] }, 'kiosk-03', siteIds)).toEqual({
      machineIds: ['kiosk-01', 'kiosk-03'],
    });
  });

  it('returns to the DYNAMIC "all" once the last box is ticked', () => {
    expect(toggleMachine({ machineIds: ['kiosk-01', 'kiosk-02'] }, 'kiosk-03', siteIds)).toEqual({
      machineIds: null,
    });
  });

  it('allows emptying the selection (send is disabled, never persisted)', () => {
    expect(toggleMachine({ machineIds: ['kiosk-01'] }, 'kiosk-01', siteIds)).toEqual({
      machineIds: [],
    });
  });

  it('unticking the only machine of a one-machine site empties the selection', () => {
    expect(toggleMachine({ machineIds: null }, 'kiosk-01', ['kiosk-01'])).toEqual({
      machineIds: [],
    });
  });

  it('clears everything from "all"', () => {
    expect(toggleAll({ machineIds: null }, siteIds)).toEqual({ machineIds: [] });
  });

  it.each([
    ['none', []],
    ['a partial set', ['kiosk-02']],
  ])('ticks all from %s', (_label, machineIds) => {
    expect(toggleAll({ machineIds }, siteIds)).toEqual({ machineIds: null });
  });

  it('clears from an explicit set that already covers the whole site', () => {
    expect(toggleAll({ machineIds: [...siteIds] }, siteIds)).toEqual({ machineIds: [] });
  });
});

describe('approvalResponseIds / isApprovalResume', () => {
  const approvalMessage = (parts: unknown[]) => [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'restart it' }] },
    { id: 'a1', role: 'assistant', parts },
  ];

  it('returns the toolCallIds of approved AND denied parts on the final assistant turn', () => {
    const messages = approvalMessage([
      { type: 'text', text: 'I need approval.' },
      {
        type: 'tool-restartMachine',
        toolCallId: 'call-1',
        state: 'approval-responded',
        approval: { approved: true },
      },
      {
        type: 'dynamic-tool',
        toolName: 'killProcess',
        toolCallId: 'call-2',
        state: 'approval-responded',
        approval: { approved: false },
      },
    ]);

    expect(approvalResponseIds(messages)).toEqual(['call-1', 'call-2']);
    expect(isApprovalResume(messages)).toBe(true);
  });

  it('collects the WHOLE trailing assistant run, in history order', () => {
    // applyApprovalConsumption (repairMessages.ts) claims and dispatches every
    // assistant message after the last user one, so the binding check has to see
    // the same span — otherwise an approval in a non-final trailing message runs
    // without ever being checked against the set it was requested on.
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'restart it' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'tool-restartMachine', toolCallId: 'call-OLD', state: 'approval-responded' }],
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'tool-killProcess', toolCallId: 'call-NEW', state: 'approval-responded' }],
      },
    ];

    expect(approvalResponseIds(messages)).toEqual(['call-OLD', 'call-NEW']);
    expect(isApprovalResume(messages)).toBe(true);
  });

  it('sees an approval behind a trailing non-assistant message', () => {
    // `role: 'system'` is a legal UIMessage role, and `applyApprovalConsumption`
    // claims by index (everything after the last user message), not by an
    // unbroken run — so ending the scan at one would leave this approval
    // claimed, executed, and never checked against the set it was requested on.
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'run it' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'tool-x', toolCallId: 'call-1', state: 'approval-responded' }],
      },
      { id: 's1', role: 'system', parts: [] },
    ];

    expect(approvalResponseIds(messages)).toEqual(['call-1']);
    expect(isApprovalResume(messages)).toBe(true);
  });

  it('stops at the last user message even when the run is long', () => {
    const messages = [
      {
        id: 'a0',
        role: 'assistant',
        parts: [{ type: 'tool-x', toolCallId: 'call-BEFORE', state: 'approval-responded' }],
      },
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'again' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'tool-x', toolCallId: 'call-AFTER', state: 'approval-responded' }],
      },
    ];
    expect(approvalResponseIds(messages)).toEqual(['call-AFTER']);
  });

  it('dedupes a repeated toolCallId across the run', () => {
    expect(
      approvalResponseIds([
        { id: 'u1', role: 'user', parts: [] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [{ type: 'tool-x', toolCallId: 'call-1', state: 'approval-responded' }],
        },
        {
          id: 'a2',
          role: 'assistant',
          parts: [{ type: 'tool-x', toolCallId: 'call-1', state: 'approval-responded' }],
        },
      ]),
    ).toEqual(['call-1']);
  });

  it('skips a malformed message in the run rather than ending the scan', () => {
    expect(
      approvalResponseIds([
        { id: 'u1', role: 'user', parts: [] },
        { id: 'a1', role: 'assistant', parts: 'broken' },
        {
          id: 'a2',
          role: 'assistant',
          parts: [{ type: 'tool-x', toolCallId: 'call-1', state: 'approval-responded' }],
        },
      ]),
    ).toEqual(['call-1']);
  });

  it('dedupes a repeated toolCallId', () => {
    const messages = approvalMessage([
      { type: 'tool-restartMachine', toolCallId: 'call-1', state: 'approval-responded' },
      { type: 'tool-restartMachine', toolCallId: 'call-1', state: 'approval-responded' },
    ]);
    expect(approvalResponseIds(messages)).toEqual(['call-1']);
  });

  it('ignores an approval on an EARLIER assistant turn', () => {
    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'tool-restartMachine', toolCallId: 'call-1', state: 'approval-responded' }],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'never mind' }] },
    ];
    expect(approvalResponseIds(messages)).toEqual([]);
    expect(isApprovalResume(messages)).toBe(false);
  });

  it.each([
    ['a still-pending approval request', 'approval-requested'],
    ['a finished tool call', 'output-available'],
    ['an errored tool call', 'output-error'],
  ])('is not a resume for %s', (_label, state) => {
    expect(isApprovalResume(approvalMessage([{ type: 'tool-x', toolCallId: 'c', state }]))).toBe(
      false,
    );
  });

  it.each([
    ['an empty history', []],
    ['a non-array body', 'messages'],
    ['null', null],
  ])('is not a resume for %s', (_label, messages) => {
    expect(approvalResponseIds(messages)).toEqual([]);
    expect(isApprovalResume(messages)).toBe(false);
  });

  it('ignores non-tool parts and malformed entries', () => {
    const messages = approvalMessage([
      { type: 'text', text: 'hi', state: 'approval-responded' },
      { type: 'tool-x', state: 'approval-responded' },
      { type: 'tool-x', toolCallId: '', state: 'approval-responded' },
      null,
    ]);
    expect(approvalResponseIds(messages)).toEqual([]);
  });
});

describe('readHootTurnMetadata', () => {
  const valid = {
    hoot: {
      turnId: 'turn_abc',
      machineIds: ['kiosk-01', 'kiosk-02'],
      via: 'mention',
      skipped: { offline: ['kiosk-03'], disabled: ['kiosk-04'] },
    },
  };

  it('reads a well-formed stamp', () => {
    expect(readHootTurnMetadata(valid)).toEqual({
      turnId: 'turn_abc',
      machineIds: ['kiosk-01', 'kiosk-02'],
      via: 'mention',
      skipped: { offline: ['kiosk-03'], disabled: ['kiosk-04'] },
      // Absent on a stamp written before the field existed, which is the
      // narrower reading: the label names the machines rather than claiming the
      // turn covered everything online.
      dynamic: false,
    });
  });

  it.each(['chat', 'mention', 'resume', 'followup', 'talon', 'machine'])('reads a stamp whose turn came by %s', (via) => {
    // a source the reader does not know would cost the transcript its label
    expect(readHootTurnMetadata({ hoot: { ...valid.hoot, via } })?.via).toBe(via);
  });

  it('reads the dynamic flag, and only from a literal true', () => {
    expect(readHootTurnMetadata({ hoot: { ...valid.hoot, dynamic: true } })?.dynamic).toBe(true);
    // The stamp is re-sent by the client, so a truthy-but-not-true value must
    // not be enough to widen what the approval prompt claims.
    for (const forged of ['true', 1, {}, [], 'yes']) {
      expect(readHootTurnMetadata({ hoot: { ...valid.hoot, dynamic: forged } })?.dynamic).toBe(
        false,
      );
    }
  });

  it('defaults a missing or malformed skipped block to empty lists', () => {
    expect(readHootTurnMetadata({ hoot: { ...valid.hoot, skipped: undefined } })?.skipped).toEqual({
      offline: [],
      disabled: [],
    });
    expect(
      readHootTurnMetadata({ hoot: { ...valid.hoot, skipped: { offline: ['a/b'] } } })?.skipped,
    ).toEqual({ offline: [], disabled: [] });
  });

  it.each([
    ['no metadata', undefined],
    ['a null metadata', null],
    ['metadata without a hoot block', { other: 1 }],
    ['a non-object hoot block', { hoot: 'targets' }],
    ['a missing turnId', { hoot: { ...valid.hoot, turnId: undefined } }],
    ['an empty turnId', { hoot: { ...valid.hoot, turnId: '' } }],
    ['an unknown source', { hoot: { ...valid.hoot, via: 'cron' } }],
    ['no machines', { hoot: { ...valid.hoot, machineIds: [] } }],
    ['an invalid machine id', { hoot: { ...valid.hoot, machineIds: ['kiosk-01', '../x'] } }],
    [
      'more machines than the cap',
      {
        hoot: {
          ...valid.hoot,
          machineIds: Array.from({ length: MAX_TARGET_MACHINES + 1 }, (_v, i) => `m${i}`),
        },
      },
    ],
  ])('returns null for %s, so the caller falls back to its own label', (_label, metadata) => {
    expect(readHootTurnMetadata(metadata)).toBeNull();
  });
});
