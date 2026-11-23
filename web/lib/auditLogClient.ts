import crypto from 'crypto';
import { after } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { PLATFORM_AUDIT_SITE_ID } from '@/lib/activity/types';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';
import { getAdminDb } from '@/lib/firebase-admin';

/**
 * fire-and-forget audit emitter. never awaits, never throws: audit failures must not add
 * latency or fail the request.
 *
 * an event only joins its site's `audit_queue`. the functions drainer
 * (`functions/src/auditLog.ts`) is the hash chain's one writer, so a burst of changes to one
 * site waits in the queue instead of racing for the chain head.
 */

const ENQUEUE_ATTEMPTS = 3;
const ENQUEUE_BACKOFF_MS = 200;
const ALREADY_EXISTS = 6;
// the grpc codes firestore's own transaction runner retries; functions/src/auditLog.ts keeps the same list
const TRANSIENT_CODES = new Set([1, 2, 4, 8, 10, 13, 14, 16]);

export type ApiKeyAuditContext = {
  keyId: string;
  scopes: ApiKeyScope[] | null;
  environment: 'live' | 'test' | null;
  isLegacy: boolean;
};

/**
 * Compact stable fingerprint of a key's scope set: first 12 chars of SHA-256 over
 * canonical JSON — enough entropy to differentiate, avoids logging exact resource ids,
 * and survives scope reordering.
 */
export function scopeFingerprint(scopes: ApiKeyScope[] | null): string {
  if (!scopes || scopes.length === 0) return 'legacy';
  const canonical = [...scopes]
    .map((s) => ({
      resource: s.resource,
      id: s.id,
      permissions: [...s.permissions].sort(),
    }))
    .sort((a, b) => {
      if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return 0;
    });
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 12);
}

export interface ApiKeyUsedEvent {
  siteId: string;
  keyId: string;
  scopeFingerprint: string;
  environment: 'live' | 'test' | 'unknown';
  endpoint: string;
  method: string;
  isLegacy: boolean;
}

/**
 * Fire-and-forget `api_key_used` audit event. Returns `void` — do NOT await. Errors are
 * swallowed + logged so an audit outage never fails the request path.
 */
export function emitApiKeyUsed(event: ApiKeyUsedEvent): void {
  enqueueAudit({
    kind: 'api_key_used',
    siteId: event.siteId,
    actor: `apiKey:${event.keyId}`,
    occurredAt: Date.now(),
    attributes: {
      keyId: event.keyId,
      scopeFingerprint: event.scopeFingerprint,
      environment: event.environment,
      endpoint: event.endpoint,
      method: event.method,
      isLegacy: event.isLegacy,
    },
  });
}

/**
 * Mutation-event taxonomy (api-sprint waves 1-3). Add a kind here AND in the cloud
 * function's recogniser when a new track lands.
 */
export type MutationKind =
  | 'api_key_mutated' // api-key lifecycle: create / update / rotate / revoke
  | 'chunk_mutated' // chunk metadata lifecycle: cross-roost mount / referrer changes
  | 'deployment_mutated' // installer-deploys-api: create / retry / cancel / uninstall / delete
  | 'distribution_mutated' // project-distribution-api: create / cancel / delete
  | 'process_mutated' // process-api: create / update / delete / kill / start / stop / schedule
  | 'roost_mutated' // roost-api: create / update / delete / publish / rollback / deploy / resync
  | 'machine_command_dispatched' // machine-api: reboot / shutdown / capture_screenshot
  | 'user_mutated' // users-api: promote / demote / assign-sites / remove-sites / delete / bootstrap
  | 'site_mutated' // sites-api: create / update / delete (security-boundary-migration wave 3.9)
  | 'site_member_mutated' // /api/sites/{siteId}/members
  | 'installer_mutated' // installer-api: upload / set-latest / delete / register / notes
  | 'webhook_mutated' // webhook-api: create / update / delete / rotate-secret / delivery retry
  | 'chat_mutated' // hoot-api: new conversation / rename / soft-delete
  | 'billing_mutated' // admin billing override: extend-trial / set-tier / force-expire
  | 'talon_mutated'; // talon lifecycle: create / update / enable / disable / delete

export interface MutationEvent {
  /** Mutation kind — see {@link MutationKind}. */
  kind: MutationKind;
  /**
   * Site this mutation belongs to. Platform-wide mutations (`user_mutated`,
   * `installer_mutated`) pass an empty string — recorded under the platform tenant.
   */
  siteId: string;
  /** `apiKey:<keyId>` for key-mediated mutations, `user:<uid>` for session/ID-token ones. */
  actor: string;
  /**
   * Resource being mutated (`deploymentId`, `processId`, `uid`, …). Dedup target for
   * "did this entity change?" queries.
   */
  targetId: string;
  /**
   * Free-form attributes. Convention: `endpoint` + `method` for traceability plus the
   * verb-specific delta (`from`/`to` for promote/demote, `reason` for cancel).
   */
  attributes: Record<string, unknown>;
}

/**
 * Fire-and-forget mutation audit; same delivery semantics as {@link emitApiKeyUsed}.
 * One call per mutation — `__tests__/api/auditMutationCoverage.test.ts` asserts every
 * mutating route produces exactly one entry.
 */
export function emitMutation(event: MutationEvent): void {
  enqueueAudit({
    kind: event.kind,
    siteId: event.siteId,
    actor: event.actor,
    occurredAt: Date.now(),
    target: event.targetId,
    attributes: event.attributes,
  });
}

/** internal: the queue write every emit helper shares. */
function enqueueAudit(event: {
  kind: 'api_key_used' | MutationKind;
  siteId: string;
  actor: string;
  occurredAt: number;
  target?: string;
  attributes: Record<string, unknown>;
}): void {
  const write = (async () => {
    try {
      // the id is fixed before the first attempt, so a retry can tell that an earlier write landed
      const ref = getAdminDb()
        .collection('sites')
        .doc(event.siteId || PLATFORM_AUDIT_SITE_ID)
        .collection('audit_queue')
        .doc();
      // a json round trip: firestore rejects undefined fields, which json drops, and the
      // drainer then hashes the event exactly as json carries it
      const queued = { event: JSON.parse(JSON.stringify(event)), enqueuedAt: FieldValue.serverTimestamp() };
      for (let attempt = 1; ; attempt++) {
        try {
          await ref.create(queued);
          return;
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          // an earlier attempt landed and only its reply was lost
          if (code === ALREADY_EXISTS) return;
          if (attempt === ENQUEUE_ATTEMPTS || !TRANSIENT_CODES.has(code as number)) throw err;
          await new Promise((resolve) => setTimeout(resolve, ENQUEUE_BACKOFF_MS * attempt));
        }
      }
    } catch (err) {
      // never fail the request, but log loudly: a silent audit gap breaks compliance + forensics
      console.warn(
        `[auditLogClient] ${event.kind} enqueue failed — audit event was DROPPED: ${(err as Error).message}`,
      );
    }
  })();
  try {
    // keeps a serverless instance (vercel's waitUntil) alive until the write settles
    after(write);
  } catch {
    // outside a request scope (a script, a test) nothing ends the process early, and the write is already running
  }
}
