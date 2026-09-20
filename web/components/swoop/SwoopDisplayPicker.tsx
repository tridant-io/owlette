'use client';

/**
 * which output the host captures.
 *
 * the host keys outputs by a stable device path, never an index — a virtual
 * display driver moves indices. the path does not fit on the wire (`hello-host`
 * carries `{index, width, height, primary}` and `signal/messages.rs` is frozen),
 * so an index is what a switch names and the host resolves it against the
 * roster it holds. sizes are the ENCODED texture's, so a portrait panel reads
 * landscape here — that is what this browser will actually be shown.
 *
 * the choice is shared state: switching moves the picture for everyone watching,
 * which is why the host gates it on `ctl` and why the footer says so.
 *
 * **there is no headless message here.** a machine with no attached output
 * fails to start a streamer at all (exit 12), so a viewer never reaches this
 * page, and a machine that loses its outputs mid-session reports `displays:
 * "headless"` on §6's `status` — host→service, with no host→viewer field to
 * carry it. the dummy-plug message belongs on the machine's dashboard page,
 * which reads that status; inventing a wire convention for it here would be a
 * second protocol.
 */

import { useSyncExternalStore } from 'react';
import { Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NO_DISPLAYS, swoopDisplays } from '@/lib/swoop/displays';
import type { SwoopSession } from '@/lib/swoop/features';

const subscribeNever = (): (() => void) => () => {};
const noDisplays = () => NO_DISPLAYS;

export interface SwoopDisplayPickerProps {
  session: SwoopSession | null;
}

export function SwoopDisplayPicker({ session }: SwoopDisplayPickerProps) {
  const store = swoopDisplays(session);
  const state = useSyncExternalStore(
    store?.subscribe ?? subscribeNever,
    store?.get ?? noDisplays,
    // the server has no session and no channel, so it renders the empty case
    // and hydration fills it in once `hello-host` lands.
    noDisplays,
  );

  // one output is not a choice, and neither is none. the toolbar carries enough
  // without a control that can only confirm what is already on screen.
  if (state.displays.length < 2) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="display">
          <Monitor aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>display</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={state.selected === null ? '' : String(state.selected)}
          onValueChange={(value) => store?.select(Number(value))}
        >
          {state.displays.map((display) => (
            <DropdownMenuRadioItem
              key={display.index}
              value={String(display.index)}
              disabled={!session?.ctl}
            >
              <span className="flex flex-col">
                <span>
                  display {display.index + 1}
                  {display.primary && ' · primary'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {display.width}×{display.height}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {session?.ctl
            ? 'switching moves the picture for everyone watching.'
            : 'view only — whoever holds control chooses the display.'}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
