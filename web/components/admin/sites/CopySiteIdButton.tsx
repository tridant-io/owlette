'use client';

import type { ReactNode } from 'react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

async function copySiteId(siteId: string) {
  try {
    await navigator.clipboard.writeText(siteId);
    toast.success('site ID copied');
  } catch {
    toast.error('could not copy the site ID');
  }
}

/** a site's ID that copies itself on a click. children stand in for the ID shown, as the site list's filter highlight does. */
export function CopySiteIdButton({
  siteId,
  className,
  children = siteId,
}: {
  siteId: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => void copySiteId(siteId)}
      aria-label={`copy site ID ${siteId}`}
      className={cn('max-w-full cursor-pointer text-left font-mono text-muted-foreground hover:text-accent-cyan', className)}
    >
      {children}
    </button>
  );
}
