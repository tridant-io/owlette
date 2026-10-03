/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The appearance setting is a three-way radiogroup. The control moves at once and
 * the theme follows a beat later, so the indicator's slide isn't cut short by the
 * theme swap suspending transitions.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppearanceControl } from '@/components/AppearanceControl';

const setChoice = jest.fn();
let current = { choice: 'system' as 'system' | 'dark' | 'light', resolved: 'dark' as 'dark' | 'light' };

jest.mock('@/hooks/useThemePreference', () => ({
  useThemePreference: () => ({ ...current, setChoice }),
}));
let reducedMotion = false;
jest.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => reducedMotion,
}));

beforeEach(() => {
  jest.useFakeTimers();
  setChoice.mockClear();
  current = { choice: 'system', resolved: 'dark' };
  reducedMotion = false;
});
afterEach(() => jest.useRealTimers());

describe('AppearanceControl', () => {
  it('is a labelled radiogroup with the current choice checked', () => {
    render(<AppearanceControl />);
    const group = screen.getByRole('radiogroup', { name: 'appearance' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'system' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'dark' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('now dark')).toBeInTheDocument();
  });

  it('moves at once and applies the theme after the slide', () => {
    render(<AppearanceControl />);
    fireEvent.click(screen.getByRole('radio', { name: 'light' }));
    expect(screen.getByRole('radio', { name: 'light' })).toHaveAttribute('aria-checked', 'true');
    expect(setChoice).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(200); });
    expect(setChoice).toHaveBeenCalledWith('light');
  });

  it('applies immediately under reduced motion', () => {
    reducedMotion = true;
    render(<AppearanceControl />);
    fireEvent.click(screen.getByRole('radio', { name: 'dark' }));
    act(() => { jest.advanceTimersByTime(0); });
    expect(setChoice).toHaveBeenCalledWith('dark');
  });

  it('roves focus and selection with the arrow keys, Home and End', () => {
    render(<AppearanceControl />);
    const system = screen.getByRole('radio', { name: 'system' });
    expect(system).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'dark' })).toHaveAttribute('tabindex', '-1');

    system.focus();
    fireEvent.keyDown(system, { key: 'ArrowRight' });
    const dark = screen.getByRole('radio', { name: 'dark' });
    expect(dark).toHaveFocus();
    expect(dark).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(dark, { key: 'End' });
    expect(screen.getByRole('radio', { name: 'light' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'light' }), { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'system' })).toHaveFocus();

    act(() => { jest.advanceTimersByTime(200); });
    expect(setChoice).toHaveBeenLastCalledWith('system');
  });

  it('does not re-apply the choice already in effect', () => {
    render(<AppearanceControl />);
    fireEvent.click(screen.getByRole('radio', { name: 'system' }));
    act(() => { jest.advanceTimersByTime(200); });
    expect(setChoice).not.toHaveBeenCalled();
  });
});
