#!/usr/bin/env node
/**
 * upload-cortex-cli — publish the Claude Code CLI that Cortex downloads on demand.
 *
 * Since 3.0.0 the installer strips `claude_agent_sdk/_bundled/claude.exe`
 * (241.5 MB) from the build tree; `agent/src/cortex_cli_fetch.py` fetches it on
 * first Cortex enable, pinned by sha256 through one Firestore document per
 * platform:
 *
 *   installer_metadata/cortex_cli_<osFamily>_<arch>
 *     { version, downloadUrl, sha256, size, storagePath, md5Base64, uploadedAt }
 *
 * This script is what writes those documents — one run per environment publishes
 * every platform you hand it, and the Windows build additionally rewrites the
 * unsuffixed `installer_metadata/cortex_cli` that every pre-3.4 agent reads.
 * Run it whenever the pinned CLI changes — i.e. whenever `claude-agent-sdk` is
 * upgraded and ships a different `_cli_version.py`.
 * See docs/internal/cortex-cli-provisioning.md.
 *
 * Not POST /api/installer/upload: that route hardcodes the agent-installer path
 * and metadata doc, so pushing claude.exe through it would publish a bogus
 * agent-installer whose bytes are the Claude CLI, served by public /download.
 * Same three-step mechanism (signed URL -> verify -> metadata write) against a
 * dedicated `cortex-cli/` prefix instead.
 *
 * Usage:
 *   node scripts/upload-cortex-cli.mjs --env=dev --windows-x64=<path to claude.exe> [--dry-run]
 *   node scripts/upload-cortex-cli.mjs --env=prod --windows-x64=<claude.exe> \
 *     --macos-universal=<claude> --linux-x64=<claude> --linux-arm64=<claude> --yes
 *
 * Options:
 *   --env=dev|prod           target project (required)
 *   --windows-x64=<path>     the CLI for that platform; pass one or more
 *   --macos-universal=<path>   universal2 only; `lipo -create` the two arch builds
 *   --linux-x64=<path>
 *   --linux-arm64=<path>
 *   --file=<path>            alias for --windows-x64
 *   --version=X.Y.Z          override the version; the default is parsed from
 *                            `<binary> -v` on whichever given file runs here
 *   --force                  re-upload even when the stored object matches
 *   --dry-run                show what would happen; touches nothing
 *   --yes                    skip the confirmation (required for --env=prod)
 *
 * Credentials (auto-loaded from web/.env.local, .claude/.env.local, scripts/.env.local):
 *   FIREBASE_PROJECT_ID_{DEV|PROD} / FIREBASE_CLIENT_EMAIL_{DEV|PROD} /
 *   FIREBASE_PRIVATE_KEY_{DEV|PROD}, falling back to the unsuffixed trio (which
 *   is what web/.env.local carries — verify where it points before using prod).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// firebase-admin lives in web/node_modules; resolved from there so this needs
// no root-level install.
const require = createRequire(join(ROOT, 'web', 'package.json'));
// Modular entry points, not the firebase-admin root namespace: since v14 the
// root exports only initializeApp/getApp/getApps/deleteApp/applicationDefault/
// cert/refreshToken, so the credential and storage accessors on it are both
// undefined and this script threw the moment it authenticated. It is the only
// documented remedy for a Cortex CLI fetch failure that is silent per machine
// (docs/runbooks/manual-infrastructure.md), so it being broken was doubly costly.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const STORAGE_PREFIX = 'cortex-cli';
const METADATA_COLLECTION = 'installer_metadata';
const METADATA_DOC_PREFIX = 'cortex_cli';
/**
 * Every id `agent/src/cortex_cli_fetch.get_metadata_doc_path()` can resolve to.
 * `object` is the storage name under `cortex-cli/<version>/`; windows_x64 keeps
 * the flat pre-3.4 name so already-published objects stay byte-identical.
 * `accepts` is what the file must actually be: three of the four binaries are
 * named `claude`, so without that check a transposed path publishes a pin whose
 * bytes verify on the agent and then cannot exec. macOS is one id for both
 * architectures (plan decision 12) while the SDK's wheels are per-arch, so its
 * payload has to be a `lipo -create` universal2 binary — a thin Mach-O is
 * rejected rather than published under `macos_universal` and left unrunnable on
 * half the Mac fleet.
 *
 * windows_x64 also rewrites the unsuffixed `installer_metadata/cortex_cli`:
 * that is the only id a pre-3.4 agent knows, so the fielded fleet keeps its pin
 * moving with the SDK. Drop `legacyDoc` once the fleet floor is 3.4.
 */
const PLATFORMS = [
  {
    id: 'windows_x64',
    flag: 'windows-x64',
    object: 'claude.exe',
    accepts: ['PE/x64'],
    nodePlatform: 'win32',
    nodeArch: 'x64',
    legacyDoc: true,
  },
  {
    id: 'macos_universal',
    flag: 'macos-universal',
    object: 'macos-universal/claude',
    accepts: ['Mach-O/universal'],
    nodePlatform: 'darwin',
    nodeArch: null,
  },
  {
    id: 'linux_x64',
    flag: 'linux-x64',
    object: 'linux-x64/claude',
    accepts: ['ELF/x64'],
    nodePlatform: 'linux',
    nodeArch: 'x64',
  },
  {
    id: 'linux_arm64',
    flag: 'linux-arm64',
    object: 'linux-arm64/claude',
    accepts: ['ELF/arm64'],
    nodePlatform: 'linux',
    nodeArch: 'arm64',
  },
];
const LEGACY_METADATA_DOC = 'cortex_cli';

// The fielded pre-3.4 fleet's pin moves only because one row still writes the
// legacy document, and nothing in CI reads this table. Dropping the flag on its
// own fails here instead of silently republishing four per-platform pins and
// leaving the whole fleet on the previous CLI.
const legacyRows = PLATFORMS.filter((p) => p.legacyDoc).map((p) => p.id);
if (legacyRows.join(',') !== 'windows_x64') {
  throw new Error(
    `PLATFORMS must carry exactly one legacyDoc row, windows_x64 (found: ${legacyRows.join(', ') || 'none'}). ` +
      `Every pre-3.4 agent reads only installer_metadata/${LEGACY_METADATA_DOC}; remove that row, and this ` +
      'guard with it, once the fleet floor is 3.4.',
  );
}
const UPLOAD_URL_TTL_MINUTES = 15;
/** Matches the installer flow's long-lived read URL. */
const DOWNLOAD_URL_EXPIRY = new Date('2030-01-01');
const CONTENT_TYPE = 'application/octet-stream';

const args = process.argv.slice(2);

function getFlag(name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

const env = getFlag('env');
const versionArg = getFlag('version');
const dryRun = getFlag('dry-run') === true;
const force = getFlag('force') === true;
const assumeYes = getFlag('yes') === true;

function usage(message) {
  console.error(`error: ${message}\n`);
  console.error('Usage: node scripts/upload-cortex-cli.mjs --env=dev|prod --<platform>=<cli binary>');
  console.error(`       platforms: ${PLATFORMS.map((p) => `--${p.flag}`).join(' ')}`);
  console.error('       [--version=X.Y.Z] [--force] [--dry-run] [--yes]');
  process.exit(1);
}

if (env !== 'dev' && env !== 'prod') usage('--env must be dev or prod');

/** Can this host execute that platform's binary? Decides version detection. */
function runsHere(platform) {
  return (
    platform.nodePlatform === process.platform &&
    (platform.nodeArch === null || platform.nodeArch === process.arch)
  );
}

/** The platforms this run publishes, in table order. */
const targets = PLATFORMS.flatMap((platform) => {
  // `--file` predates the per-platform flags and still means the Windows build.
  const arg = getFlag(platform.flag) ?? (platform.legacyDoc ? getFlag('file') : undefined);
  if (arg === undefined) return [];
  if (typeof arg !== 'string' || !arg) usage(`--${platform.flag} needs a path`);
  const path = resolve(arg);
  if (!existsSync(path)) usage(`file not found: ${path}`);
  return [{ platform, path }];
});

if (targets.length === 0) usage(`give at least one platform binary, e.g. --${PLATFORMS[0].flag}=<path>`);

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
    // Existing environment wins, so CI can override without editing files.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

const suffix = env.toUpperCase();
const projectId =
  process.env[`FIREBASE_PROJECT_ID_${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail =
  process.env[`FIREBASE_CLIENT_EMAIL_${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const privateKeyRaw =
  process.env[`FIREBASE_PRIVATE_KEY_${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !privateKeyRaw) {
  usage(
    `missing credentials for --env=${env}: set FIREBASE_PROJECT_ID_${suffix} / ` +
      `FIREBASE_CLIENT_EMAIL_${suffix} / FIREBASE_PRIVATE_KEY_${suffix}`,
  );
}

const bucketName =
  process.env[`FIREBASE_STORAGE_BUCKET_${suffix}`] ||
  (env === 'dev' ? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET : undefined) ||
  `${projectId}.firebasestorage.app`;

const MB = 1024 * 1024;

function formatMb(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
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

const PE_MACHINES = new Map([[0x8664, 'x64'], [0xaa64, 'arm64'], [0x14c, 'x86']]);
const ELF_MACHINES = new Map([[0x3e, 'x64'], [0xb7, 'arm64'], [0x03, 'x86']]);
const MACHO_CPU_TYPES = new Map([[0x01000007, 'x64'], [0x0100000c, 'arm64']]);
/** A fat header carries every slice, so its arch is `universal` by definition. */
const MACHO_FAT_MAGICS = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
/** magic -> is the rest of the header little-endian? */
const MACHO_THIN_MAGICS = new Map([
  [0xfeedface, false],
  [0xfeedfacf, false],
  [0xcefaedfe, true],
  [0xcffaedfe, true],
]);

/**
 * `<format>/<arch>` read from the file's own header, or null when it is not a
 * native binary at all. Header only — nothing past the first 4 KiB is read.
 */
function identifyBinary(path) {
  const head = Buffer.alloc(4096);
  const fd = openSync(path, 'r');
  let read = 0;
  try {
    read = readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  const buf = head.subarray(0, read);
  if (buf.length < 64) return null;

  if (buf.readUInt16LE(0) === 0x5a4d) {
    const peOffset = buf.readUInt32LE(0x3c);
    if (peOffset + 6 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) return null;
    return `PE/${PE_MACHINES.get(buf.readUInt16LE(peOffset + 4)) ?? 'unknown'}`;
  }

  if (buf.readUInt32BE(0) === 0x7f454c46) {
    const littleEndian = buf[5] === 1;
    const machine = littleEndian ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
    return `ELF/${ELF_MACHINES.get(machine) ?? 'unknown'}`;
  }

  const magic = buf.readUInt32BE(0);
  if (MACHO_FAT_MAGICS.has(magic)) return 'Mach-O/universal';
  if (MACHO_THIN_MAGICS.has(magic)) {
    const cpuType = MACHO_THIN_MAGICS.get(magic) ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
    return `Mach-O/${MACHO_CPU_TYPES.get(cpuType) ?? 'unknown'}`;
  }

  return null;
}

/** One pass over the file for both digests: sha256 pins it, md5 checks GCS. */
function hashFile(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      sha256.update(chunk);
      md5.update(chunk);
    });
    stream.on('error', rejectPromise);
    stream.on('end', () =>
      resolvePromise({
        sha256: sha256.digest('hex'),
        md5Base64: md5.digest('base64'),
      }),
    );
  });
}

function detectVersion() {
  if (typeof versionArg === 'string' && versionArg) return versionArg;

  // Only one of the binaries can run here — the rest are other platforms'.
  const local = targets.find(({ platform }) => runsHere(platform));
  if (!local) {
    usage(
      'no given binary runs on this host, so the version cannot be detected; ' +
        'pass --version=X.Y.Z explicitly',
    );
  }

  try {
    // `claude -v` prints e.g. "2.1.121 (Claude Code)".
    const out = execFileSync(local.path, ['-v'], { encoding: 'utf8', timeout: 30_000 });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
    usage(`could not parse a version from \`${local.path} -v\` output: ${out.trim()}`);
  } catch (err) {
    usage(
      `could not run \`${local.path} -v\` to detect the version (${err.message}); ` +
        'pass --version=X.Y.Z explicitly',
    );
  }
  return undefined;
}

async function confirm(question) {
  if (assumeYes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${question} `, r));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

/** Streamed PUT to the signed URL, with an explicit Content-Length. */
function uploadViaSignedUrl(signedUrl, path, size) {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(signedUrl);
    const req = httpsRequest(
      {
        protocol: url.protocol,
        host: url.host,
        path: `${url.pathname}${url.search}`,
        method: 'PUT',
        headers: {
          'Content-Type': CONTENT_TYPE,
          'Content-Length': String(size),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolvePromise();
          } else {
            rejectPromise(
              new Error(`signed upload failed: HTTP ${res.statusCode} ${body.slice(0, 400)}`),
            );
          }
        });
      },
    );

    req.on('error', rejectPromise);

    let sent = 0;
    let lastBucket = -1;
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      const bucket = Math.floor((sent / size) * 10) * 10;
      if (bucket > lastBucket) {
        lastBucket = bucket;
        process.stdout.write(`  uploading… ${bucket}% (${formatMb(sent)})\n`);
      }
    });
    stream.on('error', rejectPromise);
    stream.pipe(req);
  });
}

/** Prove the published URL actually serves bytes, without pulling 241 MB. */
function probeDownloadUrl(downloadUrl) {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(downloadUrl);
    const req = httpsRequest(
      {
        protocol: url.protocol,
        host: url.host,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
      },
      (res) => {
        res.resume();
        if (res.statusCode === 206 || res.statusCode === 200) {
          resolvePromise(res.statusCode);
        } else {
          rejectPromise(new Error(`download url probe returned HTTP ${res.statusCode}`));
        }
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

async function main() {
  const version = detectVersion();

  console.log('cortex cli provisioning');
  console.log(`  env          ${env}`);
  console.log(`  project      ${projectId}`);
  console.log(`  bucket       ${bucketName}`);
  console.log(`  version      ${version}`);

  for (const target of targets) {
    target.size = statSync(target.path).size;
    target.storagePath = `${STORAGE_PREFIX}/${version}/${target.platform.object}`;
    target.doc = `${METADATA_DOC_PREFIX}_${target.platform.id}`;

    console.log(`\n  ${target.platform.id}`);
    const identity = identifyBinary(target.path);

    console.log(`    file         ${target.path}`);
    console.log(`    binary       ${identity ?? 'not a native binary'}`);
    console.log(`    size         ${formatMb(target.size)} (${target.size} bytes)`);
    console.log(`    storagePath  ${target.storagePath}`);
    console.log(`    metadata     ${METADATA_COLLECTION}/${target.doc}`);
    if (target.platform.legacyDoc) {
      console.log(`    metadata     ${METADATA_COLLECTION}/${LEGACY_METADATA_DOC} (pre-3.4 agents)`);
    }

    if (!target.platform.accepts.includes(identity)) {
      throw new Error(
        `${target.platform.id}: ${target.path} is ${identity ?? 'not a native binary'}, not ` +
          `${target.platform.accepts.join(' or ')} — check the --${target.platform.flag} path`,
      );
    }

    process.stdout.write('    hashing…\n');
    const { sha256, md5Base64 } = await hashFile(target.path);
    target.sha256 = sha256;
    target.md5Base64 = md5Base64;
    console.log(`    sha256       ${sha256}`);
  }

  if (dryRun) {
    console.log('\ndry run — nothing uploaded, nothing written.');
    return;
  }

  if (env === 'prod') {
    const ok = await confirm(
      `\nthis publishes ${targets.length} cortex CLI pin(s) to PRODUCTION (${projectId}). ` +
        'type "yes" to continue:',
    );
    if (!ok) {
      console.log('aborted.');
      process.exit(1);
    }
  }

  const app = initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
    }),
    storageBucket: bucketName,
  });

  const bucket = getStorage(app).bucket();
  const firestore = getFirestore(app);

  for (const target of targets) {
    console.log(`\n${target.platform.id}`);
    const file = bucket.file(target.storagePath);

    // step 1: does the object already match? (idempotent re-runs)
    let uploaded = false;
    const [exists] = await file.exists();
    if (exists && !force) {
      const [meta] = await file.getMetadata();
      if (String(meta.size) === String(target.size) && meta.md5Hash === target.md5Base64) {
        console.log('  object already present and byte-identical — skipping upload');
      } else {
        console.log(
          `  object present but differs (stored ${meta.size} bytes / md5 ${meta.md5Hash}) — re-uploading`,
        );
        await doUpload(file, target.path, target.size);
        uploaded = true;
      }
    } else {
      if (exists) console.log('  --force given — re-uploading over the existing object');
      await doUpload(file, target.path, target.size);
      uploaded = true;
    }

    // step 3: verify what actually landed
    const [storedMeta] = await file.getMetadata();
    if (String(storedMeta.size) !== String(target.size)) {
      throw new Error(
        `${target.platform.id}: size mismatch after upload: stored ${storedMeta.size}, local ${target.size}`,
      );
    }
    if (storedMeta.md5Hash !== target.md5Base64) {
      throw new Error(
        `${target.platform.id}: md5 mismatch after upload: stored ${storedMeta.md5Hash}, local ${target.md5Base64}`,
      );
    }
    console.log(`  verified     size + md5 match (${uploaded ? 'uploaded' : 'pre-existing'})`);

    const [downloadUrl] = await file.getSignedUrl({
      action: 'read',
      expires: DOWNLOAD_URL_EXPIRY,
    });
    const probeStatus = await probeDownloadUrl(downloadUrl);
    console.log(`  downloadUrl  ${redactUrl(downloadUrl)} (probe HTTP ${probeStatus})`);

    // metadata doc: the pin the agent reads
    const payload = {
      version,
      downloadUrl,
      sha256: target.sha256,
      size: target.size,
      storagePath: target.storagePath,
      md5Base64: target.md5Base64,
      uploadedAt: Date.now(),
      uploadedBy: 'scripts/upload-cortex-cli.mjs',
    };
    await firestore.collection(METADATA_COLLECTION).doc(target.doc).set(payload);
    console.log(`  wrote        ${METADATA_COLLECTION}/${target.doc}`);

    if (target.platform.legacyDoc) {
      await firestore.collection(METADATA_COLLECTION).doc(LEGACY_METADATA_DOC).set(payload);
      console.log(`  wrote        ${METADATA_COLLECTION}/${LEGACY_METADATA_DOC} (every pre-3.4 agent reads this id)`);
    }
  }

  console.log(
    '\nagents pick this up on the next Cortex start (cortex_cli_fetch.ensure_cli); ' +
      'machines whose cached sha256 already matches will not re-download.',
  );
}

async function doUpload(file, path, size) {
  const [uploadUrl] = await file.getSignedUrl({
    action: 'write',
    version: 'v4',
    expires: new Date(Date.now() + UPLOAD_URL_TTL_MINUTES * 60 * 1000),
    contentType: CONTENT_TYPE,
  });
  console.log(`  signed url   ${redactUrl(uploadUrl)} (${UPLOAD_URL_TTL_MINUTES} min)`);
  const started = Date.now();
  await uploadViaSignedUrl(uploadUrl, path, size);
  console.log(`  uploaded     ${formatMb(size)} in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((err) => {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
});
