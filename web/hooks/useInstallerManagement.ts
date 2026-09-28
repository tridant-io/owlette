'use client';

import { useState, useEffect, useCallback } from 'react';
import { handleError } from '@/lib/errorHandler';
import { useAuth } from '@/contexts/AuthContext';
import type { FirestoreTs } from '@/hooks/useFirestore';
import {
  normalizeInstallerFiles,
  platformFromExtension,
  type InstallerFiles,
} from '@/lib/installerPlatform';

export interface InstallerVersion {
  id: string;
  version: string;
  download_url: string;
  file_size: number;
  release_date: FirestoreTs;
  checksum_sha256: string;
  release_notes?: string;
  uploaded_by: string;
  is_latest?: boolean;
  files: InstallerFiles;
}

// a type alias, not an interface, so the record is assignable to the normaliser's Record<string, unknown>
type InstallerVersionApi = {
  version?: string;
  download_url?: string | null;
  file_size?: number | null;
  release_date?: FirestoreTs;
  uploaded_at?: number | null;
  checksum_sha256?: string | null;
  release_notes?: string | null;
  uploaded_by?: string | null;
  files?: unknown;
};

/**
 * useInstallerManagement Hook
 *
 * Provides functionality for admin users to manage agent installer versions
 * through the documented /api/installer public API surface.
 */
export function useInstallerManagement() {
  const { user } = useAuth();
  const [versions, setVersions] = useState<InstallerVersion[]>([]);
  const [latestVersion, setLatestVersion] = useState<InstallerVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshInstallerState = useCallback(async () => {
    setLoading(true);
    try {
      const versionsResponse = await fetch('/api/installer?page_size=100', {
        cache: 'no-store',
      });
      if (!versionsResponse.ok) {
        throw new Error(await readApiError(versionsResponse, 'Failed to fetch installer versions'));
      }
      const versionsBody = (await versionsResponse.json()) as { versions?: InstallerVersionApi[] };
      const versionRows: InstallerVersion[] = Array.isArray(versionsBody.versions)
        ? versionsBody.versions.map(normalizeVersion)
        : [];

      const latestResponse = await fetch('/api/installer/latest', {
        cache: 'no-store',
      });
      let latest: InstallerVersion | null = null;
      if (latestResponse.ok) {
        latest = normalizeVersion(await latestResponse.json());
      } else if (latestResponse.status !== 404) {
        throw new Error(await readApiError(latestResponse, 'Failed to fetch latest installer'));
      }

      setLatestVersion(latest);
      setVersions(
        versionRows.map((version) => ({
          ...version,
          is_latest: latest?.version === version.version,
        })),
      );
      setError(null);
    } catch (err) {
      console.error('Error fetching installer versions:', err);
      setError(handleError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshInstallerState();
  }, [refreshInstallerState]);

  const uploadVersion = useCallback(
    async (
      file: File,
      version: string,
      releaseNotes: string | undefined,
      setAsLatest: boolean,
      onProgress?: (progress: number) => void,
    ): Promise<void> => {
      if (!user) {
        throw new Error('You must be logged in to upload');
      }
      const platform = platformFromExtension(file.name);
      if (!platform) {
        throw new Error('Installer must be a .exe, .pkg or .deb file');
      }

      try {
        const checksum = await sha256File(file);
        const idempotencyKey = createIdempotencyKey(`installer-upload-${version}-${platform}`);
        const uploadInit = await fetch('/api/installer/upload', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            version,
            fileName: file.name,
            platform,
            contentType: file.type || 'application/octet-stream',
            releaseNotes,
            setAsLatest,
          }),
        });
        if (!uploadInit.ok) throw new Error(await readApiError(uploadInit, 'Failed to start upload'));
        const uploadBody = await uploadInit.json();

        await uploadFileToSignedUrl(uploadBody.uploadUrl, file, onProgress);

        const finalize = await fetch('/api/installer/upload', {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            uploadId: uploadBody.uploadId,
            ...(checksum ? { checksum_sha256: checksum } : {}),
          }),
        });
        if (!finalize.ok) throw new Error(await readApiError(finalize, 'Failed to finalize upload'));
        await refreshInstallerState();
      } catch (err) {
        console.error('Error uploading version:', err);
        throw new Error(handleError(err));
      }
    },
    [refreshInstallerState, user],
  );

  const setAsLatest = useCallback(
    async (version: string): Promise<void> => {
      try {
        const response = await fetch(`/api/installer/${encodeURIComponent(version)}/set-latest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': createIdempotencyKey(`installer-set-latest-${version}`),
          },
          body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to set latest version'));
        await refreshInstallerState();
      } catch (err) {
        console.error('Error setting latest version:', err);
        throw new Error(handleError(err));
      }
    },
    [refreshInstallerState],
  );

  const deleteVersion = useCallback(
    async (version: string): Promise<void> => {
      try {
        const response = await fetch(`/api/installer/${encodeURIComponent(version)}`, {
          method: 'DELETE',
          headers: {
            'Idempotency-Key': createIdempotencyKey(`installer-delete-${version}`),
          },
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete installer version'));
        await refreshInstallerState();
      } catch (err) {
        console.error('Error deleting version:', err);
        throw new Error(handleError(err));
      }
    },
    [refreshInstallerState],
  );

  const getCleanupCandidates = useCallback(
    (retentionDays: number = 30): InstallerVersion[] => {
      if (!latestVersion) return [];

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);

      const groups = new Map<string, InstallerVersion[]>();
      for (const v of versions) {
        const parts = v.version.split('.');
        if (parts.length !== 3) continue;
        const key = `${parts[0]}.${parts[1]}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(v);
      }

      const keepVersions = new Set<string>();
      keepVersions.add(latestVersion.version);

      for (const [, group] of groups) {
        const first = group[0];
        if (!first) continue;
        let highest = first;
        for (const v of group) {
          const patchA = parseInt(v.version.split('.')[2], 10);
          const patchB = parseInt(highest.version.split('.')[2], 10);
          if (patchA > patchB) highest = v;
        }
        keepVersions.add(highest.version);
      }

      return versions.filter((v) => {
        if (keepVersions.has(v.version)) return false;
        const rd = v.release_date;
        const uploadDate = rd && typeof (rd as { toDate?: () => Date }).toDate === 'function'
          ? (rd as { toDate: () => Date }).toDate()
          : new Date(rd as number | string | Date);
        if (uploadDate > cutoff) return false;
        return true;
      });
    },
    [versions, latestVersion],
  );

  const cleanupVersions = useCallback(
    async (candidates: InstallerVersion[]): Promise<number> => {
      let deleted = 0;
      for (const v of candidates) {
        await deleteVersion(v.version);
        deleted++;
      }
      return deleted;
    },
    [deleteVersion],
  );

  return {
    versions,
    latestVersion,
    loading,
    error,
    uploadVersion,
    setAsLatest,
    deleteVersion,
    getCleanupCandidates,
    cleanupVersions,
  };
}

function normalizeVersion(raw: InstallerVersionApi): InstallerVersion {
  const version = raw.version ?? '';
  return {
    id: version,
    version,
    download_url: raw.download_url ?? '',
    file_size: raw.file_size ?? 0,
    release_date: raw.release_date ?? raw.uploaded_at ?? null,
    checksum_sha256: raw.checksum_sha256 ?? '',
    release_notes: raw.release_notes ?? undefined,
    uploaded_by: raw.uploaded_by ?? '',
    files: normalizeInstallerFiles(raw),
  };
}

function uploadFileToSignedUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

async function sha256File(file: File): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? body.error ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

function createIdempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
