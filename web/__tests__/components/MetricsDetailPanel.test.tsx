/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MetricsDetailPanel keyboard and screen-reader surface: a named close button,
 * Escape to close (but not out of a field, and not when a radix layer already
 * took the key), and toggles that say whether they are on.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MetricsDetailPanel } from '@/components/charts/MetricsDetailPanel';

const PREFS = { timeFormat: '12h', graphTabs: {}, graphTimeRange: '1h' };
const updateUserPreferences = jest.fn(() => Promise.resolve());

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ userPreferences: PREFS, updateUserPreferences }),
}));

jest.mock('@/contexts/DemoContext', () => ({
  useDemoContext: () => null,
}));

// no history: the panel renders its controls over the empty-range copy, no chart
const NO_DATA = { data: [], loading: false, error: null };
jest.mock('@/hooks/useHistoricalMetrics', () => ({
  useHistoricalMetrics: () => NO_DATA,
}));

function renderPanel(onClose = jest.fn()) {
  render(
    <TooltipProvider>
      <MetricsDetailPanel machineId="kiosk-01" siteId="site-A" initialMetric="cpu" onClose={onClose} />
    </TooltipProvider>,
  );
  return { onClose };
}

describe('MetricsDetailPanel', () => {
  it('names the icon-only close button and closes through it', async () => {
    const { onClose } = renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const { onClose } = renderPanel();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape pressed inside a text field', () => {
    const { onClose } = renderPanel();
    const field = document.createElement('input');
    document.body.appendChild(field);

    fireEvent.keyDown(field, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    field.remove();
  });

  it('ignores an Escape a radix layer already handled', () => {
    const { onClose } = renderPanel();
    const handled = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', handled, { capture: true });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    document.removeEventListener('keydown', handled, { capture: true });
  });

  it('exposes the selected time range and metric toggles as pressed', () => {
    renderPanel();

    const range = screen.getByRole('group', { name: 'time range' });
    expect(range.querySelector('[aria-pressed="true"]')).toHaveTextContent('hour');
    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'false');

    expect(screen.getByRole('button', { name: 'CPU' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'RAM' })).toHaveAttribute('aria-pressed', 'false');
  });

  // the sweep itself is globals.css, which jsdom never loads: this pins the classes
  it('sweeps the machine switcher and its rows on hover like the app menus, not with a flat fill', async () => {
    // radix positions the popover with a ResizeObserver that jsdom does not have
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const machines = Array.from({ length: 6 }, (_, i) => ({ machineId: `kiosk-0${i + 1}`, online: true }));
    render(
      <TooltipProvider>
        <MetricsDetailPanel
          machineId="kiosk-01"
          siteId="site-A"
          initialMetric="cpu"
          onClose={jest.fn()}
          machines={machines}
          onSwitchMachine={jest.fn()}
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'switch machine' });
    // a menu's trigger, like the header's: it sweeps, and stays lit while open
    expect(trigger).toHaveClass('btn-sweep');
    expect(trigger.className).not.toMatch(/hover:bg-/);
    await userEvent.click(trigger);

    const rows = machines.map(({ machineId }) => screen.getByRole('button', { name: machineId }));
    const current = rows.filter((row) => row.getAttribute('aria-current') === 'true');
    expect(current.map((row) => row.textContent)).toEqual(['kiosk-01']);
    // the current machine keeps its fill unswept: it is already the brightest row
    expect(current[0]).not.toHaveClass('btn-sweep');
    for (const row of rows.filter((r) => !r.hasAttribute('aria-current'))) expect(row).toHaveClass('btn-sweep');
    for (const row of rows) expect(row.className).not.toMatch(/(?:hover|focus-visible):bg-/);
  });

  it('marks a newly picked range as pressed', async () => {
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'all' }));

    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'hour' })).toHaveAttribute('aria-pressed', 'false');
  });
});
