/**
 * Client-side Firebase config for the web portal (JS SDK, not the Admin SDK the
 * Python agent uses). Env vars are validated at startup in layout.tsx (warn only).
 */

import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, Auth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, Firestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage, FirebaseStorage, connectStorageEmulator } from 'firebase/storage';

// From Firebase Console > Project Settings > Web App.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || 'placeholder',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || 'placeholder.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'placeholder',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'placeholder.appspot.com',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '123456789',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || 'placeholder',
};

// Emulator mode (Playwright E2E) accepts any API key, so count it as configured.
const isEmulatorMode =
  typeof window !== 'undefined' &&
  process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true';
const isConfigured = typeof window !== 'undefined' && (
  isEmulatorMode ||
  (
    !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY !== 'placeholder'
  )
);

// Client-only singletons.
let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let storage: FirebaseStorage | null = null;

function parseEmulatorHost(value: string | undefined, fallbackHost: string, fallbackPort: number) {
  const trimmed = value?.trim();
  if (!trimmed) return { host: fallbackHost, port: fallbackPort };

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    return {
      host: url.hostname || fallbackHost,
      port: Number(url.port) || fallbackPort,
    };
  } catch {
    return { host: fallbackHost, port: fallbackPort };
  }
}

function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Emulator wiring for Playwright E2E, gated so production never hits localhost.
// Once per app instance — tracked on window to survive hot-reload re-execution.
function maybeConnectEmulators(
  authInstance: Auth,
  dbInstance: Firestore,
  storageInstance: FirebaseStorage,
) {
  if (typeof window === 'undefined') return;
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') return;
  const w = window as Window & { __OWLETTE_EMULATORS_CONNECTED__?: boolean };
  if (w.__OWLETTE_EMULATORS_CONNECTED__) return;

  const authEmulator = parseEmulatorHost(
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST,
    '127.0.0.1',
    9099,
  );
  const firestoreEmulator = parseEmulatorHost(
    process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST,
    '127.0.0.1',
    8080,
  );
  const storageEmulator = parseEmulatorHost(
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST,
    '127.0.0.1',
    9199,
  );

  connectAuthEmulator(authInstance, `http://${authEmulator.host}:${authEmulator.port}`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(dbInstance, firestoreEmulator.host, firestoreEmulator.port);
  connectStorageEmulator(storageInstance, storageEmulator.host, storageEmulator.port);
  w.__OWLETTE_EMULATORS_CONNECTED__ = true;
}

/**
 * Firebase App Check — attests that calls come from this app rather than a script
 * hitting the API directly. It is the only instrument that reaches the
 * login/register abuse path: `signInWithEmailAndPassword` talks to
 * `identitytoolkit` straight from the browser, which is why Turnstile guards
 * /api/users/bootstrap and /api/auth/forgot-password but deliberately NOT login.
 *
 * ⚠️ ENFORCEMENT IS A CONSOLE ACTION AND IS *NOT* IMPLIED BY THIS CODE —
 * initializing the SDK only makes clients START SENDING tokens. Enforce
 * Authentication only: enforcing Cloud Firestore 403s the whole agent fleet,
 * which calls `firestore.googleapis.com` over REST
 * (agent/src/firestore_rest_client.py) and cannot produce App Check tokens.
 * Read docs/runbooks/app-check-rollout.md first.
 *
 * Inert without `NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY`, and always skipped
 * against the emulator.
 */
async function maybeInitAppCheck(firebaseApp: FirebaseApp) {
  const siteKey = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY;
  if (!siteKey) return;
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true') return;

  try {
    const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import('firebase/app-check');
    initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (error) {
    // Never let attestation setup break startup. With enforcement off a missing
    // token changes nothing; with it on, rejected Firebase calls are the signal.
    console.error('[AppCheck] initialization failed:', error);
  }
}

if (typeof window !== 'undefined' && !getApps().length && isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  maybeConnectEmulators(auth, db, storage);
  void maybeInitAppCheck(app);
} else if (typeof window !== 'undefined' && getApps().length) {
  app = getApps()[0];
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  maybeConnectEmulators(auth, db, storage);
}

export { app, auth, db, storage, isConfigured };

import { getDoc, doc } from 'firebase/firestore';
import { normalizeInstallerFiles, type InstallerFiles } from '@/lib/installerPlatform';

/**
 * Latest agent version from `installer_metadata/latest`, or null if absent.
 * `files` holds every platform's installer; `downloadUrl` and `sha256Checksum`
 * stay the windows one for callers that only want that.
 */
export async function getLatestOwletteVersion(): Promise<{
  version: string;
  downloadUrl: string;
  sha256Checksum?: string;
  files: InstallerFiles;
  releaseDate?: Date;
  releaseNotes?: string;
} | null> {
  if (!db) {
    throw new Error('Firestore not initialized');
  }

  try {
    const latestRef = doc(db, 'installer_metadata', 'latest');
    const latestDoc = await getDoc(latestRef);

    if (!latestDoc.exists()) {
      console.warn('No latest Owlette version found in installer_metadata/latest');
      return null;
    }

    const data = latestDoc.data();

    return {
      version: data.version || 'Unknown',
      downloadUrl: data.download_url || data.downloadUrl || data.url || '',
      sha256Checksum: data.checksum_sha256 || data.sha256Checksum || data.checksum,
      files: normalizeInstallerFiles(data),
      releaseDate: data.release_date?.toDate?.() || data.releaseDate?.toDate?.() || data.uploadedAt?.toDate?.(),
      releaseNotes: data.release_notes || data.releaseNotes || data.changelog,
    };
  } catch (error) {
    console.error('Error fetching latest Owlette version:', error);
    throw error;
  }
}

/**
 * Queue an `update_owlette` command. Checksum and target version are mandatory —
 * the agent rejects updates without SHA256 verification. Sends exactly the URL
 * it is given: the caller picks the file for the machine's platform, and reads
 * `installer_metadata/latest` at update time so the Storage URL (auth token
 * expires after ~7 days) is fresh.
 */
export async function sendOwletteUpdateCommand(
  siteId: string,
  machineId: string,
  installerUrl: string,
  deploymentId?: string,
  targetVersion?: string,
  checksumSha256?: string
): Promise<string> {
  if (!db) {
    throw new Error('Firestore not initialized');
  }

  if (!checksumSha256) {
    throw new Error('Checksum is required for self-updates. The agent will reject updates without SHA256 verification.');
  }

  if (!targetVersion) {
    throw new Error('Target version is required for update tracking.');
  }

  try {
    const params: Record<string, string> = {
        installer_url: installerUrl,
        target_version: targetVersion,
        checksum_sha256: checksumSha256,
    };
    if (deploymentId) params.deployment_id = deploymentId;

    const res = await fetch(
      `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/commands`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': makeIdempotencyKey(`update-owlette-${machineId}-${targetVersion}`),
        },
        body: JSON.stringify({
          type: 'update_owlette',
          params,
        }),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.detail || body?.title || 'Failed to queue update command');
    }

    const commandId = body?.data?.commandId;
    if (typeof commandId !== 'string' || commandId.length === 0) {
      throw new Error('Update command response did not include a commandId.');
    }

    console.log(`Sent update_owlette command to ${machineId}:`, commandId);
    return commandId;
  } catch (error) {
    console.error('Error sending update_owlette command:', error);
    throw error;
  }
}
