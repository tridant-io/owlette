'use client';

import React from 'react';
import { ChevronDown, Globe, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  formatTargetLabel,
  normalizeSelection,
  toggleAll,
  toggleMachine,
  type HootTarget,
} from '@/lib/hoot/target';

/** One row: the id IS the target, the two flags are the status text beside it. */
export interface MachineTargetOption {
  id: string;
  online: boolean;
  hootEnabled: boolean;
}

interface MachineTargetPickerProps {
  machines: MachineTargetOption[];
  selection: HootTarget;
  onChange: (next: HootTarget) => void;
}

/**
 * Why a machine can't take this turn, as TEXT rather than a colour: the rows are
 * the only place a skipped machine is named before the turn is sent, and a dot
 * says nothing to a screen reader or to anyone reading the menu in a hurry. Both
 * reasons show when both apply — an offline machine with hoot off stays skipped
 * after it comes back.
 */
function statusText(machine: MachineTargetOption): string | null {
  const reasons: string[] = [];
  if (!machine.online) reasons.push('offline');
  if (!machine.hootEnabled) reasons.push('hoot off');
  return reasons.length > 0 ? reasons.join(', ') : null;
}

/**
 * The small print beside a row's name. `--muted-foreground` over the focused
 * row's `--accent` fill is 4.37:1 in dark — under the 4.5:1 that axe's
 * `color-contrast` rule enforces on /hoot — so the focused row alone gets a
 * stronger tone and every other row keeps the muted hierarchy. by day the muted
 * token already clears it (5.39:1), and the same class reads one step darker at
 * 8.09:1. Radix focuses a row on pointer move, so this covers hover too; the
 * rows carry `group` for it.
 */
const STATUS_TEXT_CLASS = 'text-xs text-muted-foreground group-focus:text-accent-foreground/80';

/**
 * The header's "which machines does this chat talk to" control: a checkbox menu
 * over the site's machines, with a tri-state "all machines" master row.
 *
 * "All" is DYNAMIC (`machineIds: null`), so the master row is not a shortcut for
 * ticking every box — it is a different value, and the reducers in
 * `lib/hoot/target.ts` own the difference. Unticking one machine spells the rest
 * out; ticking the last missing one collapses back to null.
 */
/**
 * Which of a row's two jobs the last interaction asked for. A row is ONE
 * `menuitemcheckbox` — putting a real checkbox control inside a menu item would
 * be the nested-interactive violation the /hoot axe gate fails on — so the two
 * jobs are told apart by what was hit, and the answer is stashed here for the
 * `onSelect` that follows.
 *
 * Pointer: the box toggles this machine within the set, the name selects only
 * it. Keyboard keeps parity rather than losing half the control: Space is the
 * checkbox's own key and toggles, Enter is the row's primary action and selects
 * only that machine.
 */
type RowIntent = 'toggle' | 'only';

export function MachineTargetPicker({ machines, selection, onChange }: MachineTargetPickerProps) {
  const intentRef = React.useRef<RowIntent>('toggle');

  const noteIntentFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    intentRef.current = target?.closest('[data-checkbox-box]') ? 'toggle' : 'only';
  };

  const noteIntentFromKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ') intentRef.current = 'toggle';
    else if (event.key === 'Enter') intentRef.current = 'only';
  };

  const siteMachineIds = machines.map((machine) => machine.id);
  const selected = selection.machineIds;
  const isTicked = (id: string) => selected === null || selected.includes(id);

  // Tri-state master row. An explicit set that covers every machine reads as
  // ticked, not mixed: `normalizeSelection` collapses that set to null, but a
  // selection restored from a chat doc reaches this render before the machine
  // list it would be normalized against.
  const tickedCount = machines.filter((machine) => isTicked(machine.id)).length;
  const allChecked: boolean | 'indeterminate' =
    selected === null || (machines.length > 0 && tickedCount === machines.length)
      ? true
      : tickedCount === 0
        ? false
        : 'indeterminate';

  const siteOnlineCount = machines.filter((machine) => machine.online).length;
  // The trigger's count is REACHABILITY of the current target, not its size: how
  // many of the ticked machines are online. For "all machines" that is the site's
  // online count, which is the number the old single-select trigger showed.
  const targetOnlineCount = machines.filter(
    (machine) => machine.online && isTicked(machine.id),
  ).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* `w-full max-w-[220px] min-w-0` rather than a hard `w-[220px]`: the
            control shares a row with the sidebar toggle and the approval/power
            toggles, which at a 390px viewport leaves it well under 220px.
            Capping keeps the desktop width identical while letting the trigger
            shrink and its label truncate. `min-w-0` is required — a flex item's
            automatic minimum size would otherwise hold it at its content width
            and push the row into the horizontal overflow the mobile gate fails
            on. `aria-label` is how four e2e specs find this control. */}
        <Button
          variant="secondary"
          aria-label="hoot target"
          className="w-full max-w-[220px] min-w-0 flex-1 basis-0 md:flex-initial md:basis-auto justify-between border border-border font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected === null ? (
              <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="truncate">{formatTargetLabel(selected)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            ({targetOnlineCount})
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[240px]">
        <DropdownMenuCheckboxItem
          className="group"
          checked={allChecked}
          onPointerDown={noteIntentFromPointer}
          onKeyDown={noteIntentFromKey}
          // `preventDefault` keeps the menu open. Picking a set takes several
          // clicks, and Radix closes the menu on any select event it is left to
          // handle — so a reopen per machine would be the cost of not doing this.
          onSelect={(event) => {
            event.preventDefault();
            // The name means "talk to everything", which is the dynamic null —
            // not a set that happens to cover today's machines. The box keeps
            // the checkbox's own meaning: all on, or all off.
            onChange(
              intentRef.current === 'only'
                ? { machineIds: null }
                : toggleAll(selection, siteMachineIds),
            );
          }}
        >
          <span className="flex-1 truncate">all machines</span>
          <span className={STATUS_TEXT_CLASS}>{siteOnlineCount} online</span>
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />

        {machines.length === 0 ? (
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            no machines in this site
          </DropdownMenuLabel>
        ) : (
          machines.map((machine) => {
            const status = statusText(machine);
            return (
              <DropdownMenuCheckboxItem
                key={machine.id}
                className="group"
                checked={isTicked(machine.id)}
                onPointerDown={noteIntentFromPointer}
                onKeyDown={noteIntentFromKey}
                onSelect={(event) => {
                  event.preventDefault();
                  // The name is the fast path off "all machines": this one, and
                  // nothing else. `normalizeSelection` keeps a one-machine site
                  // on the dynamic null rather than freezing today's only id.
                  onChange(
                    intentRef.current === 'only'
                      ? normalizeSelection({ machineIds: [machine.id] }, siteMachineIds, true)
                      : toggleMachine(selection, machine.id, siteMachineIds),
                  );
                }}
              >
                <span className="flex-1 truncate">{machine.id}</span>
                {status !== null && <span className={STATUS_TEXT_CLASS}>{status}</span>}
              </DropdownMenuCheckboxItem>
            );
          })
        )}

      </DropdownMenuContent>
    </DropdownMenu>
  );
}
