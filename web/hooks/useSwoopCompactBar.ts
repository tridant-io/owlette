import { useMediaQuery } from '@/hooks/useMediaQuery';

/** tailwind's `md`. */
const WIDE = '(min-width: 768px)';
const TOUCH = '(pointer: coarse)';

/**
 * whether swoop's session bar folds its controls into one menu: below `md`,
 * where they don't fit a row, or on any touch screen, which has no hover to
 * read a tooltip with.
 */
export function useSwoopCompactBar(): boolean {
  const wide = useMediaQuery(WIDE, true);
  const touch = useMediaQuery(TOUCH, false);
  return !wide || touch;
}
