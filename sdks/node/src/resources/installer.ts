/**
 * `owlette.installer` — superadmin-only installer-version management over the
 * wave-1B installer-api routes: GET /api/installer, GET /api/installer/latest,
 * POST+PUT /api/installer/upload, POST /api/installer/{version}/set-latest,
 * DELETE /api/installer/{version}.
 *
 * `upload` is a 3-step flow: POST for a signed URL → PUT the binary → PUT to
 * finalize. The sha-256 is computed client-side and handed to finalize so the
 * server can reject a corrupted upload.
 *
 * Mutations auto-generate `Idempotency-Key` when the caller omits one. Errors
 * surface as `OwletteApiError`.
 */
import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import type { OwletteClient } from '../lib/client';

export type InstallerPlatform = 'windows_x64' | 'macos_arm64' | 'linux_x64';

/** One platform's installer within a version. */
export interface InstallerFile {
  download_url: string;
  checksum_sha256: string | null;
  file_size: number | null;
  /** Display name, e.g. `Owlette-Installer-v3.4.0.pkg`. */
  file_name: string | null;
  uploaded_at: number | null;
}

export interface InstallerVersion {
  version: string;
  /** The windows installer; an alias of `files.windows_x64.download_url`. */
  download_url: string | null;
  checksum_sha256: string | null;
  release_notes: string | null;
  file_size: number | null;
  uploaded_at: number | null;
  uploaded_by: string | null;
  release_date?: string | null;
  deletedAt: number | null;
  /** The installer per platform. A version uploaded before per-platform
   * files carries its windows installer under `windows_x64`. */
  files: Partial<Record<InstallerPlatform, InstallerFile>>;
  promoted_at?: number | null;
  promoted_by?: string | null;
}

export interface ListInstallerOptions {
  pageSize?: number;
  pageToken?: string;
  includeDeleted?: boolean;
}

export interface ListInstallerResult {
  versions: InstallerVersion[];
  nextPageToken: string;
}

export interface UploadRequestOptions {
  /** Local path to the `.exe`, `.pkg` or `.deb` to upload. */
  filePath: string;
  /** Semver `X.Y.Z`. */
  version: string;
  /** File name on storage; defaults to the basename of `filePath`. */
  fileName?: string;
  /** Platform key the file is stored under; the api derives it from the file
   * name's extension when omitted and rejects a mismatch. */
  platform?: InstallerPlatform;
  contentType?: string;
  releaseNotes?: string | null;
  /** Whether to promote this version to `latest` on finalize. Default true. */
  setAsLatest?: boolean;
  /** Override the auto-generated idempotency key used on both API calls. */
  idempotencyKey?: string;
  /** @deprecated Use idempotencyKey; retained for compatibility. */
  startIdempotencyKey?: string;
  /** @deprecated Use idempotencyKey; retained for compatibility. */
  finalizeIdempotencyKey?: string;
  /** Override the upload PUT; defaults to `client._fetch` so a custom proxy/agent
   * passed at construction time is honoured. */
  signedUploadFetch?: typeof fetch;
}

export interface UploadResult {
  version: string;
  download_url: string;
  checksum_sha256: string;
  file_size: number;
  platform: InstallerPlatform;
  /** Every platform file the version carries after this upload. */
  files: Partial<Record<InstallerPlatform, InstallerFile>>;
}

export class Installer {
  constructor(private readonly client: OwletteClient) {}

  async list(opts: ListInstallerOptions = {}): Promise<ListInstallerResult> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.pageSize !== undefined) query.page_size = opts.pageSize;
    if (opts.pageToken !== undefined) query.page_token = opts.pageToken;
    if (opts.includeDeleted) query.includeDeleted = 'true';

    const res = await this.client.request<{
      versions: InstallerVersion[];
      next_page_token?: string;
      nextPageToken?: string;
    }>('/api/installer', { query });
    return {
      versions: res.data.versions ?? [],
      nextPageToken: res.data.next_page_token ?? res.data.nextPageToken ?? '',
    };
  }

  async latest(): Promise<InstallerVersion> {
    const res = await this.client.request<InstallerVersion>('/api/installer/latest');
    return res.data;
  }

  /**
   * Three-step upload: request a signed URL, PUT the binary, finalize. Streams
   * the file once for its sha-256. Returns the finalized version metadata.
   */
  async upload(opts: UploadRequestOptions): Promise<UploadResult> {
    const fileName =
      opts.fileName ?? opts.filePath.split(/[\\/]/).pop() ?? 'installer.exe';
    const contentType = opts.contentType ?? 'application/octet-stream';

    // 1. POST /api/installer/upload — request the signed URL.
    const startBody: Record<string, unknown> = {
      version: opts.version,
      fileName,
      contentType,
    };
    if (opts.platform !== undefined) startBody.platform = opts.platform;
    if (opts.releaseNotes !== undefined) startBody.releaseNotes = opts.releaseNotes;
    if (opts.setAsLatest !== undefined) startBody.setAsLatest = opts.setAsLatest;
    const idempotencyKey =
      opts.idempotencyKey ??
      opts.startIdempotencyKey ??
      opts.finalizeIdempotencyKey ??
      `sdk-installer-upload-${randomUUID()}`;

    const startRes = await this.client.request<{
      uploadUrl: string;
      uploadId: string;
      storagePath: string;
      expiresAt: string;
    }>('/api/installer/upload', {
      method: 'POST',
      body: startBody,
      idempotencyKey: opts.startIdempotencyKey ?? idempotencyKey,
    });
    const { uploadUrl, uploadId } = startRes.data;

    // 2. PUT the signed URL — upload the binary.
    const fileStat = await stat(opts.filePath);
    const fileSize = fileStat.size;
    const sha256 = await sha256OfFile(opts.filePath);

    const buffer = await readFileToBuffer(opts.filePath);
    const uploadFetch = opts.signedUploadFetch ?? this.client._fetch;
    const putRes = await uploadFetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(buffer),
    });
    if (!putRes.ok) {
      throw new Error(
        `installer.upload: signed-url PUT failed with status ${putRes.status} ` +
          `(${fileSize} bytes from ${opts.filePath})`,
      );
    }

    // 3. PUT /api/installer/upload — finalize.
    const finalizeRes = await this.client.request<UploadResult>(
      '/api/installer/upload',
      {
        method: 'PUT',
        body: { uploadId, checksum_sha256: sha256 },
        idempotencyKey: opts.finalizeIdempotencyKey ?? idempotencyKey,
      },
    );
    return finalizeRes.data;
  }

  async setLatest(
    version: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ version: string; latest: Record<string, unknown> }> {
    const res = await this.client.request<{
      version: string;
      latest: Record<string, unknown>;
    }>(`/api/installer/${encodeURIComponent(version)}/set-latest`, {
      method: 'POST',
      body: {},
      idempotencyKey: opts.idempotencyKey ?? `sdk-installer-set-latest-${randomUUID()}`,
    });
    return res.data;
  }

  async delete(
    version: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ version: string; deletedAt: number; alreadyDeleted: boolean }> {
    const res = await this.client.request<{
      version: string;
      deletedAt: number;
      alreadyDeleted: boolean;
    }>(`/api/installer/${encodeURIComponent(version)}`, {
      method: 'DELETE',
      idempotencyKey: opts.idempotencyKey ?? `sdk-installer-delete-${randomUUID()}`,
    });
    return res.data;
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function readFileToBuffer(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
