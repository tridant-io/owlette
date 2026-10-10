#!/usr/bin/env npx tsx
/**
 * Validate the OpenAPI spec against the real route files: every documented path must map to
 * a route, and undocumented public routes are flagged.
 * Usage: npx tsx scripts/validate-openapi.ts
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import yaml from 'js-yaml';
import {
  getOpenApiOperations,
  operationHasAuthScopeNote,
  operationHasExplicitSecurity,
  operationHasReferenceExample,
  renderOpenApiReference,
} from '../lib/openapiReference';

const ROOT = join(__dirname, '..');
const SPEC_PATH = join(ROOT, 'openapi.yaml');
const API_DIR = join(ROOT, 'app', 'api');

// Routes that are intentionally not documented (internal only)
const INTERNAL_ROUTES = new Set([
  '/api/auth/session',
  '/api/auth/app-link',
  '/api/auth/app-link/start',
  '/api/auth/app-link/approve',
  '/api/auth/app-link/exchange',
  '/api/mfa/setup',
  '/api/mfa/verify-setup',
  '/api/mfa/verify-login',
  '/api/passkeys/register/options',
  '/api/passkeys/register/verify',
  '/api/passkeys/authenticate/options',
  '/api/passkeys/authenticate/verify',
  '/api/passkeys/list',
  '/api/passkeys/{credentialId}',
  '/api/agent/auth/exchange',
  '/api/agent/auth/refresh',
  '/api/agent/auth/device-code',
  '/api/agent/auth/device-code/authorize',
  '/api/agent/auth/device-code/poll',
  '/api/agent/alert',
  '/api/agent/screenshot',
  '/api/agent/generate-installer',
  '/api/alerts/trigger',
  '/api/bug-report',
  // hoot internals. The `/api/cortex/*` twins are back-compat re-export aliases from the
  // hoot rename, undocumented for the same reason as their canonical paths.
  '/api/hoot',
  '/api/hoot/autonomous',
  '/api/hoot/cancel-tool',
  '/api/hoot/categorize',
  '/api/hoot/escalation',
  '/api/hoot/provision-key',
  '/api/hoot/stop',
  '/api/cortex',
  '/api/cortex/autonomous',
  '/api/cortex/cancel-tool',
  '/api/cortex/categorize',
  '/api/cortex/escalation',
  '/api/cortex/provision-key',
  '/api/cortex/stop',
  // Site-admin-only hoot policy toggle (session surface, no api-key scope) + alias.
  '/api/sites/{siteId}/hoot-settings',
  '/api/sites/{siteId}/cortex-settings',
  '/api/cron/display-alerts',
  '/api/cron/status-ping',
  '/api/settings/llm-key',
  '/api/settings/llm-models',
  '/api/cron/health-check',
  '/api/cron/process-alerts',
  // Internal-secret ingress for `onTalonLogEventCreated`; same posture as
  // /api/alerts/trigger and /api/hoot/autonomous.
  '/api/talons/internal/match',
  // E2E-only chunk PUT sink (hard 404 unless OWLETTE_E2E=1) — the local stand-in
  // for the R2 presigned URL, never reachable in production.
  '/api/chunks/e2e-put',
  '/api/legal/dmca',
  '/api/setup/generate-token',
  '/api/test-email',
  '/api/unsubscribe',
  '/api/webhooks/test',
  '/api/webhooks/user-created',
  '/api/openapi',
]);

function loadSpec(): Record<string, unknown> {
  if (!existsSync(SPEC_PATH)) {
    console.error('ERROR: openapi.yaml not found at', SPEC_PATH);
    process.exit(1);
  }
  return yaml.load(readFileSync(SPEC_PATH, 'utf-8')) as Record<string, unknown>;
}

/** /api/sites/{siteId}/x/{y} → app/api/sites/[siteId]/x/[y]/route.ts */
function specPathToRoutePath(specPath: string): string {
  const segments = specPath
    .replace(/^\/api\//, 'app/api/')
    .split('/')
    .map((seg) => (seg.startsWith('{') && seg.endsWith('}') ? `[${seg.slice(1, -1)}]` : seg));
  return join(ROOT, ...segments, 'route.ts');
}

/** All route.ts files under app/api/, as API paths. */
function discoverRoutes(): string[] {
  return findRouteFiles(API_DIR)
    .map((filePath) => {
      const rel = relative(ROOT, filePath)
        .replace(/\\/g, '/')
        .replace(/^app\//, '/')
        .replace(/\/route\.ts$/, '')
        .replace(/\[([^\]]+)\]/g, '{$1}');
      return rel;
    });
}

function findRouteFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findRouteFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === 'route.ts') {
      files.push(fullPath);
    }
  }

  return files;
}

/** Roost prefixes: any route file under these MUST be documented in openapi.yaml. */
function isRoostRoute(routePath: string): boolean {
  return (
    routePath.startsWith('/api/chunks/') ||
    routePath.startsWith('/api/roosts/')
  );
}

/**
 * `x-stub: true` marks a path as documentation-first — its route file is expected NOT to
 * exist yet. One stubbed method stubs the whole path: Next collapses every method into one
 * `route.ts`, so mixed live/stub methods can't be represented.
 */
function pathIsStub(pathItem: unknown): boolean {
  if (!pathItem || typeof pathItem !== 'object') return false;
  const obj = pathItem as Record<string, unknown>;
  if (obj['x-stub'] === true) return true;
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
    const op = obj[method];
    if (op && typeof op === 'object' && (op as Record<string, unknown>)['x-stub'] === true) {
      return true;
    }
  }
  return false;
}

function routeFileExportsMethod(routeFile: string, method: string): boolean {
  const source = readFileSync(routeFile, 'utf-8');
  const upperMethod = method.toUpperCase();
  return new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${upperMethod}\\b|export\\s+const\\s+${upperMethod}\\b|export\\s*\\{[^}]*\\b${upperMethod}\\b[^}]*\\}`,
  ).test(source);
}

function main() {
  const spec = loadSpec();
  const paths = (spec.paths || {}) as Record<string, unknown>;
  const specPaths = Object.keys(paths);
  const routePaths = discoverRoutes();
  const renderedSpec = renderOpenApiReference(spec);
  const renderedOperations = getOpenApiOperations(renderedSpec);

  let errors = 0;
  let warnings = 0;
  let stubs = 0;

  console.log(`\nValidating ${specPaths.length} documented paths against ${routePaths.length} route files...\n`);

  // 1: documented path ⇒ route file, unless `x-stub: true`.
  for (const specPath of specPaths) {
    const routeFile = specPathToRoutePath(specPath);
    if (!existsSync(routeFile)) {
      if (pathIsStub(paths[specPath])) {
        stubs++;
        continue;
      }
      console.error(`ERROR: Documented path ${specPath} has no route file`);
      console.error(`       Expected: ${relative(ROOT, routeFile)}`);
      errors++;
    }
  }

  // 2: undocumented public routes warn, except roost (/api/chunks/*, /api/roosts/*) where
  // missing docs are an error — the roost contract is the point of the spec, so silent
  // drift must break CI.
  const specPathSet = new Set(specPaths);
  for (const routePath of routePaths) {
    if (specPathSet.has(routePath) || INTERNAL_ROUTES.has(routePath)) {
      continue;
    }
    if (isRoostRoute(routePath)) {
      console.error(
        `ERROR: Roost route ${routePath} is not documented in openapi.yaml`,
      );
      errors++;
    } else {
      console.warn(`WARN: Route ${routePath} exists but is not documented`);
      warnings++;
    }
  }

  // 3: documented methods must exist on the route module — Next collapses methods into one
  // file, so path presence alone hides a stale documented method.
  for (const { path, method } of getOpenApiOperations(spec)) {
    const pathItem = paths[path];
    const routeFile = specPathToRoutePath(path);
    if (!existsSync(routeFile) || pathIsStub(pathItem)) continue;
    if (!routeFileExportsMethod(routeFile, method)) {
      console.error(`ERROR: ${method.toUpperCase()} ${path} is documented but not exported by ${relative(ROOT, routeFile)}`);
      errors++;
    }
  }

  // 4: operations declare auth explicitly — Scalar renders operation-level security most
  // clearly, so don't lean on the global fallback.
  for (const { path, method, operation } of getOpenApiOperations(spec)) {
    if (!operationHasExplicitSecurity(operation)) {
      console.error(`ERROR: ${method.toUpperCase()} ${path} is missing operation-level security`);
      errors++;
    }
  }

  // 5: validate what /api/openapi actually serves — the renderer adds examples and
  // auth/scope notes, and this stops the interactive docs decaying to a shape-only shell.
  for (const { path, method, operation } of renderedOperations) {
    if (!operationHasReferenceExample(operation)) {
      console.error(`ERROR: ${method.toUpperCase()} ${path} is missing rendered examples`);
      errors++;
    }
    if (!operationHasAuthScopeNote(operation)) {
      console.error(`ERROR: ${method.toUpperCase()} ${path} is missing rendered auth/scope notes`);
      errors++;
    }
  }

  console.log('');
  if (errors === 0 && warnings === 0 && stubs === 0) {
    console.log('All documented paths match route files. No undocumented public routes found.');
    console.log(`Rendered API reference includes examples and auth/scope notes for ${renderedOperations.length} operations.`);
  } else {
    if (errors > 0) console.error(`${errors} error(s) - OpenAPI route, auth, example, or scope validation`);
    if (warnings > 0) console.warn(`${warnings} warning(s) — undocumented routes`);
    if (stubs > 0) console.log(`${stubs} stub(s) — docs-first paths awaiting implementation (x-stub: true)`);
  }

  process.exit(errors > 0 ? 1 : 0);
}

main();
