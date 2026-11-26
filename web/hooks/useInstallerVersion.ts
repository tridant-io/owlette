'use client';

import { useState, useEffect } from 'react';
import { doc, onSnapshot, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDemoContext } from '@/contexts/DemoContext';
import { handleError } from '@/lib/errorHandler';
import { normalizeInstallerFiles, type InstallerFiles } from '@/lib/installerPlatform';

export interface InstallerVersionInfo {
  version: string;
  files: InstallerFiles;
  fileSize: number;
  releaseDate: Timestamp;
  releaseNotes?: string;
}

// one shared empty map so a consumer's deps do not change on every render
const NO_FILES: InstallerFiles = {};

/**
 * Latest installer version, live via onSnapshot. Backs the dashboard header's
 * download button; readable by any authenticated user. `files` holds every
 * platform's installer; `downloadUrl` stays the windows one for callers that
 * only want that.
 */
export function useInstallerVersion() {
  // /demo offers its sample latest installer and reads nothing
  const demo = useDemoContext();
  const [versionInfo, setVersionInfo] = useState<InstallerVersionInfo | null>(null);
  const [loading, setLoading] = useState(!!db && !demo);
  const [error, setError] = useState<string | null>(db || demo ? null : 'Firebase is not configured');

  useEffect(() => {
    if (!db || demo) return;

    // No try/catch: `doc()` only throws on invalid path segments (both literal
    // here) and onSnapshot reports runtime errors through its error callback. A
    // sync catch-block setState would trip react-hooks/set-state-in-effect.
    const latestRef = doc(db, 'installer_metadata', 'latest');

    const unsubscribe = onSnapshot(
      latestRef,
      (doc) => {
        if (doc.exists()) {
          const data = doc.data();
          setVersionInfo({
            version: data.version,
            files: normalizeInstallerFiles(data),
            fileSize: data.file_size,
            releaseDate: data.release_date,
            releaseNotes: data.release_notes,
          });
          setError(null);
        } else {
          setError('No installer version available');
        }
        setLoading(false);
      },
      (err) => {
        console.error('Error fetching installer version:', err);
        const friendlyMessage = handleError(err);
        setError(friendlyMessage);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [demo]);

  const latest: Partial<InstallerVersionInfo> | null = demo?.latestInstaller ?? versionInfo;
  const files = latest?.files ?? NO_FILES;

  return {
    version: latest?.version,
    files,
    downloadUrl: files.windows_x64?.download_url ?? null,
    fileSize: latest?.fileSize,
    releaseDate: latest?.releaseDate,
    releaseNotes: latest?.releaseNotes,
    isLoading: loading,
    error,
  };
}
