'use client';

/**
 * where the session bar sits: top, left or right. the icon shows where it is
 * now. needs no session, so it works while connecting too, and it is hidden on
 * narrow screens, where the bar always runs along the top.
 */

import { PanelLeft, PanelRight, PanelTop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setBarPosition, type SwoopBarPosition } from '@/lib/swoop/barPosition';
import { useBarMenuPlacement } from '@/components/swoop/barMenuPlacement';

const ICON = { top: PanelTop, left: PanelLeft, right: PanelRight } as const;
const POSITIONS: SwoopBarPosition[] = ['top', 'left', 'right'];

export function SwoopBarPositionMenu({ position }: { position: SwoopBarPosition }) {
  const menuPlacement = useBarMenuPlacement();
  const Icon = ICON[position];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="bar position" className="max-md:hidden">
          <Icon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent {...menuPlacement} align="end" className="w-40">
        <DropdownMenuLabel>bar position</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={position}
          onValueChange={(value) => setBarPosition(value as SwoopBarPosition)}
        >
          {POSITIONS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {option}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
