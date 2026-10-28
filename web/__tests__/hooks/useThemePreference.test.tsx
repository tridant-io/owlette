/**
 * @jest-environment jsdom
 *
 * The appearance choice applies at once through next-themes, and a signed-in
 * choice is saved silently to the user's preferences so it follows them.
 */
import { act, renderHook } from '@testing-library/react';
import { themeWrites, useThemePreference } from '@/hooks/useThemePreference';

const setTheme = jest.fn();
let themeState: { theme?: string; resolvedTheme?: string } = {};
jest.mock('next-themes', () => ({
  useTheme: () => ({ ...themeState, setTheme }),
}));

const updateUserPreferences = jest.fn();
let authUser: { uid: string } | null = null;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: authUser, updateUserPreferences }),
}));

const logError = jest.fn();
jest.mock('@/lib/errorHandler', () => ({
  logError: (...args: unknown[]) => logError(...args),
}));

beforeEach(() => {
  setTheme.mockClear();
  updateUserPreferences.mockReset().mockResolvedValue(undefined);
  logError.mockClear();
  themeState = { theme: 'system', resolvedTheme: 'dark' };
  authUser = { uid: 'u1' };
  themeWrites.last = undefined;
  themeWrites.pending = 0;
});

describe('useThemePreference', () => {
  it('applies the choice and saves it silently when signed in', async () => {
    const { result } = renderHook(() => useThemePreference());
    await act(async () => { result.current.setChoice('light'); });

    expect(setTheme).toHaveBeenCalledWith('light');
    expect(updateUserPreferences).toHaveBeenCalledWith({ theme: 'light' }, { silent: true });
    expect(themeWrites).toEqual({ last: 'light', pending: 0 });
  });

  it('applies the choice without saving when signed out', async () => {
    authUser = null;
    const { result } = renderHook(() => useThemePreference());
    await act(async () => { result.current.setChoice('dark'); });

    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(updateUserPreferences).not.toHaveBeenCalled();
    expect(themeWrites).toEqual({ last: undefined, pending: 0 });
  });

  it('logs a failed save instead of throwing it', async () => {
    const failure = new Error('permission-denied');
    updateUserPreferences.mockRejectedValue(failure);
    const { result } = renderHook(() => useThemePreference());
    await act(async () => { result.current.setChoice('light'); });

    expect(logError).toHaveBeenCalledWith(failure, 'theme-preference-save');
    expect(themeWrites.pending).toBe(0);
  });

  it('reads the choice and the resolved theme from next-themes', () => {
    themeState = { theme: 'light', resolvedTheme: 'light' };
    const { result } = renderHook(() => useThemePreference());
    expect(result.current.choice).toBe('light');
    expect(result.current.resolved).toBe('light');
  });

  it('falls back to system and dark before next-themes has mounted', () => {
    themeState = {};
    const { result } = renderHook(() => useThemePreference());
    expect(result.current.choice).toBe('system');
    expect(result.current.resolved).toBe('dark');
  });

  it('treats an unknown stored theme as the default', () => {
    themeState = { theme: 'sepia', resolvedTheme: 'sepia' };
    const { result } = renderHook(() => useThemePreference());
    expect(result.current.choice).toBe('system');
    expect(result.current.resolved).toBe('dark');
  });
});
