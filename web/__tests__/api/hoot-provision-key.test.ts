/** @jest-environment node */

/**
 * Audit coverage for POST /api/hoot/provision-key (talons wave 5.4).
 *
 * The route queues a `provision_cortex_key` machine command carrying a raw LLM
 * api key, then blocks polling for the agent's terminal status. The mutation is
 * the queue write, so the `site_mutated` / `llm_key.provision` row is emitted
 * there — before the poll, and regardless of how the poll ends. The key must
 * never appear in the row.
 *
 * A payer without remote control is refused with 402 plan_required before the
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
/** What the agent has written back under `commands/completed`, by command id. */
let completedDoc: Record<string, unknown>;

function commandDoc(id: string) {
  if (id === 'pending') {
    return { set: mockPendingSet, update: mockPendingUpdate };
  }
  return {
    get: async () => ({ data: () => completedDoc }),
    update: mockCompletedUpdate,
  };
}

const fakeDb = {
  collection: (name: string) => {
    if (name !== 'sites') throw new Error(`unexpected collection: ${name}`);
    return {
      doc: () => ({
        collection: () => ({
          doc: () => ({
            collection: () => ({ doc: (id: string) => commandDoc(id) }),
          }),
        }),
      }),
    };
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
}));

import { POST } from '@/app/api/hoot/provision-key/route';
import { problemPlanRequired } from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
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

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSession.mockResolvedValue('user-1');
  // `siteRole` is what grants since the per-site-roles migration; the global
  // `role` beside it confers nothing on a site. The route requires
  // MACHINE_EXEC_COMMAND, which the `admin` membership carries.
  mockVerifyAccess.mockResolvedValue({ role: 'admin', siteRole: 'admin' });
  mockPendingSet.mockResolvedValue(undefined);
  mockCompletedUpdate.mockResolvedValue(undefined);
  mockRequireEntitlement.mockImplementation(realRequireEntitlement);
  completedDoc = {};
});

describe('POST /api/hoot/provision-key — the payer plan', () => {
  it('refuses with 402 plan_required and queues nothing', async () => {
    mockRequireEntitlement.mockResolvedValue(
      problemPlanRequired(PLAN_REQUIRED_DETAIL['owlette.control'], 'owlette.control'),
    );

    const res = await POST(request());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'plan_required', entitlement: 'owlette.control' });
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.control');
    expect(mockPendingSet).not.toHaveBeenCalled();
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('answers a read-only member 403 before the plan is looked up', async () => {
    mockVerifyAccess.mockResolvedValue({ role: 'member', siteRole: 'member' });

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
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.control');
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
    mockVerifyAccess.mockResolvedValue({ role: 'member', siteRole: 'member' });

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
