'use client';

import { useAuth } from '@/contexts/AuthContext';
import { useDemoContext } from '@/contexts/DemoContext';

/**
 * whether the viewer may only read `siteId`: a superadmin who holds no member
 * row there (adr 0021). the server refuses their changes but an allowlist
 * (update, reboot, process start, stop, restart and kill, cancelling a
 * deployment, revoking a token, ending a swoop session), so the dashboard hides
 * or locks every other change control, as it does a plan-locked one, and says
 * how to add themselves (`MemberLock`).
 *
 * false until access resolves, so a superadmin who is a member never sees the
 * lock flash while their rows land, and on /demo, whose sample site takes no
 * writes from anyone.
 */
export function useMemberLock(siteId: string | null | undefined): boolean {
  const { role, userSites, isSiteMember } = useAuth();
  const demo = useDemoContext();
  if (!siteId || demo || userSites === undefined) return false;
  return role === 'superadmin' && !isSiteMember(siteId);
}
