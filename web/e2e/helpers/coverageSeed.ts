import crypto from 'crypto';
import {
  FieldValue,
  Timestamp,
  type CollectionReference,
  type DocumentData,
} from 'firebase-admin/firestore';
import type { ChatShareDoc } from '@/lib/hoot/shareStore.server';
import type { InstallerPlatform } from '@/lib/installerPlatform';
import {
  SHARE_TOKEN_PATTERN,
  type SharedMessage,
  type ShareSnapshot,
} from '@/lib/hoot/shareTypes';
import { getAdminDb } from './emulator';
import { seedMachine, seedUser, type TestUser } from './seed';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function clearCollection(col: CollectionReference<DocumentData>): Promise<void> {
  const refs = await col.listDocuments();
  await Promise.all(refs.map((ref) => ref.delete()));
}

export async function deleteDocIfExists(path: string): Promise<void> {
  await getAdminDb().doc(path).delete();
}

export async function clearSiteLogs(siteId = 'site-A'): Promise<void> {
  await clearCollection(getAdminDb().collection('sites').doc(siteId).collection('logs'));
}

export interface SeedLogEvent {
  id: string;
  action: string;
  level: 'info' | 'warning' | 'error';
  machineId: string;
  machineName?: string;
  processName?: string;
  details?: string;
  timestamp?: Date;
  screenshotUrl?: string;
  userId?: string;
}

export async function seedLogEvents(
  siteId = 'site-A',
  events: SeedLogEvent[] = defaultLogEvents(),
): Promise<string[]> {
  await clearSiteLogs(siteId);
  const col = getAdminDb().collection('sites').doc(siteId).collection('logs');
  await Promise.all(
    events.map((event) =>
      col.doc(event.id).set({
        action: event.action,
        level: event.level,
        machineId: event.machineId,
        machineName: event.machineName ?? event.machineId,
        ...(event.processName ? { processName: event.processName } : {}),
        ...(event.details ? { details: event.details } : {}),
        ...(event.screenshotUrl ? { screenshotUrl: event.screenshotUrl } : {}),
        ...(event.userId ? { userId: event.userId } : {}),
        timestamp: Timestamp.fromDate(event.timestamp ?? new Date()),
      }),
    ),
  );
  return events.map((event) => event.id);
}

function defaultLogEvents(): SeedLogEvent[] {
  const now = Date.now();
  return [
    {
      id: 'e2e-log-crash',
      action: 'process_crash',
      level: 'error',
      machineId: 'e2e-logs-machine',
      machineName: 'e2e-logs-machine',
      processName: 'TouchDesigner',
      details: 'TouchDesigner crashed with exit code 1',
      screenshotUrl: PNG_1X1,
      timestamp: new Date(now - 60_000),
      userId: 'admin-uid',
    },
    {
      id: 'e2e-log-warning',
      action: 'deployment_failed',
      level: 'warning',
      machineId: 'e2e-logs-machine',
      machineName: 'e2e-logs-machine',
      processName: 'Installer',
      details: 'Installer returned retryable warning',
      timestamp: new Date(now - 120_000),
    },
    {
      id: 'e2e-log-info',
      action: 'agent_started',
      level: 'info',
      machineId: 'e2e-logs-alt',
      machineName: 'e2e-logs-alt',
      details: 'Agent started normally',
      timestamp: new Date(now - 180_000),
    },
  ];
}

export async function seedScreenshotFixture(
  siteId = 'site-A',
  machineId = 'e2e-screen-machine',
): Promise<void> {
  await seedMachine(siteId, machineId, { displayName: machineId });
  const machineRef = getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  await machineRef.set(
    {
      lastScreenshot: {
        url: PNG_1X1,
        capturedAt: Timestamp.fromDate(new Date()),
      },
    },
    { merge: true },
  );
  await machineRef.collection('screenshots').doc('e2e-screenshot-1').set({
    url: PNG_1X1,
    capturedAt: Timestamp.fromDate(new Date(Date.now() - 30_000)),
    width: 1,
    height: 1,
  });
}

export async function seedLiveViewFixture(
  siteId = 'site-A',
  machineId = 'e2e-live-machine',
): Promise<void> {
  await seedScreenshotFixture(siteId, machineId);
  await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        liveView: {
          active: true,
          intervalSeconds: 10,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        },
      },
      { merge: true },
    );
}

/** The online machine `seedHootFixture` seeds; the single-machine affordances render for it. */
export const HOOT_FIXTURE_MACHINE_ID = 'e2e-cortex-machine';

/** Its offline sibling — ticked alongside it by the multi-machine chat below. */
export const HOOT_FIXTURE_OFFLINE_MACHINE_ID = 'e2e-cortex-offline';

/**
 * The chat that carries the MULTI-machine shape: `targetType:'machines'` with
 * two ids, and a last turn whose own target is narrower than the chat's.
 * Keyed by user like the legacy one, so `clearHootFixture` retires it too.
 */
export const hootMachinesChatId = (userId: string): string => `e2e-cortex-machines-${userId}`;

/**
 * Pin a user's saved site (`users/{uid}.lastSiteId`), which every page restores
 * the header from. A spec that switches sites has to start from a known one —
 * the field outlives the run, so whichever site the previous spec left behind
 * would otherwise decide which conversations and machines are on screen — and
 * has to put it back afterwards.
 */
export async function setLastSite(userId: string, siteId: string): Promise<void> {
  await getAdminDb().collection('users').doc(userId).set({ lastSiteId: siteId }, { merge: true });
}

export async function clearHootFixture(userId: string, siteId = 'site-A'): Promise<void> {
  const db = getAdminDb();
  await db.collection('users').doc(userId).collection('settings').doc('llm').delete();
  await db.collection('sites').doc(siteId).collection('settings').doc('llm').delete();
  await Promise.all([
    db.collection('chats').doc(`e2e-cortex-user-${userId}`).delete(),
    db.collection('chats').doc(`e2e-cortex-auto-${siteId}`).delete(),
    db.collection('chats').doc(hootMachinesChatId(userId)).delete(),
  ]);
}

export async function seedHootFixture(opts: {
  userId: string;
  siteId?: string;
  machineId?: string;
  hasUserKey?: boolean;
}): Promise<void> {
  const siteId = opts.siteId ?? 'site-A';
  const machineId = opts.machineId ?? HOOT_FIXTURE_MACHINE_ID;
  const db = getAdminDb();
  await seedMachine(siteId, machineId, { displayName: machineId });
  await seedMachine(siteId, HOOT_FIXTURE_OFFLINE_MACHINE_ID, {
    displayName: HOOT_FIXTURE_OFFLINE_MACHINE_ID,
    heartbeatOffsetSec: 600,
  });
  if (opts.hasUserKey ?? true) {
    await db.collection('users').doc(opts.userId).collection('settings').doc('llm').set({
      provider: 'openai',
      model: 'gpt-test',
      hasKey: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  const now = new Date();
  await db.collection('chats').doc(`e2e-cortex-user-${opts.userId}`).set({
    userId: opts.userId,
    siteId,
    title: 'Deployment triage',
    category: 'Operations',
    targetType: 'machine',
    targetMachineId: machineId,
    machineName: machineId,
    source: 'user',
    messages: [
      {
        id: 'm-user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Why did deployment fail?' }],
      },
      {
        id: 'm-assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'The installer exited with a retryable warning.' },
          {
            type: 'tool-checkLogs',
            toolCallId: 'tool-1',
            state: 'output-available',
            args: { machineId },
            output: { status: 'warning' },
          },
        ],
      },
    ],
    createdAt: Timestamp.fromDate(new Date(now.getTime() - 120_000)),
    updatedAt: Timestamp.fromDate(new Date(now.getTime() - 60_000)),
  });
  // A chat aimed at TWO machines, whose last turn ran on only one of them.
  //
  // The target fields are exactly what `chatTargetFields` writes for a two-machine
  // selection (web/lib/hoot/target.ts): the authoritative `targetMachineIds`, plus
  // the legacy trio narrowed to the FIRST id so an old tab reading
  // `targetMachineId || '__site__'` narrows instead of widening to the site.
  //
  // The assistant turn carries `metadata.hoot` — the per-turn record a mention
  // narrowed to one machine. It differs from the chat's stored selection ON
  // PURPOSE: the header adopts the chat's two machines when this conversation
  // loads, so an approval card that named the selector rather than the turn would
  // credit a privileged call to a machine it never reached, which is the bug
  // Task 5.3 fixed. `state:'approval-requested'` + `approval.id` is what
  // ChatWindow.tsx reads to hand ToolCallCard `approvalState:'requested'`.
  await db.collection('chats').doc(hootMachinesChatId(opts.userId)).set({
    userId: opts.userId,
    siteId,
    title: 'Cache cleanup',
    category: 'Operations',
    targetType: 'machines',
    targetMachineIds: [machineId, HOOT_FIXTURE_OFFLINE_MACHINE_ID],
    targetMachineId: machineId,
    machineName: `${machineId}, ${HOOT_FIXTURE_OFFLINE_MACHINE_ID}`,
    source: 'user',
    messages: [
      {
        id: 'm-machines-user-1',
        role: 'user',
        parts: [{ type: 'text', text: `@${machineId} clear the render cache` }],
      },
      {
        id: 'm-machines-assistant-1',
        role: 'assistant',
        metadata: {
          hoot: {
            turnId: 'e2e-cortex-machines-turn-1',
            machineIds: [machineId],
            via: 'mention',
            skipped: { offline: [], disabled: [] },
          },
        },
        parts: [
          {
            type: 'text',
            text: 'the cache is outside the paths my file tools reach, so this needs a shell command.',
          },
          {
            type: 'tool-run_powershell',
            toolCallId: 'tool-machines-1',
            state: 'approval-requested',
            approval: { id: 'approval-machines-1' },
            args: {
              machineId,
              script: "Remove-Item 'C:\\Owlette\\cache' -Recurse -Force",
            },
          },
        ],
      },
    ],
    createdAt: Timestamp.fromDate(new Date(now.getTime() - 300_000)),
    updatedAt: Timestamp.fromDate(new Date(now.getTime() - 30_000)),
  });
  await db.collection('chats').doc(`e2e-cortex-auto-${siteId}`).set({
    siteId,
    title: 'Nightly auto investigation',
    category: 'Autonomous',
    targetType: 'site',
    targetMachineId: null,
    machineName: 'All Machines',
    source: 'autonomous',
    autonomousSummary: 'Autonomous check found no active incident.',
    messages: [
      {
        id: 'm-auto-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Autonomous check found no active incident.' }],
      },
    ],
    createdAt: Timestamp.fromDate(new Date(now.getTime() - 240_000)),
    updatedAt: Timestamp.fromDate(new Date(now.getTime() - 180_000)),
  });
}

/**
 * Collection name mirrors `CHAT_SHARES_COLLECTION` in `lib/hoot/shareStore.server.ts`.
 * Copied rather than imported as a value: that module pulls in `lib/firebase-admin`,
 * which calls `initializeApp()` at import time and would race `helpers/emulator.ts`
 * for the default Admin app. The `ChatShareDoc` TYPE import above is erased at
 * compile time, so it costs nothing at runtime while still pinning the shape.
 */
const CHAT_SHARES_COLLECTION = 'chat_shares';

const DAY_MS = 86_400_000;

const DEFAULT_SHARE_MESSAGES: SharedMessage[] = [
  { id: 'seeded-user-1', role: 'user', parts: [{ type: 'text', text: 'Why did deployment fail?' }] },
  {
    id: 'seeded-assistant-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'The installer exited with a retryable warning.' },
      { type: 'tool', toolName: 'checkLogs', outcome: 'completed' },
    ],
  },
];

export interface SeedChatShareOptions {
  /** `shr_` + 24 url-safe chars — see `SHARE_TOKEN_PATTERN`. Caller-supplied so the spec can address it. */
  token: string;
  chatId: string;
  createdBy: string;
  siteId?: string;
  /**
   * `null` never expires; a Date in the past seeds an already-expired link.
   * Defaults to 30 days out — the same default the dialog offers.
   */
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  title?: string;
  targetLabel?: string | null;
  messages?: SharedMessage[];
  createdAt?: Date;
}

/**
 * Write a `chat_shares/{token}` document directly, bypassing the create route.
 *
 * The collection has no client rules by design — every read and write goes
 * through the server — so an expiry case can only be set up with the Admin SDK.
 * `set()` rather than `create()`: re-seeding the same token in a `beforeEach`
 * must be idempotent.
 */
export async function seedChatShare(opts: SeedChatShareOptions): Promise<string> {
  // `getPublicChatShare` rejects a non-matching token before it touches Firestore,
  // so a typo here would seed a document nothing could ever serve — and the spec
  // would read that as the page being broken.
  if (!SHARE_TOKEN_PATTERN.test(opts.token)) {
    throw new Error(`seedChatShare: "${opts.token}" does not match SHARE_TOKEN_PATTERN`);
  }

  const messages = opts.messages ?? DEFAULT_SHARE_MESSAGES;
  const title = opts.title ?? 'Deployment triage';
  const targetLabel = opts.targetLabel === undefined ? null : opts.targetLabel;
  const createdAt = opts.createdAt ?? new Date(Date.now() - 60_000);
  const expiresAt =
    opts.expiresAt === undefined ? new Date(Date.now() + 30 * DAY_MS) : opts.expiresAt;

  const snapshot: ShareSnapshot = {
    version: 1,
    title,
    targetLabel,
    messages,
    omitted: { images: 0, systemMessages: 0 },
    collapsedToolCalls: messages.reduce(
      (total, message) => total + message.parts.filter((part) => part.type === 'tool').length,
      0,
    ),
  };

  const doc: ChatShareDoc = {
    token: opts.token,
    chatId: opts.chatId,
    siteId: opts.siteId ?? 'site-A',
    createdBy: opts.createdBy,
    createdAt: Timestamp.fromDate(createdAt),
    expiresAt: expiresAt === null ? null : Timestamp.fromDate(expiresAt),
    revokedAt: opts.revokedAt ? Timestamp.fromDate(opts.revokedAt) : null,
    title,
    targetLabel,
    messageCount: messages.length,
    snapshot,
  };

  await getAdminDb().collection(CHAT_SHARES_COLLECTION).doc(opts.token).set(doc);
  return opts.token;
}

/** Delete every share a chat owns — expired and revoked ones included. */
export async function clearChatShares(chatId: string): Promise<void> {
  const snap = await getAdminDb()
    .collection(CHAT_SHARES_COLLECTION)
    .where('chatId', '==', chatId)
    .get();
  await Promise.all(snap.docs.map((docSnap) => docSnap.ref.delete()));
}

export async function seedCliDeviceCode(
  code = 'silver-compass-drift',
  deviceCode = 'e2e-device-code-secret',
): Promise<string> {
  const deviceCodeHash = crypto.createHash('sha256').update(deviceCode).digest('hex');
  await getAdminDb().collection('cli_device_codes').doc(code).set({
    deviceCodeHash,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
    authorizedBy: null,
    authorizedAt: null,
    siteId: null,
    keyId: null,
    rawKey: null,
  });
  return deviceCode;
}

export async function seedSystemPreset(
  presetId = 'e2e-system-preset',
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await getAdminDb().collection('system_presets').doc(presetId).set({
    name: 'E2E Template 1.0',
    software_name: 'E2E Template',
    category: 'Utilities',
    description: 'Seeded by coverageSeed.ts',
    installer_name: 'e2e-template.exe',
    installer_url: 'https://example.test/e2e-template.exe',
    silent_flags: '/S',
    verify_path: 'C:\\Program Files\\E2E\\template.exe',
    sha256_checksum: 'ab'.repeat(32),
    timeout_seconds: 600,
    order: 10,
    is_owlette_agent: false,
    createdBy: 'e2e-seed',
    createdAt: Timestamp.fromDate(new Date(Date.now() - 60_000)),
    updatedAt: Timestamp.fromDate(new Date(Date.now() - 30_000)),
    ...overrides,
  });
}

export async function clearSystemPreset(presetId = 'e2e-system-preset'): Promise<void> {
  await getAdminDb().collection('system_presets').doc(presetId).delete();
}

export async function seedInstallerLatest(
  downloadUrl = 'https://example.test/downloads/owlette-e2e.exe',
  files?: Partial<Record<InstallerPlatform, { download_url: string }>>,
): Promise<void> {
  const db = getAdminDb();
  const version = 'e2e-latest';
  const uploadedAt = Date.now();
  const data = {
    version,
    download_url: downloadUrl,
    file_size: 1_024,
    checksum_sha256: 'e2e'.repeat(22),
    uploaded_at: uploadedAt,
    uploaded_by: 'e2e-public-static',
    release_date: Timestamp.fromMillis(uploadedAt),
    deletedAt: null,
    ...(files ? { files } : {}),
  };
  await db.collection('installer_metadata').doc('data').collection('versions').doc(version).set(data);
  await db.collection('installer_metadata').doc('latest').set({
    ...data,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export function dedicatedUser(role: TestUser['role'], suffix = Date.now().toString()): TestUser {
  return {
    uid: `e2e-${role}-${suffix}`,
    email: `e2e-${role}-${suffix}@example.test`,
    password: `e2e-${role}-${suffix}-password`,
    role,
    sites: ['site-A'],
    displayName: `E2E ${role} ${suffix}`,
  };
}

export async function seedDedicatedUser(user: TestUser): Promise<TestUser> {
  await seedUser(user);
  return user;
}

export const SAMPLE_SCREENSHOT_DATA_URL = PNG_1X1;
