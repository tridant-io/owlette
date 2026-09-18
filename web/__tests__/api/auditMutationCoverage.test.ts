/**
 * @jest-environment node
 *
 * Audit-mutation coverage gate: every mutating `app/api/**` route must produce
 * an audit entry. Static source scan (pure `fs` reads — no imports, no
 * execution) over every `route.ts` exporting POST/PUT/PATCH/DELETE.
 *
 * Audited = the route's own source, or a module it imports one level out from
 * `lib/actions/`, `lib/talons/` or a co-located `app/api/**` helper, calls
 * `authorizedSiteHandler`, `authorizedPlatformHandler`, or `emitMutation`.
 *
 * Granularity is the FILE, not the method — those markers are file-level, so a
 * file mixing an audited POST with an unaudited DELETE is indistinguishable
 * statically. Hence the hand-curated lists below.
 *
 * Fails on an unclassified mutating route (a regression) and on a stale list
 * entry (gone / no longer mutating / now audited). Both lists may only shrink.
 */

import fs from 'fs';
import path from 'path';

const WEB_ROOT = path.resolve(__dirname, '..', '..');
const API_ROOT = path.join(WEB_ROOT, 'app', 'api');

/**
 * Mutating routes that legitimately emit no detected audit — no privileged
 * actor / no persisted state change, or audited by another mechanism. Route
 * directories relative to `app/api/`, alphabetized, each justified.
 */
export const EXEMPT_ROUTES: readonly string[] = [
  // agent-originated alert telemetry (agent bearer token); sends email/webhook, no operator mutation.
  'agent/alert',
  // pairing-phrase issuance for a not-yet-authenticated agent — bootstrap step of the device-code flow.
  'agent/auth/device-code',
  // agent polls for its own pairing result; token-flow lease state, no operator actor.
  'agent/auth/device-code/poll',
  // registration-code -> token exchange; agent authentication itself, no operator actor.
  'agent/auth/exchange',
  // agent refresh-token rotation; authentication lifecycle, no operator actor.
  'agent/auth/refresh',
  // agent screenshot ingest (agent bearer token); telemetry upload, not an operator mutation.
  'agent/screenshot',
  // agent fetches its own session bundle (agent bearer token); mints short-lived credentials, persists nothing.
  'agent/swoop/bundle',
  // agent mints its own doorbell token (agent bearer token); token issuance, no operator actor.
  'agent/swoop/doorbell-token',
  // swoop host lifecycle/denial reports: writes its own blocking `sites/{siteId}/audit_log` rows inline
  // as the `swoop_host` system actor (see the route header), which the marker scan cannot see.
  'agent/swoop/events',
  // internal-secret endpoint called by the alert cloud function; sends notifications only.
  'alerts/trigger',
  // public unauthenticated password-reset email send; no actor to attribute, enumeration-safe by design.
  'auth/forgot-password',
  // session create/destroy (sign-in / sign-out); the authentication act, not a resource mutation.
  'auth/session',
  // user-submitted bug/feature intake into `bug_reports`; touches no fleet, account, or security state.
  'bug-report',
  // read-only upload negotiation — returns which chunk hashes are missing, writes nothing.
  'chunks/check',
  // read-only: mints short-lived presigned GET urls, writes nothing.
  'chunks/download-urls',
  // e2e-only chunk sink standing in for an R2 presigned PUT — hard 404 unless
  // OWLETTE_E2E=1, so it does not exist in any real deployment.
  'chunks/e2e-put',
  // mints presigned PUT urls into the immutable content-addressed store; the roost publish that references them is audited.
  'chunks/upload-urls',
  // CLI pairing-phrase issuance, unauthenticated bootstrap step of the device-code flow.
  'cli/device-code',
  // CLI polls for its own pairing result; token-flow state, no operator actor.
  'cli/device-code/poll',
  // internal-secret endpoint (CORTEX_INTERNAL_SECRET) invoked by the alert path; no user actor.
  'hoot/autonomous',
  // internal-secret + cron-secret escalation notifier; no user actor.
  'hoot/escalation',
  // public DMCA § 512(c)(3) notice intake; touches no fleet, account, or security state.
  'legal/dmca',
  // login-time TOTP / backup-code verification (+ optional device-trust cookie); the sign-in ceremony.
  'mfa/verify-login',
  // WebAuthn login ceremony: ephemeral challenge issuance, no credential state.
  'passkeys/authenticate/options',
  // WebAuthn login ceremony: verifies an assertion and starts a session; sign-in, not a mutation.
  'passkeys/authenticate/verify',
  // WebAuthn registration ceremony: ephemeral challenge issuance; the credential is persisted by register/verify.
  'passkeys/register/options',
  // WebAuthn step-up ceremony on /verify-2fa: ephemeral challenge issuance, no credential state.
  'passkeys/step-up/options',
  // WebAuthn step-up on /verify-2fa: same class as `mfa/verify-login`. Mints no session or custom
  // token; persists only the credential's clone-detection counter.
  'passkeys/step-up/verify',
  // read-only: re-mints a short-lived signed GET url for an already-published version body.
  'roosts/[roostId]/version-url',
  // read-only: lists the provider's available models for a supplied/stored key, writes nothing.
  'settings/llm-models',
  // agent-side screenshot pipeline (machine scope): publishes the uploaded object and records the capture.
  'sites/[siteId]/machines/[machineId]/screenshots/finalize',
  // agent-side screenshot pipeline (machine scope): mints a signed PUT url, writes nothing.
  'sites/[siteId]/machines/[machineId]/screenshots/upload-url',
  // internal-secret ingress from onTalonLogEventCreated; runs already-authored talons, which audit
  // their own disables. No operator actor.
  'talons/internal/match',
  // superadmin template preview send; email only, no persisted state.
  'test-email',
  // self-delete cascade: writes its own blocking `global/audit_log` row inline (see the route header).
  'users/me',
  // stateless signature probe against a caller-supplied url; creates or modifies no subscription.
  'webhooks/probe',
  // test delivery to an existing subscription; only stamps `lastTriggered`, no configuration change.
  'webhooks/test',
  // signup notification email to the admin address; reads the caller's own user doc, writes nothing.
  'webhooks/user-created',
];

/**
 * Mutating routes not audited today, pending remediation. Alphabetized, each
 * naming the unrecorded mutation. May only shrink — once a route is audited its
 * entry must go, and this test fails until it does.
 *
 * Empty since talons wave 5.4 drained the last ten. Keep it that way: a new
 * mutating route audits before it ships, rather than parking an entry here.
 */
export const KNOWN_GAPS: readonly string[] = [];

const MUTATING_METHODS = ['DELETE', 'PATCH', 'POST', 'PUT'] as const;

/** Call-site patterns that constitute "this route is audited". */
const AUDIT_MARKERS: readonly RegExp[] = [
  /\bauthorizedSiteHandler\s*(?:<[^>]*>)?\s*\(/,
  /\bauthorizedPlatformHandler\s*(?:<[^>]*>)?\s*\(/,
  /\bemitMutation\s*\(/,
];

/**
 * Followed one level out from a route file. `app/api` is in the list for
 * co-located helpers — the process-control verbs delegate their whole handler,
 * audit included, to a sibling `_helpers.ts`.
 *
 * Deliberately NOT all of `lib/`: `lib/auditLogClient.ts` *defines*
 * `emitMutation`, so following every `@/lib/...` import would mark any route
 * that merely imports `emitApiKeyUsed` as audited.
 */
const AUDITABLE_MODULE_DIRS = [
  API_ROOT,
  path.join(WEB_ROOT, 'lib', 'actions'),
  path.join(WEB_ROOT, 'lib', 'talons'),
];

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `__`-prefixed dirs are transient fixtures: authorizedHandler.eslint.test.ts
    // materializes app/api/__eslint_fixture_*/route.ts mid-run, so scanning them
    // races the parallel suite.
    if (entry.name.startsWith('__')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRouteFiles(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/** Drop comments — several `lib/*.server.ts` headers mention `authorizedSiteHandler` in prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const sourceCache = new Map<string, string>();

function readStripped(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const stripped = stripComments(fs.readFileSync(file, 'utf8'));
  sourceCache.set(file, stripped);
  return stripped;
}

function exportedMutatingMethods(source: string): string[] {
  return MUTATING_METHODS.filter(
    (method) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source) ||
      new RegExp(`export\\s+(?:const|let|var)\\s+${method}\\b`).test(source),
  );
}

function hasAuditMarker(source: string): boolean {
  return AUDIT_MARKERS.some((marker) => marker.test(source));
}

/** Every module specifier a file imports (static + dynamic). */
function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

/** Resolve one level of `@/…`/relative imports landing inside an auditable dir. */
function resolveAuditableImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(WEB_ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;

  const inAuditableDir = AUDITABLE_MODULE_DIRS.some(
    (dir) => base === dir || base.startsWith(dir + path.sep),
  );
  if (!inAuditableDir) return null;

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ScannedRoute {
  /** Route directory relative to `app/api/`, e.g. `sites/[siteId]/alerts`. */
  id: string;
  methods: string[];
  audited: boolean;
}

function scanRoutes(): ScannedRoute[] {
  return walkRouteFiles(API_ROOT)
    .map((file) => {
      const source = readStripped(file);
      const id = path.relative(API_ROOT, path.dirname(file)).split(path.sep).join('/');

      const audited =
        hasAuditMarker(source) ||
        moduleSpecifiers(source).some((specifier) => {
          const resolved = resolveAuditableImport(file, specifier);
          return resolved !== null && hasAuditMarker(readStripped(resolved));
        });

      return { id, methods: exportedMutatingMethods(source), audited };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const routes = scanRoutes();
const mutatingRoutes = routes.filter((route) => route.methods.length > 0);
const byId = new Map(routes.map((route) => [route.id, route]));

function staleEntries(list: readonly string[]): string[] {
  return list.filter((id) => {
    const route = byId.get(id);
    if (!route) return true; // route deleted or renamed
    if (route.methods.length === 0) return true; // no longer mutating
    return route.audited; // remediated — entry must go
  });
}

describe('audit coverage of mutating api routes', () => {
  it('scans the whole api tree', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(mutatingRoutes.length).toBeGreaterThan(50);
  });

  it('every mutating route is audited, exempt, or a declared known gap', () => {
    const unclassified = mutatingRoutes
      .filter(
        (route) =>
          !route.audited &&
          !EXEMPT_ROUTES.includes(route.id) &&
          !KNOWN_GAPS.includes(route.id),
      )
      .map((route) => `${route.id} [${route.methods.join(',')}]`);

    expect(unclassified).toEqual([]);
  });

  it('has no stale KNOWN_GAPS entries', () => {
    expect(staleEntries(KNOWN_GAPS)).toEqual([]);
  });

  it('has no stale EXEMPT_ROUTES entries', () => {
    expect(staleEntries(EXEMPT_ROUTES)).toEqual([]);
  });

  it('keeps both lists alphabetized, deduplicated, and disjoint', () => {
    expect(EXEMPT_ROUTES).toEqual([...EXEMPT_ROUTES].sort());
    expect(KNOWN_GAPS).toEqual([...KNOWN_GAPS].sort());
    expect([...new Set(EXEMPT_ROUTES)]).toEqual([...EXEMPT_ROUTES]);
    expect([...new Set(KNOWN_GAPS)]).toEqual([...KNOWN_GAPS]);
    expect(EXEMPT_ROUTES.filter((id) => KNOWN_GAPS.includes(id))).toEqual([]);
  });
});
