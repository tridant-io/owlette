import { type App, cert, deleteApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { type Auth, getAuth as getAdminAuth } from 'firebase-admin/auth';
import { FieldValue, type Firestore, getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  deleteApp as deleteClientApp,
  initializeApp,
  type FirebaseApp,
} from 'firebase/app';
import { getAuth, signInWithCustomToken, signOut } from 'firebase/auth';
import { DEV_PROJECT_ID } from './cleanup';

export type CheckResult = {
  name: string;
  ok: boolean;
  code?: string;
  status?: number;
  message?: string;
};

export type SignedInClient = {
  app: FirebaseApp;
  idToken: string;
  signOutAndDelete: () => Promise<void>;
};

const WEB_ROOT = process.cwd();
const REPO_ROOT = resolve(WEB_ROOT, '..');

export const REPORT_DIR = join(WEB_ROOT, 'e2e', '.output', 'report', 'security-boundary');

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;

  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

export function loadLocalEnv(): void {
  loadEnvFile(join(WEB_ROOT, '.env.local'));
  loadEnvFile(join(REPO_ROOT, '.claude', '.env.local'));
  loadEnvFile(join(REPO_ROOT, 'scripts', '.env.local'));
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function resolveProjectId(): string {
  const projectId =
    process.env.SECURITY_BOUNDARY_FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  if (!projectId) {
    throw new Error('Missing FIREBASE_PROJECT_ID / NEXT_PUBLIC_FIREBASE_PROJECT_ID');
  }
  return projectId;
}

export function assertDevProject(projectId: string): void {
  if (projectId !== DEV_PROJECT_ID && process.env.SECURITY_BOUNDARY_ALLOW_NON_DEV !== '1') {
    throw new Error(
      `Refusing to run W8.1 live-dev test against non-dev project: ${projectId}`,
    );
  }
}

export function resolveBaseUrl(): string {
  const baseUrl =
    process.env.SECURITY_BOUNDARY_BASE_URL ||
    process.env.OWLETTE_DEV_API_URL ||
    'https://dev.owlette.app';

  if (!baseUrl.includes('dev.owlette.app') && process.env.SECURITY_BOUNDARY_ALLOW_NON_DEV !== '1') {
    throw new Error(`Refusing to run W8.1 live-dev API test against non-dev URL: ${baseUrl}`);
  }

  return baseUrl.replace(/\/+$/, '');
}

export type Admin = {
  app: App;
  auth: Auth;
  db: Firestore;
  close: () => Promise<void>;
};

export function openAdmin(projectId: string, appName: string): Admin {
  const app = initializeAdminApp(
    {
      credential: cert({
        projectId,
        clientEmail: requireEnv('FIREBASE_CLIENT_EMAIL'),
        privateKey: requireEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      }),
      projectId,
    },
    appName,
  );
  return { app, auth: getAdminAuth(app), db: getAdminFirestore(app), close: () => deleteApp(app) };
}

/** site access is the member row; the `sites` list on the users row no longer grants it. */
export async function seedMember(
  db: Firestore,
  siteId: string,
  uid: string,
  role: 'admin' | 'member',
): Promise<void> {
  await db.collection('sites').doc(siteId).collection('members').doc(uid).set({
    uid,
    role,
    status: 'active',
    addedAt: FieldValue.serverTimestamp(),
    addedBy: 'security-boundary-drill',
  });
}

export async function createSignedInClient(
  adminAuth: Auth,
  projectId: string,
  uid: string,
  appName: string,
): Promise<SignedInClient> {
  const token = await adminAuth.createCustomToken(uid);
  const app = initializeApp(
    {
      apiKey: requireEnv('NEXT_PUBLIC_FIREBASE_API_KEY'),
      authDomain: requireEnv('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'),
      projectId,
      storageBucket: requireEnv('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'),
      messagingSenderId: requireEnv('NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'),
      appId: requireEnv('NEXT_PUBLIC_FIREBASE_APP_ID'),
    },
    appName,
  );

  const auth = getAuth(app);
  const credential = await signInWithCustomToken(auth, token);
  const idToken = await credential.user.getIdToken();

  return {
    app,
    idToken,
    signOutAndDelete: async () => {
      await signOut(auth).catch(() => {});
      await deleteClientApp(app);
    },
  };
}

export function errorCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function pushCheck(checks: CheckResult[], check: CheckResult): void {
  checks.push(check);
}

export function pushCleanup(checks: CheckResult[], leftovers: string[]): void {
  if (leftovers.length === 0) pushCheck(checks, { name: 'run data cleaned up', ok: true });
  for (const leftover of leftovers) {
    pushCheck(checks, { name: 'run data cleaned up', ok: false, message: leftover });
  }
}

export function writeReport(
  slug: string,
  title: string,
  report: Record<string, unknown>,
  checks: CheckResult[],
): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    join(REPORT_DIR, `${slug}.json`),
    `${JSON.stringify({ ...report, checks }, null, 2)}\n`,
    'utf8',
  );

  const metadata = Object.entries(report).flatMap(([key, value]) => {
    if (Array.isArray(value) || (value && typeof value === 'object')) return [];
    return [`${key}: ${String(value)}`];
  });
  const lines = [
    `# ${title}`,
    '',
    ...metadata,
    `overall: ${checks.every((check) => check.ok) ? 'pass' : 'fail'}`,
    '',
    '| check | result | status | code |',
    '| --- | --- | --- | --- |',
    ...checks.map((check) =>
      `| ${check.name} | ${check.ok ? 'pass' : 'fail'} | ${check.status ?? ''} | ${check.code ?? ''} |`,
    ),
    '',
  ];

  writeFileSync(join(REPORT_DIR, `${slug}.md`), `${lines.join('\n')}\n`, 'utf8');
}
