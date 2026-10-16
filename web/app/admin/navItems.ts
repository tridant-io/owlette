/**
 * Admin panel destinations and the role gate over them.
 *
 * Its own module rather than `layout.tsx` because Next validates route files'
 * exports — a layout may only export `default` and the segment config keys.
 */

import {
  Users,
  UserPlus,
  Package,
  Settings,
  Mail,
  KeyRound,
  Webhook,
  Clock,
  Bell,
  MonitorPlay,
  Inbox,
  type LucideIcon,
} from 'lucide-react';
import type { UserRole } from '@/contexts/AuthContext';

/** Lowest global role a destination admits; 'admin' also admits superadmins. */
export type AdminMinRole = 'admin' | 'superadmin';

/** The sidebar's sections, in the order they are shown. */
export const ADMIN_NAV_GROUPS = ['people', 'fleet', 'configuration', 'support'] as const;
export type AdminNavGroup = (typeof ADMIN_NAV_GROUPS)[number];

export interface AdminNavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  description: string;
  minRole: AdminMinRole;
  group: AdminNavGroup;
}

// in display order: grouped by job, people first and support last (owner, 2026-10-15)
const NAV_ITEMS: AdminNavItem[] = [
  {
    name: 'users',
    href: '/admin/users',
    icon: Users,
    description: 'manage user roles and permissions',
    minRole: 'superadmin',
    group: 'people',
  },
  {
    name: 'members',
    href: '/admin/members',
    icon: UserPlus,
    description: 'manage site members',
    minRole: 'admin',
    group: 'people',
  },
  {
    name: 'installers',
    href: '/admin/installers',
    icon: Package,
    description: 'manage agent installer versions',
    minRole: 'superadmin',
    group: 'fleet',
  },
  {
    name: 'agent tokens',
    href: '/admin/tokens',
    icon: KeyRound,
    description: 'view and revoke agent tokens',
    minRole: 'admin',
    group: 'fleet',
  },
  {
    name: 'swoop',
    href: '/admin/swoop',
    icon: MonitorPlay,
    description: 'view and end live swoop sessions',
    minRole: 'admin',
    group: 'fleet',
  },
  {
    name: 'alerts',
    href: '/admin/alerts',
    icon: Bell,
    description: 'manage alert rules',
    minRole: 'admin',
    group: 'configuration',
  },
  {
    name: 'schedules',
    href: '/admin/schedules',
    icon: Clock,
    description: 'manage schedule presets',
    minRole: 'admin',
    group: 'configuration',
  },
  {
    name: 'template library',
    href: '/admin/presets',
    icon: Settings,
    description: 'manage software catalog',
    minRole: 'superadmin',
    group: 'configuration',
  },
  {
    name: 'webhooks',
    href: '/admin/webhooks',
    icon: Webhook,
    description: 'configure webhook integrations',
    minRole: 'admin',
    group: 'configuration',
  },
  {
    name: 'issues',
    href: '/admin/issues',
    icon: Inbox,
    description: 'read and triage what users sent',
    minRole: 'superadmin',
    group: 'support',
  },
  {
    name: 'email',
    href: '/admin/email',
    icon: Mail,
    description: 'email configuration & testing',
    minRole: 'superadmin',
    group: 'support',
  },
];

/**
 * Superadmins see the whole panel; anyone who administers a site sees the
 * site-scoped destinations.
 *
 * `administersAnySite` replaces the old `role === 'admin'` test: since wave 5.1
 * the global role grants nothing on a site, so it no longer predicts whether
 * these destinations will work for the user.
 */
export function visibleNavItems(
  role: UserRole | null,
  administersAnySite: boolean
): AdminNavItem[] {
  if (role === 'superadmin') return NAV_ITEMS;
  if (administersAnySite) return NAV_ITEMS.filter((item) => item.minRole === 'admin');
  return [];
}

/**
 * Role a pathname demands. Subpaths inherit their page's requirement; anything
 * with no matching nav entry fails closed to superadmin.
 */
export function requiredRoleForPath(pathname: string | null): AdminMinRole {
  const match = NAV_ITEMS.find((item) => navItemMatches(item, pathname));
  return match?.minRole ?? 'superadmin';
}

/** Whether `pathname` is the destination's page or one of its subpages. */
export function navItemMatches(item: AdminNavItem, pathname: string | null): boolean {
  return pathname === item.href || !!pathname?.startsWith(`${item.href}/`);
}

/** The visible items split into their sections, empty sections dropped. */
export function groupNavItems(
  items: AdminNavItem[]
): { group: AdminNavGroup; items: AdminNavItem[] }[] {
  return ADMIN_NAV_GROUPS.map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0);
}
