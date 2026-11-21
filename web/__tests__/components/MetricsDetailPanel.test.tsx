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

  it('marks a newly picked range as pressed', async () => {
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'all' }));

    expect(screen.getByRole('button', { name: 'all' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'hour' })).toHaveAttribute('aria-pressed', 'false');
  });
});
