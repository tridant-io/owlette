import type { SiteMemberRole } from '@/hooks/useSiteMembers';

/** What a member row is allowed to say out loud. */
export type DisplayedRole = 'owner' | 'admin' | 'member';

/**
 * Per-site role → the label customers see.
 *
 * `superadmin` is internal-only vocabulary: it names a platform operator, and a
 * customer looking at their own site has no business learning that tier exists.
 * It therefore collapses into `admin`, which is what it behaves as on this site.
 * The string `superadmin` must never reach the screen — no badge, tooltip, or
 * aria label anywhere on any site-scoped surface (the site list, the members
 * section).
 */
export function displayRole(role: SiteMemberRole): DisplayedRole {
  if (role === 'owner') return 'owner';
  if (role === 'superadmin' || role === 'admin') return 'admin';
  return 'member';
}
