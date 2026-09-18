/**
 * @jest-environment node
 *
 * `lib/swoop/audit.server.ts` — where a swoop row lands and what it may carry.
 *
 * The destination is the point: every row goes to `sites/{siteId}/audit_log`,
 * which a site admin cannot bulk-delete, and never to `sites/{siteId}/logs`,
 * which they can. The other point is what a row must NOT hold — a reason is a
 * code, so no captured value can ride into the trail on one.
 */

import { Capability } from '@/lib/capabilities';

/** Every document write the audit writer makes, keyed by its full path. */
const written: { path: string; data: Record<string, unknown> }[] = [];

function makeDoc(docPath: string) {
  return {
    get: async () => ({ exists: false, data: () => undefined }),
    set: async (data: Record<string, unknown>) => {
      written.push({ path: docPath, data });
    },
    collection: (name: string) => makeCollection(`${docPath}/${name}`),
  };
}

let autoId = 0;
function makeCollection(collectionPath: string) {
  return {
    doc: (id?: string) => makeDoc(`${collectionPath}/${id ?? `auto-${++autoId}`}`),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: (name: string) => makeCollection(name) }),
}));
jest.mock('@/lib/securityBoundaryMetrics.server', () => ({
  emitSecurityBoundaryMetric: jest.fn(),
}));

import {
  recordSwoopDenied,
  recordSwoopHostEvent,
  recordSwoopSessionEnded,
  recordSwoopSessionStarted,
} from '@/lib/swoop/audit.server';

const SITE = 'site-a';
const MACHINE = 'machine-1';
const SID = 'sid0000000000000000000000000001';
const VIEWER = 'viewer000000000000000000000001';

const ACTOR = {
  type: 'user' as const,
  userId: 'user-admin',
  role: 'admin' as const,
};

const base = { siteId: SITE, machineId: MACHINE, actor: ACTOR, correlationId: 'corr-1' };

const auditRows = () => written.filter((w) => w.path.startsWith(`sites/${SITE}/audit_log/`));

beforeEach(() => {
  written.length = 0;
});

describe('swoop audit rows', () => {
  it('records a control session start as an allow on the control capability', async () => {
    await recordSwoopSessionStarted({ ...base, sid: SID, viewerId: VIEWER, ctl: true });

    expect(auditRows()).toHaveLength(1);
    const row = auditRows()[0].data;
    expect(row.outcome).toBe('allow');
    expect(row.capability).toBe(Capability.MACHINE_REMOTE_CONTROL);
    expect(row.correlationId).toBe('corr-1');
    expect(row.target).toEqual({ kind: 'swoop_session', id: SID, machineId: MACHINE });
    expect(row.metadata).toEqual({
      event: 'session_started',
      sid: SID,
      viewerId: VIEWER,
      ctl: true,
    });
  });

  it('records a watch session start on the view capability', async () => {
    await recordSwoopSessionStarted({ ...base, sid: SID, viewerId: VIEWER, ctl: false });

    expect(auditRows()[0].data.capability).toBe(Capability.MACHINE_REMOTE_VIEW);
  });

  it('records an end with its reason and how long the session ran', async () => {
    await recordSwoopSessionEnded({
      ...base,
      sid: SID,
      endReason: 'killed',
      durationMs: 12_000,
    });

    const row = auditRows()[0].data;
    expect(row.outcome).toBe('allow');
    expect(row.metadata).toMatchObject({
      event: 'session_ended',
      endReason: 'killed',
      durationMs: 12_000,
    });
  });

  it('records a refusal as a deny carrying its reason code', async () => {
    recordSwoopDenied({
      ...base,
      sid: SID,
      event: 'session_denied',
      denyReason: 'step_up_required',
      ctl: true,
    });
    await Promise.resolve();

    const row = auditRows()[0].data;
    expect(row.outcome).toBe('deny');
    expect(row.denyReason).toBe('step_up_required');
    expect(row.capability).toBe(Capability.MACHINE_REMOTE_CONTROL);
    expect(row.target).toEqual({ kind: 'swoop_session', id: SID, machineId: MACHINE });
  });

  it('names the machine when the refusal came before a session existed', async () => {
    recordSwoopDenied({
      siteId: SITE,
      machineId: MACHINE,
      actor: ACTOR,
      event: 'session_denied',
      denyReason: 'api_key_not_permitted',
      ctl: false,
    });
    await Promise.resolve();

    expect(auditRows()[0].data.target).toEqual({
      kind: 'machine',
      id: MACHINE,
      machineId: MACHINE,
    });
  });

  it('never records a reason verbatim — anything but a code becomes `unspecified`', async () => {
    recordSwoopDenied({
      ...base,
      event: 'step_up_failed',
      denyReason: 'jwt eyJhbGciOiJFZERTQSJ9.payload.signature rejected',
      ctl: true,
    });
    await Promise.resolve();

    expect(auditRows()[0].data.denyReason).toBe('unspecified');
    expect(JSON.stringify(auditRows()[0].data)).not.toContain('eyJhbGciOiJFZERTQSJ9');
  });

  it('attributes a host event to the reporter, never to the viewer it refused', async () => {
    await recordSwoopHostEvent({
      siteId: SITE,
      machineId: MACHINE,
      sid: SID,
      event: 'jwt_rejected',
      outcome: 'deny',
      capability: Capability.MACHINE_REMOTE_VIEW,
      reason: 'bad_signature',
      viewerId: VIEWER,
      uid: 'uid-1',
      atMs: 1_700_000_000_000,
    });

    const row = auditRows()[0].data;
    expect(row.actor).toEqual({ type: 'system', name: 'swoop_host' });
    expect(row.outcome).toBe('deny');
    expect(row.denyReason).toBe('bad_signature');
    expect(row.metadata).toMatchObject({
      event: 'jwt_rejected',
      sid: SID,
      viewerId: VIEWER,
      uid: 'uid-1',
      hostAtMs: 1_700_000_000_000,
    });
  });

  it('falls back to the event name when a denial arrives with no reason', async () => {
    await recordSwoopHostEvent({
      siteId: SITE,
      machineId: MACHINE,
      sid: SID,
      event: 'fp_mismatch',
      outcome: 'deny',
      capability: Capability.MACHINE_REMOTE_VIEW,
    });

    expect(auditRows()[0].data.denyReason).toBe('fp_mismatch');
  });

  it('writes every event to the audit log and none to the site log feed', async () => {
    await recordSwoopSessionStarted({ ...base, sid: SID, viewerId: VIEWER, ctl: true });
    await recordSwoopSessionEnded({ ...base, sid: SID, endReason: 'closed' });
    recordSwoopDenied({ ...base, event: 'lease_denied', denyReason: 'lease_cap', ctl: false });
    await recordSwoopHostEvent({
      siteId: SITE,
      machineId: MACHINE,
      sid: SID,
      event: 'session_ended',
      outcome: 'allow',
      capability: Capability.MACHINE_REMOTE_VIEW,
    });
    await Promise.resolve();

    expect(written).toHaveLength(4);
    for (const row of written) {
      expect(row.path.startsWith(`sites/${SITE}/audit_log/`)).toBe(true);
      expect(row.path).not.toContain(`sites/${SITE}/logs`);
    }
  });
});
