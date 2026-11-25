/**
 * OCI-style version body assembler for the cli push flow. Matches what
 * `app/api/roosts/[roostId]/versions/route.ts:POST` validates:
 *
 *   { schemaVersion: 2, mediaType: 'application/vnd.owlette.version.v1+json',
 *     config: {}, files: [{ path, size, chunks: [{hash, size}] }] }
 *
 * `config` stays empty, as the dashboard uploader sends it. The server's version
 * id is the hash of the whole body, so a host name, platform or cli release in it
 * would turn the same files into a new version and roll it out again.
 */

import { createHash } from 'crypto';
import type { ChunkedFileEntry } from './chunker';

export const VERSION_MEDIA_TYPE = 'application/vnd.owlette.version.v1+json';
export const VERSION_SCHEMA_VERSION = 2;

export interface BuiltVersion {
  schemaVersion: 2;
  mediaType: typeof VERSION_MEDIA_TYPE;
  config: Record<string, never>;
  files: ChunkedFileEntry[];
}

export function buildVersion(files: readonly ChunkedFileEntry[]): BuiltVersion {
  // Not required by the server, but deterministic ordering keeps the version
  // digest stable across machines and retries.
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return {
    schemaVersion: VERSION_SCHEMA_VERSION,
    mediaType: VERSION_MEDIA_TYPE,
    config: {},
    files: sorted,
  };
}

/** Canonical JSON the server derives the content address from. */
export function canonicalVersionJson(version: BuiltVersion): string {
  return JSON.stringify(sortForCanonical(version));
}

/** SHA-256 content address for a built version body. */
export function versionIdForVersion(version: BuiltVersion): string {
  return createHash('sha256').update(canonicalVersionJson(version)).digest('hex');
}

/** Deduped chunk hashes referenced by a version's files. */
export function uniqueHashes(files: readonly ChunkedFileEntry[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    for (const c of f.chunks) set.add(c.hash);
  }
  return Array.from(set);
}

/** Stats for the pre-upload summary line. */
export function summariseVersion(files: readonly ChunkedFileEntry[]): {
  fileCount: number;
  totalBytes: number;
  totalChunks: number;
  uniqueChunks: number;
} {
  let totalBytes = 0;
  let totalChunks = 0;
  const unique = new Set<string>();
  for (const f of files) {
    totalBytes += f.size;
    totalChunks += f.chunks.length;
    for (const c of f.chunks) unique.add(c.hash);
  }
  return {
    fileCount: files.length,
    totalBytes,
    totalChunks,
    uniqueChunks: unique.size,
  };
}

function sortForCanonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortForCanonical);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) out[k] = sortForCanonical((v as Record<string, unknown>)[k]);
  return out;
}
