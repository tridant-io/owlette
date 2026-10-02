'use client';

/**
 * the keyboard menu: the modifier setting (shortcuts match, or keys match)
 * with a legend of what the three modifiers do on this machine under it; the
 * combinations the browser or the viewer's own windows keeps for itself, sent
 * as chords on the input channel, and ctrl+alt+del as the secure-attention
 * control message; and, outside fullscreen, a sticky super key, since the
 * viewer's own system keeps that key until keyboard lock is held. the list is
 * the host's own, by its system. all of it needs `ctl`; a view-only session
 * sees the menu disabled rather than absent, so the affordance is learnable.
 */

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { MachineOsFamily } from '@/lib/machineOs';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { hasKeyboardLock } from '@/lib/swoop/keyboardLock';
import { isMacViewer, modifierSwap, type ModifierMapping, type ModifierSwap } from '@/lib/swoop/keymap';
import { modifierLegend } from '@/lib/swoop/modifierLegend';
import { decodeControlMessage } from '@/lib/swoop/protocol';
import { sendSpecialKey, specialKeysFor } from '@/lib/swoop/specialKeys';

/** the two settings, named for what each keeps the same. */
const SETTING_LABELS: Readonly<Record<ModifierSwap, Readonly<Record<ModifierMapping, string>>>> = {
  'ctrl-to-cmd': {
    swap: 'shortcuts match: ctrl acts as cmd',
    passthrough: 'keys match: ctrl is control',
  },
  'cmd-to-ctrl': {
    swap: 'shortcuts match: cmd acts as ctrl',
    passthrough: 'keys match: cmd is the windows key',
  },
};

const subscribeNever = (): (() => void) => () => {};
const onServer = (): boolean => false;
const subscribeFullscreen = (listener: () => void): (() => void) => {
  document.addEventListener('fullscreenchange', listener);
  return () => document.removeEventListener('fullscreenchange', listener);
};
// a browser without the api has no element, which is not fullscreen either
const inFullscreen = (): boolean => Boolean(document.fullscreenElement);

export interface SwoopSpecialKeysProps {
  session: SwoopSession | null;
  /** the machine's system; windows when it reports none. */
  osFamily: MachineOsFamily;
}

export function SwoopSpecialKeys({ session, osFamily }: SwoopSpecialKeysProps) {
  const [note, setNote] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ModifierMapping>('swap');
  const viewerIsMac = useSyncExternalStore(subscribeNever, isMacViewer, onServer);
  const keyboardLock = useSyncExternalStore(subscribeNever, hasKeyboardLock, onServer);
  const fullscreen = useSyncExternalStore(subscribeFullscreen, inFullscreen, onServer);
  const swap = modifierSwap(osFamily, viewerIsMac);
  const legend = modifierLegend(osFamily, viewerIsMac, mapping);
  const superKey = viewerIsMac ? 'cmd' : 'the windows key';
  // a sent key is the machine's, so the keyboard goes back to the picture with
  // it. a closing menu hands focus to its own button, where the "next key" of
  // a hold would land and never reach the machine.
  const sent = useRef(false);

  useEffect(() => {
    if (!session) return;
    return session.onChannelMessage('swoop-control', (data) => {
      const decoded = decodeControlMessage(data);
      if (!decoded.ok || decoded.value.t !== 'sas-result') return;
      setNote(decoded.value.ok ? null : 'ctrl + alt + del was refused by the machine.');
    });
  }, [session]);

  useEffect(() => {
    swoopInputCapture(session)?.setModifierMapping(osFamily, mapping);
  }, [session, osFamily, mapping]);

  const enabled = session !== null && session.ctl;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="send a key combination" disabled={!enabled}>
          <Keyboard aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        onCloseAutoFocus={(event) => {
          if (!sent.current) return;
          sent.current = false;
          event.preventDefault();
          session?.stage.focus();
        }}
      >
        {swap && (
          <>
            <DropdownMenuLabel>modifier keys</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={mapping}
              onValueChange={(value) => setMapping(value === 'passthrough' ? 'passthrough' : 'swap')}
            >
              <DropdownMenuRadioItem value="swap">{SETTING_LABELS[swap].swap}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="passthrough">{SETTING_LABELS[swap].passthrough}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        )}
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-4 px-2 py-1.5 text-xs text-muted-foreground"
          aria-label="what your keys do on the machine"
          data-testid="modifier-legend"
        >
          {legend.map((row) => (
            <Fragment key={row.press}>
              <dt>{row.press}</dt>
              <dd>{row.gets}</dd>
            </Fragment>
          ))}
        </dl>
        {!fullscreen && (
          <p className="px-2 pb-1.5 text-xs text-muted-foreground" data-testid="super-key-note">
            {keyboardLock
              ? `${superKey} reaches the machine in fullscreen`
              : `this browser keeps ${superKey} for itself`}
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>send keys</DropdownMenuLabel>
        {specialKeysFor(osFamily, fullscreen).map((key) => (
          <DropdownMenuItem
            key={key.id}
            className="cursor-pointer justify-between"
            onSelect={() => {
              if (!session) return;
              setNote(null);
              sent.current = sendSpecialKey({ send: session.send, capture: swoopInputCapture(session) }, key);
              if (!sent.current) setNote('that key could not be sent right now.');
            }}
          >
            <span>{key.label}</span>
            {key.hint && <span className="text-xs text-muted-foreground">{key.hint}</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          these are the shortcuts your browser or your own windows keeps. in fullscreen most
          others reach the machine directly.
        </p>
        {note && <p className="px-2 pb-1.5 text-xs text-destructive">{note}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
