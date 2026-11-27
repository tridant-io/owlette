/**
 * Whether a machine is online, asleep or offline: the one reading the dashboard,
 * the api, hoot, the fleet tools and talons all share. No firebase sdk import, so
 * client and server code both use it.
 *
 * The agent's `online` flag alone is not enough: an agent that dies without
 * writing `online: false` (a crash, an installer kill, a power cut) leaves it
 * stuck true, and only the heartbeat age shows the machine is gone.
 */

/**
 * Heartbeat age at which a machine reads offline. 300s tolerates two missed idle
 * beats (120s each); 180s greyed out healthy machines on one slow tick. The
 * health-check cron's OFFLINE_THRESHOLD_MS is built from it, so pill and alerts agree.
 */
export const OFFLINE_HEARTBEAT_AGE_SEC = 300;

export type MachineOnlineState = 'online' | 'asleep' | 'offline';

/**
 * Any Firestore timestamp shape -> Unix seconds; 0 means "no value" (renders `--`,
 * reads offline). Bare numbers are seconds, as e2e seeds and the agent's own
 * second stamps (`rebootScheduledAt`) write them. Must handle every shape the sdk
 * emits: cache rehydration yields plain {seconds,nanoseconds}, which an earlier
 * Timestamp-only parser silently dropped and made the dashboard online pill flap.
 */
export function parseFirestoreSeconds(value: unknown): number {
  if (value == null) return 0;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'object') {
    const v = value as {
      toMillis?: () => number;
      seconds?: number;
      _seconds?: number;
    };
    if (typeof v.toMillis === 'function') {
      try {
        const ms = v.toMillis();
        return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
      } catch {
        // fall through to property reads
      }
    }
    if (typeof v.seconds === 'number') return v.seconds;
    // legacy admin-SDK shape
    if (typeof v._seconds === 'number') return v._seconds;
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  }

  // some Firestore paths hand back ISO strings
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }

  return 0;
}

/**
 * Agent flag AND heartbeat younger than OFFLINE_HEARTBEAT_AGE_SEC (Unix seconds;
 * 0 = absent, fails the check). The dashboard's 30s staleness tick calls this on
 * the derived flag, so it never turns an asleep machine green. Mirrors
 * `classifyMachineHealth` in `app/api/cron/health-check/route.ts`.
 */
export function isMachineOnline(
  onlineFlag: unknown,
  lastHeartbeatSec: number,
  nowSec: number,
): boolean {
  if (onlineFlag !== true) return false;
  if (!Number.isFinite(lastHeartbeatSec)) return false;
  return nowSec - lastHeartbeatSec < OFFLINE_HEARTBEAT_AGE_SEC;
}

/**
 * A machine doc's state as the dashboard pill shows it. Asleep needs the agent's
 * flag too: a machine whose agent wrote `online: false` is offline, whatever
 * `asleep` still says. It comes before the heartbeat age: a dark wake heartbeats
 * for seconds and still says asleep, so no green flicker.
 */
export function machineOnlineState(
  doc: { online?: unknown; asleep?: unknown; lastHeartbeat?: unknown },
  nowSec: number,
): MachineOnlineState {
  if (doc.online === true && doc.asleep === true) return 'asleep';
  return isMachineOnline(doc.online, parseFirestoreSeconds(doc.lastHeartbeat), nowSec) ? 'online' : 'offline';
}
