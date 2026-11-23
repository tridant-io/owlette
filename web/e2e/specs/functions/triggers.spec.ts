/**
 * Cloud Functions — Firestore trigger integration.
 *
 * These assert the trigger WIRING, which is the one thing functions/'s 241
 * node:test units structurally cannot cover: those import the handler logic
 * directly, so a broken `onDocumentWritten` path, a renamed collection, or an
 * import that only fails at module load would pass them and still be dead in
 * production. Here the emulator loads functions/lib and Firestore delivers the
 * event, so the whole path is exercised.
 *
 * Scope note: only the FIRESTORE triggers register. The scheduled
 * (pubsub) functions log "function ignored because the pubsub emulator does
 * not exist or is not running" — `pubsub` is not in the emulator set — so
 * processRetryQueue, chunkGcNightly and the sweep dailies are out of reach
 * here by design.
 *
 * Data is written under a site id the UI never lists (no parent site doc is
 * created), so a sampled bucket cannot perturb dashboard specs.
 */

import { expect, test } from '@playwright/test';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyRecord, type AuditRecord } from '@/lib/auditLogVerify';
import { DEFAULT_LOW_DISK_RULE } from '@/lib/defaultAlertRules';
import { getAdminDb } from '../../helpers/emulator';

const SITE_ID = 'e2e-functions-triggers';

/** Mirrors hourlyBucketId in functions/src/metricsHistory.ts: YYYY-MM-DD-HH. */
function hourlyBucketId(date: Date): string {
  return date.toISOString().slice(0, 13).replace('T', '-');
}

/** Poll until `check` returns a value, or fail with `label` after ~20s. */
async function waitFor<T>(
  label: string,
  check: () => Promise<T | null | undefined>,
): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test.describe('firestore triggers', () => {
  test('onMetricsWrite samples an hourly metrics_history bucket', async () => {
    const db = getAdminDb();
    const machineId = `metrics-${Date.now()}`;
    const machineRef = db
      .collection('sites')
      .doc(SITE_ID)
      .collection('machines')
      .doc(machineId);

    // metrics.timestamp must clear the 10-minute liveness gate
    // (metricsWriteDisposition), or the handler deliberately skips the sample.
    const now = new Date();
    await machineRef.set({
      name: 'trigger-probe',
      online: true,
      lastHeartbeat: Timestamp.fromDate(now),
      metrics: {
        timestamp: Timestamp.fromDate(now),
        cpu_percent: 42,
        memory_percent: 61,
      },
    });

    const bucketRef = machineRef.collection('metrics_history').doc(hourlyBucketId(now));
    const snap = await waitFor('onMetricsWrite to sample a bucket', async () => {
      const s = await bucketRef.get();
      return s.exists ? s : null;
    });

    // Bucket id is derived, so existence at THIS id proves the hourly keying
    // too — a daily-keyed regression would land elsewhere and time out above.
    expect(snap.exists).toBe(true);

    await machineRef.collection('metrics_history').get()
      .then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
    await machineRef.delete();
  });

  test('onMetricsWrite fires the default low disk rule on a site that never saved its rules', async () => {
    const db = getAdminDb();
    // a site of its own: the function caches each site's rules for 5 minutes
    const siteId = `e2e-default-low-disk-${Date.now()}`;
    const machineId = 'disk-probe';
    const machineRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);

    const now = new Date();
    await machineRef.set({
      name: 'disk-probe',
      online: true,
      lastHeartbeat: Timestamp.fromDate(now),
      metrics: {
        timestamp: Timestamp.fromDate(now),
        disks: { '/': { percent: DEFAULT_LOW_DISK_RULE.value + 5 } },
      },
    });

    // the cooldown is stamped before the alert is sent, and the emulator has no
    // CORTEX_INTERNAL_SECRET, so it stops there and mails nobody
    const cooldownRef = db
      .collection('sites')
      .doc(siteId)
      .collection('alert_cooldowns')
      .doc(`${DEFAULT_LOW_DISK_RULE.id}_${machineId}`);
    await waitFor('the default low disk rule to fire', async () => ((await cooldownRef.get()).exists ? true : null));

    await cooldownRef.delete();
    await machineRef.collection('metrics_history').get()
      .then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
    await machineRef.delete();
  });

  test('onCommandCompleted advances the matching deployment target', async () => {
    const db = getAdminDb();
    const machineId = `deploy-${Date.now()}`;
    const deploymentId = `dep-${Date.now()}`;

    const deploymentRef = db
      .collection('sites')
      .doc(SITE_ID)
      .collection('deployments')
      .doc(deploymentId);

    // The handler resolves the deployment, finds the target whose machineId
    // matches, and refuses to regress a terminal status — so start intermediate.
    await deploymentRef.set({
      status: 'in_progress',
      targets: [{ machineId, status: 'installing', progress: 10 }],
    });

    // The trigger is on the `commands/completed` DOC, whose fields are a map of
    // commandId -> command. status 'completed' + a non-uninstall type maps to
    // target status 'completed' (mapCommandToTargetStatus).
    await db
      .collection('sites')
      .doc(SITE_ID)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('completed')
      .set({
        'cmd-1': {
          status: 'completed',
          type: 'install_software',
          deployment_id: deploymentId,
          progress: 100,
        },
      });

    const result = await waitFor('the deployment target to reach completed', async () => {
      const snap = await deploymentRef.get();
      const data = snap.data() ?? {};
      const targets = (data.targets ?? []) as Array<{
        machineId: string;
        status: string;
        progress?: number;
        completedAt?: unknown;
      }>;
      const t = targets.find((x) => x.machineId === machineId);
      return t && t.status === 'completed' ? { target: t, deployment: data } : null;
    });

    expect(result.target.status).toBe('completed');
    // `progress` is DELETED on any terminal status, not carried at 100 — a
    // regression that leaves a stale percentage on a finished target shows up
    // here (deploymentStatus.ts: "Clear progress on terminal").
    expect(result.target.progress).toBeUndefined();
    expect(result.target.completedAt).toBeTruthy();
    // The single target going terminal rolls the whole deployment up.
    expect(result.deployment.status).toBe('completed');

    await deploymentRef.delete();
    await db
      .collection('sites')
      .doc(SITE_ID)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('completed')
      .delete();
  });

  test('onAuditQueued drains a burst of queued audit events into one verified chain', async () => {
    const db = getAdminDb();
    // a site of its own, so its chain starts at genesis
    const site = db.collection('sites').doc(`${SITE_ID}-audit-${Date.now()}`);
    const targets = Array.from({ length: 50 }, (_, i) => `t${i}`);

    // queued all at once, as a burst of changes on one site reaches the web emitter
    await Promise.all(
      targets.map((target) =>
        site.collection('audit_queue').add({
          event: { kind: 'process_mutated', siteId: site.id, actor: 'user:e2e', occurredAt: Date.now(), target, attributes: {} },
          enqueuedAt: FieldValue.serverTimestamp(),
        }),
      ),
    );

    const chain = await waitFor('the queue to drain into the audit log', async () => {
      const [queued, log] = await Promise.all([
        site.collection('audit_queue').get(),
        site.collection('audit_log').orderBy('recordedAt').get(),
      ]);
      return queued.empty && log.size === targets.length ? log.docs.map((d) => d.data() as AuditRecord) : null;
    });

    expect(chain.map((r) => r.event.target).sort()).toEqual([...targets].sort());
    chain.forEach((record, i) => {
      expect(verifyRecord(record, i === 0 ? null : chain[i - 1])).toMatchObject({ ok: true, isGenesis: i === 0 });
    });
    expect((await site.collection('audit_log_meta').doc('head').get()).get('hash')).toBe(chain[chain.length - 1].hash);

    await site.collection('audit_log').get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
    await site.collection('audit_log_meta').get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
  });
});
