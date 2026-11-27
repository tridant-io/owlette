'use client';

import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { Monitor } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import type { ListedMachine } from '@/hooks/useMachinesBySite';
import type { MachineOnlineState } from '@/lib/machineOnline';
import { listedMachineState, machineLastSeen, MACHINE_STATE_DOT, MACHINE_STATE_TEXT } from '@/lib/machineStateLabel';

/** a site's machines as the list knows them: still loading, not loaded (or not the caller's to read), or the list */
export type SiteMachinesState = 'loading' | 'failed' | readonly ListedMachine[];

/** the card lists this many machines, then sums the rest */
const CARD_ROWS = 12;

// trouble first, so a long site never cuts it off
const RANK: Record<MachineOnlineState, number> = { offline: 0, asleep: 1, online: 2 };

// the admin panel's tooltip delay, and a beat to cross the gap into the card
const OPEN_DELAY_MS = 100;
const CLOSE_DELAY_MS = 150;

function tally(machines: readonly ListedMachine[]) {
  let online = 0;
  let asleep = 0;
  for (const m of machines) {
    const state = listedMachineState(m);
    if (state === 'online') online++;
    else if (state === 'asleep') asleep++;
  }
  return { total: machines.length, online, asleep, offline: machines.length - online - asleep };
}

function machinesWord(n: number): string {
  return `${n} ${n === 1 ? 'machine' : 'machines'}`;
}

function cellLabel({ total, online, asleep, offline }: ReturnType<typeof tally>): string {
  const machines = machinesWord(total);
  if (online === total) return `${machines}, all online`;
  if (offline === total) return `${machines}, all offline`;
  if (asleep === total) return `${machines}, all asleep`;
  return `${machines}: ${online} online${asleep ? `, ${asleep} asleep` : ''}${offline ? `, ${offline} offline` : ''}`;
}

function sortForCard(machines: readonly ListedMachine[]): ListedMachine[] {
  return [...machines].sort(
    (a, b) => RANK[listedMachineState(a)] - RANK[listedMachineState(b)] || a.name.localeCompare(b.name),
  );
}

function MachinesCard({ siteName, machines }: { siteName: string; machines: readonly ListedMachine[] }) {
  const sorted = sortForCard(machines);
  const { total, online } = tally(machines);
  const rest = sorted.slice(CARD_ROWS);
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2.5">
        <span className="truncate text-[13px] font-medium">{siteName}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {online} of {total} online
        </span>
      </div>
      <ul className="py-1">
        {sorted.slice(0, CARD_ROWS).map((m) => {
          const state = listedMachineState(m);
          return (
            <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto_76px] items-center gap-x-3 px-3 py-1 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${MACHINE_STATE_DOT[state]}`} />
                <Monitor aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate" title={m.name}>{m.name}</span>
              </span>
              <span className={`whitespace-nowrap text-[11px] ${MACHINE_STATE_TEXT[state]}`}>{machineLastSeen(m)}</span>
              <span className="truncate text-right font-mono text-[11px] text-muted-foreground">
                {m.agentVersion ? `v${m.agentVersion}` : '—'}
              </span>
            </li>
          );
        })}
        {rest.length > 0 && (
          <li className="py-1 pr-3 pl-[46px] text-[11px] text-muted-foreground">
            + {rest.length} more{rest.every((m) => listedMachineState(m) === 'online') ? ', all online' : ''}
          </li>
        )}
      </ul>
    </>
  );
}

/**
 * md up: a site's machine count and what is not online, as a button whose card
 * lists the machines. hover, keyboard focus or a tap opens it; it leads nowhere.
 * a popover, not a tooltip: radix's tooltip ignores a touch, so a tablet would get a dead button.
 */
function MachinesButton({ siteName, machines }: { siteName: string; machines: readonly ListedMachine[] }) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the pointer that pressed the button, so its focus and click are told from a keyboard's
  const pressedWith = useRef<string | null>(null);
  const counts = tally(machines);

  const later = (next: boolean, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  // hover is a mouse's: a finger's enter and leave come with its tap
  const hoverOpen = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') later(true, OPEN_DELAY_MS);
  };
  const hoverClose = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') later(false, CLOSE_DELAY_MS);
  };
  const hoverStay = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') cancel();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        cancel();
        setOpen(next);
      }}
    >
      <PopoverAnchor asChild>
        <button
          ref={anchorRef}
          type="button"
          aria-label={cellLabel(counts)}
          aria-describedby={open ? cardId : undefined}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          onPointerDown={(e) => {
            pressedWith.current = e.pointerType;
          }}
          onPointerCancel={() => {
            pressedWith.current = null;
          }}
          onFocus={() => {
            if (pressedWith.current === null) setOpen(true);
          }}
          onBlur={() => {
            pressedWith.current = null;
          }}
          onClick={() => {
            // a tap toggles; a mouse or a key only opens, so a click never closes what hover opened
            const touch = pressedWith.current === 'touch' || pressedWith.current === 'pen';
            pressedWith.current = null;
            cancel();
            setOpen((was) => (touch ? !was : true));
          }}
          // wraps rather than spill into the next column on a narrow md screen
          className="-ml-1.5 inline-flex max-w-full min-w-0 cursor-help flex-wrap items-center gap-x-2 rounded-lg px-1.5 py-0.5 text-left text-xs text-muted-foreground outline-none focus-visible:bg-[var(--surface-hover)]"
        >
          <span className="font-medium tabular-nums text-foreground">{counts.total}</span>
          {counts.online === counts.total && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />}
          {counts.offline > 0 && (
            <span className="whitespace-nowrap text-danger">
              {counts.offline === counts.total ? 'all offline' : `${counts.offline} offline`}
            </span>
          )}
          {counts.asleep > 0 && (
            <span className="whitespace-nowrap text-info">
              {counts.asleep === counts.total ? 'all asleep' : `${counts.asleep} asleep`}
            </span>
          )}
        </button>
      </PopoverAnchor>
      <PopoverContent
        id={cardId}
        role="tooltip"
        align="start"
        alignOffset={-2}
        sideOffset={6}
        collisionPadding={16}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        onPointerEnter={hoverStay}
        onPointerLeave={hoverClose}
        className="w-[380px] max-w-[calc(100vw-2rem)] rounded-lg p-0 shadow-[0_12px_32px_var(--elevation-shadow)]"
      >
        <MachinesCard siteName={siteName} machines={machines} />
      </PopoverContent>
    </Popover>
  );
}

/** the machines column's cell, md up */
export function SiteMachinesCell({ siteName, state }: { siteName: string; state: SiteMachinesState }) {
  if (state === 'loading') {
    return <span role="img" aria-label="loading machines" className="block h-3 w-11 rounded bg-muted motion-safe:animate-pulse" />;
  }
  if (state === 'failed') {
    return (
      <span className="text-muted-foreground" title="machines did not load">
        <span aria-hidden="true">—</span>
        <span className="sr-only">machines did not load</span>
      </span>
    );
  }
  if (state.length === 0) {
    return (
      <span className="tabular-nums text-muted-foreground" title="no machines on this site">
        <span aria-hidden="true">0</span>
        <span className="sr-only">no machines</span>
      </span>
    );
  }
  return <MachinesButton siteName={siteName} machines={state} />;
}

/** a phone row's machines, on its second line: no card, the count and what is not online */
export function SiteMachinesSummary({ state }: { state: Exclude<SiteMachinesState, 'failed'> }) {
  if (state === 'loading') {
    return <span role="img" aria-label="loading machines" className="block h-3 w-16 rounded bg-muted motion-safe:animate-pulse" />;
  }
  const { total, online, asleep, offline } = tally(state);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{total === 0 ? 'no machines' : machinesWord(total)}</span>
      {total > 0 && online === total && (
        <span role="img" aria-label="all online" className="size-[7px] shrink-0 rounded-full bg-success" />
      )}
      {offline > 0 && <span className="text-danger">{offline === total ? 'offline' : `${offline} offline`}</span>}
      {asleep > 0 && <span className="text-info">{asleep === total ? 'asleep' : `${asleep} asleep`}</span>}
    </span>
  );
}
