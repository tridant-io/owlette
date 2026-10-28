/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The root error fallback in both themes. Its "try again" button lost its fill
 * in the hover-sweep refactor and kept gray-900 text, which is unreadable on
 * the dark page; it is a primary Button now, and nothing in the fallback uses a
 * colour that only works in one theme.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ErrorBoundary } from '@/components/ErrorBoundary';

jest.mock('@sentry/nextjs', () => ({
  withScope: jest.fn(),
  captureException: jest.fn(),
}));

const RAW_COLOUR =
  /\b(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke|from|to|via|outline|divide|shadow|decoration|placeholder|caret|accent)-(?:red|green|emerald|amber|yellow|orange|blue|sky|cyan|teal|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|lime|indigo|fuchsia)-\d{2,3}\b|\btext-(?:white|gray-900)\b/;

let shouldThrow = true;

function Boom() {
  if (shouldThrow) throw new Error('boom');
  return <p>recovered</p>;
}

function renderFallback() {
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );
}

describe('ErrorBoundary fallback', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    shouldThrow = true;
    // react logs the caught render error; the boundary logs it again
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => consoleError.mockRestore());

  it('paints try again as the primary button', () => {
    renderFallback();
    const tryAgain = screen.getByRole('button', { name: 'try again' });
    expect(tryAgain).toHaveAttribute('data-slot', 'button');
    expect(tryAgain).toHaveClass('bg-primary', 'text-primary-foreground');
  });

  it('uses theme tokens only', () => {
    renderFallback();
    const heading = screen.getByRole('heading', { name: 'something went wrong' });
    const panel = heading.parentElement as HTMLElement;
    const raw = [panel, ...panel.querySelectorAll('*')]
      .flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/))
      .filter((c) => RAW_COLOUR.test(c));
    expect(raw).toEqual([]);
  });

  it('renders the children again after try again', async () => {
    const user = userEvent.setup();
    renderFallback();
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
