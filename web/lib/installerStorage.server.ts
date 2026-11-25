/**
 * Installer files on R2, served by tridant's shared download worker at a
 * permanent public url: download.tridant.io/owlette/<file> for prod,
 * download-staging.tridant.io/owlette/<file> for dev. The worker caches a file
 * as immutable for a year, so a published name never gets new bytes: uploads
 * land on a private staging key, and only finalize copies one to its public
 * name, after its checks, carrying its sha256 so a later finalize can tell
 * whether the public name already holds the same bytes.
 *
 * Env: INSTALLER_R2_ACCESS_KEY_ID + INSTALLER_R2_SECRET_ACCESS_KEY, a token
 * scoped to this environment's bucket only, and R2_S3_ENDPOINT. Uploads stay on
 * firebase storage until both key vars are set.
 */

import 'server-only';
import { createHash } from 'crypto';
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logger from '@/lib/logger';
import { currentEnv } from '@/lib/r2Client.server';

const TARGETS = {
  prod: { bucket: 'owlette-downloads', publicBase: 'https://download.tridant.io/owlette' },
  dev: { bucket: 'owlette-downloads-staging', publicBase: 'https://download-staging.tridant.io/owlette' },
} as const;

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function bucket(): string {
  return TARGETS[currentEnv()].bucket;
}

export function isInstallerR2Configured(): boolean {
  return Boolean(
    env('R2_S3_ENDPOINT') && env('INSTALLER_R2_ACCESS_KEY_ID') && env('INSTALLER_R2_SECRET_ACCESS_KEY'),
  );
}

export function installerPublicUrl(fileName: string): string {
  return `${TARGETS[currentEnv()].publicBase}/${fileName}`;
}

/** true when the url is a file on this environment's download host. */
export function isInstallerPublicUrl(url: string): boolean {
  return url.startsWith(`${TARGETS[currentEnv()].publicBase}/`);
}

/** where an upload lands until finalize publishes it; the worker serves only installer names. */
export function installerStagingKey(uploadId: string): string {
  return `uploads/${uploadId}`;
}

let client: S3Client | null = null;

function installerClient(): S3Client {
  if (client) return client;
  const endpoint = env('R2_S3_ENDPOINT');
  const accessKeyId = env('INSTALLER_R2_ACCESS_KEY_ID');
  const secretAccessKey = env('INSTALLER_R2_SECRET_ACCESS_KEY');
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('installer R2 is not configured: set INSTALLER_R2_ACCESS_KEY_ID and INSTALLER_R2_SECRET_ACCESS_KEY');
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

/** a presigned PUT to `key`; the uploader must send this content type. */
export async function presignInstallerUpload(
  key: string,
  contentType: string,
  expiresInSeconds: number,
): Promise<string> {
  return getSignedUrl(
    installerClient(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type']) },
  );
}

export interface StoredInstaller {
  size: number;
  sha256: string;
  contentType: string;
}

/**
 * An uploaded object's size and sha256, hashed as it streams so a large
 * installer is never held in memory. Null when nothing was uploaded.
 */
export async function readInstaller(key: string): Promise<StoredInstaller | null> {
  let response;
  try {
    response = await installerClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const hash = createHash('sha256');
  let size = 0;
  const body = response.Body as AsyncIterable<Uint8Array> | undefined;
  if (body) {
    for await (const chunk of body) {
      hash.update(chunk);
      size += chunk.length;
    }
  }
  return {
    size,
    sha256: hash.digest('hex'),
    contentType: response.ContentType || 'application/octet-stream',
  };
}

/**
 * The sha256 a published installer was copied with: null when the name is not
 * published, '' when it is but carries none (treat as different bytes).
 */
export async function publishedInstallerSha256(fileName: string): Promise<string | null> {
  try {
    const head = await installerClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: fileName }));
    return head.Metadata?.sha256 ?? '';
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** copies a finalized upload to its public name, recording its sha256 there. */
export async function publishInstaller(
  stagingKey: string,
  fileName: string,
  sha256: string,
  contentType: string,
): Promise<void> {
  const name = bucket();
  await installerClient().send(
    new CopyObjectCommand({
      Bucket: name,
      Key: fileName,
      CopySource: `${name}/${stagingKey}`,
      MetadataDirective: 'REPLACE',
      ContentType: contentType,
      Metadata: { sha256 },
    }),
  );
}

/** drops a finalized upload's staging object; a leftover one is never served, so a failure only warns. */
export async function discardInstallerUpload(stagingKey: string): Promise<void> {
  try {
    await installerClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: stagingKey }));
  } catch (err) {
    logger.warn('[installer] staging object not removed', {
      context: 'installer',
      data: { stagingKey, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
