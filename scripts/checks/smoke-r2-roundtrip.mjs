#!/usr/bin/env node
/**
 * R2 round-trip smoke against a deployed web service. Hashes 1 MiB of random
 * bytes and drives the public chunk pipeline: check (missing) -> upload-urls ->
 * PUT -> check (present). Exits non-zero on any step, printing the step and
 * http status to stderr.
 *
 * Run before promoting roost beyond the design-partner cohort.
 *
 * Usage:
 *   node scripts/checks/smoke-r2-roundtrip.mjs \
 *     --base-url https://dev.owlette.app --site <siteId> --api-key owk_<key>
 *
 * The api key must carry `site=<siteId>:write` scope.
 */

import { createHash, randomBytes } from 'node:crypto';
import { argv, exit, env } from 'node:process';

const ONE_MIB = 1024 * 1024;

function parseArgs() {
  const out = { baseUrl: '', siteId: '', apiKey: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const eat = () => argv[++i];
    if (a === '--base-url') out.baseUrl = eat();
    else if (a === '--site') out.siteId = eat();
    else if (a === '--api-key') out.apiKey = eat();
    else if (a === '--help' || a === '-h') {
      printUsage();
      exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      printUsage();
      exit(2);
    }
  }
  out.baseUrl ||= env.OWLETTE_BASE_URL ?? '';
  out.siteId ||= env.OWLETTE_SITE_ID ?? '';
  out.apiKey ||= env.OWLETTE_API_KEY ?? '';
  if (!out.baseUrl || !out.siteId || !out.apiKey) {
    console.error('missing required arg(s). need --base-url, --site, --api-key');
    printUsage();
    exit(2);
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

function printUsage() {
  console.error(`
usage:
  node scripts/checks/smoke-r2-roundtrip.mjs --base-url <url> --site <id> --api-key <key>

env fallbacks:
  OWLETTE_BASE_URL, OWLETTE_SITE_ID, OWLETTE_API_KEY

example:
  node scripts/checks/smoke-r2-roundtrip.mjs \\
    --base-url https://dev.owlette.app \\
    --site demo-site \\
    --api-key owk_test_xxxxxxxxxxxxxxxx
`);
}

async function step(label, fn) {
  process.stdout.write(`  ${label}... `);
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    console.log(`ok (${ms}ms)`);
    return result;
  } catch (err) {
    console.log('FAIL');
    console.error(`\n  step "${label}" failed: ${err.message ?? err}`);
    throw err;
  }
}

async function postJson(url, apiKey, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 400)}`);
  }
  return parsed;
}

async function main() {
  const { baseUrl, siteId, apiKey } = parseArgs();

  console.log(`r2 round-trip smoke`);
  console.log(`  base url:  ${baseUrl}`);
  console.log(`  site id:   ${siteId}`);
  // A fingerprint, not a prefix. The point of the line is to let the operator
  // confirm WHICH key they passed; the first 12 characters leak key bytes to
  // do it, and the house rule is not even partially.
  const keyFp = createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
  console.log(`  api key:   fp:${keyFp}`);
  console.log();

  // Random, so nothing on the server can collide: check #1 must say missing.
  const bytes = randomBytes(ONE_MIB);
  const hash = createHash('sha256').update(bytes).digest('hex');
  console.log(`  bytes:     ${ONE_MIB} (${(ONE_MIB / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`  sha256:    ${hash}`);
  console.log();

  await step('chunks/check (expect missing)', async () => {
    const r = await postJson(`${baseUrl}/api/chunks/check`, apiKey, {
      siteId,
      hashes: [hash],
    });
    if (!Array.isArray(r?.missing) || !r.missing.includes(hash)) {
      throw new Error(`expected hash in missing[]; got ${JSON.stringify(r)}`);
    }
  });

  const signed = await step('chunks/upload-urls (mint PUT)', async () => {
    const r = await postJson(`${baseUrl}/api/chunks/upload-urls`, apiKey, {
      siteId,
      hashes: [hash],
    });
    const url = r?.urls?.[hash];
    if (typeof url !== 'string' || !url.startsWith('http')) {
      throw new Error(`expected urls[hash] to be an http url; got ${JSON.stringify(r)}`);
    }
    return url;
  });

  await step('PUT 1 MiB to signed R2 url', async () => {
    const res = await fetch(signed, { method: 'PUT', body: bytes });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PUT failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  });

  await step('chunks/check (expect present)', async () => {
    const r = await postJson(`${baseUrl}/api/chunks/check`, apiKey, {
      siteId,
      hashes: [hash],
    });
    if (!Array.isArray(r?.missing)) {
      throw new Error(`malformed response: ${JSON.stringify(r)}`);
    }
    if (r.missing.includes(hash)) {
      throw new Error(`hash still reported missing after upload — r2 wiring broken or check is reading stale state`);
    }
  });

  console.log();
  console.log('  ✓ round-trip complete — r2 is wired end-to-end');
}

main().catch((err) => {
  console.error();
  console.error(`smoke FAILED: ${err.message ?? err}`);
  exit(1);
});
