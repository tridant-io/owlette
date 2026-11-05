import { normalizeInstallerFiles, type InstallerFiles } from '@/lib/installerPlatform';

export interface InstallerVersionRecord {
  version?: unknown;
  download_url?: unknown;
  checksum_sha256?: unknown;
  release_notes?: unknown;
  file_size?: unknown;
  uploaded_at?: unknown;
  uploaded_by?: unknown;
  release_date?: unknown;
  promoted_at?: unknown;
  promoted_by?: unknown;
  deletedAt?: unknown;
  files?: unknown;
}

export interface InstallerVersionResponse {
  version: string;
  download_url: string | null;
  checksum_sha256: string | null;
  release_notes: string | null;
  file_size: number | null;
  uploaded_at: number | null;
  uploaded_by: string | null;
  release_date: string | null;
  deletedAt: number | null;
  files: InstallerFiles;
  promoted_at?: number | null;
  promoted_by?: string | null;
}

export function installerVersionResponse(
  id: string,
  data: InstallerVersionRecord,
): InstallerVersionResponse {
  const version = stringOrNull(data.version) ?? id;
  const uploadedAt = numberOrNull(data.uploaded_at);
  const promotedAt = numberOrNull(data.promoted_at);
  const promotedBy = stringOrNull(data.promoted_by);
  return {
    version,
    download_url: stringOrNull(data.download_url),
    checksum_sha256: stringOrNull(data.checksum_sha256),
    release_notes: stringOrNull(data.release_notes),
    file_size: numberOrNull(data.file_size),
    uploaded_at: uploadedAt,
    uploaded_by: stringOrNull(data.uploaded_by),
    release_date: dateStringOrNull(data.release_date, uploadedAt),
    deletedAt: numberOrNull(data.deletedAt),
    // the legacy windows entry names its file from the version, which a doc keyed by id may not carry
    files: normalizeInstallerFiles({ ...data, version }),
    ...(promotedAt !== null ? { promoted_at: promotedAt } : {}),
    ...(promotedBy !== null ? { promoted_by: promotedBy } : {}),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dateStringOrNull(value: unknown, fallbackMs: number | null): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (value && typeof value === 'object') {
    const maybeTimestamp = value as {
      toDate?: () => Date;
      toMillis?: () => number;
      seconds?: number;
      _seconds?: number;
    };
    if (typeof maybeTimestamp.toDate === 'function') {
      return maybeTimestamp.toDate().toISOString();
    }
    if (typeof maybeTimestamp.toMillis === 'function') {
      return new Date(maybeTimestamp.toMillis()).toISOString();
    }
    if (typeof maybeTimestamp.seconds === 'number') {
      return new Date(maybeTimestamp.seconds * 1000).toISOString();
    }
    if (typeof maybeTimestamp._seconds === 'number') {
      return new Date(maybeTimestamp._seconds * 1000).toISOString();
    }
  }
  return fallbackMs !== null ? new Date(fallbackMs).toISOString() : null;
}
