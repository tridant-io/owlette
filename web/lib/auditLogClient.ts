import crypto from 'crypto';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';
import { HOOT_INTERNAL_SECRET_ENV, hootInternalSecret } from '@/lib/hootInternalSecret';

/**
 * Fire-and-forget HTTP client for the `recordAuditEvent` cloud function. Never awaits,
 * never throws — audit failures must not add latency or fail the request.
 *
 * Endpoint: env `AUDIT_LOG_URL`, else computed from `FIREBASE_PROJECT_ID` +
 * `AUDIT_LOG_REGION` (default us-central1). Neither set → no-op, so dev environments
 * without deployed functions stay quiet.
 */

const DEFAULT_REGION = 'us-central1';
const AUDIT_TIMEOUT_MS = 3000;

export type ApiKeyAuditContext = {
  keyId: string;
  scopes: ApiKeyScope[] | null;
  environment: 'live' | 'test' | null;
  isLegacy: boolean;
};

function getAuditLogUrl(): string | null {
  const explicit = process.env.AUDIT_LOG_URL;
  if (explicit && explicit.length > 0) return explicit;
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) return null;
  const region = process.env.AUDIT_LOG_REGION || DEFAULT_REGION;
  return `https://${region}-${projectId}.cloudfunctions.net/recordAuditEvent`;
}

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
  const url = getAuditLogUrl();
  if (!url) return;

  const body = {
    kind: 'api_key_used' as const,
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
  };

  postAudit(url, body, 'api_key_used');
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
  | 'installer_mutated' // installer-api: upload / set-latest / delete / register
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
 * Fire-and-forget mutation audit; same delivery/abort semantics as {@link emitApiKeyUsed}.
 * One call per mutation — `__tests__/api/auditMutationCoverage.test.ts` asserts every
 * mutating route produces exactly one entry.
 */
export function emitMutation(event: MutationEvent): void {
  const url = getAuditLogUrl();
  if (!url) return;

  const body = {
    kind: event.kind,
    siteId: event.siteId,
    actor: event.actor,
    occurredAt: Date.now(),
    target: event.targetId,
    attributes: event.attributes,
  };

  postAudit(url, body, event.kind);
}

/** Internal: shared POST-with-timeout used by every emit helper. */
function postAudit(url: string, body: unknown, label: string): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);

  // The `recordAuditEvent` function requires `x-internal-secret` (Wave 1A, see
  // functions/src/lib/requireInternalSecret.ts). Without it the function 401s, fetch still
  // resolves, and .catch() never fires — audit events would vanish silently. Hence the
  // header here AND the response.ok check below.
  const internalSecret = hootInternalSecret();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (internalSecret) {
    headers['x-internal-secret'] = internalSecret;
  }

  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then((response) => {
      // Audit failures must NOT propagate, but log loudly: a silent audit gap breaks
      // compliance + forensics.
      if (!response.ok) {
        console.warn(
          `[auditLogClient] ${label} emit returned ${response.status} — audit event was DROPPED. ` +
            (internalSecret
              ? 'Check x-internal-secret matches the cloud function env.'
              : `${HOOT_INTERNAL_SECRET_ENV} is not set in this web env.`),
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[auditLogClient] ${label} emit failed: ${(err as Error).message}`,
      );
    })
    .finally(() => {
      clearTimeout(timeout);
    });
}
