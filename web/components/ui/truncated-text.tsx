'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * One line of text that truncates, and reveals itself on hover ONLY when it is
 * actually clipped.
 *
 * A tooltip that repeats text already fully on screen is noise: it covers the
 * row to tell you what you just read, and it trains people to ignore the one
 * tooltip that did have something to say. So the wrapper is conditional, not
 * the content — an unclipped cell renders a bare span with no trigger, no
 * `cursor-help`, and nothing to hover.
 *
 * Use it for cells whose tooltip would only REPEAT the cell. A tooltip that
 * adds something the cell does not show — a relative time's absolute stamp, an
 * error behind a summary — must stay unconditional and is not this component.
 */
export function TruncatedText({
  text,
  className,
  tooltip,
  side,
  'data-testid': testId,
}: {
  /** The line to render. Also the tooltip body unless `tooltip` overrides it. */
  text: string;
  className?: string;
  /** Richer tooltip body. Still only shown when the text is clipped. */
  tooltip?: React.ReactNode;
  side?: React.ComponentProps<typeof TooltipContent>['side'];
  'data-testid'?: string;
}) {
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [isClipped, setIsClipped] = useState(false);

  const measure = useCallback((el: HTMLSpanElement | null) => {
    if (!el) return;
    // 1px tolerance: `scrollWidth` rounds up on fractional layouts, so an exact
    // fit can report a permanent 1px overflow and tooltip text that fits.
    setIsClipped(el.scrollWidth > el.clientWidth + 1);
  }, []);

  // A callback ref, not an effect: flipping `isClipped` re-parents the span into
  // a TooltipTrigger, which remounts it. An effect holding the first element
  // would keep observing a detached node and never see another resize.
  const attach = useCallback(
    (el: HTMLSpanElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      nodeRef.current = el;
      if (!el) return;
      measure(el);
      // ResizeObserver, not a window listener: these sit in grid and flex
      // columns that change width when a sibling or the container does, with no
      // window event to hear. Guarded — jsdom has no ResizeObserver.
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => measure(el));
      observer.observe(el);
      observerRef.current = observer;
    },
    [measure],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  // New text in the same box resizes nothing, so ResizeObserver stays silent.
  useEffect(() => {
    measure(nodeRef.current);
  }, [measure, text]);

  const content = (
    <span
      ref={attach}
      data-testid={testId}
      className={cn('truncate', isClipped && 'cursor-help', className)}
    >
      {text}
    </span>
  );

  if (!isClipped) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side={side}>
        <p className="max-w-sm whitespace-pre-wrap break-words">{tooltip ?? text}</p>
      </TooltipContent>
    </Tooltip>
  );
}
