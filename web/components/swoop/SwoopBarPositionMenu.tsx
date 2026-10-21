'use client';

/**
 * where the session bar sits: auto, top, left or right. the icon shows where it
 * is now, auto included. needs no session, so it works while connecting too,
 * and it is hidden on narrow screens, where the bar always runs along the top.
 */

import { useSyncExternalStore } from 'react';
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
import {
  readBarChoice,
  setBarChoice,
  subscribeBarPosition,
  type SwoopBarChoice,
  type SwoopBarPosition,
} from '@/lib/swoop/barPosition';
import { useBarMenuPlacement } from '@/components/swoop/barMenuPlacement';
import { BarTooltip } from '@/components/swoop/BarTooltip';

const ICON = { top: PanelTop, left: PanelLeft, right: PanelRight } as const;
const CHOICES: { value: SwoopBarChoice; hint?: string }[] = [
  { value: 'auto', hint: 'biggest picture' },
  { value: 'top' },
  { value: 'left' },
  { value: 'right' },
];
const choseAuto = (): SwoopBarChoice => 'auto';

export function SwoopBarPositionMenu({ position }: { position: SwoopBarPosition }) {
  const menuPlacement = useBarMenuPlacement();
  const choice = useSyncExternalStore(subscribeBarPosition, readBarChoice, choseAuto);
  const Icon = ICON[position];
  return (
    <DropdownMenu>
      <BarTooltip label="bar position" className="max-md:hidden">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="bar position">
            <Icon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </BarTooltip>
      <DropdownMenuContent {...menuPlacement} align="end" className="w-56">
        <DropdownMenuLabel>bar position</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={choice} onValueChange={(value) => setBarChoice(value as SwoopBarChoice)}>
          {CHOICES.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.value}
              {option.hint && <span className="ml-auto text-xs text-muted-foreground">{option.hint}</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
