/**
 * Signed-URL helpers for screenshot capture.
 *
 * WRITE urls (5 min) let the agent PUT straight to Storage, so a multi-MB
 * binary never proxies through Next.js. READ urls (1 hour) are minted per
 * request and never persisted, so expiry is always honoured.
 *
 * Paths are `screenshots/{siteId}/{machineId}/{unixMs}-{rand}.{ext}`; a
 * bucket lifecycle rule prunes `screenshots/**` after 30 days, so nothing
 * here enumerates or deletes.
 */
import crypto from 'crypto';
import { getAdminStorage } from '@/lib/firebase-admin';

const WRITE_URL_TTL_MS = 5 * 60 * 1000; // 5 minutes
const READ_URL_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_CONTENT_TYPE = 'image/png';

export interface SignedWriteUrlResult {
  uploadUrl: string;
  storagePath: string;
  expiresAt: string;
}

export interface SignedReadUrlResult {
  url: string;
  expiresAt: string;
}

/** Bucket for signed screenshot URLs: NEXT_PUBLIC_ first, FIREBASE_STORAGE_BUCKET as fallback. */
function resolveBucketName(): string {
  const explicit =
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    process.env.FIREBASE_STORAGE_BUCKET;
  if (!explicit || explicit.length === 0) {
    throw new Error(
      '[screenshotStorage] NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not configured',
    );
  }
  return explicit;
}

/** Map a screenshot content-type to its file extension. */
function extForContentType(contentType: string): string {
  return contentType === 'image/jpeg' ? 'jpg' : 'png';
}

/**
 * Canonical path for a new capture. The extension tracks the content-type so
 * a JPEG never sits at a `.png` url — browsers honour the header, but
 * downloads and CDN sniffing trust the path.
 *
 * Exported so the route and tests can rebuild a path without the storage SDK.
 */
export function buildScreenshotPath(
  siteId: string,
  machineId: string,
  contentType: string = DEFAULT_CONTENT_TYPE,
): string {
  const ts = Date.now();
  const suffix = crypto.randomBytes(4).toString('hex');
  return `screenshots/${siteId}/${machineId}/${ts}-${suffix}.${extForContentType(contentType)}`;
}

/**
 * 5-minute v4-signed PUT url. The agent MUST send the matching Content-Type —
 * Storage binds it at signing time.
 */
export async function issueScreenshotUploadUrl(
  siteId: string,
  machineId: string,
  contentType: string = DEFAULT_CONTENT_TYPE,
): Promise<SignedWriteUrlResult> {
  const storage = getAdminStorage();
  const bucket = storage.bucket(resolveBucketName());
  const storagePath = buildScreenshotPath(siteId, machineId, contentType);
  const file = bucket.file(storagePath);

  const expiresAt = new Date(Date.now() + WRITE_URL_TTL_MS);
  const [uploadUrl] = await file.getSignedUrl({
    action: 'write',
    version: 'v4',
    expires: expiresAt,
    contentType,
  });

  return {
    uploadUrl,
    storagePath,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * 1-hour v4-signed GET url; `null` for a blank path so callers can pass
 * through commands with no screenshot yet.
 */
export async function issueScreenshotReadUrl(
  storagePath: string | null | undefined,
): Promise<SignedReadUrlResult | null> {
  if (!storagePath || typeof storagePath !== 'string' || storagePath.length === 0) {
    return null;
  }
  const storage = getAdminStorage();
  const bucket = storage.bucket(resolveBucketName());
  const file = bucket.file(storagePath);

  const expiresAt = new Date(Date.now() + READ_URL_TTL_MS);
  const [url] = await file.getSignedUrl({
    action: 'read',
    version: 'v4',
    expires: expiresAt,
  });

  return {
    url,
    expiresAt: expiresAt.toISOString(),
  };
}
