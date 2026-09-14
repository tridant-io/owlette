#!/usr/bin/env node
/**
 * provision-r2 — create the four roost R2 buckets (wave 0.5). Idempotent; safe to re-run.
 * Reads CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_R2_API_TOKEN from `.claude/.env.local` or env.
 *
 * Does NOT mint the app's S3-compatible access keys — that's a one-time dashboard visit
 * after this script runs (see the hint printed on success).
 *
 * Usage:
 *   node scripts/provision-r2.mjs                # provision (default)
 *   node scripts/provision-r2.mjs --dry-run      # show what would happen
 *   node scripts/provision-r2.mjs --verify-only  # just check existing state
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_FILE = join(ROOT, '.claude', '.env.local');

const BUCKETS = [
  'owlette-prod-content',
  'owlette-prod-manifests',
  'owlette-dev-content',
  'owlette-dev-manifests',
];

/**
 * Content buckets take direct browser uploads (presigned PUT) so they need CORS.
 * Manifests only move server-side (`putManifestBody` in web/lib/r2Client.server.ts) and
 * agent-side, so manifest buckets stay CORS-less — fewer origins a rogue page can reach.
 */
const CORS_ENABLED_BUCKETS = [
  'owlette-prod-content',
  'owlette-dev-content',
];

// Next dev falls back to 3001, 3002… when the primary port is taken, so allow a small
// range — otherwise port-hopping shows up as a CORS preflight failure on roost uploads
// (which PUT to R2 straight from the browser). Re-run this script after adding a port.
const CORS_ALLOWED_ORIGINS = [
  ...[3000, 3001, 3002, 3003, 3100].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]),
  'https://dev.owlette.app',
  'https://owlette.app',
];

/** R2 jurisdiction — 'default' (automatic) / 'eu' / 'fedramp'. Start default. */
const JURISDICTION = 'default';

function loadEnv() {
  // existing env wins (CI can override without editing the file)
  const env = { ...process.env };
  if (!existsSync(ENV_FILE)) {
    throw new Error(`env file not found: ${ENV_FILE}`);
  }
  const text = readFileSync(ENV_FILE, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes if present
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = val;
  }
  return env;
}

class CfApi {
  constructor(accountId, token) {
    if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID missing');
    if (!token) throw new Error('CLOUDFLARE_R2_API_TOKEN missing');
    this.accountId = accountId;
    this.token = token;
  }

  async call(method, path, body) {
    const url = `https://api.cloudflare.com/client/v4${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  async verifyToken() {
    // First: is the token active? Account-owned tokens (the kind the R2 dashboard
    // issues) only verify against the account endpoint; user-owned tokens only
    // against /user/tokens/verify. Try the account one first, then fall back, so
    // either kind separates "bad token" from "R2 not enabled on account".
    let tokenCheck = await this.call('GET', `/accounts/${this.accountId}/tokens/verify`);
    if (tokenCheck.status !== 200 || !tokenCheck.json?.success) {
      tokenCheck = await this.call('GET', `/user/tokens/verify`);
    }
    if (tokenCheck.status !== 200 || !tokenCheck.json?.success) {
      return {
        ok: false,
        reason:
          tokenCheck.json?.errors?.[0]?.message ||
          `token invalid (HTTP ${tokenCheck.status})`,
        hint: 'create a fresh token with `Workers R2 Storage: Edit` scope.',
      };
    }
    // Second: can it reach R2? Distinguishes R2-disabled (10042) from missing-scope from
    // account-id mismatch.
    const r2Probe = await this.call(
      'GET',
      `/accounts/${this.accountId}/r2/buckets`,
    );
    if (r2Probe.status === 200 && r2Probe.json?.success) return { ok: true };
    const code = r2Probe.json?.errors?.[0]?.code;
    const msg = r2Probe.json?.errors?.[0]?.message || `HTTP ${r2Probe.status}`;
    let hint = 'check that the token scope is Workers R2 Storage: Edit on THIS account.';
    if (code === 10042 || /enable r2/i.test(msg)) {
      hint = 'Cloudflare dashboard → R2 Object Storage → accept terms to enable R2 on this account (free tier: 10 GB/mo). No script changes needed after.';
    }
    return { ok: false, reason: msg, hint };
  }

  async listBuckets() {
    const { status, json } = await this.call(
      'GET',
      `/accounts/${this.accountId}/r2/buckets`,
    );
    if (status !== 200 || !json?.success) {
      throw new Error(
        `list buckets failed: ${json?.errors?.[0]?.message || `HTTP ${status}`}`,
      );
    }
    return json.result?.buckets ?? [];
  }

  async createBucket(name) {
    const { status, json } = await this.call(
      'POST',
      `/accounts/${this.accountId}/r2/buckets`,
      { name, locationHint: JURISDICTION === 'default' ? undefined : undefined },
    );
    if (status === 200 && json?.success) return { created: true };
    // Duplicate name returns 400 with a specific code; treat as idempotent.
    const msg = json?.errors?.[0]?.message || '';
    if (/already exists/i.test(msg) || /10004/.test(JSON.stringify(json))) {
      return { created: false, existed: true };
    }
    throw new Error(`create ${name} failed: ${msg || `HTTP ${status}`}`);
  }

  /**
   * Apply CORS rules to a bucket. R2's CORS endpoint is a full-replace PUT — no merging,
   * so this function is the source of truth for which origins can reach the bucket.
   * Methods are scoped to what the browser needs (HEAD dedup probe, PUT upload, GET
   * download); ETag is exposed for a future multipart client.
   */
  async putBucketCors(bucketName) {
    const rules = {
      rules: [
        {
          allowed: {
            origins: CORS_ALLOWED_ORIGINS,
            methods: ['GET', 'PUT', 'HEAD'],
            headers: ['*'],
          },
          exposeHeaders: ['ETag'],
          maxAgeSeconds: 3600,
        },
      ],
    };
    const { status, json } = await this.call(
      'PUT',
      `/accounts/${this.accountId}/r2/buckets/${bucketName}/cors`,
      rules,
    );
    if (status === 200 && json?.success) return { ok: true };
    const msg = json?.errors?.[0]?.message || `HTTP ${status}`;
    return { ok: false, reason: msg };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verifyOnly = args.includes('--verify-only');

  const env = loadEnv();
  const api = new CfApi(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_R2_API_TOKEN,
  );

  console.log('→ verifying token + R2 access…');
  const check = await api.verifyToken();
  if (!check.ok) {
    console.error(`✗ ${check.reason}`);
    if (check.hint) console.error(`  → ${check.hint}`);
    process.exit(1);
  }
  console.log('  ✓ token active + R2 reachable');

  console.log('→ listing existing buckets…');
  const existing = new Set((await api.listBuckets()).map((b) => b.name));
  const have = BUCKETS.filter((b) => existing.has(b));
  const need = BUCKETS.filter((b) => !existing.has(b));
  console.log(`  ✓ already present: ${have.length}/${BUCKETS.length}`);
  if (have.length) console.log(`    ${have.join(', ')}`);
  if (need.length) console.log(`  ○ will create:      ${need.join(', ')}`);
  else console.log('  ✓ all roost buckets present');

  if (verifyOnly) {
    console.log('\n(verify-only; no changes made)');
    return;
  }

  if (dryRun) {
    console.log(
      `\n(dry-run; would create ${need.length} bucket(s) against jurisdiction=${JURISDICTION})`,
    );
    return;
  }

  if (need.length > 0) {
    console.log('→ creating missing buckets…');
    for (const name of need) {
      const result = await api.createBucket(name);
      console.log(
        `  ${result.created ? '✓ created' : '• already existed'}: ${name}`,
      );
    }
  }

  console.log(`→ applying CORS rules to content buckets (origins: ${CORS_ALLOWED_ORIGINS.length})…`);
  for (const name of CORS_ENABLED_BUCKETS) {
    const result = await api.putBucketCors(name);
    if (result.ok) {
      console.log(`  ✓ CORS applied: ${name}`);
    } else {
      console.error(`  ✗ CORS failed on ${name}: ${result.reason}`);
      process.exit(1);
    }
  }

  // Smoke-check: anonymous GET against the S3 endpoint shape should 401/403 — a 200 would
  // mean the bucket got public-ified.
  const probeBucket = BUCKETS[0];
  const probeUrl = `https://${api.accountId}.r2.cloudflarestorage.com/${probeBucket}/.probe-anonymous-access`;
  console.log('→ smoke-checking anonymous access is denied…');
  const probe = await fetch(probeUrl, { method: 'GET' });
  if (probe.status === 401 || probe.status === 403) {
    console.log(`  ✓ anonymous GET returned ${probe.status} (correct)`);
  } else if (probe.status === 404) {
    // 404 is fine too: bucket exists, object doesn't, default-deny still applied.
    console.log(
      `  ✓ anonymous GET returned 404 (bucket exists, default-private)`,
    );
  } else {
    console.warn(
      `  ⚠ anonymous GET returned ${probe.status} (expected 401/403/404) — verify bucket is private!`,
    );
  }

  console.log('\n─── next step: mint S3-compatible access keys ───');
  console.log('  the bucket provisioning is done. the app still needs');
  console.log('  S3-shaped credentials to sign upload/download URLs.');
  console.log('  these are NOT the same as the Cloudflare API token you just used.');
  console.log('');
  console.log('  dashboard → R2 → Manage R2 API Tokens → Create API Token');
  console.log('    Name:         owlette-app-r2');
  console.log('    Permissions:  Object Read & Write');
  console.log('    Specify bucket(s): include all four:');
  console.log('      owlette-prod-content, owlette-prod-manifests,');
  console.log('      owlette-dev-content,  owlette-dev-manifests');
  console.log('    TTL: start at 90 days, rotate on schedule');
  console.log('');
  console.log('  paste the resulting accessKeyId + secretAccessKey into');
  console.log('  .claude/.env.local as:');
  console.log('    R2_S3_ACCESS_KEY_ID=<access key>');
  console.log('    R2_S3_SECRET_ACCESS_KEY=<secret>');
  console.log(`    R2_S3_ENDPOINT=https://${api.accountId}.r2.cloudflarestorage.com`);
  console.log('');
}

main().catch((err) => {
  console.error('✗', err.message);
  process.exit(1);
});
