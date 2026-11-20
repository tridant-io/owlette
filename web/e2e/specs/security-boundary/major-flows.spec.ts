import { type Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
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
  seedMember,
  type CheckResult,
  writeReport,
} from './helpers';

type ApiResult = {
  status: number;
  body: unknown;
};

const COMMAND_TYPES = [
  { type: 'restart_process', params: { process_name: 'TouchDesigner.exe' } },
  { type: 'kill_process', params: { process_name: 'TouchDesigner.exe' } },
  { type: 'start_process', params: { process_name: 'TouchDesigner.exe' } },
  { type: 'reboot_machine', params: { delay_seconds: 60 } },
  { type: 'shutdown_machine', params: { delay_seconds: 60 } },
  { type: 'cancel_reboot', params: {} },
];

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedString(value: unknown, ...path: string[]): string | undefined {
  let cursor = value;
  for (const segment of path) {
    const obj = jsonObject(cursor);
    cursor = obj[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

async function apiCall(
  request: APIRequestContext,
  baseUrl: string,
  idToken: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
    data: body ?? {},
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

function expectStatusIn(
  checks: CheckResult[],
  name: string,
  result: ApiResult,
  expectedStatuses: number[],
): void {
  const ok = expectedStatuses.includes(result.status);
  pushCheck(checks, {
    name,
    ok,
    status: result.status,
    code: nestedString(result.body, 'code') ?? nestedString(result.body, 'title'),
    message: ok ? undefined : JSON.stringify(result.body),
  });
  expect(expectedStatuses, `${name}: ${JSON.stringify(result.body)}`).toContain(result.status);
}

async function seedLiveData(
  db: Firestore,
  auth: Auth,
  ids: ReturnType<typeof makeRunIds>,
  machineIds: string[],
): Promise<void> {
  await auth.createUser({
    uid: ids.uid,
    email: ids.email,
    emailVerified: true,
    displayName: 'W8.1 Major Flows Admin',
  }).catch(async (err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      await auth.updateUser(ids.uid, {
        email: ids.email,
        emailVerified: true,
        displayName: 'W8.1 Major Flows Admin',
      });
      return;
    }
    throw err;
  });

  await db.collection('sites').doc(ids.siteId).set({
    name: 'W8.1 Major Flow Site',
    // no owner: plans are not enforced on a site with no payer, and a plan refusal (402) would
    // come before the checks this drill is about
    ...runSiteMark(ids.siteId),
    timezone: 'UTC',
    deployQuota: 100,
    distributionQuota: 100,
    createdAt: FieldValue.serverTimestamp(),
  });
  await db.collection('users').doc(ids.uid).set({
    email: ids.email,
    role: 'admin',
    sites: [ids.siteId],
    displayName: 'W8.1 Major Flows Admin',
    createdAt: FieldValue.serverTimestamp(),
    mfaEnrolled: false,
    requiresMfaSetup: false,
  });
  await seedMember(db, ids.siteId, ids.uid, 'admin');

  const batch = db.batch();
  for (const machineId of machineIds) {
    const machineRef = db
      .collection('sites')
      .doc(ids.siteId)
      .collection('machines')
      .doc(machineId);
    batch.set(machineRef, {
      online: true,
      lastHeartbeat: Math.floor(Date.now() / 1000),
      agent_version: 'w8.1-e2e',
      cortexEnabled: true,
      capabilities: { displayRemoteApply: 1 },
      metrics: {
        processes: {
          'TouchDesigner.exe': {
            status: 'running',
            pid: 1234,
            responsive: true,
          },
        },
      },
    });
    batch.set(
      db.collection('config').doc(ids.siteId).collection('machines').doc(machineId),
      { processes: [] },
      { merge: true },
    );
  }
  await batch.commit();

  await db
    .collection('sites')
    .doc(ids.siteId)
    .collection('machines')
    .doc(ids.machineId)
    .collection('installed_software')
    .doc('w8-app')
    .set({
      name: 'W8 Test App',
      uninstall_command: 'msiexec.exe /x {00000000-0000-0000-0000-000000000081} /qn',
      installer_type: 'msi',
      install_location: 'C:\\Program Files\\W8 Test App',
    });
}

test('live dev API major control-plane flows stay server-mediated after lockdown', async ({ request }) => {
  loadLocalEnv();

  const projectId = resolveProjectId();
  assertDevProject(projectId);
  const baseUrl = resolveBaseUrl();
  const ids = makeRunIds('w8-api');
  const fanOutMachineIds = Array.from({ length: 50 }, (_, i) =>
    i === 0 ? ids.machineId : `${ids.machineId}-${String(i + 1).padStart(2, '0')}`,
  );

  const admin = openAdmin(projectId, `security-boundary-api-admin-${ids.runId}`);
  const adminAuth = admin.auth;
  const adminDb = admin.db;
  let client: Awaited<ReturnType<typeof createSignedInClient>> | undefined;
  const checks: CheckResult[] = [];
  const leftovers: string[] = [];
  const createdIds: Record<string, string | undefined> = {};

  try {
    leftovers.push(...(await sweepStaleRuns(adminDb, adminAuth, projectId)));
    await seedLiveData(adminDb, adminAuth, ids, fanOutMachineIds);
    client = await createSignedInClient(
      adminAuth,
      projectId,
      ids.uid,
      `security-boundary-api-client-${ids.runId}`,
    );

    for (const command of COMMAND_TYPES) {
      const result = await apiCall(
        request,
        baseUrl,
        client.idToken,
        'POST',
        `/api/sites/${ids.siteId}/machines/${ids.machineId}/commands`,
        command,
      );
      expectStatus(checks, `command ${command.type}`, result, 202);
    }

    const displayCapture = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'PUT',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/display-layout`,
      {
        op: 'capture',
        capturedBy: ids.email,
        monitors: [
          {
            id: 'MONITOR\\W8',
            friendlyName: 'W8 Primary',
            primary: true,
            position: { x: 0, y: 0 },
            resolution: { width: 1920, height: 1080 },
            refreshHz: 60,
          },
        ],
      },
    );
    expectStatus(checks, 'display store layout', displayCapture, 200);

    const displayApply = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'POST',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/commands`,
      {
        type: 'apply_display_topology',
        params: {
          applyId: `apply-${ids.runId}`,
          layout: {
            monitors: [
              {
                id: 'MONITOR\\W8',
                primary: true,
                position: { x: 0, y: 0 },
                resolution: { width: 1920, height: 1080 },
              },
            ],
          },
        },
      },
    );
    expectStatus(checks, 'display apply command', displayApply, 202);

    const displayAck = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'POST',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/commands`,
      {
        type: 'ack_display_topology',
        params: { applyId: `apply-${ids.runId}` },
      },
    );
    expectStatus(checks, 'display recall ack command', displayAck, 202);

    const displayClear = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'DELETE',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/display-layout`,
      {},
    );
    expectStatus(checks, 'display clear layout', displayClear, 200);

    const deploymentCreate = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'POST',
      `/api/sites/${ids.siteId}/deployments`,
      {
        name: 'W8 50-machine deployment',
        installer_name: 'w8-installer.exe',
        installer_url: 'https://example.com/w8-installer.exe',
        silent_flags: '/S',
        machines: fanOutMachineIds,
      },
    );
    expectStatus(checks, 'deployment create 50-machine fan-out', deploymentCreate, 201);
    createdIds.deploymentId = nestedString(deploymentCreate.body, 'deploymentId');
    expect(createdIds.deploymentId).toBeTruthy();

    const deploymentCancel = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'POST',
      `/api/sites/${ids.siteId}/deployments/${createdIds.deploymentId}/cancel`,
      {},
    );
    expectStatus(checks, 'deployment cancel 50-machine fan-out', deploymentCancel, 200);

    const deploymentDelete = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'DELETE',
      `/api/sites/${ids.siteId}/deployments/${createdIds.deploymentId}`,
      {},
    );
    expectStatus(checks, 'deployment delete after cancel', deploymentDelete, 200);

    // The v1 by-URL distribution routes were removed — roost v2 owns project
    // distribution, and its API surface is covered by `specs/roosts/*`.

    const uninstallTrigger = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'POST',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/uninstall`,
      { software_name: 'W8 Test App', timeout_seconds: 120 },
    );
    expectStatus(checks, 'uninstall trigger', uninstallTrigger, 202);

    const uninstallCancel = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'DELETE',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/uninstall?software_name=${encodeURIComponent('W8 Test App')}`,
      {},
    );
    expectStatus(checks, 'uninstall cancel', uninstallCancel, 202);

    const scheduleCreate = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'POST',
      `/api/sites/${ids.siteId}/presets/schedule`,
      {
        name: `W8 Schedule ${ids.runId}`,
        description: 'W8 e2e schedule preset',
        blocks: [],
        isBuiltIn: false,
        order: 81,
      },
    );
    expectStatus(checks, 'schedule preset create', scheduleCreate, 201);
    createdIds.schedulePresetId = nestedString(scheduleCreate.body, 'presetId');

    const schedulePatch = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'PATCH',
      `/api/sites/${ids.siteId}/presets/schedule/${createdIds.schedulePresetId}`,
      {
        name: `W8 Schedule Updated ${ids.runId}`,
        description: 'W8 e2e schedule preset updated',
        blocks: [],
        isBuiltIn: false,
        order: 82,
      },
    );
    expectStatus(checks, 'schedule preset update', schedulePatch, 200);

    const scheduleDelete = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'DELETE',
      `/api/sites/${ids.siteId}/presets/schedule/${createdIds.schedulePresetId}`,
      {},
    );
    expectStatus(checks, 'schedule preset delete', scheduleDelete, 204);

    const rebootCreate = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'POST',
      `/api/sites/${ids.siteId}/presets/reboot`,
      {
        name: `W8 Reboot ${ids.runId}`,
        description: 'W8 e2e reboot preset',
        entries: [],
        isBuiltIn: false,
        order: 81,
      },
    );
    expectStatus(checks, 'reboot preset create', rebootCreate, 201);
    createdIds.rebootPresetId = nestedString(rebootCreate.body, 'presetId');

    const rebootPatch = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'PATCH',
      `/api/sites/${ids.siteId}/presets/reboot/${createdIds.rebootPresetId}`,
      {
        name: `W8 Reboot Updated ${ids.runId}`,
        description: 'W8 e2e reboot preset updated',
        entries: [],
        isBuiltIn: false,
        order: 82,
      },
    );
    expectStatus(checks, 'reboot preset update', rebootPatch, 200);

    const rebootDelete = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'DELETE',
      `/api/sites/${ids.siteId}/presets/reboot/${createdIds.rebootPresetId}`,
      {},
    );
    expectStatus(checks, 'reboot preset delete', rebootDelete, 204);

    const distributionPresetCreate = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'POST',
      `/api/sites/${ids.siteId}/presets/distribution`,
      {
        name: `W8 Distribution Preset ${ids.runId}`,
        description: 'W8 e2e distribution preset',
        project_url: 'https://example.com/w8-preset.toe',
        extract_path: 'C:\\Owlette\\Projects\\W8Preset',
        verify_files: ['w8-preset.toe'],
        isBuiltIn: false,
        order: 81,
      },
    );
    expectStatus(checks, 'distribution preset create', distributionPresetCreate, 201);
    createdIds.distributionPresetId = nestedString(distributionPresetCreate.body, 'presetId');

    const distributionPresetPatch = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'PATCH',
      `/api/sites/${ids.siteId}/presets/distribution/${createdIds.distributionPresetId}`,
      {
        name: `W8 Distribution Preset Updated ${ids.runId}`,
        description: 'W8 e2e distribution preset updated',
        project_url: 'https://example.com/w8-preset-updated.toe',
        extract_path: 'C:\\Owlette\\Projects\\W8PresetUpdated',
        verify_files: ['w8-preset-updated.toe'],
        isBuiltIn: false,
        order: 82,
      },
    );
    expectStatus(checks, 'distribution preset update', distributionPresetPatch, 200);

    const distributionPresetDelete = await apiCall(
      request,
      baseUrl,
      client.idToken,
      'DELETE',
      `/api/sites/${ids.siteId}/presets/distribution/${createdIds.distributionPresetId}`,
      {},
    );
    expectStatus(checks, 'distribution preset delete', distributionPresetDelete, 204);

    const removeMachineId = `${ids.machineId}-remove`;
    await adminDb
      .collection('sites')
      .doc(ids.siteId)
      .collection('machines')
      .doc(removeMachineId)
      .set({
        online: false,
        lastHeartbeat: Math.floor(Date.now() / 1000) - 3600,
        agent_version: 'w8.1-e2e',
      });

    const superUid = `${ids.uid}-super`;
    const superEmail = `${superUid}@security-boundary.e2e`;
    await adminAuth.createUser({ uid: superUid, email: superEmail, emailVerified: true });
    await adminDb.collection('users').doc(superUid).set({
      email: superEmail,
      role: 'superadmin',
      sites: [],
      mfaEnrolled: false,
      requiresMfaSetup: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    const superClient = await createSignedInClient(
      adminAuth,
      projectId,
      superUid,
      `security-boundary-api-super-${ids.runId}`,
    );
    try {
      const machineRemoval = await apiCall(
        request,
        baseUrl,
        superClient.idToken,
        'DELETE',
        `/api/sites/${ids.siteId}/machines/${removeMachineId}`,
        {},
      );
      expectStatus(checks, 'machine removal superadmin', machineRemoval, 200);
    } finally {
      await superClient.signOutAndDelete();
    }

    const memberUid = `${ids.uid}-member`;
    const memberEmail = `${memberUid}@security-boundary.e2e`;
    await adminAuth.createUser({ uid: memberUid, email: memberEmail, emailVerified: true });
    await adminDb.collection('users').doc(memberUid).set({
      email: memberEmail,
      role: 'member',
      sites: [ids.siteId],
      mfaEnrolled: false,
      requiresMfaSetup: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    await seedMember(adminDb, ids.siteId, memberUid, 'member');
    const memberClient = await createSignedInClient(
      adminAuth,
      projectId,
      memberUid,
      `security-boundary-api-member-${ids.runId}`,
    );
    try {
      const memberCommandDenied = await apiCall(
        request,
        baseUrl,
        memberClient.idToken,
        'POST',
        `/api/sites/${ids.siteId}/machines/${ids.machineId}/commands`,
        { type: 'restart_process', params: { process_name: 'TouchDesigner.exe' } },
      );
      expectStatusIn(checks, 'member command denied by capability', memberCommandDenied, [403]);
    } finally {
      await memberClient.signOutAndDelete();
    }
  } finally {
    leftovers.push(
      ...(await cleanupRun(adminDb, adminAuth, ids, [ids.uid, `${ids.uid}-super`, `${ids.uid}-member`])),
    );
    pushCleanup(checks, leftovers);

    writeReport(
      'major-flows',
      'W8.1 Major API Control-Plane Flows',
      {
        generatedAt: new Date().toISOString(),
        projectId,
        baseUrl,
        siteId: ids.siteId,
        uid: ids.uid,
        machineCount: fanOutMachineIds.length,
      },
      checks,
    );

    await Promise.allSettled([client?.signOutAndDelete()]);
    await admin.close();
    expect.soft(leftovers, 'left on the live project').toEqual([]);
  }
});
