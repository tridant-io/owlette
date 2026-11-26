'use client';

import { useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useDemoContext } from '@/contexts/DemoContext';

/**
 * whether the viewer may act on a machine of `siteId` (`isMachineAdmin`), asked
 * per machine. never on /demo, whoever is signed in: its sample site takes no
 * writes.
 */
export function useCanAdminMachine(siteId: string): (machineId: string) => boolean {
  const { isMachineAdmin } = useAuth();
  const demo = useDemoContext();
  return useCallback(
    (machineId: string) => !demo && isMachineAdmin(siteId, machineId),
    [demo, isMachineAdmin, siteId],
  );
}
