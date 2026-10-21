/**
 * @jest-environment jsdom
 *
 * ThemePreferenceSync applies the appearance saved on the user doc, so a choice
 * made on another device lands here, without ever re-applying this tab's own
 * write when Firestore echoes it back (the ping-pong the plan rules out).
 */
import React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { ThemePreferenceSync } from '@/components/ThemePreferenceSync';
import { themeWrites, useThemePreference } from '@/hooks/useThemePreference';
import type { ThemeChoice } from '@/lib/theme';

const setTheme = jest.fn();
let currentTheme = 'dark';
jest.mock('next-themes', () => ({
  useTheme: () => ({ theme: currentTheme, resolvedTheme: currentTheme, setTheme }),
}));

let savedTheme: ThemeChoice | undefined;
let resolveWrite: (() => void)[] = [];
const updateUserPreferences = jest.fn(
  () => new Promise<void>((resolve) => { resolveWrite.push(resolve); }),
);
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    userPreferences: { theme: savedTheme },
    updateUserPreferences,
  }),
}));

jest.mock('@/lib/errorHandler', () => ({ logError: jest.fn() }));

/** this tab picks a theme through the real hook, as the appearance control does */
function choose(choice: ThemeChoice) {
  const { result, unmount } = renderHook(() => useThemePreference());
  act(() => { result.current.setChoice(choice); });
  unmount();
}

async function settleWrites() {
  await act(async () => {
    resolveWrite.forEach((resolve) => resolve());
    resolveWrite = [];
  });
}

beforeEach(() => {
  setTheme.mockClear();
  updateUserPreferences.mockClear();
  resolveWrite = [];
  currentTheme = 'dark';
  savedTheme = undefined;
  themeWrites.last = undefined;
  themeWrites.pending = 0;
});

describe('ThemePreferenceSync', () => {
  it('applies a saved theme that differs from the one on screen', () => {
    savedTheme = 'light';
    render(<ThemePreferenceSync />);
    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('does nothing when no theme was ever saved', () => {
    render(<ThemePreferenceSync />);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('ignores the echo of its own write', async () => {
    choose('light');
    await settleWrites();
    setTheme.mockClear();

    // next-themes is mocked, so the screen still reads dark: only the
    // last-written record stops the echo from being applied again
    savedTheme = 'light';
    render(<ThemePreferenceSync />);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('ignores a stale read-back while a later write is still in flight', async () => {
    choose('light');
    choose('dark');
    setTheme.mockClear();
    currentTheme = 'dark';

    // updateUserPreferences re-applies the first write's value when it lands
    savedTheme = 'light';
    const { rerender } = render(<ThemePreferenceSync />);
    expect(setTheme).not.toHaveBeenCalled();

    await settleWrites();
    savedTheme = 'dark';
    rerender(<ThemePreferenceSync />);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('still applies a change made on another device after its own write', async () => {
    choose('light');
    await settleWrites();
    setTheme.mockClear();
    currentTheme = 'light';

    savedTheme = 'light';
    const { rerender } = render(<ThemePreferenceSync />);
    savedTheme = 'dark';
    rerender(<ThemePreferenceSync />);
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('does not drag back a theme changed in another tab', () => {
    savedTheme = 'dark';
    const { rerender } = render(<ThemePreferenceSync />);
    expect(setTheme).not.toHaveBeenCalled();

    // next-themes syncs another tab's choice through storage before that
    // tab's write reaches this one's snapshot
    currentTheme = 'light';
    rerender(<ThemePreferenceSync />);
    expect(setTheme).not.toHaveBeenCalled();
  });
});
