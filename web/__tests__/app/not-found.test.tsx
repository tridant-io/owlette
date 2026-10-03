/**
 * @jest-environment jsdom
 *
 * The 404 rain is drawn on a canvas, which can't follow css: it paints in the
 * theme's muted ink and re-reads it when the theme class on <html> changes.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import NotFound from '@/app/not-found';

const fills: string[] = [];

beforeAll(() => {
  // reduced motion: the rain paints one still frame per change, no animation loop
  window.matchMedia = jest.fn(() => ({
    matches: true,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;

  const ctx = {
    clearRect: jest.fn(),
    beginPath: jest.fn(),
    arc: jest.fn(),
    fill: jest.fn(),
    globalAlpha: 1,
    set fillStyle(value: string) {
      fills.push(value);
    },
  };
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  const style = document.createElement('style');
  style.textContent = ':root { --muted-foreground: rgb(1, 2, 3); } .dark { --muted-foreground: rgb(4, 5, 6); }';
  document.head.appendChild(style);
});

afterEach(() => {
  document.documentElement.className = '';
  fills.length = 0;
});

describe('not-found rain', () => {
  it('paints in the muted ink of the current theme', () => {
    document.documentElement.className = 'dark';
    render(<NotFound />);

    expect(fills.at(-1)).toBe('rgb(4, 5, 6)');
  });

  it('re-reads the ink when the theme changes', async () => {
    document.documentElement.className = 'dark';
    render(<NotFound />);

    document.documentElement.className = 'light';

    await waitFor(() => expect(fills.at(-1)).toBe('rgb(1, 2, 3)'));
  });
});
