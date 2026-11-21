'use client';

import { useState } from 'react';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { TERMINAL_DEPLOYMENT_STATUSES } from '@/lib/deploymentStatuses';

interface Software {
  name: string;
  version: string;
  publisher: string;
  install_location: string;
  uninstall_command: string;
  installer_type: string;
  registry_key: string;
}

/**
 * Hook for managing software uninstallation.
 *
 * Reads stay on Firestore for real-time inventory data. Mutations go through
 * the server-mediated uninstall API so the security boundary owns command
 * writes and audit correlation.
 */
export function useUninstall() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMachineSoftware = async (siteId: string, machineId: string): Promise<Software[]> => {
    if (!db || !siteId || !machineId) {
      throw new Error('Invalid parameters');
    }

    try {
      const softwareRef = collection(db, 'sites', siteId, 'machines', machineId, 'installed_software');
      const snapshot = await getDocs(softwareRef);

      const software: Software[] = [];
      snapshot.forEach((doc) => {
        software.push(doc.data() as Software);
      });

      return software.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to fetch software:', err);
      throw new Error(message || 'Failed to fetch installed software');
    }
  };

  const fetchSoftwareFromMachines = async (siteId: string, machineIds: string[]): Promise<Software[]> => {
    if (!db || !siteId || machineIds.length === 0) {
      throw new Error('Invalid parameters');
    }

    setLoading(true);
    setError(null);

    try {
      const softwareMap = new Map<string, Software>();

      for (const machineId of machineIds) {
        try {
          const softwareList = await fetchMachineSoftware(siteId, machineId);
          softwareList.forEach((software) => {
            const key = `${software.name}_${software.version}`;
            if (!softwareMap.has(key)) {
              softwareMap.set(key, software);
            }
          });
        } catch (err) {
          console.error(`Failed to fetch software from ${machineId}:`, err);
        }
      }

      return Array.from(softwareMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const errorMsg = message || 'Failed to fetch software';
      setError(errorMsg);
      throw new Error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const createUninstall = async (
    siteId: string,
    softwareName: string,
    machineIds: string[],
    deploymentId?: string
  ): Promise<void> => {
    if (!db || !siteId || !softwareName || machineIds.length === 0) {
      throw new Error('Invalid parameters');
    }

    setLoading(true);
    setError(null);

    try {
      console.log('[useUninstall] Creating uninstall:', { siteId, softwareName, machineIds, deploymentId });

      // the server refuses a deployment_id whose target on that machine is still
      // installing, so only finished targets carry it; other machines go untied.
      const finishedTargets = deploymentId
        ? await fetchFinishedTargets(siteId, deploymentId)
        : new Set<string>();

      for (const machineId of machineIds) {
        const response = await fetch(
          `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/uninstall`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'Idempotency-Key':
                'machine-uninstall-' +
                siteId +
                '-' +
                machineId +
                '-' +
                encodeURIComponent(softwareName) +
                '-' +
                Date.now() +
                '-' +
                Math.random().toString(36).slice(2),
            },
            body: JSON.stringify({
              software_name: softwareName,
              ...(deploymentId && finishedTargets.has(machineId)
                ? { deployment_id: deploymentId }
                : {}),
            }),
          },
        );
        if (!response.ok) {
          throw new Error(await readApiError(response, `Failed to create uninstall command for ${machineId}`));
        }
      }

      console.log(`[useUninstall] All uninstall commands created for ${machineIds.length} machines`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[useUninstall] Error:', err);
      const errorMsg = message || 'Failed to create uninstall commands';
      setError(errorMsg);
      throw new Error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const cancelUninstall = async (
    siteId: string,
    machineId: string,
    softwareName: string
  ): Promise<void> => {
    if (!db || !siteId || !machineId || !softwareName) {
      throw new Error('Invalid parameters');
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/uninstall?software_name=${encodeURIComponent(softwareName)}`,
        {
          method: 'DELETE',
          headers: {
            'Idempotency-Key':
              'machine-cancel-uninstall-' +
              siteId +
              '-' +
              machineId +
              '-' +
              encodeURIComponent(softwareName) +
              '-' +
              Date.now() +
              '-' +
              Math.random().toString(36).slice(2),
          },
        },
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to cancel uninstall'));
      }

      console.log(`Cancel uninstall command sent for ${softwareName} on ${machineId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const errorMsg = message || 'Failed to cancel uninstall';
      setError(errorMsg);
      throw new Error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    error,
    fetchMachineSoftware,
    fetchSoftwareFromMachines,
    createUninstall,
    cancelUninstall,
  };
}

async function fetchFinishedTargets(siteId: string, deploymentId: string): Promise<Set<string>> {
  const snap = await getDoc(doc(db!, 'sites', siteId, 'deployments', deploymentId));
  const targets: unknown = snap.exists() ? snap.data().targets : undefined;
  return new Set(
    (Array.isArray(targets) ? targets : [])
      .map((target) => target as { machineId?: unknown; status?: unknown } | null)
      .filter((target) => typeof target?.status === 'string' && TERMINAL_DEPLOYMENT_STATUSES.has(target.status))
      .map((target) => target?.machineId)
      .filter((machineId): machineId is string => typeof machineId === 'string'),
  );
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
