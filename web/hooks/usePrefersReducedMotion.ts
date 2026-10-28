import { useMediaQuery } from '@/hooks/useMediaQuery';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** whether the visitor asked for less motion, kept live; see `useMediaQuery` for `serverValue`. */
export function usePrefersReducedMotion(serverValue: boolean): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY, serverValue);
}
