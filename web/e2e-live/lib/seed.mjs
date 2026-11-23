/**
 * Seed and teardown for the live dev smoke suite. owlette-dev-3838a only: devAdmin.mjs
 * pins the project before any read or write.
 *
 * seed()      Idempotent. Site `smoke-live` and three persistent, MFA-free test users
 *             with per-site member rows. Every call rotates each password (returned in
 *             memory only, never printed); everything else is written only when it has
 *             drifted, so a second call changes nothing but the passwords.
 * teardown()  Removes everything a run creates and prints a count per path. Never
 *             deletes the site or the three persistent users.
 *
 * `sites/smoke-live.owner` is held at smoke-siteadmin for one reason: alert delivery.
 * getSiteAlertRecipients (web/lib/adminUtils.server.ts) still finds a site's users only
 * through the legacy `owner` field and `users/{uid}.sites[]`, and a site with none counts
 * as orphaned, so every alert for it goes to ADMIN_EMAIL. With the owner set, the site has
 * an alertable user whose alert preferences are all off, and the empty recipient set is an
 * opt-out. The field grants nothing: access is the member row (web/lib/sitePolicy.server.ts,
 * firestore.rules), and the members page lists rows only.
 *
 * Deliberately never written:
 *   - `users/{uid}.sites[]` — legacy membership that no longer grants access; the member
 *     row is what grants.
 *   - `users/{uid}/settings/llm` — the key is encrypted with a secret that exists only
 *     on dev, so it is saved through POST /api/settings/llm-key. See hasLlmKey().
 *   - `sites/smoke-live/settings/cortex.requireTier3Approval` — absent means approval
 *     required (getHootRequireTier3Approval), which the tier-3 deny check relies on.
 *
 * CLI: node web/e2e-live/lib/seed.mjs --seed | --teardown [--dry-run]
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FieldValue } from 'firebase-admin/firestore';
import { closeDevAdmin, getAuth, getDb } from './devAdmin.mjs';

export const SITE_ID = 'smoke-live';
export const STUB_MACHINE_ID = 'smoke-stub-01';
export const TEST_EMAIL_DOMAIN = '@owlette.test';
/** Per-run passkey accounts are `smoke-passkey-<runId>@owlette.test`, fresh every run. */
export const PASSKEY_EMAIL_PREFIX = 'smoke-passkey-';

const SITE_NAME = 'smoke live';
const SITE_TIMEZONE = 'UTC';
/** Member-row `addedBy`, in the `system:<name>` actor convention the membership backfill uses. */
const SEED_ACTOR = 'system:live-smoke-seed';
/** Every account this module creates or updates has a uid with this prefix. */
const SMOKE_UID_PREFIX = 'smoke-';

/** Fixed uids keep the three stable across runs and filterable (`smoke-`) in dev logs. */
export const PERSISTENT_USERS = Object.freeze({
  siteadmin: Object.freeze({
    uid: 'smoke-siteadmin',
    email: 'smoke-siteadmin@owlette.test',
    displayName: 'smoke siteadmin',
    siteRole: 'admin',
  }),
  member: Object.freeze({
    uid: 'smoke-member',
    email: 'smoke-member@owlette.test',
    displayName: 'smoke member',
    siteRole: 'member',
  }),
  target: Object.freeze({
    uid: 'smoke-target',
    email: 'smoke-target@owlette.test',
    displayName: 'smoke target',
    siteRole: null,
  }),
});
const PERSISTENT_UIDS = new Set(Object.values(PERSISTENT_USERS).map((user) => user.uid));

/** Stored per-site roles (MemberRole in web/lib/membership.server.ts). */
const MEMBER_ROLES = new Set(['owner', 'admin', 'member']);

/** Firestore caps a write batch at 500 operations. */
const BATCH_LIMIT = 400;
/** Firestore caps an `in` filter at 30 values. */
const IN_LIMIT = 30;
/** Documents per getAll existence check. */
const READ_CHUNK = 300;

/** Upper bound of the email prefix range: the prefix with its last character incremented. */
const PASSKEY_EMAIL_RANGE_END =
  PASSKEY_EMAIL_PREFIX.slice(0, -1) +
  String.fromCharCode(PASSKEY_EMAIL_PREFIX.charCodeAt(PASSKEY_EMAIL_PREFIX.length - 1) + 1);

const PASSKEY_UID_LABEL = '{smoke-passkey}';
const TARGET_MEMBER_PATH = `sites/${SITE_ID}/members/${PERSISTENT_USERS.target.uid}`;
const TARGET_LEGACY_SITES_LABEL = `users/${PERSISTENT_USERS.target.uid}.sites[${SITE_ID}]`;
const TIER3_GATE_OFF_LABEL = `sites/${SITE_ID}/settings/cortex.requireTier3Approval=false`;
const PASSKEY_MEMBER_LABEL = `sites/${SITE_ID}/members/${PASSKEY_UID_LABEL}`;
const STUB_MACHINE_PATH = `sites/${SITE_ID}/machines/${STUB_MACHINE_ID}`;

/** Every path teardown sweeps, printed even at zero so a clean run reads as all zeros. */
const TEARDOWN_PATHS = [
  TARGET_MEMBER_PATH,
  TARGET_LEGACY_SITES_LABEL,
  TIER3_GATE_OFF_LABEL,
  PASSKEY_MEMBER_LABEL,
  'chats/*',
  'chats/*/stream',
  'chats/*/approvals',
  'chat_shares',
  'cortex-followups',
  STUB_MACHINE_PATH,
  `${STUB_MACHINE_PATH}/commands`,
  `${STUB_MACHINE_PATH}/smoke`,
  `${STUB_MACHINE_PATH}/metrics_history`,
  `config/${SITE_ID}/machines/${STUB_MACHINE_ID}`,
  `users/${PASSKEY_UID_LABEL}`,
  `users/${PASSKEY_UID_LABEL}/passkeys`,
  `users/${PASSKEY_UID_LABEL}/trustedDevices`,
  `mfa_pending/${PASSKEY_UID_LABEL}`,
  'webauthn_challenges',
];
const AUTH_ACCOUNTS_LABEL = 'auth accounts smoke-passkey-*';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Field path → value for every field of `desired` that `existing` lacks or holds
 * differently. Nested maps are compared leaf by leaf, so an update touches only the
 * drifted leaves and leaves their siblings (other preferences, say) alone.
 */
function collectDrift(existing, desired, prefix = '') {
  const drift = {};
  for (const [key, want] of Object.entries(desired)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const have = existing?.[key];
    if (isPlainObject(want)) {
      if (isPlainObject(have)) Object.assign(drift, collectDrift(have, want, fieldPath));
      else drift[fieldPath] = want;
    } else if (have !== want) {
      drift[fieldPath] = want;
    }
  }
  return drift;
}

function describeDrift(drift) {
  return Object.entries(drift)
    .map(([field, value]) => `${field}=${value instanceof FieldValue ? '(removed)' : JSON.stringify(value)}`)
    .join(', ');
}

/** Record `description`; perform `write` unless this is a dry run. */
async function act(ctx, actions, description, write) {
  actions.push(description);
  if (!ctx.dryRun) await write();
}

/**
 * 24 random bytes, base64url. The fixed tail guarantees an upper, lower, digit and
 * symbol, so a Firebase password policy can never reject a run by chance — a bare
 * 32-character base64url string lacks a symbol about a third of the time.
 */
function newPassword() {
  return `${randomBytes(24).toString('base64url')}aA9!`;
}

async function findAuthUser(lookup) {
  try {
    return await lookup();
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return null;
    throw err;
  }
}

function assertSmokeIdentity({ uid, email }) {
  if (!uid.startsWith(SMOKE_UID_PREFIX) || !email.endsWith(TEST_EMAIL_DOMAIN)) {
    throw new Error(`ABORT: ${uid} <${email}> is not a smoke test identity`);
  }
}

/** The user-doc fields every smoke account is held at on every seed. */
function enforcedUserFields({ email, displayName }) {
  return {
    email,
    displayName,
    // Never superadmin (it bypasses every capability check) and never a global admin.
    role: 'member',
    // MFA-free. New accounts are born `requiresMfaSetup: true`
    // (web/lib/actions/bootstrapUser.server.ts), which the proxy turns into a /setup-2fa
    // redirect; `mfaEnrolled: true` would send every login to /verify-2fa instead.
    mfaEnrolled: false,
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 0 },
    // Every alert preference off: the full set the unsubscribe link clears
    // (ALERT_PREFERENCES, web/app/api/unsubscribe/route.ts). getSiteAlertRecipients reads them
    // for smoke-live through sites/smoke-live.owner; see the module comment.
    preferences: {
      healthAlerts: false,
      processAlerts: false,
      thresholdAlerts: false,
      cortexAlerts: false,
      displayAlerts: false,
      talonAlerts: false,
      apiKeyAlerts: false,
    },
  };
}

/**
 * Forcing `mfaEnrolled: false` over a factor the account really holds would desync the
 * inventory web/lib/mfaFactors.server.ts owns. Persistent smoke users never enroll one
 * (the passkey check uses a fresh account per run), so a factor here is a fault to fix
 * by hand, not something to paper over.
 */
async function assertNoSecondFactor(userRef, data) {
  const factors = isPlainObject(data.mfaFactors) ? data.mfaFactors : {};
  // normalizeMfaFactors' fallback: before `mfaFactors` existed, only TOTP set mfaEnrolled.
  const totp = typeof factors.totp === 'boolean' ? factors.totp : data.mfaEnrolled === true;
  const passkeys = await userRef.collection('passkeys').limit(1).get();
  if (totp || !passkeys.empty) {
    throw new Error(
      `ABORT: ${userRef.id} holds a second factor (${totp ? 'totp' : 'passkey'}); remove it by hand before seeding`,
    );
  }
}

/**
 * Create or update one MFA-free smoke account: the Auth user and `users/{uid}`.
 * Rotates the password unless `dryRun` and returns it in memory only (null on a dry
 * run). Every read and check runs before the first write, and it throws rather than
 * adopt an email held by another uid.
 */
export async function ensureTestUser(spec, { dryRun = false, db = getDb(), auth = getAuth() } = {}) {
  assertSmokeIdentity(spec);
  const { uid, email, displayName } = spec;
  const ctx = { dryRun };
  const actions = [];

  const byEmail = await findAuthUser(() => auth.getUserByEmail(email));
  if (byEmail && byEmail.uid !== uid) {
    throw new Error(`ABORT: ${email} belongs to uid ${byEmail.uid}, not ${uid}; the seed never adopts an account`);
  }
  const authUser = byEmail ?? (await findAuthUser(() => auth.getUser(uid)));

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const enforced = enforcedUserFields(spec);
  let drift = null;
  if (userSnap.exists) {
    const data = userSnap.data();
    await assertNoSecondFactor(userRef, data);
    drift = collectDrift(data, enforced);
    // A soft-deleted account 403s on every API call (assertActiveUser); restore it.
    for (const field of ['deletedAt', 'deletedBy']) {
      if (field in data) drift[field] = FieldValue.delete();
    }
  }

  const password = dryRun ? null : newPassword();
  const profile = { email, displayName, emailVerified: true, disabled: false };
  if (!authUser) {
    await act(ctx, actions, `auth ${uid}: create`, () => auth.createUser({ uid, ...profile, password }));
  } else {
    const drifted = Object.keys(profile).filter((field) => authUser[field] !== profile[field]);
    const description = drifted.length
      ? `auth ${uid}: rotate password, update ${drifted.join(', ')}`
      : `auth ${uid}: rotate password`;
    await act(ctx, actions, description, () => auth.updateUser(uid, { ...profile, password }));
  }

  if (!userSnap.exists) {
    await act(ctx, actions, `${userRef.path}: create`, () =>
      userRef.create({
        ...enforced,
        preferences: {
          temperatureUnit: 'C',
          timezone: 'UTC',
          ...enforced.preferences,
          mutedMachines: [],
          alertCcEmails: [],
        },
        createdAt: new Date(),
      }),
    );
  } else if (Object.keys(drift).length > 0) {
    await act(ctx, actions, `${userRef.path}: update ${describeDrift(drift)}`, () => userRef.update(drift));
  }

  return { uid, email, password, actions };
}

/**
 * Hold `sites/{siteId}/members/{uid}` at `role` (status active), or absent when `role`
 * is null. Row shape is the membership backfill's
 * (scripts/migrations/backfill-per-site-membership.mjs:631-637) under this module's
 * actor; an existing row keeps its addedAt/addedBy. Writes only the row — never the
 * legacy `users.sites[]` / `sites.owner` pair. Returns the actions taken (or planned).
 */
export async function ensureMemberRow({ siteId, uid, role }, { dryRun = false, db = getDb() } = {}) {
  if (role !== null && !MEMBER_ROLES.has(role)) throw new Error(`invalid member role: ${role}`);
  const ctx = { dryRun };
  const actions = [];
  const ref = db.collection('sites').doc(siteId).collection('members').doc(uid);
  const snap = await ref.get();

  if (role === null) {
    if (snap.exists) await act(ctx, actions, `${ref.path}: delete`, () => ref.delete());
  } else if (!snap.exists) {
    await act(ctx, actions, `${ref.path}: create (${role})`, () =>
      ref.create({ uid, role, status: 'active', addedAt: new Date(), addedBy: SEED_ACTOR }),
    );
  } else {
    const drift = collectDrift(snap.data(), { uid, role, status: 'active' });
    if (Object.keys(drift).length > 0) {
      await act(ctx, actions, `${ref.path}: update ${describeDrift(drift)}`, () => ref.update(drift));
    }
  }
  return actions;
}

/**
 * sites/smoke-live/settings/cortex when it holds `requireTier3Approval: false`, else null. A
 * site admin can switch the gate off from the hoot toolbar; absent is the fail-safe default.
 */
async function findSwitchedOffTier3Gate(db) {
  const cortexRef = db.collection('sites').doc(SITE_ID).collection('settings').doc('cortex');
  const cortex = await cortexRef.get();
  return cortex.exists && cortex.data().requireTier3Approval === false ? cortexRef : null;
}

/** Remove only that value, restoring the absent state; never set the field. */
function restoreTier3Gate(cortexRef) {
  return cortexRef.update({ requireTier3Approval: FieldValue.delete() });
}

async function ensureSite(ctx) {
  const actions = [];
  const siteRef = ctx.db.collection('sites').doc(SITE_ID);
  const site = await siteRef.get();
  // owner: alert delivery only (module comment).
  const enforced = { name: SITE_NAME, timezone: SITE_TIMEZONE, owner: PERSISTENT_USERS.siteadmin.uid };
  if (!site.exists) {
    await act(ctx, actions, `${siteRef.path}: create`, () => siteRef.create({ ...enforced, createdAt: new Date() }));
  } else {
    const drift = collectDrift(site.data(), enforced);
    if (Object.keys(drift).length > 0) {
      await act(ctx, actions, `${siteRef.path}: update ${describeDrift(drift)}`, () => siteRef.update(drift));
    }
  }

  // Threshold rules are the only site-level alert setting (getAlertRules in
  // functions/src/metricsHistory.ts); offline and process alerts are the per-user
  // preferences held off in ensureTestUser. Empty the rules, not the doc: the
  // evaluator keeps sibling fields there. No rules array at all is a site that
  // never saved its rules, which gets the default low disk rule, so save [].
  const alertsRef = siteRef.collection('settings').doc('alerts');
  const alerts = await alertsRef.get();
  const rules = alerts.exists ? alerts.data().rules : undefined;
  if (!Array.isArray(rules)) {
    await act(ctx, actions, `${alertsRef.path}: save an empty threshold rule list`, () =>
      alertsRef.set({ rules: [] }, { merge: true }),
    );
  } else if (rules.length > 0) {
    await act(ctx, actions, `${alertsRef.path}: clear ${rules.length} threshold rule(s)`, () =>
      alertsRef.update({ rules: [] }),
    );
  }

  const gate = await findSwitchedOffTier3Gate(ctx.db);
  if (gate) {
    await act(ctx, actions, `${gate.path}: remove requireTier3Approval=false`, () => restoreTier3Gate(gate));
  }
  return actions;
}

/**
 * Idempotent seed. Returns `{ siteId, users: { siteadmin, member, target }, actions }`,
 * each user `{ uid, email, password }`; passwords live in memory only and are null on a
 * dry run, which rotates nothing.
 */
export async function seed({ dryRun = false, log = console.log, db = getDb(), auth = getAuth() } = {}) {
  const ctx = { dryRun, db, auth };
  const actions = await ensureSite(ctx);
  const users = {};
  for (const [key, spec] of Object.entries(PERSISTENT_USERS)) {
    const { password, actions: userActions } = await ensureTestUser(spec, ctx);
    actions.push(...userActions);
    actions.push(...(await ensureMemberRow({ siteId: SITE_ID, uid: spec.uid, role: spec.siteRole }, ctx)));
    users[key] = { uid: spec.uid, email: spec.email, password };
  }

  log(`[smoke seed] ${SITE_ID}${dryRun ? ' (dry run: nothing written)' : ''}`);
  for (const action of actions) log(`  ${action}`);
  log(`[smoke seed] ${actions.length} change(s)`);
  return { siteId: SITE_ID, users, actions };
}

/**
 * Whether `users/{uid}/settings/llm` exists. Existence only: the document is written
 * solely by POST /api/settings/llm-key, which encrypts with a secret held on dev — a
 * locally written one would fail to decrypt mid-turn.
 */
export async function hasLlmKey(uid, { db = getDb() } = {}) {
  return (await readLlmKeyProvider(uid, { db })) !== null;
}

/**
 * The provider of the stored hoot LLM key, which the route keeps in plaintext beside the
 * ciphertext; null when no key is stored. A read only: nothing here writes the document, and
 * the ciphertext is never returned.
 */
export async function readLlmKeyProvider(uid, { db = getDb() } = {}) {
  const snap = await db.collection('users').doc(uid).collection('settings').doc('llm').get();
  if (!snap.exists) return null;
  const provider = snap.data()?.provider;
  return typeof provider === 'string' && provider !== '' ? provider : '(none recorded)';
}

/**
 * Revoke the three persistent users' Firebase refresh tokens, so the ones a run's saved role
 * states and failure traces hold stop working when the run ends, not at the next run's password
 * rotation. The app's `__session` cookie is untouched: it is an iron-session cookie with no
 * revocation check (web/lib/sessionManager.server.ts), valid for its 7-day maxAge. A user that
 * does not exist yet is skipped. Returns the uids revoked.
 */
export async function revokeRefreshTokens({ log = console.log, auth = getAuth() } = {}) {
  const revoked = [];
  for (const { uid } of Object.values(PERSISTENT_USERS)) {
    try {
      await auth.revokeRefreshTokens(uid);
      revoked.push(uid);
    } catch (err) {
      if (err?.code !== 'auth/user-not-found') throw err;
    }
  }
  log(`[smoke teardown] Firebase refresh tokens revoked: ${revoked.length > 0 ? revoked.join(', ') : 'none'}`);
  return revoked;
}

function isPasskeyEmail(email) {
  return typeof email === 'string' && email.startsWith(PASSKEY_EMAIL_PREFIX) && email.endsWith(TEST_EMAIL_DOMAIN);
}

/**
 * Per-run passkey accounts, found two ways so a half-created or half-deleted one is
 * still caught: Auth accounts by email, and user docs by email (the Auth account may
 * already be gone). Returns uid → { hasAuth }.
 */
async function findPasskeyUsers(db, auth) {
  const found = new Map();
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (isPasskeyEmail(user.email)) found.set(user.uid, { hasAuth: true });
    }
    pageToken = page.pageToken;
  } while (pageToken);

  const docs = await db
    .collection('users')
    .where('email', '>=', PASSKEY_EMAIL_PREFIX)
    .where('email', '<', PASSKEY_EMAIL_RANGE_END)
    .get();
  for (const doc of docs.docs) {
    if (isPasskeyEmail(doc.data().email) && !found.has(doc.id)) found.set(doc.id, { hasAuth: false });
  }

  for (const uid of found.keys()) {
    if (PERSISTENT_UIDS.has(uid)) throw new Error(`ABORT: persistent user ${uid} matched the passkey sweep`);
  }
  return found;
}

/** Everything at and beneath `docRef`, children first, ids below the root generalised to `*`. */
async function gatherTree(docRef, label) {
  const out = [];
  await gatherBelow(docRef, label, out);
  out.push({ ref: docRef, label });
  return out;
}

async function gatherBelow(docRef, label, out) {
  for (const collection of await docRef.listCollections()) {
    const collectionLabel = `${label}/${collection.id}`;
    // listDocuments includes "missing" parents that only hold subcollections.
    for (const child of await collection.listDocuments()) {
      await gatherBelow(child, `${collectionLabel}/*`, out);
      out.push({ ref: child, label: collectionLabel });
    }
  }
}

/** Expand each root into its tree, de-duplicate, and keep only documents that exist. */
async function gatherExisting(db, roots) {
  const byPath = new Map();
  for (const { ref, label } of roots) {
    for (const entry of await gatherTree(ref, label)) {
      if (!byPath.has(entry.ref.path)) byPath.set(entry.ref.path, entry);
    }
  }
  const all = [...byPath.values()];
  const existing = [];
  for (let i = 0; i < all.length; i += READ_CHUNK) {
    const chunk = all.slice(i, i + READ_CHUNK);
    const snaps = await db.getAll(...chunk.map((entry) => entry.ref));
    snaps.forEach((snap, j) => {
      if (snap.exists) existing.push(chunk[j]);
    });
  }
  return existing;
}

/** Delete in gathered order — children before parents — so a failed run never strands a subtree. */
async function deleteInOrder(db, entries) {
  for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const { ref } of entries.slice(i, i + BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
  }
}

async function addQueryResults(query, into) {
  for (const doc of (await query.get()).docs) into.set(doc.ref.path, doc.ref);
}

/**
 * Residue a run can leave in fields of documents teardown keeps: a tier-3 gate switched off on
 * smoke-live, and smoke-live in smoke-target's legacy users.sites[], which the app's member add
 * mirrors there and only its removal strips (addMember and removeMember,
 * web/lib/membership.server.ts). Neither grants anything; a clean dev holds neither.
 */
async function findFieldRepairs(db) {
  const repairs = [];
  const gate = await findSwitchedOffTier3Gate(db);
  if (gate) repairs.push({ label: TIER3_GATE_OFF_LABEL, apply: () => restoreTier3Gate(gate) });

  const targetRef = db.collection('users').doc(PERSISTENT_USERS.target.uid);
  const legacySites = (await targetRef.get()).data()?.sites;
  if (Array.isArray(legacySites) && legacySites.includes(SITE_ID)) {
    repairs.push({
      label: TARGET_LEGACY_SITES_LABEL,
      apply: () => targetRef.update({ sites: FieldValue.arrayRemove(SITE_ID) }),
    });
  }
  return repairs;
}

/**
 * Remove everything a run creates. Prints and returns `{ counts, total }` — removed,
 * or on a dry run what would be. Never deletes the site document, the three persistent
 * users, or their own member rows and settings; its only writes to documents it keeps
 * are the field repairs in findFieldRepairs().
 */
export async function teardown({ dryRun = false, log = console.log, db = getDb(), auth = getAuth() } = {}) {
  const passkeyUsers = await findPasskeyUsers(db, auth);
  const passkeyUids = [...passkeyUsers.keys()];
  const smokeUids = [...PERSISTENT_UIDS, ...passkeyUids];
  const site = db.collection('sites').doc(SITE_ID);
  const roots = [];

  // Membership a run grants: the roles check's target, and any passkey account.
  roots.push({ ref: site.collection('members').doc(PERSISTENT_USERS.target.uid), label: TARGET_MEMBER_PATH });
  for (const uid of passkeyUids) roots.push({ ref: site.collection('members').doc(uid), label: PASSKEY_MEMBER_LABEL });

  // hoot conversations: every chat a smoke account owns, plus ownerless autonomous ones in the site.
  const chats = new Map();
  for (const uid of smokeUids) await addQueryResults(db.collection('chats').where('userId', '==', uid), chats);
  for (const doc of (await db.collection('chats').where('siteId', '==', SITE_ID).get()).docs) {
    if (doc.data().source === 'autonomous') chats.set(doc.ref.path, doc.ref);
  }
  for (const ref of chats.values()) roots.push({ ref, label: 'chats/*' });

  // Shares of those chats, and any a smoke account created (their chat may already be gone).
  const shares = new Map();
  const chatIds = [...chats.values()].map((ref) => ref.id);
  for (let i = 0; i < chatIds.length; i += IN_LIMIT) {
    await addQueryResults(db.collection('chat_shares').where('chatId', 'in', chatIds.slice(i, i + IN_LIMIT)), shares);
  }
  for (const uid of smokeUids) await addQueryResults(db.collection('chat_shares').where('createdBy', '==', uid), shares);
  for (const ref of shares.values()) roots.push({ ref, label: 'chat_shares' });

  // A scheduled follow-up that outlived its chat would start a turn after teardown.
  const followups = new Map();
  for (const uid of smokeUids) {
    await addQueryResults(db.collection('cortex-followups').where('userId', '==', uid), followups);
  }
  for (const ref of followups.values()) roots.push({ ref, label: 'cortex-followups' });

  // The stub machine with everything under it (commands, smoke control, metrics_history), and its config doc.
  roots.push({ ref: site.collection('machines').doc(STUB_MACHINE_ID), label: STUB_MACHINE_PATH });
  roots.push({
    ref: db.collection('config').doc(SITE_ID).collection('machines').doc(STUB_MACHINE_ID),
    label: `config/${SITE_ID}/machines/${STUB_MACHINE_ID}`,
  });

  // Per-run passkey accounts: user doc and everything beneath it, pending MFA setup, WebAuthn challenges.
  for (const uid of passkeyUids) {
    roots.push({ ref: db.collection('users').doc(uid), label: `users/${PASSKEY_UID_LABEL}` });
    roots.push({ ref: db.collection('mfa_pending').doc(uid), label: `mfa_pending/${PASSKEY_UID_LABEL}` });
    const challenges = new Map();
    await addQueryResults(db.collection('webauthn_challenges').where('userId', '==', uid), challenges);
    for (const ref of challenges.values()) roots.push({ ref, label: 'webauthn_challenges' });
  }

  const entries = await gatherExisting(db, roots);
  const repairs = await findFieldRepairs(db);
  const authUids = passkeyUids.filter((uid) => passkeyUsers.get(uid).hasAuth);
  let authFailures = [];
  if (!dryRun) {
    await deleteInOrder(db, entries);
    for (const { apply } of repairs) await apply();
    // Auth last: until the account is gone, the next teardown can still find the uid by email.
    if (authUids.length > 0) authFailures = (await auth.deleteUsers(authUids)).errors;
  }

  const counts = Object.fromEntries(TEARDOWN_PATHS.map((label) => [label, 0]));
  for (const { label } of [...entries, ...repairs]) counts[label] = (counts[label] ?? 0) + 1;
  counts[AUTH_ACCOUNTS_LABEL] = authUids.length - authFailures.length;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const width = Math.max(...Object.keys(counts).map((label) => label.length));
  log(`[smoke teardown] ${SITE_ID}${dryRun ? ' (dry run: counts are what would be removed)' : ''}`);
  for (const [label, n] of Object.entries(counts)) log(`  ${label.padEnd(width)}  ${n}`);
  log(`[smoke teardown] total ${total}`);

  if (authFailures.length > 0) {
    const failed = authFailures.map((failure) => authUids[failure.index]).join(', ');
    throw new Error(`failed to delete Auth account(s): ${failed}`);
  }
  return { counts, total };
}

const USAGE = 'usage: node web/e2e-live/lib/seed.mjs --seed | --teardown [--dry-run]';

async function main(args) {
  const known = new Set(['--seed', '--teardown', '--dry-run']);
  const wantsSeed = args.includes('--seed');
  const wantsTeardown = args.includes('--teardown');
  if (args.some((arg) => !known.has(arg)) || wantsSeed === wantsTeardown) {
    console.error(USAGE);
    return 2;
  }
  const dryRun = args.includes('--dry-run');
  try {
    if (wantsSeed) {
      const { users } = await seed({ dryRun });
      for (const [key, user] of Object.entries(users)) console.log(`  ${key}: ${user.uid} <${user.email}>`);
      if (!dryRun) console.log('  passwords rotated; held in memory only, never printed');
    } else {
      await teardown({ dryRun });
    }
    return 0;
  } catch (err) {
    console.error(`[smoke] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await closeDevAdmin();
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  const normalize = (file) => {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(fileURLToPath(import.meta.url)) === normalize(process.argv[1]);
}

// No top-level await: it would make this an async module, which require() refuses
// (ERR_REQUIRE_ASYNC_MODULE), and Playwright loads TypeScript setup files as CommonJS.
if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`[smoke] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
