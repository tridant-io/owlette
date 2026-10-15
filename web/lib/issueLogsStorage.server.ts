/**
 * Logs a machine attaches to an issue report, as one zip on R2. The agent PUTs
 * the zip to a presigned url, the report then names its key, and support opens
 * it through a short-lived download url. An R2 lifecycle rule deletes every
 * object 30 days after upload (`scripts/provision-r2.mjs`).
 *
 * Env: ISSUE_LOGS_R2_ACCESS_KEY_ID + ISSUE_LOGS_R2_SECRET_ACCESS_KEY, a token
 * scoped to the two issue-logs buckets only, and R2_S3_ENDPOINT, the roost
 * endpoint customer firewalls already allow (ADR 0003).
 */

import 'server-only';
import { randomUUID } from 'crypto';
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { currentEnv } from '@/lib/r2Client.server';

// the agent caps its zip at 150,000,000 bytes, logs plus screenshots and a video
export const ISSUE_LOGS_MAX_BYTES = 150 * 1024 * 1024;
export const ISSUE_LOGS_RETENTION_DAYS = 30;

export const ISSUE_LOGS_DOWNLOAD_TTL_SECONDS = 15 * 60;
// matches the desktop's 30-minute send budget, so a retry of a slow video upload is still signed
export const ISSUE_LOGS_UPLOAD_TTL_SECONDS = 30 * 60;

// what a HEAD reports for any issues/ key under OWLETTE_E2E, where no real R2 exists
export const ISSUE_LOGS_E2E_SIZE = 1024;
const E2E_BASE = 'https://issue-logs.e2e.invalid';

function isE2E(): boolean {
  return process.env.OWLETTE_E2E === '1';
}

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function bucket(): string {
  return `owlette-${currentEnv()}-issue-logs`;
}

function assertSegment(name: string, value: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

export function issueLogsKey(siteId: string, machineId: string): string {
  assertSegment('siteId', siteId);
  assertSegment('machineId', machineId);
  return `issues/${siteId}/${machineId}/${randomUUID()}.zip`;
}

let client: S3Client | null = null;

function issueLogsClient(): S3Client {
  if (client) return client;
  const endpoint = env('R2_S3_ENDPOINT');
  const accessKeyId = env('ISSUE_LOGS_R2_ACCESS_KEY_ID');
  const secretAccessKey = env('ISSUE_LOGS_R2_SECRET_ACCESS_KEY');
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('issue logs R2 is not configured: set ISSUE_LOGS_R2_ACCESS_KEY_ID and ISSUE_LOGS_R2_SECRET_ACCESS_KEY');
  }
  client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    // otherwise the sdk signs a crc32 of the empty presign body into the url,
    // and the real upload fails its checksum
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

/** a presigned PUT to `key`; content-length is signed, so R2 refuses a body of any other size. */
export async function presignIssueLogsUpload(key: string, size: number): Promise<string> {
  if (isE2E()) return `${E2E_BASE}/${key}?op=put&size=${size}`;
  return getSignedUrl(
    issueLogsClient(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentLength: size, ContentType: 'application/zip' }),
    { expiresIn: ISSUE_LOGS_UPLOAD_TTL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) },
  );
}

/** the uploaded zip's size, or null when nothing was uploaded under `key`. */
export async function headIssueLogs(key: string): Promise<{ size: number } | null> {
  if (isE2E()) return key.startsWith('issues/') ? { size: ISSUE_LOGS_E2E_SIZE } : null;
  try {
    const head = await issueLogsClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: head.ContentLength ?? 0 };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** a presigned GET that saves the zip as `filename`. */
export async function presignIssueLogsDownload(key: string, filename: string): Promise<string> {
  // the name lands in a header, so keep it to characters that need no quoting rules
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  if (isE2E()) return `${E2E_BASE}/${key}?op=get&filename=${encodeURIComponent(safeName)}`;
  return getSignedUrl(
    issueLogsClient(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safeName}"`,
    }),
    { expiresIn: ISSUE_LOGS_DOWNLOAD_TTL_SECONDS },
  );
}
