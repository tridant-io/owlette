import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { cleanupRun, holdSecurityConfig, makeRunIds, runSiteMark, sweepStaleRuns } from './cleanup';
import {
  assertDevProject,
  createSignedInClient,
  errorMessage,
  loadLocalEnv,
  openAdmin,
  pushCheck,
  pushCleanup,
  requireEnv,
  resolveBaseUrl,
  resolveProjectId,
  seedMember,
  type CheckResult,
  writeReport,
} from './helpers';
import { dispatchExistingCommandAsSystem } from '@/lib/hoot/dispatch.server';
import { Capability } from '@/lib/capabilities';
import { securityConfig } from '@/lib/securityConfig.server';

type ApiResult = {
  status: number;
  body: unknown;
};

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedString(value: unknown, ...path: string[]): string | undefined {
  let cursor = value;
  for (const segment of path) {
    cursor = jsonObject(cursor)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

async function apiCall(
  request: APIRequestContext,
  baseUrl: string,
  idToken: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const response = await request.fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `w8-${randomUUID()}`,
    },
    data: method === 'POST' ? body ?? {} : undefined,
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

function expectStatus(
  checks: CheckResult[],
  name: string,
  result: ApiResult,
  expectedStatus: number,
): void {
  const ok = result.status === expectedStatus;
  pushCheck(checks, {
    name,
    ok,
    status: result.status,
    code: nestedString(result.body, 'code') ?? nestedString(result.body, 'title'),
    message: ok ? undefined : JSON.stringify(result.body),
  });
  expect(result.status, `${name}: ${JSON.stringify(result.body)}`).toBe(expectedStatus);
}

function subjectDocId(subjectKey: string): string {
  return createHash('sha256').update(subjectKey).digest('hex').slice(0, 32);
}

async function sumRateLimitShards(
  db: Firestore,
  siteId: string,
  bucket: 'system' | 'user',
  subjectKey: string,
  capability: string,
): Promise<number> {
  const snap = await db
    .collection('sites')
    .doc(siteId)
    .collection('rate_limits')
    .doc(bucket)
    .collection('subjects')
    .doc(subjectDocId(subjectKey))
    .collection('capabilities')
    .doc(capability)
    .collection('shards')
    .get();

  let total = 0;
  snap.forEach((doc) => {
    const count = doc.data().count;
    if (typeof count === 'number') total += count;
  });
  return total;
}

async function seedHootData(
  db: Firestore,
  auth: Auth,
  ids: ReturnType<typeof makeRunIds>,
  machineIds: string[],
  memberUid: string,
  memberEmail: string,
): Promise<void> {
  await auth.createUser({
    uid: memberUid,
    email: memberEmail,
    emailVerified: true,
    displayName: 'W8.1 Hoot Member',
  }).catch(async (err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      await auth.updateUser(memberUid, {
        email: memberEmail,
        emailVerified: true,
        displayName: 'W8.1 Hoot Member',
      });
      return;
    }
    throw err;
  });

  await db.collection('sites').doc(ids.siteId).set({
    name: 'W8.1 Hoot Site',
    // no owner: plans are not enforced on a site with no payer, and a plan refusal (402) would
    // come before the checks this drill is about
    ...runSiteMark(ids.siteId),
    timezone: 'UTC',
    createdAt: FieldValue.serverTimestamp(),
  });

  await db.collection('users').doc(memberUid).set({
    email: memberEmail,
    role: 'member',
    sites: [ids.siteId],
    displayName: 'W8.1 Hoot Member',
    createdAt: FieldValue.serverTimestamp(),
    mfaEnrolled: false,
    requiresMfaSetup: false,
  });
  await seedMember(db, ids.siteId, memberUid, 'member');

  const batch = db.batch();
  for (const machineId of machineIds) {
    batch.set(db.collection('sites').doc(ids.siteId).collection('machines').doc(machineId), {
      name: 'W8.1 Hoot Machine',
      online: true,
      lastHeartbeat: Math.floor(Date.now() / 1000),
      agent_version: 'w8.1-e2e',
      cortexEnabled: true,
      metrics: {
        processes: {
          'TouchDesigner.exe': { status: 'running', pid: 8123 },
        },
      },
    });
  }
  await batch.commit();

  await db.collection('global').doc('security_config').set(
    {
      capability_enforcement: true,
      rate_limit_enforcement: true,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'w8.1-cortex-autonomous-burst',
    },
    { merge: true },
  );
}

function ensureDefaultAdminApp(projectId: string): void {
  if (getApps().some((app) => app?.name === '[DEFAULT]')) return;

  initializeApp({
    credential: cert({
      projectId,
      clientEmail: requireEnv('FIREBASE_CLIENT_EMAIL'),
      privateKey: requireEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    }),
    projectId,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function completePendingCommands(
  db: Firestore,
  siteId: string,
  machineIds: string[],
  shouldStop: () => boolean,
): Promise<void> {
  const completed = new Set<string>();
  while (!shouldStop()) {
    await Promise.all(
      machineIds.map(async (machineId) => {
        const pendingRef = db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('commands')
          .doc('pending');
        const completedRef = db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('commands')
          .doc('completed');
        const snap = await pendingRef.get();
        const data = snap.data() ?? {};
        const updates: Record<string, unknown> = {};
        for (const commandId of Object.keys(data)) {
          const key = `${machineId}:${commandId}`;
          if (completed.has(key)) continue;
          completed.add(key);
          updates[commandId] = {
            status: 'success',
            result: 'w8.1 synthetic agent completion',
            completedAt: FieldValue.serverTimestamp(),
          };
        }
        if (Object.keys(updates).length > 0) {
          await completedRef.set(updates, { merge: true });
        }
      }),
    );
    await delay(250);
  }
}

test('member Hoot read path and autonomous burst stay inside system boundary', async ({ request }) => {
  test.setTimeout(180_000);
  loadLocalEnv();
  process.env.E2E_DISABLE_RATE_LIMIT = 'false';

  const projectId = resolveProjectId();
  assertDevProject(projectId);
  const baseUrl = resolveBaseUrl();
  const ids = makeRunIds('w8-cortex');
  const burstMachineIds = [
    ids.machineId,
    `${ids.machineId}-burst-2`,
    `${ids.machineId}-burst-3`,
  ];
  const memberUid = `${ids.uid}-member`;
  const memberEmail = `${memberUid}@security-boundary.e2e`;
  const checks: CheckResult[] = [];
  const leftovers: string[] = [];
  let conversationId: string | undefined;
  ensureDefaultAdminApp(projectId);

  const admin = openAdmin(projectId, `security-boundary-cortex-admin-${ids.runId}`);
  const adminAuth = admin.auth;
  const adminDb = admin.db;
  let memberClient: Awaited<ReturnType<typeof createSignedInClient>> | undefined;
  let restoreSecurityConfig: Awaited<ReturnType<typeof holdSecurityConfig>> | undefined;

  try {
    leftovers.push(...(await sweepStaleRuns(adminDb, adminAuth, projectId)));
    restoreSecurityConfig = await holdSecurityConfig(adminDb);
    await seedHootData(adminDb, adminAuth, ids, burstMachineIds, memberUid, memberEmail);
    memberClient = await createSignedInClient(
      adminAuth,
      projectId,
      memberUid,
      `security-boundary-cortex-member-${ids.runId}`,
    );

    const createConversation = await apiCall(
      request,
      baseUrl,
      memberClient.idToken,
      'POST',
      '/api/cortex/conversations',
      {
        siteId: ids.siteId,
        machineId: ids.machineId,
        title: 'W8.1 member read-only Hoot question',
        initial_message: {
          role: 'user',
          content: 'What is the current machine state?',
        },
      },
    );
    expectStatus(checks, 'member hoot question accepted', createConversation, 201);
    conversationId = nestedString(createConversation.body, 'data', 'conversationId');
    expect(conversationId).toBeTruthy();

    const conversationSnap = await adminDb
      .collection('chat_conversations')
      .doc(conversationId!)
      .get();
    const conversation = conversationSnap.data() ?? {};
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const questionPersisted =
      conversation.ownerUid === memberUid &&
      conversation.siteId === ids.siteId &&
      messages.some((message) => jsonObject(message).role === 'user');
    pushCheck(checks, {
      name: 'member hoot question persisted',
      ok: questionPersisted,
      status: conversationSnap.exists ? 200 : 404,
    });
    expect(questionPersisted).toBe(true);

    securityConfig.__resetCacheForTests();

    let stopCompleter = false;
    const completerErrors: string[] = [];
    const completer = completePendingCommands(
      adminDb,
      ids.siteId,
      burstMachineIds,
      () => stopCompleter,
    ).catch((err: unknown) => {
      completerErrors.push(err instanceof Error ? err.message : String(err));
    });

    let burstResults: unknown[] = [];
    try {
      burstResults = (
        await Promise.all(
          burstMachineIds.map(async (machineId, investigation) => {
            const results: unknown[] = [];
            for (let toolCall = 0; toolCall < 20; toolCall += 1) {
              results.push(
                await dispatchExistingCommandAsSystem(
                  {
                    db: adminDb,
                    siteId: ids.siteId,
                    machineId,
                    chatId: `chat-${ids.runId}-${investigation}`,
                    eventId: `event-${ids.runId}-${investigation}`,
                  },
                  'restart_process',
                  { process_name: `W8Process${toolCall}.exe` },
                ),
              );
            }
            return results;
          }),
        )
      ).flat();
    } finally {
      stopCompleter = true;
      await completer;
    }
    expect(completerErrors).toEqual([]);

    pushCheck(checks, {
      name: 'hoot autonomous 3x20 burst allowed',
      ok: burstResults.length === 60,
      status: burstResults.length,
    });
    expect(burstResults).toHaveLength(60);

    const auditSnap = await adminDb
      .collection('sites')
      .doc(ids.siteId)
      .collection('audit_log')
      .get();
    const burstAuditRows = auditSnap.docs
      .map((doc) => doc.data())
      .filter((row) => {
        const eventId = jsonObject(row.metadata).cortexEventId;
        return typeof eventId === 'string' && eventId.startsWith(`event-${ids.runId}-`);
      });

    const allSystemAuditRows =
      burstAuditRows.length === 60 &&
      burstAuditRows.every((row) => {
        const actor = jsonObject(row.actor);
        return (
          row.outcome === 'allow' &&
          row.capability === Capability.MACHINE_EXEC_COMMAND &&
          actor.type === 'system' &&
          actor.name === 'cortex_autonomous'
        );
      });
    pushCheck(checks, {
      name: 'burst audit rows use cortex_autonomous system actor',
      ok: allSystemAuditRows,
      status: burstAuditRows.length,
    });
    expect(allSystemAuditRows).toBe(true);

    const systemShardTotal = await sumRateLimitShards(
      adminDb,
      ids.siteId,
      'system',
      'system:cortex_autonomous',
      Capability.MACHINE_EXEC_COMMAND,
    );
    const userSubjects = await adminDb
      .collection('sites')
      .doc(ids.siteId)
      .collection('rate_limits')
      .doc('user')
      .collection('subjects')
      .listDocuments();

    pushCheck(checks, {
      name: 'system rate-limit bucket records hoot burst',
      ok: systemShardTotal >= 60,
      status: systemShardTotal,
    });
    expect(systemShardTotal).toBeGreaterThanOrEqual(60);

    pushCheck(checks, {
      name: 'user rate-limit bucket untouched by hoot burst',
      ok: userSubjects.length === 0,
      status: userSubjects.length,
    });
    expect(userSubjects).toHaveLength(0);
  } finally {
    leftovers.push(...(await cleanupRun(adminDb, adminAuth, ids, [memberUid])));
    await restoreSecurityConfig?.().catch((err: unknown) => {
      leftovers.push(`global/security_config: ${errorMessage(err)}`);
    });
    pushCleanup(checks, leftovers);

    writeReport(
      'cortex-autonomous-burst',
      'W8.1 Hoot Member Read + Autonomous Burst',
      {
        generatedAt: new Date().toISOString(),
        projectId,
        baseUrl,
        siteId: ids.siteId,
        machineId: ids.machineId,
        memberUid,
        conversationId: conversationId ?? '',
        burstCalls: 60,
      },
      checks,
    );

    await Promise.allSettled([memberClient?.signOutAndDelete()]);
    await admin.close();
    expect.soft(leftovers, 'left on the live project').toEqual([]);
  }
});
