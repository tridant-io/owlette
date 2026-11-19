import { FieldValue } from 'firebase-admin/firestore';
import { expect, test } from '@playwright/test';
import { type FirebaseApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  doc,
  getDoc,
  getFirestore,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { cleanupRun, makeRunIds, runSiteMark, sweepStaleRuns } from './cleanup';
import {
  assertDevProject,
  createSignedInClient,
  errorCode,
  errorMessage,
  loadLocalEnv,
  openAdmin,
  pushCleanup,
  resolveProjectId,
  seedMember,
  type CheckResult,
  writeReport,
} from './helpers';

async function expectPermissionDenied(
  name: string,
  operation: () => Promise<unknown>,
  checks: CheckResult[],
): Promise<void> {
  try {
    await operation();
    checks.push({
      name,
      ok: false,
      message: 'operation unexpectedly succeeded',
    });
    expect(`${name} unexpectedly succeeded`).toBe('');
  } catch (err) {
    const code = errorCode(err);
    const denied = code === 'permission-denied';
    checks.push({
      name,
      ok: denied,
      code,
      message: denied ? undefined : errorMessage(err),
    });
    expect(code).toBe('permission-denied');
  }
}

async function expectAllowed(
  name: string,
  operation: () => Promise<unknown>,
  checks: CheckResult[],
): Promise<void> {
  try {
    await operation();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({
      name,
      ok: false,
      code: errorCode(err),
      message: errorMessage(err),
    });
    expect(`${name} was denied with ${errorCode(err)}`).toBe('');
  }
}

test('live dev rejects direct browser control-plane writes post-lockdown', async () => {
  loadLocalEnv();

  const projectId = resolveProjectId();
  assertDevProject(projectId);
  const ids = makeRunIds('w8');
  const admin = openAdmin(projectId, `security-boundary-admin-${ids.runId}`);
  const adminAuth = admin.auth;
  const adminDb = admin.db;

  let clientApp: FirebaseApp | undefined;
  let signOutAndDelete: (() => Promise<void>) | undefined;
  const checks: CheckResult[] = [];
  const leftovers: string[] = [];

  try {
    leftovers.push(...(await sweepStaleRuns(adminDb, adminAuth, projectId)));
    await adminDb.collection('sites').doc(ids.siteId).set({
      name: 'W8.1 Security Boundary',
      owner: 'security-boundary-owner',
      ...runSiteMark(ids.siteId),
      timezone: 'UTC',
      createdAt: FieldValue.serverTimestamp(),
    });
    await adminDb.collection('users').doc(ids.uid).set({
      email: ids.email,
      role: 'member',
      sites: [ids.siteId],
      displayName: 'W8.1 Boundary User',
      createdAt: FieldValue.serverTimestamp(),
      mfaEnrolled: false,
      requiresMfaSetup: false,
    });
    // The member ROW is what grants site access; `users/{uid}.sites[]` above is
    // the legacy mirror and grants nothing. Seeding only the mirror left this
    // user with no access to the site AT ALL, so all four denials below fired
    // because the site was unreachable rather than because the control-plane
    // lockdown works — the drill would have passed against wide-open rules.
    // `member` is deliberate: the read-only tier is exactly the actor this drill
    // is about, someone with legitimate access who must still be refused direct
    // writes.
    await seedMember(adminDb, ids.siteId, ids.uid, 'member');
    await adminDb
      .collection('sites')
      .doc(ids.siteId)
      .collection('machines')
      .doc(ids.machineId)
      .set({
        online: true,
        lastHeartbeat: Math.floor(Date.now() / 1000),
        configChangeFlag: false,
        cortexEnabled: true,
      });
    await adminDb
      .collection('config')
      .doc(ids.siteId)
      .collection('machines')
      .doc(ids.machineId)
      .set({ processes: [] });

    const signedIn = await createSignedInClient(
      adminAuth,
      projectId,
      ids.uid,
      `security-boundary-client-${ids.runId}`,
    );
    clientApp = signedIn.app;
    signOutAndDelete = signedIn.signOutAndDelete;
    expect(getAuth(clientApp).currentUser?.uid).toBe(ids.uid);

    const clientDb = getFirestore(clientApp);

    // POSITIVE CONTROL, and it has to come first: it proves the access is real.
    // Without it a denial below cannot be distinguished from having no access,
    // which is the precise way this drill was passing vacuously.
    await expectAllowed(
      'positive control — member can read the site it belongs to',
      () => getDoc(doc(clientDb, 'sites', ids.siteId)),
      checks,
    );

    await expectAllowed(
      'preference write remains allowed',
      () =>
        setDoc(doc(clientDb, 'users', ids.uid, 'settings', 'security-boundary-smoke'), {
          provider: 'none',
          updatedAt: Date.now(),
        }),
      checks,
    );

    await expectPermissionDenied(
      'deployment create direct write denied',
      () =>
        setDoc(doc(clientDb, 'sites', ids.siteId, 'deployments', 'direct-deployment'), {
          name: 'Direct Deployment',
          installer_name: 'TouchDesigner.exe',
          targets: [ids.machineId],
          status: 'pending',
          createdAt: Date.now(),
        }),
      checks,
    );

    await expectPermissionDenied(
      'machine hoot toggle direct write denied',
      () =>
        updateDoc(doc(clientDb, 'sites', ids.siteId, 'machines', ids.machineId), {
          cortexEnabled: false,
        }),
      checks,
    );

    await expectPermissionDenied(
      'pending command direct write denied',
      () =>
        setDoc(
          doc(clientDb, 'sites', ids.siteId, 'machines', ids.machineId, 'commands', 'pending'),
          {
            'cmd-direct': {
              type: 'restart_process',
              status: 'pending',
              createdAt: Date.now(),
            },
          },
          { merge: true },
        ),
      checks,
    );

    await expectPermissionDenied(
      'machine config direct write denied',
      () =>
        setDoc(
          doc(clientDb, 'config', ids.siteId, 'machines', ids.machineId),
          {
            processes: [
              {
                id: 'proc-direct',
                name: 'TouchDesigner',
                path: 'C:\\TouchDesigner\\TouchDesigner.exe',
              },
            ],
          },
          { merge: true },
        ),
      checks,
    );
  } finally {
    leftovers.push(...(await cleanupRun(adminDb, adminAuth, ids, [ids.uid])));
    pushCleanup(checks, leftovers);

    writeReport(
      'direct-write-bypass',
      'W8.1 Direct Browser Write Bypass',
      {
        generatedAt: new Date().toISOString(),
        projectId,
        siteId: ids.siteId,
        machineId: ids.machineId,
        uid: ids.uid,
      },
      checks,
    );

    await signOutAndDelete?.();
    await admin.close();
    expect.soft(leftovers, 'left on the live project').toEqual([]);
  }
});
