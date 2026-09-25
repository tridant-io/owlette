/**
 * GET /api/sites/{siteId}/machines — every machine in the site with online status
 * and a `currentRoosts` summary: the roosts targeting it plus their
 * currentVersionId, so "what is this machine running" reads at a glance.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
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

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
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

    const machines = machinesSnap.docs.map((d) => {
      const data = d.data();
      const lastHeartbeat = data.lastHeartbeat ?? data.presence?.lastHeartbeat ?? null;
      return {
        id: d.id,
        name: typeof data.name === 'string'
          ? data.name
          : typeof data.machine_name === 'string'
            ? data.machine_name
            : d.id,
        online: data.online === true,
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
        currentRoosts: roostsByMachine.get(d.id) ?? [],
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
