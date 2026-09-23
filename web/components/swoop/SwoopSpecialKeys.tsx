'use client';

/**
 * the keyboard menu: the combinations the browser or the viewer's own windows
 * keeps for itself, sent as chords on the input channel, and ctrl+alt+del as
 * the secure-attention control message. all of it needs `ctl`; a view-only
 * session sees the menu disabled rather than absent, so the affordance is
 * learnable.
 */

import { useEffect, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { decodeControlMessage } from '@/lib/swoop/protocol';
import { SPECIAL_KEYS, sendSpecialKey } from '@/lib/swoop/specialKeys';

export interface SwoopSpecialKeysProps {
  session: SwoopSession | null;
}

export function SwoopSpecialKeys({ session }: SwoopSpecialKeysProps) {
  const [note, setNote] = useState<string | null>(null);

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

  const enabled = session !== null && session.ctl;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="send a key combination" disabled={!enabled}>
          <Keyboard aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>send keys</DropdownMenuLabel>
        {SPECIAL_KEYS.map((key) => (
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
