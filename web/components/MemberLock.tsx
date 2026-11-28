'use client';

/**
 * what a superadmin who isn't a member of the site in view sees (adr 0021,
 * `useMemberLock`): the controls the server refuses them are hidden, as a
 * role-locked control is, and one hint says how to change that, linking to the
 * admin users page opened on their own site access, where they add themselves.
 * the banner sits under a site page's header, where the plan banner does; the
 * notice heads an admin section that acts on one site.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMemberLock } from '@/hooks/useMemberLock';
import { cn } from '@/lib/utils';

export const MEMBER_LOCK_HINT = 'add yourself to this site to change it';

/** the admin users page, opened on the viewer's own site access. */
export const ADD_YOURSELF_PATH = '/admin/users?sites=me';

/** the link the lock's hint carries. */
export function AddYourselfLink() {
  return (
    <Button asChild variant="link" size="sm">
      <Link href={ADD_YOURSELF_PATH}>add yourself</Link>
    </Button>
  );
}

export function MemberLockBanner({ siteId }: { siteId: string | null | undefined }) {
  if (!useMemberLock(siteId)) return null;
  return (
    <div data-testid="member-lock" role="status" className="relative z-10 border-b border-border bg-accent-cyan/10">
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-1 text-sm">
        <Lock className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
        <span className="text-foreground">{MEMBER_LOCK_HINT}.</span>
        <AddYourselfLink />
      </div>
    </div>
  );
}

export function MemberLockNotice({ siteId, className }: { siteId: string | null | undefined; className?: string }) {
  if (!useMemberLock(siteId)) return null;
  return (
    <div
      data-testid="member-lock"
      role="status"
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-card px-3 py-2 text-sm', className)}
    >
      <Lock className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
      <span className="text-foreground">{MEMBER_LOCK_HINT}.</span>
      <AddYourselfLink />
    </div>
  );
}

/** the hint, small, in a row of a table of sites (admin panel → swoop). */
export function MemberLockRowHint({ siteId }: { siteId: string }) {
  if (!useMemberLock(siteId)) return null;
  return (
    <span data-testid="member-lock" className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
      {MEMBER_LOCK_HINT}.
      <AddYourselfLink />
    </span>
  );
}

/**
 * an admin section that acts on one site: the notice above it, and every
 * control in it disabled, the way a disabled fieldset disables its form controls,
 * so its values still read. its actions (save, add, edit, delete) are hidden where
 * they are drawn, as a role-locked action is. links keep working: they only navigate.
 */
export function MemberLockSection({ siteId, children }: { siteId: string | null | undefined; children: ReactNode }) {
  const locked = useMemberLock(siteId);
  return (
    <>
      {locked && <MemberLockNotice siteId={siteId} className="mb-4" />}
      <fieldset disabled={locked} className="contents">
        {children}
      </fieldset>
    </>
  );
}
