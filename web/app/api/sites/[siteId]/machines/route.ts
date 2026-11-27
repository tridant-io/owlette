/**
 * GET /api/sites/{siteId}/machines — every machine in the site with `online` and
 * `asleep` read as the dashboard reads them (`machineOnlineState`), and a
 * `currentRoosts` summary: the roosts targeting it plus their
 * currentVersionId, so "what is this machine running" reads at a glance.
 * a scoped member gets only the machines in their machine scope, each with its
 * `currentRoosts`: a roost that targets their machine is about their machine.
 * each machine carries its `pendingMove` out of the site, or null.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { scopeCovers } from '@/lib/machineAccess';
import { readMove, type MoveStatus } from '@/lib/machineMoves.server';
import { machineOnlineState } from '@/lib/machineOnline';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

interface RoostSummary {
  roostId: string;
  name: string;
  currentVersionId: string | null;
  versionCounter: number;
}

interface PendingMove {
  targetSiteId: string;
  targetSiteName: string;
  status: MoveStatus;
  /** epoch milliseconds, as the move store keeps it. */
  expiresAt: number;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read', { machineScope: 'admit' });
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const siteRef = db.collection('sites').doc(siteId);

    // Roosts drive the per-machine current-roost summary.
    const [machinesSnap, roostsSnap] = await Promise.all([
      siteRef.collection('machines').get(),
      siteRef.collection('roosts').get(),
    ]);

    // machineId → roost summaries[]
    const roostsByMachine = new Map<string, RoostSummary[]>();
    for (const roostDoc of roostsSnap.docs) {
      const data = roostDoc.data();
      if (data.deletedAt) continue;
      const targets = Array.isArray(data.targets) ? (data.targets as string[]) : [];
      const summary: RoostSummary = {
        roostId: roostDoc.id,
        name: typeof data.name === 'string' ? data.name : roostDoc.id,
        currentVersionId: typeof data.currentVersionId === 'string' ? data.currentVersionId : null,
        versionCounter: typeof data.versionCounter === 'number' ? data.versionCounter : 0,
      };
      for (const machineId of targets) {
        const existing = roostsByMachine.get(machineId);
        if (existing) existing.push(summary);
        else roostsByMachine.set(machineId, [summary]);
      }
    }

    const inMachineScope = machinesSnap.docs.filter((d) => scopeCovers(auth.machineIds, d.id));
    const moves = await pendingMoves(db, siteId, inMachineScope.map((d) => d.id));
    const nowSec = Math.floor(Date.now() / 1000);
    const machines = inMachineScope.map((d, i) => {
      const data = d.data();
      const lastHeartbeat = data.lastHeartbeat ?? data.presence?.lastHeartbeat ?? null;
      const onlineState = machineOnlineState({ online: data.online, asleep: data.asleep, lastHeartbeat }, nowSec);
      return {
        id: d.id,
        name: typeof data.name === 'string'
          ? data.name
          : typeof data.machine_name === 'string'
            ? data.machine_name
            : d.id,
        online: onlineState === 'online',
        asleep: onlineState === 'asleep',
        lastHeartbeat: heartbeatToIso(lastHeartbeat),
        agentVersion:
          data.agent_version ?? data.presence?.agent_version ?? null,
        os: data.os ?? data.presence?.os ?? null,
        // what the agent writes on every heartbeat (firebase_client._os_identity):
        // 'windows' | 'macos' | 'linux', 'x64' | 'arm64', and the version string.
        // an absent osFamily is a pre-3.4 windows agent.
        osFamily: data.osFamily ?? null,
        arch: data.arch ?? null,
        osVersion: data.osVersion ?? null,
        // what the agent holds for the site's keep screens awake switch
        // ({ wanted, held, session, how, reason }), mirrored on each change;
        // absent on an agent that predates it.
        displayAwake: data.displayAwake ?? null,
        // what the dashboard needs to tell whether the agent would refuse a
        // restart now: the heartbeat's capability map (activeHoursGuard), its
        // windows active hours ({ start, end, source }) and the machine's own
        // zone, which the window is read on.
        capabilities: data.capabilities ?? null,
        activeHours: data.activeHours ?? null,
        machineTimezone: data.machine_timezone_iana ?? null,
        currentRoosts: roostsByMachine.get(d.id) ?? [],
        pendingMove: moves[i],
      };
    });

    machines.sort((a, b) => a.name.localeCompare(b.name));

    return applyAuthDeprecations(
      NextResponse.json({ machines }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/machines:GET');
  }
}

/**
 * each machine's move out of the site, in order, or null. the target is named
 * for the row's tag, by its id when the site has no name or is gone. a lapsed
 * pending move reads as none.
 */
async function pendingMoves(db: Firestore, siteId: string, machineIds: string[]): Promise<Array<PendingMove | null>> {
  const moves = await Promise.all(machineIds.map((machineId) => readMove(db, siteId, machineId)));
  const targetIds = [...new Set(moves.flatMap((move) => (move ? [move.targetSiteId] : [])))];
  const targets = await Promise.all(targetIds.map((id) => db.collection('sites').doc(id).get()));
  const names = new Map(
    targetIds.map((id, i) => {
      const name: unknown = targets[i].data()?.name;
      return [id, typeof name === 'string' && name ? name : id];
    }),
  );
  return moves.map((move) =>
    move
      ? {
          targetSiteId: move.targetSiteId,
          targetSiteName: names.get(move.targetSiteId) ?? move.targetSiteId,
          status: move.status,
          expiresAt: move.expiresAt,
        }
      : null,
  );
}

function heartbeatToIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}
