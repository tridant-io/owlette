'use client';

/**
 * the keyboard menu: the combinations the browser or the viewer's own windows
 * keeps for itself, sent as chords on the input channel, and ctrl+alt+del as
 * the secure-attention control message. the list is the host's own, by its
 * system, and above it sits the one modifier choice this host and viewer have,
 * when they have one; it drives the input capture's mapping. all of it needs
 * `ctl`; a view-only session sees the menu disabled rather than absent, so the
 * affordance is learnable.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { MachineOsFamily } from '@/lib/machineOs';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { isMacViewer, modifierSwap, type ModifierMapping, type ModifierSwap } from '@/lib/swoop/keymap';
import { decodeControlMessage } from '@/lib/swoop/protocol';
import { sendSpecialKey, specialKeysFor } from '@/lib/swoop/specialKeys';

const SWAP_LABELS: Readonly<Record<ModifierSwap, string>> = {
  'ctrl-to-cmd': 'ctrl acts as cmd',
  'cmd-to-ctrl': 'cmd acts as ctrl',
};

const subscribeNever = (): (() => void) => () => {};
const onServer = (): boolean => false;

export interface SwoopSpecialKeysProps {
  session: SwoopSession | null;
  /** the machine's system; windows when it reports none. */
  osFamily: MachineOsFamily;
}

export function SwoopSpecialKeys({ session, osFamily }: SwoopSpecialKeysProps) {
  const [note, setNote] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ModifierMapping>('swap');
  // the server has no navigator; hydration fills it in.
  const viewerIsMac = useSyncExternalStore(subscribeNever, isMacViewer, onServer);
  const swap = modifierSwap(osFamily, viewerIsMac);

  // the host answers a sas with sas-result; a refusal is the one outcome the
  // viewer cannot see on the screen, so it is said here.
  useEffect(() => {
    if (!session) return;
    return session.onChannelMessage('swoop-control', (data) => {
      const decoded = decodeControlMessage(data);
      if (!decoded.ok || decoded.value.t !== 'sas-result') return;
      setNote(decoded.value.ok ? null : 'ctrl + alt + del was refused by the machine.');
    });
  }, [session]);

  // each session attaches a capture of its own, and the machine's system can
  // arrive after it did, so the choice is handed over again on every change.
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
      <DropdownMenuContent align="end" className="w-64">
        {swap && (
          <>
            <DropdownMenuCheckboxItem
              checked={mapping === 'swap'}
              onCheckedChange={(checked) => setMapping(checked ? 'swap' : 'passthrough')}
            >
              {SWAP_LABELS[swap]}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>send keys</DropdownMenuLabel>
        {specialKeysFor(osFamily).map((key) => (
          <DropdownMenuItem
            key={key.id}
            className="cursor-pointer justify-between"
            onSelect={() => {
              if (!session) return;
              setNote(null);
              if (!sendSpecialKey({ send: session.send, capture: swoopInputCapture(session) }, key)) {
                setNote('that key could not be sent right now.');
              }
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
