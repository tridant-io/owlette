'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const STAGGER_WINDOW_MS = 1500;

/**
 * A page root that fades in one row after another (`page-cascade` in
 * globals.css). The stagger only runs while the page opens: after the window a
 * row that is added, moved or expanded fades in at once instead of waiting for
 * its turn. A class, not CSS alone, because a custom property animated in
 * @keyframes is ignored inside animation-delay.
 */
export function PageCascade({ className, children }: { className?: string; children: React.ReactNode }) {
  const [opening, setOpening] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setOpening(false), STAGGER_WINDOW_MS);
    return () => clearTimeout(timer);
  }, []);
  return <div className={cn('page-cascade', opening && 'page-cascade-opening', className)}>{children}</div>;
}
