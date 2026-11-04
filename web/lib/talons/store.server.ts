/**
 * Talon store — the one write path for `sites/{siteId}/talons/{talonId}`.
 * Every mutation routes through here so validation, the privileged-output
 * gate, webhook SSRF checks, the author-LLM-key precondition, `nextRunAt`
 * stamping and the audit emit can't be sidestepped by a new caller.
 *
 * One document per talon, never an array on a settings doc: dashboard and
 * hoot edit concurrently (an array write clobbers the other writer), and the
 * cron sweep needs the `enabled == true && nextRunAt <= now` collection-group
 * query (composite index in firestore.indexes.json).
 *
 * `validateTalonInput` owns and normalizes the caller half and rejects unknown
 * top-level fields; every server-owned field is stamped here after validation.
 *
 * Webhook talons get a `whsec_` secret in `sites/{siteId}/talon_secrets/{id}`,
 * which no client can read — deliberately unlike `webhooks.signingSecret`.
 */
import { randomBytes } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import { Capability, hasCapability, siteStanding, type Actor, type UserActor } from '@/lib/capabilities';
import { assertLlmKeyAvailable } from '@/lib/hoot-utils.server';
import logger from '@/lib/logger';
import { deriveMembership, deriveSwoopMode } from '@/lib/sitePolicy.server';
import { validateWebhookUrl } from '@/lib/webhookUrl';
import { computeNextRunAt } from './schedule.server';
import { isCreatorDisabledReason } from './types';
import type {
  TalonCondition,
  TalonCreatedVia,
  TalonDoc,
  TalonOutput,
} from './types';
import {
  MAX_TALONS_PER_SITE,
  validateTalonInput,
  type TalonFieldError,
  type ValidatedTalonInput,
} from './validation';

/** 32 random bytes → 64 hex chars, `whsec_`-prefixed like the webhooks API. */
const SIGNING_SECRET_BYTES = 32;

/** `createdBy` prefix for a non-user author: no uid, so it can never satisfy the llm-key precondition. */
const SYSTEM_AUTHOR_PREFIX = 'system:';

/** Deliberately looser than Firestore's 20-char auto-ids, matching the route regexes; the job is rejecting ids that escape the document path. */
const TALON_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Talon fields a caller can change — the diff basis for audit `changedFields`. */
const CALLER_OWNED_FIELDS = [
  'name',
  'description',
  'enabled',
  'trigger',
  'condition',
  'outputs',
  'scope',
  'cooldownMinutes',
] as const;

export type TalonAuditVerb =
  | 'talon.create'
  | 'talon.update'
  | 'talon.delete'
  | 'talon.enable'
  | 'talon.disable'
  | 'talon.reassign';

const METHOD_BY_VERB: Readonly<Record<TalonAuditVerb, string>> = {
  'talon.create': 'POST',
  'talon.update': 'PATCH',
  'talon.delete': 'DELETE',
  'talon.enable': 'PATCH',
  'talon.disable': 'PATCH',
  'talon.reassign': 'POST',
};

export type TalonStoreErrorCode =
  | 'invalid_talon'
  | 'talon_limit_reached'
  | 'command_output_forbidden'
  | 'hoot_actions_forbidden'
  | 'invalid_webhook_url'
  | 'llm_key_required'
  | 'talon_not_found'
  | 'invalid_reassign'
  | 'successor_invalid';

/**
 * Store rejection carrying the HTTP status the route returns. Mirrors
 * `ActionInputError`, plus field errors so the editor can render inline.
 */
export class TalonStoreError extends Error {
  readonly status: number;
  readonly code: TalonStoreErrorCode;
  readonly fieldErrors?: TalonFieldError[];

  constructor(
    status: number,
    code: TalonStoreErrorCode,
    message: string,
    fieldErrors?: TalonFieldError[],
  ) {
    super(message);
    this.name = 'TalonStoreError';
    this.status = status;
    this.code = code;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

/** A stored talon, with the document id the collection keys it by. */
export interface StoredTalon extends TalonDoc {
  id: string;
}

/** Trusted caller context. Authorization (TALON_MANAGE) is the wrapper's job. */
export interface TalonStoreContext {
  siteId: string;
  /** Decides whether privileged outputs may be authored — see {@link assertPrivilegedOutputsAllowed}. */
  actor: Actor;
  /** Audit actor string ("user:<uid>", "cortex:user_<uid>", "apiKey:<keyId>"). */
  auditActor: string;
  /** How the talon is being authored. Persisted as `createdVia` on create. */
  via: TalonCreatedVia;
  /** Hoot-authored talons only — the chat the talon came from. */
  chatId?: string;
  /** Audit `endpoint` attribute. Defaults to the canonical talons path. */
  endpoint?: string;
  /** Audit `method` attribute. Defaults to the verb's HTTP method. */
  method?: string;
}

function talonsCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('talons');
}

function talonSecretsCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('talon_secrets');
}

/**
 * Site's IANA timezone, `'UTC'` when unset/unusable. Fixed clock times resolve
 * against the SITE zone, not the machine zone: one talon can span machines in
 * several zones and its schedule must have one meaning.
 */
export async function getSiteTimezone(db: Firestore, siteId: string): Promise<string> {
  try {
    const snapshot = await db.collection('sites').doc(siteId).get();
    const timezone = snapshot.data()?.timezone;
    return typeof timezone === 'string' && timezone.trim().length > 0
      ? timezone.trim()
      : 'UTC';
  } catch {
    return 'UTC';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural equality over plain validated data — no Dates, no class instances. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
    );
  }
  return false;
}

function validateOrThrow(input: unknown): ValidatedTalonInput {
  const result = validateTalonInput(input);
  if (result.ok) return result.value;
  const [first, ...rest] = result.errors;
  const summary = rest.length > 0 ? `${first.message} (+${rest.length} more)` : first.message;
  throw new TalonStoreError(400, 'invalid_talon', summary, result.errors);
}

/**
 * Both privileged output classes take MACHINE_EXEC_COMMAND (site admin+):
 * `command` queues a machine command directly; a hoot output with
 * `allowActions` hands an unattended turn the tier-2 tool set. Site-scoped,
 * and checked on create AND update so an edit can't acquire either.
 */
function hasCommandOutput(outputs: TalonOutput[]): boolean {
  return outputs.some((output) => output.type === 'command');
}

function hasHootActionOutput(outputs: TalonOutput[]): boolean {
  return outputs.some((output) => output.type === 'cortex' && output.allowActions === true);
}

/** True when either privileged output class is present — see the doc above. */
function hasPrivilegedOutput(outputs: TalonOutput[]): boolean {
  return hasCommandOutput(outputs) || hasHootActionOutput(outputs);
}

function assertPrivilegedOutputsAllowed(ctx: TalonStoreContext, outputs: TalonOutput[]): void {
  const isAllowed = () => hasCapability(ctx.actor, Capability.MACHINE_EXEC_COMMAND, ctx.siteId);

  if (hasCommandOutput(outputs) && !isAllowed()) {
    throw new TalonStoreError(
      403,
      'command_output_forbidden',
      '`command` outputs may only be authored by a site admin.',
    );
  }

  if (hasHootActionOutput(outputs) && !isAllowed()) {
    throw new TalonStoreError(
      403,
      'hoot_actions_forbidden',
      'letting hoot act on a machine may only be authored by a site admin.',
    );
  }
}

/**
 * DNS-resolving, private-range-rejecting SSRF pass; the shared validator is
 * syntax-only because it also runs in the browser. The dispatcher re-validates
 * at send time — DNS can change underneath us.
 */
async function assertWebhookUrlsAreSafe(outputs: TalonOutput[]): Promise<void> {
  for (const [index, output] of outputs.entries()) {
    if (output.type !== 'webhook') continue;
    const result = await validateWebhookUrl(output.url);
    if (result.ok) continue;
    throw new TalonStoreError(
      400,
      'invalid_webhook_url',
      `\`outputs[${index}].url\` was rejected: ${result.detail ?? result.reason}.`,
    );
  }
}

/**
 * Unattended model calls (visual_check conditions, hoot outputs) spend the
 * talon AUTHOR's key — there is no shared site key (`resolveLlmConfig`).
 * Checked at authoring time so it fails in the editor, not silently at 3am.
 * `authorId` is undefined for a system actor, which can never satisfy it.
 */
async function assertAuthorLlmKeyAvailable(
  authorId: string | undefined,
  db: Firestore,
  condition: TalonCondition,
  outputs: TalonOutput[],
): Promise<void> {
  const needsLlm =
    condition.type === 'visual_check' || outputs.some((output) => output.type === 'cortex');
  if (!needsLlm) return;

  if (!authorId) {
    throw new TalonStoreError(
      400,
      'llm_key_required',
      'this talon uses ai, so it has to belong to a person whose ai key it can run with.',
    );
  }

  try {
    await assertLlmKeyAvailable(db, authorId);
  } catch {
    // Underlying message leaks infra detail (encryption key / storage path).
    throw new TalonStoreError(
      400,
      'llm_key_required',
      'this talon uses ai, so it needs an ai key. add one in settings → hoot, then save again.',
    );
  }
}

/** The uid a new talon would be authored by, or `undefined` for a system actor. */
function actorAuthorUid(actor: Actor): string | undefined {
  return actor.type === 'user' ? actor.userId : undefined;
}

/** The uid an EXISTING talon's key spend resolves to; undefined when it has no user author. */
function talonAuthorUid(talon: Pick<TalonDoc, 'createdBy'>): string | undefined {
  const createdBy = talon.createdBy;
  if (!createdBy || createdBy.startsWith(SYSTEM_AUTHOR_PREFIX)) return undefined;
  return createdBy;
}

function hasWebhookOutput(outputs: TalonOutput[]): boolean {
  return outputs.some((output) => output.type === 'webhook');
}

function mintWebhookSecret(): string {
  return `whsec_${randomBytes(SIGNING_SECRET_BYTES).toString('hex')}`;
}

/** `createdBy` is non-optional, so a system caller is recorded under its actor name rather than blank. */
function authorIdentifier(actor: Actor): string {
  return actor.type === 'user' ? actor.userId : `${SYSTEM_AUTHOR_PREFIX}${actor.name}`;
}

function emitTalonAudit(
  ctx: TalonStoreContext,
  verb: TalonAuditVerb,
  talonId: string,
  changedFields?: string[],
  /** Verb-specific delta, e.g. the previous/new author on a reassign. */
  extraAttributes?: Record<string, unknown>,
): void {
  const basePath = `/api/sites/${ctx.siteId}/talons`;
  const collectionScoped = verb === 'talon.create' || verb === 'talon.reassign';
  emitMutation({
    kind: 'talon_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: talonId,
    attributes: {
      verb,
      endpoint: ctx.endpoint ?? (collectionScoped ? basePath : `${basePath}/${talonId}`),
      method: ctx.method ?? METHOD_BY_VERB[verb],
      ...(changedFields ? { changedFields } : {}),
      via: ctx.via,
      ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
      ...extraAttributes,
    },
  });
}

async function requireTalon(
  db: Firestore,
  siteId: string,
  talonId: string,
): Promise<TalonDoc> {
  const snapshot = await talonsCollection(db, siteId).doc(talonId).get();
  const data = snapshot.exists ? (snapshot.data() as TalonDoc | undefined) : undefined;
  if (!data) {
    throw new TalonStoreError(404, 'talon_not_found', `talon \`${talonId}\` was not found.`);
  }
  return data;
}

/**
 * Validate, gate, and persist a new talon. `input` is raw caller input;
 * server-owned fields are stamped here and rejected if the caller sends them.
 */
export async function createTalon(
  db: Firestore,
  ctx: TalonStoreContext,
  input: unknown,
): Promise<StoredTalon> {
  const value = validateOrThrow(input);
  assertPrivilegedOutputsAllowed(ctx, value.outputs);

  // Count-then-write, not a transaction: the cap is a product limit, not a
  // security boundary — two admins racing the last slot land at worst on 21.
  const collection = talonsCollection(db, ctx.siteId);
  const countSnapshot = await collection.count().get();
  const existingCount = countSnapshot.data().count;
  if (existingCount >= MAX_TALONS_PER_SITE) {
    throw new TalonStoreError(
      409,
      'talon_limit_reached',
      `this site already has ${existingCount} talons — the limit is ${MAX_TALONS_PER_SITE}.`,
    );
  }

  await assertWebhookUrlsAreSafe(value.outputs);
  await assertAuthorLlmKeyAvailable(
    actorAuthorUid(ctx.actor),
    db,
    value.condition,
    value.outputs,
  );

  const now = new Date();
  const timezone = await getSiteTimezone(db, ctx.siteId);
  const nextRunAt = computeNextRunAt(value.trigger, timezone, now);

  const doc: TalonDoc = {
    schemaVersion: 1,
    ...value,
    createdBy: authorIdentifier(ctx.actor),
    createdVia: ctx.via,
    ...(ctx.via === 'cortex' && ctx.chatId ? { chatId: ctx.chatId } : {}),
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    // Omitted, never null: Firestore sorts null below every timestamp, so null
    // matches the sweep's `nextRunAt <= now` and hands it unscheduled talons.
    ...(nextRunAt ? { nextRunAt } : {}),
  };

  const ref = collection.doc();
  const batch = db.batch();
  batch.set(ref, doc);
  if (hasWebhookOutput(value.outputs)) {
    batch.set(talonSecretsCollection(db, ctx.siteId).doc(ref.id), {
      talonId: ref.id,
      secret: mintWebhookSecret(),
      createdAt: now,
    });
  }
  // One commit so a webhook talon can never exist without its signing secret.
  await batch.commit();

  emitTalonAudit(ctx, 'talon.create', ref.id);
  logger.info(`Talon created: ${value.name} (${ref.id}) on ${ctx.siteId} via ${ctx.via}`, {
    context: 'talons/store',
  });

  return { id: ref.id, ...doc };
}

/**
 * Replace a talon's caller-owned fields. Full-document semantics; run
 * bookkeeping (`lastRunAt`, `consecutiveFailures`, …) is untouched.
 */
export async function updateTalon(
  db: Firestore,
  ctx: TalonStoreContext,
  talonId: string,
  input: unknown,
): Promise<StoredTalon> {
  const existing = await requireTalon(db, ctx.siteId, talonId);

  const value = validateOrThrow(input);
  assertPrivilegedOutputsAllowed(ctx, value.outputs);
  await assertWebhookUrlsAreSafe(value.outputs);
  // The AUTHOR's key, not the editor's — `createdBy` never changes on update.
  await assertAuthorLlmKeyAvailable(
    talonAuthorUid(existing),
    db,
    value.condition,
    value.outputs,
  );

  const existingFields = existing as unknown as Record<string, unknown>;
  const changedFields = CALLER_OWNED_FIELDS.filter(
    (field) => !deepEqual(existingFields[field], value[field]),
  );

  const now = new Date();
  const updates: Record<string, unknown> = { ...value, updatedAt: now };
  // A cleared description must be removed, not left behind at its old value.
  if (value.description === undefined && existing.description !== undefined) {
    updates.description = FieldValue.delete();
  }

  if (changedFields.includes('trigger')) {
    const timezone = await getSiteTimezone(db, ctx.siteId);
    const nextRunAt = computeNextRunAt(value.trigger, timezone, now);
    // Switching a schedule talon to a threshold/event one must drop the field
    // entirely — see the null-sorting note in `createTalon`.
    updates.nextRunAt = nextRunAt ?? FieldValue.delete();
  }

  const ref = talonsCollection(db, ctx.siteId).doc(talonId);
  const secretRef = talonSecretsCollection(db, ctx.siteId).doc(talonId);
  // Mint on the first webhook output. Losing the output does NOT delete the
  // secret — it stays the stable signing identity; only deletion clears it.
  const needsSecret = hasWebhookOutput(value.outputs) && !(await secretRef.get()).exists;

  const batch = db.batch();
  batch.update(ref, updates);
  if (needsSecret) {
    batch.set(secretRef, { talonId, secret: mintWebhookSecret(), createdAt: now });
  }
  await batch.commit();

  emitTalonAudit(ctx, 'talon.update', talonId, changedFields);
  logger.info(
    `Talon updated: ${talonId} on ${ctx.siteId} (changed: ${changedFields.join(', ') || 'none'})`,
    { context: 'talons/store' },
  );

  const refreshed = await requireTalon(db, ctx.siteId, talonId);
  return { id: talonId, ...refreshed };
}

/**
 * Flip a talon on or off. Enabling re-arms `nextRunAt` from now — a month-old
 * next-run would otherwise fire the instant the sweep sees it. Disabling leaves
 * it stale, harmless because the sweep filters `enabled == true`.
 */
export async function setTalonEnabled(
  db: Firestore,
  ctx: TalonStoreContext,
  talonId: string,
  enabled: boolean,
): Promise<StoredTalon> {
  const existing = await requireTalon(db, ctx.siteId, talonId);

  const now = new Date();
  // A human moved the switch: clear the system's disabledReason on either edge,
  // else a re-armed talon still claims it was switched off.
  const updates: Record<string, unknown> = {
    enabled,
    updatedAt: now,
    ...(existing.disabledReason !== undefined ? { disabledReason: FieldValue.delete() } : {}),
  };

  if (enabled) {
    await assertAuthorLlmKeyAvailable(
      talonAuthorUid(existing),
      db,
      existing.condition,
      existing.outputs,
    );
    const timezone = await getSiteTimezone(db, ctx.siteId);
    const nextRunAt = computeNextRunAt(existing.trigger, timezone, now);
    updates.nextRunAt = nextRunAt ?? FieldValue.delete();
  }

  await talonsCollection(db, ctx.siteId).doc(talonId).update(updates);

  emitTalonAudit(ctx, enabled ? 'talon.enable' : 'talon.disable', talonId, ['enabled']);
  logger.info(`Talon ${enabled ? 'enabled' : 'disabled'}: ${talonId} on ${ctx.siteId}`, {
    context: 'talons/store',
  });

  const refreshed = await requireTalon(db, ctx.siteId, talonId);
  return { id: talonId, ...refreshed };
}

/**
 * Delete a talon and its signing secret. Run history in `talon_runs` is kept
 * on purpose — it is an audit surface and outlives the talon it describes.
 */
export async function deleteTalon(
  db: Firestore,
  ctx: TalonStoreContext,
  talonId: string,
): Promise<void> {
  await requireTalon(db, ctx.siteId, talonId);

  const batch = db.batch();
  batch.delete(talonsCollection(db, ctx.siteId).doc(talonId));
  // Unconditional: deleting a document that does not exist is a no-op, and a
  // secret must never outlive the talon it signs for.
  batch.delete(talonSecretsCollection(db, ctx.siteId).doc(talonId));
  await batch.commit();

  emitTalonAudit(ctx, 'talon.delete', talonId);
  logger.info(`Talon deleted: ${talonId} on ${ctx.siteId}`, { context: 'talons/store' });
}

/**
 * Why reassign exists: a hoot output re-resolves the AUTHOR's site access on
 * every unattended run (`hootOutput.server.ts`) and a throw there fails the
 * run, so when the author loses access their ai talons stop silently at 3am.
 * The fire-time check is deliberately NOT weakened — this changes who the
 * author is.
 */
export type TalonSuccessorRejection =
  | 'not_found'
  | 'soft_deleted'
  | 'insufficient_role'
  | 'insufficient_privilege';

const SUCCESSOR_REJECTION_DETAIL: Readonly<Record<TalonSuccessorRejection, string>> = {
  not_found: 'the successor does not match an existing user.',
  soft_deleted: 'the successor is a deleted account.',
  insufficient_role:
    'the successor must be a site admin (or superadmin) with access to this site — the same bar the talon store holds every author to.',
  insufficient_privilege:
    'at least one talon runs commands or lets hoot act on a machine, which only a site admin may author.',
};

/** Which talons to move. Exactly one selector must be supplied. */
export interface TalonReassignSelection {
  /** Every talon on the site currently authored by this uid. */
  fromUid?: string;
  /** An explicit list of talon ids on the site. */
  talonIds?: string[];
}

export interface TalonReassignResult {
  siteId: string;
  toUid: string;
  /** Talons whose `createdBy` was rewritten by this call. */
  reassignedTalonIds: string[];
  /** Talons that were already authored by `toUid` — no write, no audit row. */
  skippedTalonIds: string[];
}

/**
 * Resolve a uid to a capability-matrix actor for a specific site. Reads
 * `users/{uid}` and the successor's membership rather than trusting a
 * caller-supplied role — the successor is named in a request body.
 *
 * `siteId` is required: the successor's authority is per-site, so an actor built
 * without it would carry no standing and reject every candidate.
 */
async function loadSuccessorActor(
  db: Firestore,
  uid: string,
  siteId: string,
): Promise<{ ok: true; actor: UserActor } | { ok: false; reason: TalonSuccessorRejection }> {
  const [snapshot, memberSnapshot] = await db.getAll(
    db.collection('users').doc(uid),
    db.collection('sites').doc(siteId).collection('members').doc(uid),
  );
  const data = snapshot.exists ? snapshot.data() : undefined;
  if (!data) return { ok: false, reason: 'not_found' };
  // Soft-deleted accounts keep their user doc, so `deletedAt` is the liveness test.
  if (data.deletedAt != null) return { ok: false, reason: 'soft_deleted' };

  // `'user'` and anything unrecognised are the `member` tier — no global
  // privilege. Standing on the site comes from the membership row below.
  const role = data.role === 'admin' || data.role === 'superadmin' ? data.role : 'member';

  const memberData = memberSnapshot.exists ? (memberSnapshot.data() ?? null) : null;
  const siteRole = deriveMembership(memberData);

  return {
    ok: true,
    actor: {
      type: 'user',
      userId: uid,
      role,
      ...siteStanding({
        [siteId]: { role: siteRole, swoopMode: deriveSwoopMode(memberData, siteRole) },
      }),
    },
  };
}

/**
 * Successor must clear both author gates: TALON_MANAGE, plus
 * MACHINE_EXEC_COMMAND when any talon carries a privileged output. Kept
 * separate even though today's matrix grants both to the same roles — merging
 * them re-opens the privileged-output hole if the matrix diverges.
 */
function successorRejection(
  siteId: string,
  successor: UserActor,
  talons: StoredTalon[],
): TalonSuccessorRejection | null {
  if (!hasCapability(successor, Capability.TALON_MANAGE, siteId)) {
    return 'insufficient_role';
  }
  if (
    talons.some((talon) => hasPrivilegedOutput(talon.outputs)) &&
    !hasCapability(successor, Capability.MACHINE_EXEC_COMMAND, siteId)
  ) {
    return 'insufficient_privilege';
  }
  return null;
}

/** Every talon on the site authored by `uid`, ordered by name. */
export async function listTalonsAuthoredBy(
  db: Firestore,
  siteId: string,
  uid: string,
): Promise<StoredTalon[]> {
  const snapshot = await talonsCollection(db, siteId)
    .where('createdBy', '==', uid)
    .orderBy('name')
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as TalonDoc) }));
}

/**
 * How many talons on the site `uid` authored. Aggregate, so a departure
 * preview costs no per-talon read; single-field equality, covered by
 * Firestore's automatic collection-scoped index.
 */
export async function countTalonsAuthoredBy(
  db: Firestore,
  siteId: string,
  uid: string,
): Promise<number> {
  const snapshot = await talonsCollection(db, siteId)
    .where('createdBy', '==', uid)
    .count()
    .get();
  return snapshot.data().count;
}

/** One authored talon, with the site it lives on — the cross-site preview row. */
export interface AuthoredTalonRef {
  siteId: string;
  talonId: string;
  name: string;
  enabled: boolean;
}

/**
 * Every talon `uid` authored across all sites, in one collection-group query:
 * a superadmin's `sites[]` can be empty while they still author talons, so
 * walking the membership array under-reports. The `orderBy('name')` is
 * load-bearing — the composite index is declared over `createdBy ASC, name ASC`.
 */
export async function listTalonsAuthoredByAcrossSites(
  db: Firestore,
  uid: string,
): Promise<AuthoredTalonRef[]> {
  const snapshot = await db
    .collectionGroup('talons')
    .where('createdBy', '==', uid)
    .orderBy('name')
    .get();

  const refs: AuthoredTalonRef[] = [];
  for (const doc of snapshot.docs) {
    // `sites/{siteId}/talons/{talonId}` — the grandparent is the site document.
    const siteId = doc.ref.parent.parent?.id;
    if (!siteId) continue;
    const data = doc.data() as TalonDoc;
    refs.push({
      siteId,
      talonId: doc.id,
      name: typeof data.name === 'string' ? data.name : doc.id,
      enabled: data.enabled === true,
    });
  }
  return refs;
}

/**
 * Move authorship of one or more talons to `toUid`. Selection is every talon
 * by `fromUid` OR an explicit `talonIds` list, never both.
 *
 * One atomic batch (MAX_TALONS_PER_SITE is far under the 500-op limit), and
 * nothing is written unless every selected talon exists and the successor
 * clears both author gates — a partial handover gives no signal which half.
 *
 * The previous author lives only in the audit row (`previousCreatedBy`); a
 * second copy on the document would drift.
 */
export async function reassignTalons(
  db: Firestore,
  ctx: TalonStoreContext,
  toUid: string,
  selection: TalonReassignSelection,
): Promise<TalonReassignResult> {
  if (typeof toUid !== 'string' || !UID_RE.test(toUid)) {
    throw new TalonStoreError(400, 'invalid_reassign', '`toUid` must be a valid user id.');
  }

  const { fromUid, talonIds } = selection;
  const hasFromUid = fromUid !== undefined;
  const hasTalonIds = talonIds !== undefined;
  if (hasFromUid === hasTalonIds) {
    throw new TalonStoreError(
      400,
      'invalid_reassign',
      'supply exactly one of `fromUid` or `talonIds`.',
    );
  }

  let selected: StoredTalon[];
  if (hasFromUid) {
    if (typeof fromUid !== 'string' || !UID_RE.test(fromUid)) {
      throw new TalonStoreError(400, 'invalid_reassign', '`fromUid` must be a valid user id.');
    }
    if (fromUid === toUid) {
      throw new TalonStoreError(
        400,
        'invalid_reassign',
        '`fromUid` and `toUid` are the same user.',
      );
    }
    selected = await listTalonsAuthoredBy(db, ctx.siteId, fromUid);
  } else {
    const ids = talonIds ?? [];
    if (ids.length === 0) {
      throw new TalonStoreError(400, 'invalid_reassign', '`talonIds` must not be empty.');
    }
    if (ids.some((id) => typeof id !== 'string' || !TALON_ID_RE.test(id))) {
      throw new TalonStoreError(400, 'invalid_reassign', '`talonIds` contains a malformed id.');
    }
    const unique = Array.from(new Set(ids));
    if (unique.length > MAX_TALONS_PER_SITE) {
      throw new TalonStoreError(
        400,
        'invalid_reassign',
        `\`talonIds\` may name at most ${MAX_TALONS_PER_SITE} talons.`,
      );
    }
    // All-or-nothing: `requireTalon` throws 404 for the first missing id.
    selected = await Promise.all(
      unique.map(async (id) => ({ id, ...(await requireTalon(db, ctx.siteId, id)) })),
    );
  }

  const successor = await loadSuccessorActor(db, toUid, ctx.siteId);
  if (!successor.ok) {
    throw new TalonStoreError(
      400,
      'successor_invalid',
      SUCCESSOR_REJECTION_DETAIL[successor.reason],
    );
  }

  const rejection = successorRejection(ctx.siteId, successor.actor, selected);
  if (rejection) {
    throw new TalonStoreError(400, 'successor_invalid', SUCCESSOR_REJECTION_DETAIL[rejection]);
  }

  const moving = selected.filter((talon) => talon.createdBy !== toUid);
  const skippedTalonIds = selected
    .filter((talon) => talon.createdBy === toUid)
    .map((talon) => talon.id);

  if (moving.length === 0) {
    return { siteId: ctx.siteId, toUid, reassignedTalonIds: [], skippedTalonIds };
  }

  // Reassignment is authoring, so the successor needs a key too — otherwise the
  // handover re-enables straight into `creator_missing_llm_key` on the next run.
  // Optional-chained: these docs were not validated on this path, and a talon
  // predating a field must stay movable (absent condition => not a visual check).
  const movingNeedsLlm = moving.some(
    (talon) =>
      talon.condition?.type === 'visual_check' ||
      talon.outputs?.some((output) => output.type === 'cortex'),
  );
  if (movingNeedsLlm) {
    try {
      await assertLlmKeyAvailable(db, toUid);
    } catch {
      throw new TalonStoreError(
        400,
        'successor_invalid',
        'some of these talons use ai, so the person taking them over needs an ai key of their own. they can add one in settings → hoot.',
      );
    }
  }

  const now = new Date();
  const collection = talonsCollection(db, ctx.siteId);
  const batch = db.batch();
  for (const talon of moving) {
    batch.update(collection.doc(talon.id), {
      createdBy: toUid,
      updatedAt: now,
      // Reassignment resolves the creator reasons: the new author is present and
      // keyed, so re-arm rather than leave a reason that is no longer true.
      // Creator reasons only — `repeated_failures` describes the talon, and a
      // human-disabled talon carries no reason and must stay off.
      ...(isCreatorDisabledReason(talon.disabledReason)
        ? { enabled: true, disabledReason: FieldValue.delete(), consecutiveFailures: 0 }
        : {}),
    });
  }
  await batch.commit();

  // One row per talon: `targetId` must name the resource that changed.
  for (const talon of moving) {
    const rearmed = isCreatorDisabledReason(talon.disabledReason);
    emitTalonAudit(
      ctx,
      'talon.reassign',
      talon.id,
      rearmed ? ['createdBy', 'enabled', 'disabledReason'] : ['createdBy'],
      {
        previousCreatedBy: talon.createdBy,
        newCreatedBy: toUid,
        ...(rearmed ? { rearmedFrom: talon.disabledReason } : {}),
      },
    );
  }

  logger.info(
    `Talons reassigned to ${toUid} on ${ctx.siteId}: ${moving.map((t) => t.id).join(', ')}`,
    { context: 'talons/store' },
  );

  return {
    siteId: ctx.siteId,
    toUid,
    reassignedTalonIds: moving.map((talon) => talon.id),
    skippedTalonIds,
  };
}

/** One talon, or `null` when the site has no talon with that id. */
export async function getTalon(
  db: Firestore,
  siteId: string,
  talonId: string,
): Promise<StoredTalon | null> {
  const snapshot = await talonsCollection(db, siteId).doc(talonId).get();
  const data = snapshot.exists ? (snapshot.data() as TalonDoc | undefined) : undefined;
  return data ? { id: talonId, ...data } : null;
}

/** Every talon on the site, ordered by name — the order the editor lists them in. */
export async function listTalons(db: Firestore, siteId: string): Promise<StoredTalon[]> {
  const snapshot = await talonsCollection(db, siteId).orderBy('name').get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as TalonDoc) }));
}
