/**
 * `owlette roost push <dir> --to <roostId> --site <siteId>` — end-to-end publish:
 *   1. walk + chunk (sha-256, 4 MiB) — cli/src/lib/chunker.ts
 *   2. POST /api/chunks/check       { siteId, hashes } → { missing }
 *   3. POST /api/chunks/upload-urls { siteId, missing } → { urls }
 *   4. PUT each signed url (bounded parallelism)
 *   5. POST /api/roosts/{id}/versions; a 412 means the head moved — re-fetch and retry,
 *      since the server transaction compare-and-swaps `currentVersionId`.
 *
 * All chunk IO goes through the server-minted signed R2 URLs; the cli holds no R2 creds.
 */

import { createReadStream, promises as fs } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import { Command } from 'commander';
import { loadConfig } from '../config';
import {
  CHUNK_SIZE_BYTES,
  chunkDirectory,
  type ChunkedFileEntry,
} from '../lib/chunker';
import {
  buildVersion,
  summariseVersion,
  uniqueHashes,
  versionIdForVersion,
} from '../lib/versionBuilder';
import { fetchWithTimeout } from '../lib/http';
import { unconfirmedMutationFatal } from '../lib/output';

const UPLOAD_CONCURRENCY = 8;
const CHECK_BATCH_SIZE = 900; // server cap is 1000 — stay under.
const PUSH_MAX_RETRIES = 5;
const MAX_DESCRIPTION_LENGTH = 500;
const SIGNED_URL_REFRESH_SKEW_MS = 60_000;

export function registerPushCommand(program: Command): void {
  const roost = (program.commands.find((c) => c.name() === 'roost') as Command) ?? program.command('roost');

  roost
    .command('push <dir>')
    .description('chunk + upload + publish a directory as a new version')
    .requiredOption('--to <roostId>', 'target roost id')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .option('--name <name>', 'human-readable display name for the roost')
    .option(
      '-m, --description <text>',
      `commit-message-style summary for this version (≤${MAX_DESCRIPTION_LENGTH} chars)`,
    )
    .option(
      '--targets <machineIds>',
      'comma-separated list of target machine ids (overrides roost.targets)',
    )
    .option('--extract-path <path>', 'extract root override')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header for the publish request',
    )
    .action(async (dir: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token, profile } = loadConfig({ profile: globals.profile });
      if (!token) {
        process.stderr.write(
          'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
        );
        process.exitCode = 2;
        return;
      }

      const input: PushInputs = {
        apiUrl,
        token,
        profile,
        dir,
        roostId: opts.to,
        siteId: opts.site,
        json: globals.json === true,
      };
      if (opts.name) input.name = opts.name;
      if (opts.extractPath) input.extractPath = opts.extractPath;
      if (opts.targets) {
        input.targets = String(opts.targets)
          .split(',')
          .map((t: string) => t.trim())
          .filter(Boolean);
      }
      if (opts.description !== undefined) {
        const desc = String(opts.description);
        // Fail locally before a full chunk-upload cycle earns a server 400. The server
        // re-validates the same limit.
        if (desc.length > MAX_DESCRIPTION_LENGTH) {
          process.stderr.write(
            `owlette: --description is ${desc.length} chars; max is ${MAX_DESCRIPTION_LENGTH}.\n`,
          );
          process.exitCode = 2;
          return;
        }
        input.description = desc;
      }
      if (opts.idempotencyKey) {
        input.idempotencyKey = String(opts.idempotencyKey);
        input.idempotencyKeyWasProvided = true;
      } else {
        input.idempotencyKey = `cli-push-${randomUUID()}`;
        input.idempotencyKeyWasProvided = false;
      }
      await runPush(input);
    });
}

interface PushInputs {
  apiUrl: string;
  token: string;
  profile: string;
  dir: string;
  roostId: string;
  siteId: string;
  name?: string;
  targets?: string[];
  extractPath?: string;
  description?: string;
  idempotencyKey?: string;
  idempotencyKeyWasProvided?: boolean;
  json: boolean;
}

async function runPush(input: PushInputs): Promise<void> {
  const { apiUrl, token, dir, roostId, siteId, json } = input;

  const stat = await fs.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    process.stderr.write(`owlette: ${dir} is not a directory\n`);
    process.exitCode = 2;
    return;
  }

  log(json, `owlette: walking ${dir}…`);
  const files = await chunkDirectory(dir, {
    onProgress: (evt) => {
      if (json) return;
      if (evt.phase === 'discover') {
        process.stderr.write(
          `owlette: ${evt.fileCount} files, ${humanBytes(evt.totalBytes)} total\n`,
        );
      } else if (evt.phase === 'hash' && evt.file) {
        process.stderr.write(
          `  [${evt.filesDone}/${evt.filesTotal}] hashing ${evt.file}\n`,
        );
      }
    },
  });

  if (files.length === 0) {
    process.stderr.write('owlette: no non-empty files found — nothing to push\n');
    process.exitCode = 2;
    return;
  }

  const summary = summariseVersion(files);
  log(
    json,
    `owlette: ${summary.fileCount} files / ${summary.totalChunks} chunks ` +
      `(${summary.uniqueChunks} unique) / ${humanBytes(summary.totalBytes)}`,
  );

  const allHashes = uniqueHashes(files);

  log(json, 'owlette: querying server for missing chunks…');
  const missing = await checkMissing({ apiUrl, token, siteId, hashes: allHashes });
  log(
    json,
    `owlette: ${missing.length}/${allHashes.length} chunks need upload ` +
      `(${allHashes.length - missing.length} deduped)`,
  );

  if (missing.length > 0) {
    log(json, 'owlette: minting signed upload urls…');
    const uploadUrls = await mintUploadUrls({ apiUrl, token, siteId, hashes: missing });

    log(json, `owlette: uploading ${missing.length} chunks (${UPLOAD_CONCURRENCY}-wide)…`);
    await uploadChunksInParallel({
      missing,
      uploadUrls,
      apiUrl,
      token,
      siteId,
      dir,
      files,
      json,
    });
  }

  log(json, 'owlette: publishing version (with optimistic retry on 412)…');
  const version = buildVersion(files);

  const publishInput: PublishInput = {
    apiUrl,
    token,
    siteId,
    roostId,
    dir,
    version,
  };
  if (input.name) publishInput.name = input.name;
  if (input.targets) publishInput.targets = input.targets;
  if (input.extractPath) publishInput.extractPath = input.extractPath;
  if (input.description !== undefined) publishInput.description = input.description;
  if (input.idempotencyKey) publishInput.idempotencyKey = input.idempotencyKey;
  if (input.idempotencyKeyWasProvided !== undefined) {
    publishInput.idempotencyKeyWasProvided = input.idempotencyKeyWasProvided;
  }
  let result: PublishResult;
  try {
    result = await publishWithRetry(publishInput);
  } catch (err) {
    if (err instanceof HandledFatalError) return;
    fatal((err as Error).message);
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const numberLabel =
      typeof result.versionNumber === 'number' ? ` (#${result.versionNumber})` : '';
    process.stdout.write(
      `owlette: published ${result.versionId}${numberLabel}\n` +
        `       previous: ${result.previousVersionId ?? '(none)'}\n`,
    );
  }
}

async function apiPost<T>(
  apiUrl: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const res = await fetchWithTimeout(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data, headers: res.headers };
}

interface CheckMissingInput {
  apiUrl: string;
  token: string;
  siteId: string;
  hashes: readonly string[];
}

async function checkMissing(input: CheckMissingInput): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < input.hashes.length; i += CHECK_BATCH_SIZE) {
    const batch = input.hashes.slice(i, i + CHECK_BATCH_SIZE);
    const res = await apiPost<{ missing?: string[] }>(
      input.apiUrl,
      '/api/chunks/check',
      input.token,
      { siteId: input.siteId, hashes: batch },
    );
    if (res.status !== 200 || !Array.isArray(res.data.missing)) {
      throw new Error(
        `/api/chunks/check failed (${res.status}): ${JSON.stringify(res.data)}`,
      );
    }
    missing.push(...res.data.missing);
  }
  return missing;
}

interface MintUploadUrlsInput {
  apiUrl: string;
  token: string;
  siteId: string;
  hashes: readonly string[];
}

interface UploadUrlBatch {
  urls: Record<string, string>;
  expiresAtMs: number | null;
}

async function mintUploadUrls(input: MintUploadUrlsInput): Promise<UploadUrlBatch> {
  const all: Record<string, string> = {};
  let earliestExpiresAtMs: number | null = null;
  for (let i = 0; i < input.hashes.length; i += CHECK_BATCH_SIZE) {
    const batch = input.hashes.slice(i, i + CHECK_BATCH_SIZE);
    const res = await apiPost<{ urls?: Record<string, string>; expiresAt?: string }>(
      input.apiUrl,
      '/api/chunks/upload-urls',
      input.token,
      { siteId: input.siteId, hashes: batch },
    );
    if (res.status !== 200 || !res.data.urls) {
      throw new Error(
        `/api/chunks/upload-urls failed (${res.status}): ${JSON.stringify(res.data)}`,
      );
    }
    Object.assign(all, res.data.urls);
    if (typeof res.data.expiresAt === 'string') {
      const expiresAtMs = Date.parse(res.data.expiresAt);
      if (Number.isFinite(expiresAtMs)) {
        earliestExpiresAtMs =
          earliestExpiresAtMs === null
            ? expiresAtMs
            : Math.min(earliestExpiresAtMs, expiresAtMs);
      }
    }
  }
  return { urls: all, expiresAtMs: earliestExpiresAtMs };
}

interface UploadChunksInput {
  missing: readonly string[];
  uploadUrls: UploadUrlBatch;
  apiUrl: string;
  token: string;
  siteId: string;
  dir: string;
  files: readonly ChunkedFileEntry[];
  json: boolean;
}

async function uploadChunksInParallel(input: UploadChunksInput): Promise<void> {
  // hash → (filePath, chunkIndex), to locate source bytes at PUT time.
  interface Source {
    absPath: string;
    offset: number;
    size: number;
  }
  const sourceByHash = new Map<string, Source>();
  for (const f of input.files) {
    let offset = 0;
    for (const c of f.chunks) {
      if (!sourceByHash.has(c.hash)) {
        sourceByHash.set(c.hash, {
          absPath: join(input.dir, ...f.path.split('/')),
          offset,
          size: c.size,
        });
      }
      offset += c.size;
    }
  }

  let uploaded = 0;
  const total = input.missing.length;

  const queue = [...input.missing];
  async function refreshUrl(hash: string): Promise<string> {
    const refreshed = await mintUploadUrls({
      apiUrl: input.apiUrl,
      token: input.token,
      siteId: input.siteId,
      hashes: [hash],
    });
    Object.assign(input.uploadUrls.urls, refreshed.urls);
    input.uploadUrls.expiresAtMs = refreshed.expiresAtMs;
    const nextUrl = input.uploadUrls.urls[hash];
    if (!nextUrl) throw new Error(`server did not return a refreshed upload url for ${hash}`);
    return nextUrl;
  }

  async function worker(): Promise<void> {
    for (;;) {
      const hash = queue.shift();
      if (!hash) return;
      const source = sourceByHash.get(hash);
      let url = input.uploadUrls.urls[hash];
      if (!source || !url) {
        throw new Error(`internal: no source for chunk ${hash}`);
      }
      if (
        input.uploadUrls.expiresAtMs !== null &&
        Date.now() + SIGNED_URL_REFRESH_SKEW_MS >= input.uploadUrls.expiresAtMs
      ) {
        url = await refreshUrl(hash);
      }
      try {
        await putChunk(hash, source.absPath, source.offset, source.size, url);
      } catch (err) {
        if (err instanceof ChunkPutError && (err.status === 401 || err.status === 403)) {
          const refreshedUrl = await refreshUrl(hash);
          await putChunk(hash, source.absPath, source.offset, source.size, refreshedUrl);
        } else {
          throw err;
        }
      }
      uploaded += 1;
      if (!input.json && uploaded % 10 === 0) {
        process.stderr.write(`  uploaded ${uploaded}/${total}\n`);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(UPLOAD_CONCURRENCY, total); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (!input.json) {
    process.stderr.write(`  uploaded ${uploaded}/${total}\n`);
  }
}

class ChunkPutError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

async function putChunk(
  hash: string,
  absPath: string,
  offset: number,
  size: number,
  url: string,
): Promise<void> {
  // Buffer the byte range: R2's signed PUT is single-shot, no multipart.
  const stream = createReadStream(absPath, {
    start: offset,
    end: offset + size - 1,
  });
  const bufs: Buffer[] = [];
  for await (const chunk of stream) {
    bufs.push(chunk as Buffer);
  }
  const body = Buffer.concat(bufs);
  if (body.length !== size) {
    throw new Error(
      `chunk ${hash}: expected ${size} bytes, read ${body.length} from ${absPath}`,
    );
  }
  const actualHash = createHash('sha256').update(body).digest('hex');
  if (actualHash !== hash) {
    throw new Error(`chunk ${hash}: source bytes changed while reading ${absPath}`);
  }

  // One retry, for transient R2 5xx / connection resets.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new ChunkPutError(`PUT ${hash} → ${res.status} ${detail}`, res.status);
        if (res.status >= 500 && attempt === 0) throw err;
        throw err;
      }
      return;
    } catch (err) {
      lastErr = err as Error;
      const retryable =
        !(err instanceof ChunkPutError) || (err.status !== undefined && err.status >= 500);
      if (attempt === 0 && retryable) await new Promise((r) => setTimeout(r, 250));
      else break;
    }
  }
  throw lastErr ?? new Error(`PUT ${hash}: unknown error`);
}

interface PublishInput {
  apiUrl: string;
  token: string;
  siteId: string;
  roostId: string;
  dir?: string;
  version: ReturnType<typeof buildVersion>;
  name?: string;
  targets?: string[];
  extractPath?: string;
  description?: string;
  idempotencyKey?: string;
  idempotencyKeyWasProvided?: boolean;
}

interface PublishResult {
  versionId: string;
  versionNumber?: number;
  currentVersionId: string;
  previousVersionId: string | null;
}

class HandledFatalError extends Error {}

async function publishWithRetry(input: PublishInput): Promise<PublishResult> {
  const localVersionId = versionIdForVersion(input.version);
  let expectedCurrent = expectedHeadForPublish(
    await fetchRoostHead(input),
    localVersionId,
    input.idempotencyKey !== undefined && input.idempotencyKeyWasProvided !== false,
  );
  let lastStatus = 0;
  let lastBody: unknown = null;
  const baseIdempotencyKey = input.idempotencyKey ?? `cli-push-${randomUUID()}`;

  for (let attempt = 0; attempt < PUSH_MAX_RETRIES; attempt++) {
    const attemptIdempotencyKey =
      attempt === 0 ? baseIdempotencyKey : `${baseIdempotencyKey}-${attempt}`;
    const payload: Record<string, unknown> = {
      siteId: input.siteId,
      version: input.version,
    };
    if (expectedCurrent !== undefined) payload.expectedCurrentVersionId = expectedCurrent;
    if (input.name) payload.name = input.name;
    if (input.targets && input.targets.length > 0) payload.targets = input.targets;
    if (input.extractPath) payload.extractPath = input.extractPath;
    if (input.description !== undefined) payload.description = input.description;

    let res: {
      status: number;
      data: PublishResult & {
        code?: string;
        currentId?: string | null;
        detail?: string;
      };
      headers: Headers;
    };
    try {
      res = await apiPost<
        PublishResult & { code?: string; currentId?: string | null; detail?: string }
      >(
        input.apiUrl,
        `/api/roosts/${input.roostId}/versions`,
        input.token,
        payload,
        { 'Idempotency-Key': attemptIdempotencyKey },
      );
    } catch (err) {
      unconfirmedMutationFatal({
        operation: `POST /api/roosts/${input.roostId}/versions`,
        idempotencyKey: attemptIdempotencyKey,
        cause: err,
      });
      throw new HandledFatalError('unconfirmed publish failure handled');
    }

    if (res.status === 201 || res.status === 200) {
      const result: PublishResult = {
        versionId: res.data.versionId,
        currentVersionId: res.data.currentVersionId,
        previousVersionId: res.data.previousVersionId ?? null,
      };
      if (typeof res.data.versionNumber === 'number') {
        result.versionNumber = res.data.versionNumber;
      }
      return result;
    }

    lastStatus = res.status;
    lastBody = res.data;

    // 412 with a moved head: refresh and retry. Other 412s (missing chunks) are real failures.
    if (res.status === 412) {
      const problem = res.data as {
        code?: string;
        detail?: string;
        currentId?: string | null;
      };
      let nextExpected = currentHeadFromProblem(problem);
      if (problem.code !== 'version_stale' && nextExpected === undefined) {
        throw new Error(
          `version publish failed (${res.status}): ${JSON.stringify(res.data)}`,
        );
      }
      if (nextExpected === undefined) {
        nextExpected = (await fetchRoostHead(input))?.currentVersionId;
      }
      if (nextExpected === undefined) {
        throw new Error(
          'publish conflicted (stale head) and the current head could not be determined; re-run `owlette roost push`',
        );
      }
      expectedCurrent = nextExpected;
      continue;
    }

    break;
  }

  throw new Error(
    `version publish failed after ${PUSH_MAX_RETRIES} attempts (last ${lastStatus}): ${JSON.stringify(lastBody)}`,
  );
}

function currentHeadFromProblem(problem: {
  detail?: string;
  currentId?: string | null;
}): string | null | undefined {
  const matched = /current head \((?<cur>[^)]+)\)/.exec(problem.detail ?? '')?.groups
    ?.cur;
  if (matched !== undefined) return matched === 'null' ? null : matched;
  if (typeof problem.currentId === 'string') return problem.currentId;
  if (problem.currentId === null) return null;
  return undefined;
}

interface RoostHead {
  currentVersionId: string | null;
  previousVersionId: string | null;
}

function expectedHeadForPublish(
  head: RoostHead | undefined,
  localVersionId: string,
  explicitReplayKey: boolean,
): string | null | undefined {
  if (!head) return undefined;
  if (explicitReplayKey && head.currentVersionId === localVersionId) {
    return head.previousVersionId;
  }
  return head.currentVersionId;
}

async function fetchRoostHead(input: PublishInput): Promise<RoostHead | undefined> {
  try {
    const qs = new URLSearchParams({ siteId: input.siteId });
    const res = await fetchWithTimeout(
      `${input.apiUrl}/api/roosts/${encodeURIComponent(input.roostId)}?${qs}`,
      { headers: { Authorization: `Bearer ${input.token}` } },
    );
    if (res.status === 404) return { currentVersionId: null, previousVersionId: null };
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => ({}))) as {
      currentVersionId?: unknown;
      previousVersionId?: unknown;
    };
    let currentVersionId: string | null;
    if (typeof data.currentVersionId === 'string') currentVersionId = data.currentVersionId;
    else if (data.currentVersionId === null || data.currentVersionId === undefined) {
      currentVersionId = null;
    } else return undefined;

    const previousVersionId =
      typeof data.previousVersionId === 'string' ? data.previousVersionId : null;
    return { currentVersionId, previousVersionId };
  } catch {
    return undefined;
  }
}

function log(json: boolean, msg: string): void {
  if (!json) process.stderr.write(msg + '\n');
}

function humanBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 && u > 0 ? 2 : 1)} ${units[u]}`;
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}

/** Export for tests. */
export const _internals = {
  CHUNK_SIZE_BYTES,
  humanBytes,
  publishWithRetry,
  checkMissing,
  mintUploadUrls,
};
