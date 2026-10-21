/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MachineTargetPicker — the checkbox menu that decides which machines a hoot
 * chat talks to.
 *
 * Two properties carry the weight here. The first is that "all machines" is a
 * DYNAMIC value (`machineIds: null`), not a ticked box per machine: unticking one
 * has to spell the rest out, and ticking the last missing one has to collapse
 * back to null, or a machine added to the site later would quietly stop being
 * targeted. The second is that the menu survives a toggle — picking a set is
 * several clicks, and Radix closes a menu on any select event left to it.
 *
 * The trigger's classes are asserted on purpose: the 390px e2e gate fails on any
 * horizontal document overflow, and this control is the widest thing in the hoot
 * header row.
 *
 * The rendered target itself is not on trial — `__tests__/lib/hoot/target.test.ts`
 * owns the reducers. What is on trial is that the picker calls them with the
 * site's machines and renders what comes back.
 */
import React, { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MachineTargetPicker } from '@/app/hoot/components/MachineTargetPicker';
import type { HootTarget } from '@/lib/hoot/target';

// jsdom ships no ResizeObserver; Radix's menu positioning constructs one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix menus drive the trigger with pointer capture and scroll the focused item
// into view — jsdom has neither.
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.setPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

const MACHINES = [
  { id: 'kiosk-01', online: true, hootEnabled: true },
  { id: 'kiosk-02', online: false, hootEnabled: true },
  { id: 'kiosk-03', online: true, hootEnabled: false },
];

const ALL: HootTarget = { machineIds: null };

/** The master row's accessible name over `MACHINES`: two of the three are online. */
const MASTER_ROW = 'all machines 2 online';

/**
 * The picker is controlled, so the harness holds the selection: a toggle that
 * did not come back as a new `selection` prop would otherwise look green while
 * the menu showed a stale set.
 */
function Harness({
  initial,
  machines,
  onChange,
}: {
  initial: HootTarget;
  machines: React.ComponentProps<typeof MachineTargetPicker>['machines'];
  onChange: (next: HootTarget) => void;
}) {
  const [selection, setSelection] = useState<HootTarget>(initial);
  return (
    <MachineTargetPicker
      machines={machines}
      selection={selection}
      onChange={(next) => {
        onChange(next);
        setSelection(next);
      }}
    />
  );
}

function renderPicker(initial: HootTarget, machines = MACHINES) {
  const onChange = jest.fn();
  const user = userEvent.setup();
  render(<Harness initial={initial} machines={machines} onChange={onChange} />);
  const trigger = screen.getByRole('button', { name: 'hoot target' });
  return { user, onChange, trigger };
}

async function openPicker(initial: HootTarget, machines = MACHINES) {
  const rendered = renderPicker(initial, machines);
  await rendered.user.click(rendered.trigger);
  const menu = await screen.findByRole('menu');
  return { ...rendered, menu };
}

function row(name: string) {
  return screen.getByRole('menuitemcheckbox', { name });
}

/**
 * The row's checkbox column — the half that TOGGLES. Clicking the row anywhere
 * else means "just this machine", so a test that means to add one to the set has
 * to hit this, exactly as a user does.
 */
function box(name: string): HTMLElement {
  const column = row(name).querySelector('[data-checkbox-box]');
  if (column === null) throw new Error(`row "${name}" has no checkbox column`);
  return column as HTMLElement;
}

describe('MachineTargetPicker trigger', () => {
  it('is named for the e2e locator and shows the label with the online count', () => {
    const { trigger } = renderPicker(ALL);

    // kiosk-02 is offline, so two of the three targeted machines are reachable.
    expect(trigger).toHaveTextContent('all machines');
    expect(trigger).toHaveTextContent('(2)');
  });

  it('shows a subset as its formatted label, counting only its online machines', () => {
    const { trigger } = renderPicker({ machineIds: ['kiosk-01', 'kiosk-02'] });

    expect(trigger).toHaveTextContent('kiosk-01, kiosk-02');
    expect(trigger).toHaveTextContent('(1)');
  });

  it('keeps the width cap the 390px mobile gate depends on', () => {
    const { trigger } = renderPicker(ALL);

    expect(trigger).toHaveClass('w-full', 'max-w-[220px]', 'min-w-0');
  });
});

describe('MachineTargetPicker rows', () => {
  it('ticks every machine when the target is all machines', async () => {
    await openPicker(ALL);

    expect(row(MASTER_ROW)).toHaveAttribute('aria-checked', 'true');
    expect(row('kiosk-01')).toHaveAttribute('aria-checked', 'true');
    expect(row('kiosk-02 offline')).toHaveAttribute('aria-checked', 'true');
    expect(row('kiosk-03 hoot off')).toHaveAttribute('aria-checked', 'true');
  });

  it('names each machine with its status as text', async () => {
    const { menu } = await openPicker({ machineIds: ['kiosk-01'] });
    const names = within(menu)
      .getAllByRole('menuitemcheckbox')
      .map((item) => item.textContent);

    expect(names).toEqual([
      'all machines2 online',
      'kiosk-01',
      'kiosk-02offline',
      'kiosk-03hoot off',
    ]);
  });

  it('shows both reasons when a machine is offline AND has hoot off', async () => {
    await openPicker(ALL, [{ id: 'kiosk-09', online: false, hootEnabled: false }]);

    expect(row('kiosk-09 offline, hoot off')).toBeInTheDocument();
  });

  it('spells out the rest of the site when one machine is unticked from "all"', async () => {
    const { user, onChange } = await openPicker(ALL);

    await user.click(box('kiosk-02 offline'));

    expect(onChange).toHaveBeenCalledWith({ machineIds: ['kiosk-01', 'kiosk-03'] });
  });

  it('collapses back to dynamic "all" when the last missing machine is ticked', async () => {
    const { user, onChange } = await openPicker({ machineIds: ['kiosk-01', 'kiosk-02'] });

    await user.click(box('kiosk-03 hoot off'));

    expect(onChange).toHaveBeenCalledWith({ machineIds: null });
  });

  it('stays open across several toggles', async () => {
    const { user, onChange } = await openPicker(ALL);

    await user.click(box('kiosk-02 offline'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(box('kiosk-03 hoot off'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(onChange).toHaveBeenNthCalledWith(2, { machineIds: ['kiosk-01'] });
  });

  it('selects ONLY that machine when its name is clicked', async () => {
    // The fast path off "all machines", and the behaviour the old single-select
    // dropdown had: clicking a name means "talk to this one", not "add it".
    const { user, onChange } = await openPicker(ALL);

    await user.click(row('kiosk-02 offline'));

    expect(onChange).toHaveBeenCalledWith({ machineIds: ['kiosk-02'] });
  });

  it('drops the rest of an existing set when a name is clicked', async () => {
    const { user, onChange } = await openPicker({ machineIds: ['kiosk-01', 'kiosk-03'] });

    await user.click(row('kiosk-01'));

    expect(onChange).toHaveBeenCalledWith({ machineIds: ['kiosk-01'] });
  });

  it('keeps a one-machine site on dynamic "all" when its name is clicked', async () => {
    // Freezing the only id would stop a machine added tomorrow from being
    // targeted — `normalizeSelection` collapses a set covering the site to null.
    const { user, onChange } = await openPicker(
      { machineIds: [] },
      [{ id: 'kiosk-01', online: true, hootEnabled: true }],
    );

    await user.click(row('kiosk-01'));

    expect(onChange).toHaveBeenCalledWith({ machineIds: null });
  });

  it('toggles with Space and selects only with Enter, keeping the menu and focus', async () => {
    // Keyboard parity for the pointer's two halves: Space is the checkbox's own
    // key, Enter is the row's primary action. Focus has to survive the
    // re-render too — losing it would send the next arrow key to <body>.
    const { user, onChange, trigger } = renderPicker(ALL);

    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    // Radix lands focus on the first row (the master); one step down is kiosk-01.
    await user.keyboard('{ArrowDown}');
    const first = row('kiosk-01');
    expect(first).toHaveFocus();

    await user.keyboard('[Space]');

    expect(onChange).toHaveBeenNthCalledWith(1, { machineIds: ['kiosk-02', 'kiosk-03'] });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(first).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenNthCalledWith(2, { machineIds: ['kiosk-01'] });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('says so when the site has no machines', async () => {
    const { menu } = await openPicker(ALL, []);

    expect(within(menu).getByText('no machines in this site')).toBeInTheDocument();
    // Only the master row, and nothing to tick under it.
    expect(within(menu).getAllByRole('menuitemcheckbox')).toHaveLength(1);
  });
});

describe('MachineTargetPicker "all machines" master row', () => {
  it('reads mixed, with its own glyph, when only some machines are ticked', async () => {
    await openPicker({ machineIds: ['kiosk-01'] });
    const master = row(MASTER_ROW);

    expect(master).toHaveAttribute('aria-checked', 'mixed');
    expect(master).toHaveAttribute('data-state', 'indeterminate');
    // Radix renders an indicator for `indeterminate` too, so the glyph has to
    // differ from a ticked row's — otherwise the menu claims all three.
    expect(master.querySelector('.lucide-minus')).toBeInTheDocument();
    expect(master.querySelector('.lucide-check')).not.toBeInTheDocument();
    expect(row('kiosk-01').querySelector('.lucide-check')).toBeInTheDocument();
  });

  it('clears the selection when its box is unticked', async () => {
    const { user, onChange } = await openPicker(ALL);

    await user.click(box(MASTER_ROW));

    expect(onChange).toHaveBeenCalledWith({ machineIds: [] });
  });

  it('ticks every machine from an empty selection', async () => {
    const { user, onChange } = await openPicker({ machineIds: [] });
    const master = row(MASTER_ROW);

    expect(master).toHaveAttribute('aria-checked', 'false');

    await user.click(box(MASTER_ROW));

    expect(onChange).toHaveBeenCalledWith({ machineIds: null });
  });

  it('ticks every machine from a mixed selection', async () => {
    const { user, onChange } = await openPicker({ machineIds: ['kiosk-01'] });

    await user.click(box(MASTER_ROW));

    expect(onChange).toHaveBeenCalledWith({ machineIds: null });
  });

  it('goes back to dynamic "all" when its name is clicked, from any set', async () => {
    // The name means "talk to everything", so it is the dynamic null — not a
    // set that happens to cover today's machines.
    const { user, onChange } = await openPicker({ machineIds: ['kiosk-01'] });

    await user.click(row(MASTER_ROW));

    expect(onChange).toHaveBeenCalledWith({ machineIds: null });
  });
});

describe('MachineTargetPicker accessibility', () => {
  it('nests no interactive controls inside the menu', async () => {
    const { menu } = await openPicker(ALL);

    // The /hoot route runs an axe gate; a control inside a menuitemcheckbox is a
    // serious violation there and unreachable by keyboard in the menu's roving
    // focus.
    expect(menu.querySelectorAll('button, input, a, select, textarea')).toHaveLength(0);
  });

  it('lifts the status text off the muted token on the focused row', async () => {
    // jsdom computes no Tailwind, so the class pair IS the guard: the muted
    // token over the focused row's --accent fill is 4.37:1 in dark, under the 4.5:1
    // axe's color-contrast rule enforces on /hoot. Radix focuses a row on
    // pointer move, so every hover reaches that state.
    await openPicker({ machineIds: ['kiosk-01'] });

    const master = row(MASTER_ROW);
    expect(master).toHaveClass('group');
    expect(within(master).getByText('2 online')).toHaveClass(
      'group-focus:text-accent-foreground/80',
    );

    const offline = row('kiosk-02 offline');
    expect(offline).toHaveClass('group');
    expect(within(offline).getByText('offline')).toHaveClass(
      'group-focus:text-accent-foreground/80',
    );
  });

  it('labels the trigger without borrowing an inner control', () => {
    const { trigger } = renderPicker(ALL);

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger.querySelectorAll('button, input')).toHaveLength(0);
  });
});
