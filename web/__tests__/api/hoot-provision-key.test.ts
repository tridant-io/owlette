/** @jest-environment node */

/**
 * Audit coverage for POST /api/hoot/provision-key (talons wave 5.4).
 *
 * The route queues a `provision_cortex_key` machine command, then blocks polling
 * for the agent's terminal status. A 4.2.0 agent's command carries a key id and
 * fetches the key itself; an older agent's carries the key. The mutation is
 * the queue write, so the `site_mutated` / `llm_key.provision` row is emitted
 * there — before the poll, and regardless of how the poll ends. The key must
 * never appear in the row.
 *
 * A payer without hoot is refused with 402 plan_required before the
 * queue write, so nothing is queued or audited.
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

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
    delete: () => '__DELETE__',
  },
}));

const mockRequireSession = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSession: (...a: unknown[]) => mockRequireSession(...a),
  };
});

const mockVerifyAccess = jest.fn();
jest.mock('@/lib/hoot-utils.server', () => ({
  verifyUserSiteAccess: (...a: unknown[]) => mockVerifyAccess(...a),
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
const MACHINE = 'lobby-01';
const RAW_KEY = 'sk-ant-super-secret-value';

const mockPendingSet = jest.fn();
const mockPendingUpdate = jest.fn();
const mockCompletedUpdate = jest.fn();
const mockKeySet = jest.fn();
const mockKeyDelete = jest.fn();
/** What the agent has written back under `commands/completed`, by command id. */
let completedDoc: Record<string, unknown>;
/** Machine documents by id; a missing id is a machine with no document. */
let machines: Record<string, Record<string, unknown>>;

function makeDoc(docPath: string) {
  const [, , , machineId, sub, id] = docPath.split('/');
  if (sub === 'commands' && id === 'pending') {
    return { set: mockPendingSet, update: mockPendingUpdate };
  }
  if (sub === 'commands') {
    return {
      get: async () => ({ data: () => completedDoc }),
      update: mockCompletedUpdate,
    };
  }
  if (sub === 'hoot_key_handoffs') {
    return {
      id,
      set: (data: unknown) => mockKeySet(docPath, data),
      delete: () => mockKeyDelete(docPath),
    };
  }
  return {
    get: async () => ({ exists: machineId in machines, data: () => machines[machineId] }),
    collection: (name: string) => makeCollection(`${docPath}/${name}`),
  };
}

function makeCollection(collectionPath: string) {
  return {
    doc: (id: string) => {
      const docPath = `${collectionPath}/${id}`;
      return docPath.split('/').length < 4
        ? { collection: (name: string) => makeCollection(`${docPath}/${name}`) }
        : makeDoc(docPath);
    },
  };
}

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'sites') throw new Error(`unexpected collection: ${name}`);
    return makeCollection(name);
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
}));

import { POST } from '@/app/api/hoot/provision-key/route';
import { problemPlanRequired } from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { decryptApiKey } from '@/lib/llm-encryption.server';
import { PLAN_REQUIRED_DETAIL } from '@/lib/plan.server';

const { requireEntitlement: realRequireEntitlement } = jest.requireActual('@/lib/plan.server');

function request(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest('http://localhost/api/hoot/provision-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      siteId: SITE,
      machineId: MACHINE,
      apiKey: RAW_KEY,
      provider: 'anthropic',
      ...body,
    }),
  });
}

/** verifyUserSiteAccess's answer; `machineIds` null is the whole site. */
function siteAccess(role: 'admin' | 'member', machineIds: readonly string[] | null = null) {
  return { role, siteRole: role, swoopMode: null, standing: { role, swoopMode: null, machineIds } };
}

/** The single audit row, with the command id the route minted. */
function soleAudit() {
  expect(emitMutation).toHaveBeenCalledTimes(1);
  return (emitMutation as jest.Mock).mock.calls[0][0] as {
    kind: string;
    siteId: string;
    actor: string;
    targetId: string;
    attributes: Record<string, unknown>;
  };
}

/** The one pending entry the route queued: its command id and its fields. */
function solePending() {
  expect(mockPendingSet).toHaveBeenCalledTimes(1);
  const [[commandId, entry]] = Object.entries(mockPendingSet.mock.calls[0][0]);
  return { commandId, entry: entry as Record<string, unknown> };
}

beforeAll(() => {
  process.env.LLM_ENCRYPTION_KEY = 'test-llm-encryption-key-not-a-real-one';
});

afterAll(() => {
  delete process.env.LLM_ENCRYPTION_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  machines = { [MACHINE]: { agent_version: '4.2.0' } };
  mockKeySet.mockResolvedValue(undefined);
  mockKeyDelete.mockResolvedValue(undefined);
  mockRequireSession.mockResolvedValue('user-1');
  // `siteRole` is what grants since the per-site-roles migration; the global
  // `role` beside it confers nothing on a site. The route requires
  // MACHINE_EXEC_COMMAND, which the `admin` membership carries.
  mockVerifyAccess.mockResolvedValue(siteAccess('admin'));
  mockPendingSet.mockResolvedValue(undefined);
  mockCompletedUpdate.mockResolvedValue(undefined);
  mockRequireEntitlement.mockImplementation(realRequireEntitlement);
  completedDoc = {};
});

describe('POST /api/hoot/provision-key — the payer plan', () => {
  it('refuses with 402 plan_required and queues nothing', async () => {
    mockRequireEntitlement.mockResolvedValue(
      problemPlanRequired(PLAN_REQUIRED_DETAIL['owlette.hoot'], 'owlette.hoot'),
    );

    const res = await POST(request());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'plan_required', entitlement: 'owlette.hoot' });
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
    expect(mockPendingSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('answers a read-only member 403 before the plan is looked up', async () => {
    mockVerifyAccess.mockResolvedValue(siteAccess('member'));

    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(mockRequireEntitlement).not.toHaveBeenCalled();
  });

  it('queues the command as before with enforcement off', async () => {
    mockPendingSet.mockImplementation(async (payload: Record<string, unknown>) => {
      const [commandId] = Object.keys(payload);
      completedDoc = { [commandId]: { status: 'completed' } };
    });

    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
    expect(mockPendingSet).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/hoot/provision-key — audit', () => {
  it('emits one site_mutated/llm_key.provision row naming the machine, never the key', async () => {
    // Agent answers on the first poll so the handler doesn't sit out its
    // 15s timeout.
    mockPendingSet.mockImplementation(async (payload: Record<string, unknown>) => {
      const [commandId] = Object.keys(payload);
      completedDoc = { [commandId]: { status: 'completed' } };
    });

    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const audit = soleAudit();
    expect(audit.kind).toBe('site_mutated');
    expect(audit.siteId).toBe(SITE);
    expect(audit.actor).toBe('user:user-1');
    expect(audit.targetId).toBe(MACHINE);
    expect(audit.attributes).toMatchObject({
      verb: 'llm_key.provision',
      endpoint: '/api/hoot/provision-key',
      method: 'POST',
      siteId: SITE,
      machineId: MACHINE,
      provider: 'anthropic',
      commandId: expect.stringMatching(/^provision_cortex_key_\d+$/),
    });
    expect(JSON.stringify(audit)).not.toContain(RAW_KEY);
  });

  it('still records the queued command when the agent reports a failure', async () => {
    // The command WAS written to the machine's queue; a failed install does not
    // un-write it, so the row must stand.
    mockPendingSet.mockImplementation(async (payload: Record<string, unknown>) => {
      const [commandId] = Object.keys(payload);
      completedDoc = { [commandId]: { status: 'failed', error: 'no disk' } };
    });

    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(soleAudit().attributes.verb).toBe('llm_key.provision');
  });

  it('emits nothing when the caller has no access to the site', async () => {
    mockVerifyAccess.mockRejectedValue(new Error('You do not have access to this site'));

    await POST(request());
    expect(mockPendingSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('refuses a read-only MEMBER of the site, and queues nothing', async () => {
    // The reason this route needed a capability at all. `commands/pending` is
    // reserved by firestore.rules to the service account and the machine's own
    // agent, so this route IS the boundary — and with only a membership check a
    // read-only member could make any machine overwrite its stored LLM credential.
    mockVerifyAccess.mockResolvedValue(siteAccess('member'));

    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(mockPendingSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('emits nothing when required fields are missing', async () => {
    const res = await POST(request({ apiKey: undefined }));
    expect(res.status).toBe(400);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

describe('POST /api/hoot/provision-key — machine scope', () => {
  function agentAnswers() {
    mockPendingSet.mockImplementation(async (payload: Record<string, unknown>) => {
      const [commandId] = Object.keys(payload);
      completedDoc = { [commandId]: { status: 'completed' } };
    });
  }

  it('answers a scoped admin 404 on a machine outside the scope, with nothing queued or written', async () => {
    // before machine scope reached this route, its actor was whole site, so a
    // scoped admin passed the site-level MACHINE_EXEC_COMMAND check here
    mockVerifyAccess.mockResolvedValue(siteAccess('admin', ['other-01']));
    agentAnswers();

    const res = await POST(request());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'machine not found or no access' });
    expect(mockRequireEntitlement).not.toHaveBeenCalled();
    expect(mockPendingSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('queues as before for a scoped admin on a machine inside the scope', async () => {
    mockVerifyAccess.mockResolvedValue(siteAccess('admin', [MACHINE]));
    agentAnswers();

    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockPendingSet).toHaveBeenCalledTimes(1);
    expect(soleAudit().targetId).toBe(MACHINE);
  });

  it('still refuses a scoped member on a machine inside the scope: the role decides', async () => {
    mockVerifyAccess.mockResolvedValue(siteAccess('member', [MACHINE]));

    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(mockPendingSet).not.toHaveBeenCalled();
  });

  it('leaves a whole-site admin unchanged on any machine', async () => {
    agentAnswers();

    const res = await POST(request({ machineId: 'other-01' }));
    expect(res.status).toBe(200);
    expect(soleAudit().targetId).toBe('other-01');
  });
});

describe('POST /api/hoot/provision-key — how the key reaches the machine', () => {
  function agentAnswers(status = 'completed') {
    mockPendingSet.mockImplementation(async (payload: Record<string, unknown>) => {
      const [commandId] = Object.keys(payload);
      completedDoc = { [commandId]: { status } };
    });
  }

  it('queues a key id and no key for a 4.2.0 agent; the key waits encrypted under the machine', async () => {
    agentAnswers();

    const res = await POST(request());
    expect(res.status).toBe(200);

    const { entry } = solePending();
    expect(entry).not.toHaveProperty('api_key');
    expect(JSON.stringify(mockPendingSet.mock.calls)).not.toContain(RAW_KEY);
    expect(entry).toMatchObject({ type: 'provision_cortex_key', provider: 'anthropic' });
    expect(entry.key_id).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/));

    expect(mockKeySet).toHaveBeenCalledTimes(1);
    const [keyPath, stored] = mockKeySet.mock.calls[0] as [string, Record<string, unknown>];
    expect(keyPath).toBe(`sites/${SITE}/machines/${MACHINE}/hoot_key_handoffs/${entry.key_id}`);
    expect(JSON.stringify(stored)).not.toContain(RAW_KEY);
    expect(decryptApiKey(stored.apiKeyEncrypted as string)).toBe(RAW_KEY);
  });

  it('queues the key itself for an agent older than 4.2.0, which only reads it there', async () => {
    machines[MACHINE] = { agent_version: '4.1.28' };
    agentAnswers();

    const res = await POST(request());
    expect(res.status).toBe(200);

    const { entry } = solePending();
    expect(entry).toMatchObject({ type: 'provision_cortex_key', api_key: RAW_KEY, provider: 'anthropic' });
    expect(entry).not.toHaveProperty('key_id');
    expect(mockKeySet).not.toHaveBeenCalled();
  });

  it('queues a key id when the machine reports no agent version', async () => {
    machines = {};
    agentAnswers();

    await POST(request());

    expect(solePending().entry).not.toHaveProperty('api_key');
    expect(mockKeySet).toHaveBeenCalledTimes(1);
  });

  it('drops a key the agent never fetched once the command ends', async () => {
    agentAnswers('failed');

    const res = await POST(request());
    expect(res.status).toBe(500);

    const { entry } = solePending();
    expect(mockKeyDelete).toHaveBeenCalledWith(
      `sites/${SITE}/machines/${MACHINE}/hoot_key_handoffs/${entry.key_id}`,
    );
  });
});
