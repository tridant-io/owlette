/**
 * a machine document read as the api lists it: its name, agent version, last
 * heartbeat and `machineOnlineState`. `GET /api/sites/{siteId}/machines`, its
 * machine detail and `GET /api/sites?include=machines` all map their documents
 * through it, so no two readers derive a machine's state apart.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { machineOnlineState } from '@/lib/machineOnline';

/** the fields `machineStatus` reads, for a query's `select()`; its fallbacks included. */
export const MACHINE_STATUS_FIELDS = [
  'name',
  'machine_name',
  'online',
  'asleep',
  'lastHeartbeat',
  'agent_version',
  'presence.lastHeartbeat',
  'presence.agent_version',
] as const;

export interface MachineStatus {
  id: string;
  name: string;
  /** the agent's flag and a heartbeat younger than OFFLINE_HEARTBEAT_AGE_SEC */
  online: boolean;
  /** the agent marked it asleep; `online` is false meanwhile */
  asleep: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
}

export function machineStatus(
  id: string,
  data: FirebaseFirestore.DocumentData,
  nowSec: number,
): MachineStatus {
  const lastHeartbeat = data.lastHeartbeat ?? data.presence?.lastHeartbeat ?? null;
  const state = machineOnlineState({ online: data.online, asleep: data.asleep, lastHeartbeat }, nowSec);
  return {
    id,
    name: typeof data.name === 'string'
      ? data.name
      : typeof data.machine_name === 'string'
        ? data.machine_name
        : id,
    online: state === 'online',
    asleep: state === 'asleep',
    lastHeartbeat: heartbeatToIso(lastHeartbeat),
    agentVersion: data.agent_version ?? data.presence?.agent_version ?? null,
  };
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
