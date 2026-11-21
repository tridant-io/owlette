'use client';

import { useLayoutEffect, useRef } from 'react';
import { osLabelCandidates } from '@/lib/osLabel';

/**
 * The OS line under a hostname. Renders the full string, then fits the box by
 * writing the longest form from `osLabelCandidates` that does not overflow
 * straight into the DOM, again whenever the box is resized. The DOM is the
 * external system here, so no state churns: React owns the full string (and
 * the title, which always carries it), the effect owns the abbreviation.
 */
export default function OsLabel({
  osVersion,
  className = '',
  testId = 'machine-os-version',
}: {
  osVersion: string;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const candidates = osLabelCandidates(osVersion);
    const fit = () => {
      for (const candidate of candidates) {
        el.textContent = candidate;
        if (el.scrollWidth <= el.clientWidth) return;
      }
      // the shortest form still overflows: the css ellipsis is the floor
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [osVersion]);

  return (
    <span ref={ref} data-testid={testId} className={`block truncate ${className}`} title={osVersion}>
      {osVersion}
    </span>
  );
}
