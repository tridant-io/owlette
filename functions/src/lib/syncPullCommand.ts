/**
 * sync_pull payload contract — pure builder + id helper for the command queued onto each
 * machine's `commands/pending` doc. Five call sites must stay aligned: functions/src/
 * distributionFanout.ts and rolloutScheduler.ts through this builder, and the roost deploy,
 * resync and rollback routes, which build their own.
 *
 * agent/src/sync_commands.py:_handle_sync_pull runs `_require_str` over every key emitted
 * here, so a renamed or missing field crashes the agent before any disk work.
 *
 * No firebase-admin imports, so a contract test can pin field names without a firestore client.
 */

export function buildSyncPullCommand(
  siteId: string,
  roostId: string,
  versionId: string,
  versionUrl: string,
  extractRoot: string,
  queuedAt: unknown,
): Record<string, unknown> {
  return {
    type: 'sync_pull',
    site_id: siteId,
    roost_id: roostId,
    version_id: versionId,
    version_url: versionUrl,
    extract_root: extractRoot,
    queued_at: queuedAt,
  };
}

export function syncPullCommandId(roostId: string, versionId: string): string {
  return `roost_sync_${roostId}_${versionId}`;
}
