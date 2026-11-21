/**
 * @jest-environment jsdom
 *
 * TurnstileWidget — the challenge wears the app's resolved theme, never the
 * os's ('auto'), and re-renders when that theme changes.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { TurnstileWidget } from '@/components/TurnstileWidget';

let mockResolvedTheme: string | undefined;
jest.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

const turnstile = {
  render: jest.fn(() => 'widget-1'),
  reset: jest.fn(),
  remove: jest.fn(),
};

const renderedThemes = () =>
  turnstile.render.mock.calls.map((call: unknown[]) => (call[1] as { theme?: string }).theme);

describe('TurnstileWidget', () => {
  const originalKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'test-site-key';
    window.turnstile = turnstile;
    mockResolvedTheme = 'dark';
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = originalKey;
    delete window.turnstile;
  });

  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
    [undefined, 'dark'],
  ])('renders resolved theme %s as %s', async (resolved, expected) => {
    mockResolvedTheme = resolved;
    render(<TurnstileWidget action="register" onToken={jest.fn()} />);

    await waitFor(() => expect(renderedThemes()).toEqual([expected]));
  });

  it('re-renders the widget when the theme changes', async () => {
    const view = render(<TurnstileWidget action="register" onToken={jest.fn()} />);
    await waitFor(() => expect(renderedThemes()).toEqual(['dark']));

    mockResolvedTheme = 'light';
    view.rerender(<TurnstileWidget action="register" onToken={jest.fn()} />);

    await waitFor(() => expect(renderedThemes()).toEqual(['dark', 'light']));
    expect(turnstile.remove).toHaveBeenCalledWith('widget-1');
  });
});
