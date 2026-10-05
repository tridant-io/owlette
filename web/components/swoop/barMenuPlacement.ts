'use client';

/**
 * where a menu in the session bar opens: down from a top bar, toward the
 * picture from a side one, clear of the bar itself rather than just of the
 * button. the bar provides it; its menus spread it onto their content, so a
 * menu never opens over the column of buttons it came from.
 */

import { createContext, useContext } from 'react';
import type { SwoopBarPosition } from '@/lib/swoop/barPosition';

interface MenuPlacement {
  side: 'bottom' | 'right' | 'left';
  sideOffset?: number;
}

const ON_TOP: MenuPlacement = { side: 'bottom' };
// a 32 px button in a 44 px bar: 6 px to the bar's edge, and 4 beyond it
const BESIDE = 10;

export const SwoopBarMenuPlacement = createContext<MenuPlacement>(ON_TOP);

export function menuPlacementFor(position: SwoopBarPosition): MenuPlacement {
  if (position === 'left') return { side: 'right', sideOffset: BESIDE };
  if (position === 'right') return { side: 'left', sideOffset: BESIDE };
  return ON_TOP;
}

export function useBarMenuPlacement(): MenuPlacement {
  return useContext(SwoopBarMenuPlacement);
}
