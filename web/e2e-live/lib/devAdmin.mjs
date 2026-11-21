/**
 * Dev-pinned firebase-admin for the live smoke suite (web/e2e-live).
 *
 * Every Firestore and Auth handle the suite uses comes from here. `init()` reads the
 * service account and refuses to build a client unless it belongs to
 * `owlette-dev-3838a` — the check runs before `initializeApp`, so no read or write can
 * reach another project.
 *
 * Credentials are gitignored and resolved at runtime only:
 *   SMOKE_SA_PATH   service account JSON  (default <repo>/agent/config/firebase-creds-dev.json)
 *   SMOKE_ENV_FILE  web env file          (default <repo>/web/.env.local — read only by getWebApiKey)
 * `git worktree add` brings neither file along; from a worktree, point the overrides at
 * the main checkout instead of copying the files in.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth as getAppAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** web/e2e-live/lib → repository root. */
const REPO = path.resolve(HERE, '..', '..', '..');

export const DEV_PROJECT_ID = 'owlette-dev-3838a';
const DEV_HOST = 'dev.owlette.app';
export const DEV_ORIGIN = `https://${DEV_HOST}`;

/** Named, so it can never collide with a default app another module initialized. */
const APP_NAME = 'owlette-live-smoke';

/** Each of these silently reroutes firebase-admin to a local emulator. */
const EMULATOR_ENV_VARS = [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
];

let state = null;

function serviceAccountPath() {
  return path.resolve(
    process.env.SMOKE_SA_PATH || path.join(REPO, 'agent', 'config', 'firebase-creds-dev.json'),
  );
}

function envFilePath() {
  return path.resolve(process.env.SMOKE_ENV_FILE || path.join(REPO, 'web', '.env.local'));
}

function init() {
  if (state) return state;

  const emulatorVar = EMULATOR_ENV_VARS.find((name) => process.env[name]);
  if (emulatorVar) {
    throw new Error(
      `ABORT: ${emulatorVar} is set — the live smoke suite targets ${DEV_PROJECT_ID}, never an emulator`,
    );
  }

  const saPath = serviceAccountPath();
  if (!existsSync(saPath)) {
    throw new Error(
      `missing dev service account at ${saPath} (gitignored — obtain it out-of-band, or set SMOKE_SA_PATH)`,
    );
  }
  let sa;
  try {
    sa = JSON.parse(readFileSync(saPath, 'utf8'));
  } catch {
    // Not the parser's message: newer V8 quotes a slice of the input, which here is key material.
    throw new Error(`${saPath} is not valid JSON`);
  }
  if (sa?.project_id !== DEV_PROJECT_ID) {
    throw new Error(`ABORT: service account project '${sa?.project_id}' != '${DEV_PROJECT_ID}'`);
  }

  const app = initializeApp({ credential: cert(sa), projectId: DEV_PROJECT_ID }, APP_NAME);
  state = { app, db: getFirestore(app), auth: getAppAuth(app) };
  return state;
}

/** Firestore for owlette-dev-3838a. The first call runs the project pin. */
export function getDb() {
  return init().db;
}

/** Firebase Auth for owlette-dev-3838a. The first call runs the project pin. */
export function getAuth() {
  return init().auth;
}

/** Release the app so a CLI process can exit; the next getDb()/getAuth() re-initializes. */
export async function closeDevAdmin() {
  if (!state) return;
  const { app } = state;
  state = null;
  await deleteApp(app);
}

/** Throws unless `url` is an absolute URL on the dev origin; returns it parsed. */
export function assertDevUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`ABORT: expected an absolute URL on ${DEV_ORIGIN}`);
  }
  if (parsed.origin !== DEV_ORIGIN) {
    throw new Error(`ABORT: ${parsed.origin} is not ${DEV_ORIGIN}`);
  }
  return parsed;
}

/** One `KEY=value` line from an env file, surrounding quotes stripped; null when absent or empty. */
function readEnvValue(text, name) {
  const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'));
  if (!match) return null;
  const raw = match[1];
  const value = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  return value || null;
}

/**
 * The dev Firebase web API key, for UI and REST sign-in. Read lazily so seed and
 * teardown never need the env file. Refuses a file whose NEXT_PUBLIC_FIREBASE_PROJECT_ID
 * is not dev; that is a local guard only — proving the key itself belongs to dev takes
 * a call to Firebase, which the login path makes before its first sign-in.
 */
export function getWebApiKey() {
  const file = envFilePath();
  if (!existsSync(file)) {
    throw new Error(`missing ${file} (gitignored — obtain it out-of-band, or set SMOKE_ENV_FILE)`);
  }
  const text = readFileSync(file, 'utf8');
  const projectId = readEnvValue(text, 'NEXT_PUBLIC_FIREBASE_PROJECT_ID');
  if (projectId !== DEV_PROJECT_ID) {
    throw new Error(`ABORT: ${file} targets project '${projectId ?? '(unset)'}', not '${DEV_PROJECT_ID}'`);
  }
  const key = readEnvValue(text, 'NEXT_PUBLIC_FIREBASE_API_KEY');
  if (!key) throw new Error(`NEXT_PUBLIC_FIREBASE_API_KEY not found in ${file}`);
  return key;
}
