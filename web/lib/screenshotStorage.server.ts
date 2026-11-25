/**
 * Signed-URL helpers for screenshot capture.
 *
 * WRITE urls (5 min) let the agent PUT straight to Storage, so a multi-MB
 * binary never proxies through Next.js. READ urls (1 hour) are minted per
 * request and never persisted, so expiry is always honoured. Objects stay
 * private: a stored record carries the path and `screenshotImageUrl`, which
 * signs a read url for whoever loads it.
 *
 * Paths are `screenshots/{siteId}/{machineId}/{unixMs}-{rand}.{ext}`; a
 * bucket lifecycle rule prunes `screenshots/**` after 30 days, so nothing
 * here enumerates or deletes.
 */
import crypto from 'crypto';
import { getAdminDb, getAdminStorage } from '@/lib/firebase-admin';

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

/**
 * One of this machine's screenshots: `screenshots/{siteId}/{machineId}/{name}`.
 * Every path read from a stored record passes this before it is signed, so a
 * record cannot name another site's or machine's object.
 */
export function isMachineScreenshotPath(
  storagePath: unknown,
  siteId: string,
  machineId: string,
): storagePath is string {
  const prefix = `screenshots/${siteId}/${machineId}/`;
  return (
    typeof storagePath === 'string' &&
    storagePath.startsWith(prefix) &&
    storagePath.length > prefix.length &&
    !storagePath.includes('..')
  );
}

/** The url a screenshot record carries: the image route redirects a caller with access to a fresh read url. */
export function screenshotImageUrl(siteId: string, machineId: string, storagePath: string): string {
  return `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/screenshots/image?path=${encodeURIComponent(storagePath)}`;
}

/** The object behind a screenshot record: its `path`, or the one in an older record's storage url. */
export function screenshotRecordPath(
  record: { path?: unknown; url?: unknown } | undefined,
  bucketName: string,
): string | null {
  if (typeof record?.path === 'string' && record.path.length > 0) return record.path;
  if (typeof record?.url !== 'string') return null;
  const marker = `${bucketName}/`;
  const start = record.url.indexOf(marker);
  if (start === -1) return null;
  return record.url.slice(start + marker.length).split('?')[0] || null;
}

/**
 * A url a model provider can fetch, for the screenshot url a capture on `machineId`
 * returned: the `path` stored on that machine's screenshot record carrying the url
 * becomes a fresh read url, an absolute url passes through, and anything else is
 * null, a capture pruned from the history included.
 */
export async function screenshotUrlForModel(
  url: string,
  siteId: string,
  machineId: string,
): Promise<string | null> {
  if (!url.startsWith('/')) return url;
  if (!machineId || machineId.includes('/')) return null;
  const records = await getAdminDb()
    .collection('sites').doc(siteId)
    .collection('machines').doc(machineId)
    .collection('screenshots')
    .where('url', '==', url)
    .limit(1)
    .get();
  const storagePath: unknown = records.docs[0]?.data()?.path;
  if (!isMachineScreenshotPath(storagePath, siteId, machineId)) return null;
  return (await issueScreenshotReadUrl(storagePath))?.url ?? null;
}
