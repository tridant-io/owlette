/**
 * how a machine row shows the state the api read for it (`machineStatus`): the
 * dot, the status words and their colours, as `MachineStatusPill` colours the
 * same three states. the site settings machines list and the admin site list's
 * machines card share them.
 */
import type { MachineOnlineState } from '@/lib/machineOnline';
import { formatRelativeTime } from '@/lib/timeUtils';

/** a machine as `GET /api/sites/{siteId}/machines` and `GET /api/sites?include=machines` list it */
export interface ListedMachineState {
  online: boolean;
  asleep: boolean;
  lastHeartbeat: string | null;
}

export function listedMachineState(m: Pick<ListedMachineState, 'online' | 'asleep'>): MachineOnlineState {
  return m.online ? 'online' : m.asleep ? 'asleep' : 'offline';
}

/** "online", "asleep", "last seen 18d ago" or "never seen" */
export function machineLastSeen(m: ListedMachineState): string {
  if (m.online) return 'online';
  if (m.asleep) return 'asleep';
  if (!m.lastHeartbeat) return 'never seen';
  const parsed = Date.parse(m.lastHeartbeat);
  return Number.isNaN(parsed) ? 'unknown' : `last seen ${formatRelativeTime(parsed / 1000)}`;
}

export const MACHINE_STATE_DOT: Record<MachineOnlineState, string> = {
  online: 'bg-success',
  asleep: 'bg-info-solid',
  offline: 'bg-danger/70',
};

export const MACHINE_STATE_TEXT: Record<MachineOnlineState, string> = {
  online: 'text-success dark:text-success/90',
  asleep: 'text-info',
  offline: 'text-muted-foreground',
};
