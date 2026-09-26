#!/usr/bin/env node
/**
 * upload-installer — publish one release's installer files through the 3-step
 * API flow (signed URL -> bytes -> finalize), one file per platform, so a version
 * lands as one `installer_metadata/data/versions/{version}` doc whose `files`
 * map carries every platform and, with --set-latest, one `latest` pointer that
 * carries them all.
 *
 * Usage:
 *   node scripts/upload-installer.mjs --env dev|prod --version X.Y.Z [--notes "…"] [--set-latest] <file>…
 *
 *   <file>   Owlette-Installer-vX.Y.Z.exe | .pkg | .deb — the platform is the
 *            extension (windows_x64 / macos_arm64 / linux_x64), one file each.
 *   --set-latest   promotes the version once the LAST file has finalized, so the
 *                  latest pointer carries every entry rather than the first one.
 *
 * Credentials (auto-loaded from web/.env.local, .claude/.env.local, scripts/.env.local):
 *   dev:  OWLETTE_API_KEY       + OWLETTE_DEV_API_URL
 *   prod: OWLETTE_API_KEY_PROD  + OWLETTE_PROD_API_URL
 *
 * Idempotency keys are deterministic (installer-<step>-<version>-<platform>): a
 * re-run within 24h replays the first result for an unchanged body, and the API
 * refuses the key if the body changed — use a new version or wait it out.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM_BY_EXT = { '.exe': 'windows_x64', '.pkg': 'macos_arm64', '.deb': 'linux_x64' };
const EXTENSIONS = Object.keys(PLATFORM_BY_EXT).join(', ');

function usage(message) {
  console.error(`error: ${message}\n`);
  console.error(
    'Usage: node scripts/upload-installer.mjs --env dev|prod --version X.Y.Z [--notes "…"] [--set-latest] <file>…',
  );
  process.exit(1);
}

// --- arguments ----------------------------------------------------------------
const args = process.argv.slice(2);
const options = { env: undefined, version: undefined, notes: '', setLatest: false };
const paths = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (!arg.startsWith('--')) {
    paths.push(arg);
    continue;
  }
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
  const value = () => {
    if (eq !== -1) return arg.slice(eq + 1);
    i += 1;
    if (i >= args.length) usage(`--${name} needs a value`);
    return args[i];
  };
  if (name === 'env') options.env = value();
  else if (name === 'version') options.version = value();
  else if (name === 'notes') options.notes = value();
  else if (name === 'set-latest') options.setLatest = true;
  else usage(`unknown option --${name}`);
}

const { env, version, notes, setLatest } = options;
if (env !== 'dev' && env !== 'prod') usage('--env must be dev or prod');
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) usage('--version must be X.Y.Z');
if (paths.length === 0) usage(`give at least one installer file (${EXTENSIONS})`);

const targets = paths.map((given) => {
  const path = resolve(given);
  if (!existsSync(path)) usage(`file not found: ${path}`);
  const platform = PLATFORM_BY_EXT[extname(path).toLowerCase()];
  if (!platform) usage(`${basename(path)}: the extension must be one of ${EXTENSIONS}`);
  return { path, fileName: basename(path), platform, size: statSync(path).size };
});
for (const target of targets) {
  if (targets.some((other) => other !== target && other.platform === target.platform)) {
    usage(`two files map to ${target.platform}; give one file per platform`);
  }
}

// --- credentials ----------------------------------------------------------------
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // existing environment wins, so CI can override without editing files
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

const keyVar = env === 'prod' ? 'OWLETTE_API_KEY_PROD' : 'OWLETTE_API_KEY';
const urlVar = env === 'prod' ? 'OWLETTE_PROD_API_URL' : 'OWLETTE_DEV_API_URL';
const apiKey = process.env[keyVar];
const baseUrl = process.env[urlVar]?.replace(/\/+$/, '');
if (!apiKey) usage(`${keyVar} is not set (looked in .claude/.env.local)`);
if (!baseUrl) usage(`${urlVar} is not set (looked in .claude/.env.local)`);

// --- helpers --------------------------------------------------------------------
function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', rejectPromise)
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/** Strip the signature so nothing sensitive-looking lands in a terminal log. */
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<url>';
  }
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function api(method, route, { body, idempotencyKey } = {}) {
  const headers = { 'x-api-key': apiKey, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  // a 2xx with no body has been seen once on a cold route; the idempotency key
  // makes the retry replay the same result, so one more try is safe
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${route} -> ${response.status}\n${text}`);
    }
    if (text.length > 0) return JSON.parse(text);
    if (attempt > 0) throw new Error(`${method} ${route} -> ${response.status} with an empty body twice`);
    console.log(`  ${method} ${route} answered with an empty body; retrying once`);
  }
}

/** The bytes go straight from disk to the signed url: no owlette headers, no buffering. */
function putBytes(url, path, size) {
  const parsed = new URL(url);
  const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      parsed,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': size },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolvePromise();
          else rejectPromise(new Error(`PUT ${redactUrl(url)} -> ${res.statusCode}\n${text}`));
        });
      },
    );
    req.on('error', rejectPromise);
    createReadStream(path).on('error', rejectPromise).pipe(req);
  });
}

// --- the upload -------------------------------------------------------------------
async function uploadOne(target, promote) {
  const { path, fileName, platform, size } = target;
  const checksum = await sha256File(path);
  console.log(`${platform}  ${fileName}  ${formatMb(size)}  ${checksum}`);

  const intent = await api('POST', '/api/installer/upload', {
    idempotencyKey: `installer-upload-${version}-${platform}`,
    body: { version, fileName, platform, releaseNotes: notes, setAsLatest: promote },
  });
  console.log(`  uploading to ${redactUrl(intent.uploadUrl)}`);
  await putBytes(intent.uploadUrl, path, size);

  const finalized = await api('PUT', '/api/installer/upload', {
    idempotencyKey: `installer-finalize-${version}-${platform}`,
    body: { uploadId: intent.uploadId, checksum_sha256: checksum },
  });
  console.log(`  finalized${promote ? ' and promoted to latest' : ''}:`);
  console.log(JSON.stringify(finalized, null, 2));
}

let done = 0;
try {
  for (const [index, target] of targets.entries()) {
    await uploadOne(target, setLatest && index === targets.length - 1);
    done += 1;
  }
  const latest = await api('GET', '/api/installer/latest');
  const files = latest?.files && typeof latest.files === 'object' ? Object.keys(latest.files) : [];
  console.log(`latest: v${latest?.version ?? '?'}  files: ${files.join(', ') || '(none)'}`);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  const left = targets.slice(done).map((target) => target.fileName);
  if (left.length > 0) console.error(`not published: ${left.join(', ')}`);
  process.exit(1);
}
