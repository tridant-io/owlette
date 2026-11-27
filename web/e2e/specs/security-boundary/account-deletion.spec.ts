import { type Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupRun, makeRunIds, runSiteMark, sweepStaleRuns } from './cleanup';
import {
  assertDevProject,
  createSignedInClient,
  loadLocalEnv,
  openAdmin,
  pushCheck,
  pushCleanup,
  resolveBaseUrl,
  resolveProjectId,
  type CheckResult,
  writeReport,
} from './helpers';

type ApiResult = {
  status: number;
  body: unknown;
};

async function apiDelete(
  request: APIRequestContext,
  baseUrl: string,
  idToken: string,
  path: string,
  idempotencyKey: string,
): Promise<ApiResult> {
  const response = await request.fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    data: {},
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status(), body: parsed };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function deletedCounts(body: unknown): Record<string, unknown> {
  return asObject(asObject(body).deletedCounts);
}

function check(
  checks: CheckResult[],
  name: string,
  ok: boolean,
  message?: string,
): void {
  pushCheck(checks, { name, ok, message: ok ? undefined : message });
  expect(ok, `${name}: ${message ?? ''}`).toBe(true);
}

function expectStatus(checks: CheckResult[], name: string, result: ApiResult, expected: number): void {
  const ok = result.status === expected;
  pushCheck(checks, {
    name,
    ok,
    status: result.status,
    message: ok ? undefined : JSON.stringify(result.body),
  });
  expect(result.status, `${name}: ${JSON.stringify(result.body)}`).toBe(expected);
}

async function seedAccountDeletionData(
  db: Firestore,
  auth: Auth,
  uid: string,
  email: string,
  siteId: string,
): Promise<void> {
  await auth.createUser({
    uid,
    email,
    emailVerified: true,
    displayName: 'W8 Account Delete',
  }).catch(async (err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      await auth.updateUser(uid, { email, emailVerified: true });
      return;
    }
    throw err;
  });

  await db.collection('users').doc(uid).set({
    email,
    role: 'member',
    sites: [siteId],
    displayName: 'W8 Account Delete',
    createdAt: FieldValue.serverTimestamp(),
    mfaEnrolled: false,
    requiresMfaSetup: false,
  });
  await db.collection('sites').doc(siteId).set({
    name: 'W8 Account Delete Site',
    owner: uid,
    ...runSiteMark(siteId),
    timezone: 'UTC',
    createdAt: FieldValue.serverTimestamp(),
  });

  const siteRef = db.collection('sites').doc(siteId);
  await Promise.all([
    siteRef.collection('machines').doc('machine-a').set({ online: true }),
    siteRef.collection('machines').doc('machine-b').set({ online: true }),
    siteRef.collection('deployments').doc('deploy-a').set({ status: 'completed' }),
    siteRef.collection('logs').doc('log-a').set({ level: 'info', action: 'a' }),
    siteRef.collection('logs').doc('log-b').set({ level: 'warn', action: 'b' }),
  ]);
}

test('live dev account deletion dry-run and replay stay server-mediated', async ({ request }) => {
  loadLocalEnv();

  const projectId = resolveProjectId();
  assertDevProject(projectId);
  const baseUrl = resolveBaseUrl();
  const ids = makeRunIds('w8-account');
  const admin = openAdmin(projectId, `security-boundary-account-admin-${ids.runId}`);
  const adminAuth = admin.auth;
  const adminDb = admin.db;
  let client: Awaited<ReturnType<typeof createSignedInClient>> | undefined;
  const checks: CheckResult[] = [];
  const leftovers: string[] = [];

  try {
    leftovers.push(...(await sweepStaleRuns(adminDb, adminAuth, projectId)));
    await seedAccountDeletionData(adminDb, adminAuth, ids.uid, ids.email, ids.siteId);
    client = await createSignedInClient(
      adminAuth,
      projectId,
      ids.uid,
      `security-boundary-account-client-${ids.runId}`,
    );

    const dryRun = await apiDelete(
      request,
      baseUrl,
      client.idToken,
      '/api/users/me?dryRun=1',
      `dry-${ids.runId}`,
    );
    expectStatus(checks, 'account deletion dry-run', dryRun, 200);
    const dryBody = asObject(dryRun.body);
    const dryCounts = deletedCounts(dryRun.body);
    check(checks, 'dry-run reports no live deletes', dryBody.dryRun === true && dryBody.performed === false);
    check(checks, 'dry-run counts owned docs', (
      dryCounts.machines === 2 &&
      dryCounts.deployments === 1 &&
      dryCounts.logs === 2 &&
      dryCounts.sites === 1 &&
      dryCounts.users === 1
    ), JSON.stringify(dryCounts));

    const [userAfterDryRun, siteAfterDryRun] = await Promise.all([
      adminDb.collection('users').doc(ids.uid).get(),
      adminDb.collection('sites').doc(ids.siteId).get(),
    ]);
    check(
      checks,
      'dry-run leaves user and site docs intact',
      userAfterDryRun.exists && siteAfterDryRun.exists,
    );

    const liveKey = `delete-${ids.runId}`;
    const liveDelete = await apiDelete(
      request,
      baseUrl,
      client.idToken,
      '/api/users/me',
      liveKey,
    );
    expectStatus(checks, 'account deletion live cascade', liveDelete, 200);
    const liveBody = asObject(liveDelete.body);
    check(
      checks,
      'live deletion performs cascade',
      liveBody.performed === true &&
        liveBody.alreadyCompleted === false &&
        asObject(liveBody.deletedCounts).sites === 1 &&
        asObject(liveBody.deletedCounts).users === 1,
      JSON.stringify(liveBody),
    );

    const [userAfterDelete, siteAfterDelete] = await Promise.all([
      adminDb.collection('users').doc(ids.uid).get(),
      adminDb.collection('sites').doc(ids.siteId).get(),
    ]);
    check(
      checks,
      'live deletion removes user and owned site docs',
      !userAfterDelete.exists && !siteAfterDelete.exists,
    );

    const replay = await apiDelete(
      request,
      baseUrl,
      client.idToken,
      '/api/users/me',
      liveKey,
    );
    expectStatus(checks, 'account deletion idempotency replay', replay, 200);
    const replayBody = asObject(replay.body);
    check(
      checks,
      'replay returns recorded outcome without redoing deletes',
      replayBody.performed === false && replayBody.alreadyCompleted === true,
      JSON.stringify(replayBody),
    );
  } finally {
    leftovers.push(...(await cleanupRun(adminDb, adminAuth, ids, [ids.uid])));
    pushCleanup(checks, leftovers);

    writeReport(
      'account-deletion',
      'W8.1 Account Deletion',
      {
        generatedAt: new Date().toISOString(),
        projectId,
        baseUrl,
        siteId: ids.siteId,
        uid: ids.uid,
      },
      checks,
    );

    await Promise.allSettled([client?.signOutAndDelete()]);
    await admin.close();
    expect.soft(leftovers, 'left on the live project').toEqual([]);
  }
});
