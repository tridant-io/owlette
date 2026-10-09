/** @jest-environment node */

/**
 * Audit coverage for the two turn-lifecycle routes (talons wave 5.4), and the
 * turn-start contract `/api/hoot` owns since multi-machine targeting.
 *
 * POST /api/hoot      — resolves the turn's machines, claims the per-chat lock,
 *                       and audits `chat_mutated` / `send` once that write has
 *                       committed, never before.
 * POST /api/hoot/stop — cancels one; audits `chat_mutated` / `cancel_turn` only
 *                       when `finishTurn` actually wrote the terminal state. The
 *                       route is idempotent and always 200s, so a no-op stop
 *                       must not manufacture a row.
 *
 * Neither emit may carry message content, and neither may change the response.
 *
 * The target describes cover what the route decides before anything is claimed:
 * the api-key tier ceiling, the cross-site chat guard, which machines a body
 * resolves to (legacy and new), when an `@mention` may narrow a turn, and the
 * approval binding — an approval runs on the machines it was requested on or
 * not at all.
 */

import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  __esModule: true,
  withRateLimit: (handler: unknown) => handler,
  getUserIdFromSession: jest.fn(async () => null),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

const mockVerifyAccess = jest.fn();
const mockResolveHootTargets = jest.fn();
jest.mock('@/lib/hoot-utils.server', () => {
  // Inline: jest hoists the factory, so `instanceof` needs the class defined here.
  class SiteAccessError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'SiteAccessError';
      this.code = code;
    }
  }
  return {
    __esModule: true,
    SiteAccessError,
    verifyUserSiteAccess: (...a: unknown[]) => mockVerifyAccess(...a),
    resolveHootTargets: (...a: unknown[]) => mockResolveHootTargets(...a),
  };
});

const mockAcquireTurnLock = jest.fn();
const mockReadTurnRecord = jest.fn();
const mockFinishTurn = jest.fn();
jest.mock('@/lib/hoot/turnStore.server', () => {
  class TurnActiveError extends Error {}
  class ApprovalStaleError extends Error {}
  return {
    __esModule: true,
    TurnActiveError,
    ApprovalStaleError,
    generateTurnId: () => 'turn-fixed',
    acquireTurnLock: (...a: unknown[]) => mockAcquireTurnLock(...a),
    readTurnRecord: (...a: unknown[]) => mockReadTurnRecord(...a),
    finishTurn: (...a: unknown[]) => mockFinishTurn(...a),
  };
});

const mockStartTurn = jest.fn();
jest.mock('@/lib/hoot/turnRunner.server', () => ({
  startTurn: (...a: unknown[]) => mockStartTurn(...a),
}));

jest.mock('ai', () => ({
  __esModule: true,
  createUIMessageStreamResponse: jest.fn(() => new Response('stream', { status: 200 })),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

// the real gate by default, which with PLAN_ENFORCEMENT unset answers before any read.
const mockRequireEntitlement = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  requireEntitlement: (...a: unknown[]) => mockRequireEntitlement(...a),
}));

const SITE = 'site-a';
const CHAT = 'chat-1';
const MACHINE = 'lobby-01';
const MACHINE_B = 'lobby-02';

/** `chats/{chatId}`; `null` means the doc does not exist yet (first turn). */
let chatDoc: Record<string, unknown> | null;

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'chats') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: chatDoc !== null, data: () => chatDoc ?? undefined }),
      }),
    };
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

import { POST as TURN } from '@/app/api/hoot/route';
import { POST as STOP } from '@/app/api/hoot/stop/route';
import { emitMutation } from '@/lib/auditLogClient';
import { problemPlanRequired } from '@/lib/apiErrors';
import { PLAN_REQUIRED_DETAIL } from '@/lib/plan.server';
import type { ResolvedAuth } from '@/lib/apiAuth.server';
import type { StartTurnParams } from '@/lib/hoot/turnRunner.server';

const { requireEntitlement: realRequireEntitlement } = jest.requireActual('@/lib/plan.server');

function controlRefusal() {
  return problemPlanRequired(PLAN_REQUIRED_DETAIL['owlette.hoot'], 'owlette.hoot');
}

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function authedKey(): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scopes: [{ resource: 'chat', id: '*', permissions: ['write'] }] as any,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
    },
  };
}

/** What `resolveHootTargets` hands back for a healthy single-machine turn. */
function resolvedOn(ids: string[], fanOut = ids.length !== 1) {
  return { ok: true, resolved: { ids, fanOut, skipped: { offline: [], disabled: [] } } };
}

function turnRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/hoot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'secret plans' }] }],
      siteId: SITE,
      machineId: MACHINE,
      machineName: 'Lobby',
      chatId: CHAT,
      ...body,
    }),
  });
}

function stopRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/hoot/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: CHAT, turnId: 'turn-fixed', ...body }),
  });
}

function startTurnParams(): StartTurnParams {
  return mockStartTurn.mock.calls[0][1] as StartTurnParams;
}

/** The request `resolveHootTargets` was asked to resolve. */
function resolveRequest(): { requested: string[] | null; mentions?: string[] } {
  return mockResolveHootTargets.mock.calls[0][2];
}

beforeEach(() => {
  jest.clearAllMocks();
  chatDoc = { userId: 'user-1', siteId: SITE };
  mockResolveAuth.mockResolvedValue(authedSession());
  mockVerifyAccess.mockResolvedValue({
    role: 'admin',
    isSuperadmin: false,
    isSiteAdmin: true,
    isSiteOwner: true,
  });
  mockResolveHootTargets.mockResolvedValue(resolvedOn([MACHINE]));
  // `PriorTurn | null`; null is "this chat has never run a turn".
  mockAcquireTurnLock.mockResolvedValue(null);
  mockReadTurnRecord.mockResolvedValue(null);
  mockStartTurn.mockReturnValue({ cancel: jest.fn(async () => {}) });
  mockFinishTurn.mockResolvedValue(true);
  mockRequireEntitlement.mockImplementation(realRequireEntitlement);
});

describe('POST /api/hoot — the payer plan', () => {
  it('refuses with 402 plan_required before claiming the lock or starting a turn', async () => {
    mockRequireEntitlement.mockResolvedValue(controlRefusal());

    const res = await TURN(turnRequest());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'plan_required', entitlement: 'owlette.hoot' });
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('refuses an approval resume the same way', async () => {
    mockRequireEntitlement.mockResolvedValue(controlRefusal());

    const res = await TURN(
      turnRequest({
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-restart_process',
                toolCallId: 'call-1',
                state: 'approval-responded',
                approval: { id: 'ap-1', approved: true },
              },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(402);
    expect(mockReadTurnRecord).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('starts the turn with enforcement off', async () => {
    const res = await TURN(turnRequest());
    expect(res.status).toBe(200);
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
    expect(mockStartTurn).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/hoot — turn-start audit', () => {
  it('emits one chat_mutated/send row after the lock is held, without message content', async () => {
    const res = await TURN(turnRequest());
    expect(res.status).toBe(200);

    expect(emitMutation).toHaveBeenCalledTimes(1);
    expect(emitMutation).toHaveBeenCalledWith({
      kind: 'chat_mutated',
      siteId: SITE,
      actor: 'user:user-1',
      targetId: CHAT,
      attributes: {
        verb: 'send',
        endpoint: '/api/hoot',
        method: 'POST',
        siteId: SITE,
        // The legacy single-target view is kept for readers that parse it;
        // `machineIds` is what the turn actually dispatches to.
        machineId: MACHINE,
        machineIds: [MACHINE],
        turnId: 'turn-fixed',
        supersede: false,
      },
    });
    // What was said is not audit material.
    expect(JSON.stringify((emitMutation as jest.Mock).mock.calls[0][0])).not.toContain(
      'secret plans',
    );
  });

  it('records a supersede claim as such', async () => {
    await TURN(turnRequest({ supersede: true }));
    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ supersede: true }),
      }),
    );
  });

  it('attributes an api-key caller to its key', async () => {
    mockResolveAuth.mockResolvedValue(authedKey());
    await TURN(turnRequest());
    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'apiKey:key-test' }),
    );
  });

  it('audits a subset turn with the whole set and a NARROWING legacy field', async () => {
    mockResolveHootTargets.mockResolvedValue(resolvedOn([MACHINE, MACHINE_B]));

    await TURN(turnRequest({ machineId: undefined, target: { machineIds: [MACHINE, MACHINE_B] } }));

    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          machineId: MACHINE,
          machineIds: [MACHINE, MACHINE_B],
        }),
      }),
    );
  });

  it('emits nothing when the lock is already held by a live turn', async () => {
    const { TurnActiveError } = jest.requireMock('@/lib/hoot/turnStore.server') as {
      TurnActiveError: new (m: string) => Error;
    };
    mockAcquireTurnLock.mockRejectedValue(new TurnActiveError('busy'));

    const res = await TURN(turnRequest());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'turn_active' });
    expect(emitMutation).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('emits nothing when the chat belongs to another user', async () => {
    chatDoc = { userId: 'someone-else', siteId: SITE };

    const res = await TURN(turnRequest());
    expect(res.status).toBe(403);
    expect(emitMutation).not.toHaveBeenCalled();
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('emits nothing when the target machine is offline', async () => {
    mockResolveHootTargets.mockResolvedValue({
      ok: false,
      status: 503,
      reason: 'machine_offline',
      machineIds: [MACHINE],
    });

    const res = await TURN(turnRequest());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: `Machine "${MACHINE}" appears to be offline.`,
    });
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

describe('POST /api/hoot — turn-start guards', () => {
  it('hands an api-key caller an access level capped below site admin', async () => {
    mockResolveAuth.mockResolvedValue(authedKey());

    const res = await TURN(turnRequest());
    expect(res.status).toBe(200);

    // resolveHootMaxTier keys off isSiteAdmin alone, so clearing it here is the
    // whole reason a chat-scoped key stays at tier 1 instead of inheriting the
    // owner's admin role. The rest of the resolved access passes through.
    expect(mockStartTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        access: { role: 'admin', isSuperadmin: false, isSiteAdmin: false, isSiteOwner: true },
      }),
    );
  });

  it('leaves a session caller on the access their role resolved to', async () => {
    const res = await TURN(turnRequest());
    expect(res.status).toBe(200);

    expect(mockStartTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        access: expect.objectContaining({ isSiteAdmin: true }),
      }),
    );
  });

  it('threads the whole prior turn record into the runner', async () => {
    // The runner needs more than the recovery index now: `fanOut` decides how a
    // dead turn's results are shaped when this one splices them back in.
    const prior = {
      toolCommands: { call_1: { [MACHINE]: { commandId: 'cmd_1' } } },
      fanOut: false,
      resolvedMachineIds: [MACHINE],
      messageId: 'msg_a',
      pendingApprovals: ['call_1'],
    };
    mockAcquireTurnLock.mockResolvedValue(prior);

    await TURN(turnRequest());

    expect(startTurnParams().priorTurn).toEqual(prior);
  });

  it('passes null when the chat has no prior turn', async () => {
    await TURN(turnRequest());

    expect(mockStartTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ priorTurn: null }),
    );
  });

  it('refuses a chat that belongs to another site, even for its owner', async () => {
    // Same user, different site: the runner persists via the admin SDK, so this
    // route is the only gate against a chat being written under a foreign siteId.
    chatDoc = { userId: 'user-1', siteId: 'site-b' };

    const res = await TURN(turnRequest());
    expect(res.status).toBe(403);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('refuses a single machine with hoot turned off, before claiming the lock', async () => {
    mockResolveHootTargets.mockResolvedValue({
      ok: false,
      status: 423,
      reason: 'hoot_disabled',
      machineIds: [MACHINE],
    });

    const res = await TURN(turnRequest());
    expect(res.status).toBe(423);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('gives an access refusal its real status instead of a 500', async () => {
    const { SiteAccessError } = jest.requireMock('@/lib/hoot-utils.server') as {
      SiteAccessError: new (code: string, message: string) => Error;
    };
    mockVerifyAccess.mockRejectedValue(
      new SiteAccessError('no_site_access', 'You do not have access to this site'),
    );

    const res = await TURN(turnRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'no_site_access' });
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('reports a missing site as 404', async () => {
    const { SiteAccessError } = jest.requireMock('@/lib/hoot-utils.server') as {
      SiteAccessError: new (code: string, message: string) => Error;
    };
    mockVerifyAccess.mockRejectedValue(new SiteAccessError('site_not_found', 'Site not found'));

    const res = await TURN(turnRequest());
    expect(res.status).toBe(404);
  });

  it('reports an out-of-scope api key as 403, not 500', async () => {
    mockResolveAuth.mockResolvedValue({
      userId: 'user-1',
      keyContext: {
        keyId: 'key-other',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scopes: [{ resource: 'chat', id: 'other-site', permissions: ['write'] }] as any,
        environment: 'live',
        expiresAt: Date.now() + 60_000,
        isLegacy: false,
      },
    });

    const res = await TURN(turnRequest());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'scope_insufficient' });
  });
});

describe('POST /api/hoot — which machines a body resolves to', () => {
  it('maps the legacy site sentinel to "every machine, dynamically"', async () => {
    mockResolveHootTargets.mockResolvedValue(resolvedOn([MACHINE, MACHINE_B]));

    await TURN(turnRequest({ machineId: '__site__' }));

    expect(resolveRequest()).toEqual({ requested: null, mentions: [] });
    expect(startTurnParams().turnTarget).toEqual({
      machineIds: null,
      fanOut: true,
      source: 'chat',
    });
    expect(startTurnParams().chatTarget).toEqual({ machineIds: null });
  });

  it('maps a legacy single machineId to exactly that machine', async () => {
    await TURN(turnRequest());

    expect(resolveRequest()).toEqual({ requested: [MACHINE], mentions: [] });
    expect(startTurnParams().turnTarget).toMatchObject({ machineIds: [MACHINE], fanOut: false });
  });

  it('takes an explicit set from target.machineIds and records it on the lock', async () => {
    mockResolveHootTargets.mockResolvedValue(resolvedOn([MACHINE, MACHINE_B]));

    await TURN(turnRequest({ machineId: undefined, target: { machineIds: [MACHINE, MACHINE_B] } }));

    expect(resolveRequest()).toMatchObject({ requested: [MACHINE, MACHINE_B] });
    expect(mockAcquireTurnLock).toHaveBeenCalledWith(fakeDb, CHAT, {
      turnId: 'turn-fixed',
      siteId: SITE,
      // Never-widen: an old reader maps this single id and narrows to it.
      machineId: MACHINE,
      supersede: false,
      target: { machineIds: [MACHINE, MACHINE_B], fanOut: true, source: 'chat' },
      resolvedMachineIds: [MACHINE, MACHINE_B],
    });
  });

  it('stores the SELECTION, not the machines that survived resolution', async () => {
    // One ticked machine is offline: it is skipped for this turn but stays part
    // of the chat's selection, so it comes back when it does.
    mockResolveHootTargets.mockResolvedValue({
      ok: true,
      resolved: {
        ids: [MACHINE],
        fanOut: true,
        skipped: { offline: [MACHINE_B], disabled: [] },
      },
    });

    await TURN(turnRequest({ machineId: undefined, target: { machineIds: [MACHINE, MACHINE_B] } }));

    expect(startTurnParams().chatTarget).toEqual({ machineIds: [MACHINE, MACHINE_B] });
    expect(startTurnParams().resolved.ids).toEqual([MACHINE]);
  });

  it('collapses a repeated id in the stored selection', async () => {
    await TURN(turnRequest({ machineId: undefined, target: { machineIds: [MACHINE, MACHINE] } }));

    expect(startTurnParams().chatTarget).toEqual({ machineIds: [MACHINE] });
  });

  it('refuses an unknown or foreign machine id with no lock and no turn', async () => {
    mockResolveHootTargets.mockResolvedValue({
      ok: false,
      status: 400,
      reason: 'unknown_machine',
      machineIds: ['other-site-machine'],
    });

    const res = await TURN(turnRequest({ machineId: 'other-site-machine' }));

    expect(res.status).toBe(400);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('refuses a body with no target at all', async () => {
    const res = await TURN(turnRequest({ machineId: undefined }));

    expect(res.status).toBe(400);
    expect(mockResolveHootTargets).not.toHaveBeenCalled();
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('refuses a malformed target rather than falling back to the legacy field', async () => {
    // Falling back could WIDEN: a subset that failed to serialize would be sent
    // as whatever the legacy field happened to say.
    const res = await TURN(turnRequest({ machineId: '__site__', target: { machineIds: 'all' } }));

    expect(res.status).toBe(400);
    expect(mockResolveHootTargets).not.toHaveBeenCalled();
  });

  it('never lets the client-supplied machineName reach the turn', async () => {
    await TURN(turnRequest({ machineName: 'Lobby Wall (front)' }));

    expect(JSON.stringify(startTurnParams())).not.toContain('Lobby Wall');
  });
});

describe('POST /api/hoot — @mention narrowing', () => {
  const mentionBody = (overrides: Record<string, unknown> = {}) => ({
    machineId: undefined,
    target: { machineIds: null, mentions: [MACHINE_B] },
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: `@${MACHINE_B} what is running?` }] },
    ],
    ...overrides,
  });

  it('narrows the turn to the mentioned machine and leaves the selection alone', async () => {
    mockResolveHootTargets.mockResolvedValue(resolvedOn([MACHINE_B]));

    await TURN(turnRequest(mentionBody()));

    expect(resolveRequest()).toEqual({ requested: null, mentions: [MACHINE_B] });
    expect(startTurnParams().turnTarget).toEqual({
      machineIds: [MACHINE_B],
      fanOut: false,
      source: 'mention',
    });
    // The chat still targets everything — the narrowing was for this turn only.
    expect(startTurnParams().chatTarget).toEqual({ machineIds: null });
  });

  it('ignores a mention the message does not actually contain', async () => {
    // The body alone never narrows a turn: the server re-parses the message it
    // is about to send and keeps only what is really mentioned in it.
    await TURN(
      turnRequest(
        mentionBody({
          messages: [
            { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'what is running?' }] },
          ],
        }),
      ),
    );

    expect(resolveRequest()).toEqual({ requested: null, mentions: [] });
    expect(startTurnParams().turnTarget.source).toBe('chat');
  });

  it('ignores a mention inside a code span', async () => {
    await TURN(
      turnRequest(
        mentionBody({
          messages: [
            {
              id: 'm1',
              role: 'user',
              parts: [{ type: 'text', text: `run \`@${MACHINE_B} = @(1,2)\` please` }],
            },
          ],
        }),
      ),
    );

    expect(resolveRequest()).toEqual({ requested: null, mentions: [] });
  });

  it('gives an api-key caller no narrowing (D-I)', async () => {
    mockResolveAuth.mockResolvedValue(authedKey());

    await TURN(turnRequest(mentionBody()));

    expect(resolveRequest()).toEqual({ requested: null, mentions: [] });
    expect(startTurnParams().turnTarget.source).toBe('chat');
  });

  it('gives a legacy body no narrowing, however the text reads', async () => {
    await TURN(
      turnRequest({
        machineId: '__site__',
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: `@${MACHINE_B} status?` }] },
        ],
      }),
    );

    expect(resolveRequest()).toEqual({ requested: null, mentions: [] });
  });

  it('never narrows on a machine-authored opener', async () => {
    // A follow-up note is the assistant's own words coming back; an `@id` in it
    // was never a person choosing a target.
    await TURN(
      turnRequest(
        mentionBody({
          messages: [
            {
              id: 'followup_msg_fu-1',
              role: 'user',
              parts: [{ type: 'text', text: `[scheduled follow-up] check @${MACHINE_B}` }],
            },
          ],
        }),
      ),
    );

    expect(resolveRequest()).toEqual({ requested: null, mentions: [] });
    expect(startTurnParams().turnTarget.source).toBe('chat');
  });
});

describe('POST /api/hoot — approval resume binding', () => {
  const APPROVED_CALL = 'toolu_appr_1';
  const ASSISTANT_ID = 'msg_a';

  /** History ending in the assistant message whose approval was answered. */
  function approvalHistory() {
    return [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'run the scan' }] },
      {
        id: ASSISTANT_ID,
        role: 'assistant',
        parts: [
          {
            type: 'tool-execute_script',
            toolCallId: APPROVED_CALL,
            state: 'approval-responded',
            approval: { id: 'appr_1', approved: true },
          },
        ],
      },
    ];
  }

  function priorTurn(overrides: Record<string, unknown> = {}) {
    return {
      toolCommands: {},
      fanOut: false,
      resolvedMachineIds: [MACHINE],
      messageId: ASSISTANT_ID,
      pendingApprovals: [APPROVED_CALL],
      ...overrides,
    };
  }

  it('runs the approved call on the machines it was requested on, not the ones the body names', async () => {
    mockReadTurnRecord.mockResolvedValue(priorTurn());
    mockAcquireTurnLock.mockResolvedValue(priorTurn());

    const res = await TURN(
      turnRequest({
        machineId: undefined,
        // The picker has since been widened to both machines — irrelevant.
        target: { machineIds: [MACHINE, MACHINE_B] },
        messages: approvalHistory(),
      }),
    );

    expect(res.status).toBe(200);
    expect(resolveRequest()).toEqual({ requested: [MACHINE] });
    expect(startTurnParams().resolved.ids).toEqual([MACHINE]);
    expect(startTurnParams().turnTarget).toMatchObject({
      machineIds: [MACHINE],
      source: 'resume',
    });
    // The lock re-verifies the same binding inside the claim transaction.
    expect(mockAcquireTurnLock).toHaveBeenCalledWith(fakeDb, CHAT, {
      turnId: 'turn-fixed',
      siteId: SITE,
      machineId: MACHINE,
      supersede: false,
      // `fanOut` is this turn's own mode, resolved from the bound set; the
      // machine list is deliberately absent, so the claim re-reads it from the
      // record inside its transaction.
      resume: { messageId: ASSISTANT_ID, toolCallIds: [APPROVED_CALL], fanOut: false },
    });
    // A resume must never move the chat's stored selection.
    expect(startTurnParams().chatTarget).toBeUndefined();
  });

  it('ignores a site-wide body on a resume', async () => {
    mockReadTurnRecord.mockResolvedValue(priorTurn());
    mockAcquireTurnLock.mockResolvedValue(priorTurn());

    await TURN(turnRequest({ machineId: '__site__', messages: approvalHistory() }));

    expect(resolveRequest()).toEqual({ requested: [MACHINE] });
  });

  it('resolves a legacy site-wide prior against whatever is online now', async () => {
    // `null` is the one case a record can leave its set unwritten, and only a
    // doc from before per-turn targeting can say it.
    mockReadTurnRecord.mockResolvedValue(priorTurn({ resolvedMachineIds: null, fanOut: true }));
    mockAcquireTurnLock.mockResolvedValue(priorTurn({ resolvedMachineIds: null, fanOut: true }));
    mockResolveHootTargets.mockResolvedValue(resolvedOn([MACHINE, MACHINE_B]));

    await TURN(turnRequest({ messages: approvalHistory() }));

    expect(resolveRequest()).toEqual({ requested: null });
    expect(startTurnParams().resolved.ids).toEqual([MACHINE, MACHINE_B]);
  });

  it('cannot be slipped past the binding by a trailing non-assistant message', async () => {
    // `applyApprovalConsumption` claims every assistant message after the last
    // USER one, so an approval hiding behind a trailing `system` message (a
    // legal UIMessage role) is still claimed and executed. If the route stopped
    // looking at the first non-assistant message it would take this for a fresh
    // turn and run the approved tier-3 call on whatever the body named.
    mockReadTurnRecord.mockResolvedValue(priorTurn());

    const res = await TURN(
      turnRequest({
        machineId: undefined,
        target: { machineIds: [MACHINE_B] },
        messages: [...approvalHistory(), { id: 'sys_1', role: 'system', parts: [] }],
      }),
    );

    // Refused, because the resumed message id no longer matches the record —
    // and refused BEFORE the claim, so the approval is still answerable.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'approval_stale' });
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('refuses a resume whose requesting message is no longer the record', async () => {
    // An intervening turn (a follow-up, another device) overwrote the record.
    mockReadTurnRecord.mockResolvedValue(
      priorTurn({ messageId: 'msg_from_a_later_turn', pendingApprovals: [] }),
    );

    const res = await TURN(turnRequest({ messages: approvalHistory() }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'approval_stale' });
    // Nothing claimed, nothing dispatched, and the approval is NOT consumed —
    // the runner's one-shot ledger claim is never reached.
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('refuses a resume for an approval the record is not waiting on', async () => {
    mockReadTurnRecord.mockResolvedValue(priorTurn({ pendingApprovals: ['toolu_other'] }));

    const res = await TURN(turnRequest({ messages: approvalHistory() }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'approval_stale' });
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('refuses a resume when the chat has no turn record at all', async () => {
    mockReadTurnRecord.mockResolvedValue(null);

    const res = await TURN(turnRequest({ messages: approvalHistory() }));

    expect(res.status).toBe(409);
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('maps the claim transaction`s own staleness check to approval_stale', async () => {
    // The pre-check passed and the record changed underneath it — the
    // in-transaction re-verify is what catches that race.
    const { ApprovalStaleError } = jest.requireMock('@/lib/hoot/turnStore.server') as {
      ApprovalStaleError: new (m: string) => Error;
    };
    mockReadTurnRecord.mockResolvedValue(priorTurn());
    mockAcquireTurnLock.mockRejectedValue(new ApprovalStaleError('stale'));

    const res = await TURN(turnRequest({ messages: approvalHistory() }));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'approval_stale' });
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('leaves the approval unconsumed when the bound machine went offline', async () => {
    mockReadTurnRecord.mockResolvedValue(priorTurn());
    mockResolveHootTargets.mockResolvedValue({
      ok: false,
      status: 503,
      reason: 'machine_offline',
      machineIds: [MACHINE],
    });

    const res = await TURN(turnRequest({ messages: approvalHistory() }));

    expect(res.status).toBe(503);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

describe('POST /api/hoot/stop — turn-cancel audit', () => {
  it('emits one chat_mutated/cancel_turn row when the terminal write lands', async () => {
    const res = await STOP(stopRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });

    expect(emitMutation).toHaveBeenCalledTimes(1);
    expect(emitMutation).toHaveBeenCalledWith({
      kind: 'chat_mutated',
      siteId: SITE,
      actor: 'user:user-1',
      targetId: CHAT,
      attributes: {
        verb: 'cancel_turn',
        endpoint: '/api/hoot/stop',
        method: 'POST',
        siteId: SITE,
        turnId: 'turn-fixed',
      },
    });
  });

  it('still 200s but emits nothing when the turnId is stale or already terminal', async () => {
    mockFinishTurn.mockResolvedValue(false);

    const res = await STOP(stopRequest({ turnId: 'turn-stale' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('emits nothing when the caller does not own the chat', async () => {
    chatDoc = { userId: 'someone-else', siteId: SITE };

    const res = await STOP(stopRequest());
    expect(res.status).toBe(403);
    expect(emitMutation).not.toHaveBeenCalled();
    expect(mockFinishTurn).not.toHaveBeenCalled();
  });
});
