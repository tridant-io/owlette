/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * `TruncatedText` — a tooltip ONLY when the line is actually clipped.
 *
 * Reported 2026-09-15: the logs table showed a tooltip repeating text that was
 * already fully visible ("owlette agent v3.3.4 started successfully"), while the
 * one column that genuinely needed one — process — had none at all. A tooltip
 * that repeats what you just read is noise, and it trains people to ignore the
 * one that had something to say.
 *
 * The "fits" cases are the regression guard: make the wrapper unconditional
 * again and they fail. jsdom has no layout, so width is stubbed — `clientWidth`
 * is the column, `scrollWidth` the text — which is exactly the comparison the
 * component makes.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';

/** Stubbed column width, in px. Change it, then fire a resize. */
let columnWidth = 100;
/** Stubbed px-per-character, so text length drives `scrollWidth`. */
const CHAR_PX = 10;

const resizeCallbacks = new Set<() => void>();

class ResizeObserverStub {
  constructor(private readonly callback: () => void) {}
  observe() {
    resizeCallbacks.add(this.callback);
  }
  disconnect() {
    resizeCallbacks.delete(this.callback);
  }
  unobserve() {
    resizeCallbacks.delete(this.callback);
  }
}

/** Fire every live observer, as a real column resize would. */
function resizeColumnTo(width: number) {
  columnWidth = width;
  act(() => {
    resizeCallbacks.forEach((cb) => cb());
  });
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return columnWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return (this.textContent ?? '').length * CHAR_PX;
    },
  });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
});

beforeEach(() => {
  columnWidth = 100;
  resizeCallbacks.clear();
});

const SHORT = 'td';
const LONG = 'constellation renderer node 07 (primary)';

function renderText(ui: React.ReactElement) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

describe('TruncatedText', () => {
  it('renders no tooltip trigger when the text fits', () => {
    renderText(<TruncatedText text={SHORT} data-testid="cell" />);

    const cell = screen.getByTestId('cell');
    // Radix stamps `data-state` on the trigger it wraps; a bare span has none.
    expect(cell).not.toHaveAttribute('data-state');
    expect(cell).not.toHaveClass('cursor-help');
  });

  it('shows nothing on hover when the text fits', async () => {
    const user = userEvent.setup();
    renderText(<TruncatedText text={SHORT} data-testid="cell" />);

    await user.hover(screen.getByTestId('cell'));

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('wraps a clipped line in a trigger and reveals it on hover', async () => {
    const user = userEvent.setup();
    renderText(<TruncatedText text={LONG} data-testid="cell" />);

    const cell = screen.getByTestId('cell');
    expect(cell).toHaveAttribute('data-state');
    expect(cell).toHaveClass('cursor-help');

    await user.hover(cell);

    expect(await screen.findByRole('tooltip')).toHaveTextContent(LONG);
  });

  it('drops the tooltip when the column grows enough to fit the text', () => {
    renderText(<TruncatedText text={LONG} data-testid="cell" />);
    expect(screen.getByTestId('cell')).toHaveAttribute('data-state');

    // Re-parenting into (and out of) the trigger remounts the span. The observer
    // has to follow it, or the cell keeps a tooltip it no longer needs.
    resizeColumnTo(LONG.length * CHAR_PX + 50);

    expect(screen.getByTestId('cell')).not.toHaveAttribute('data-state');
  });

  it('gains a tooltip when the column shrinks below the text', () => {
    renderText(<TruncatedText text={SHORT} data-testid="cell" />);
    expect(screen.getByTestId('cell')).not.toHaveAttribute('data-state');

    resizeColumnTo(5);

    expect(screen.getByTestId('cell')).toHaveAttribute('data-state');
  });

  it('re-measures when the text changes under a fixed column', () => {
    const { rerender } = renderText(<TruncatedText text={LONG} data-testid="cell" />);
    expect(screen.getByTestId('cell')).toHaveAttribute('data-state');

    // No resize fires here — same box, new content — so the measurement has to
    // be driven by the text as well.
    rerender(
      <TooltipProvider delayDuration={0}>
        <TruncatedText text={SHORT} data-testid="cell" />
      </TooltipProvider>,
    );

    expect(screen.getByTestId('cell')).not.toHaveAttribute('data-state');
  });

  it('shows a richer tooltip body when given one', async () => {
    const user = userEvent.setup();
    renderText(<TruncatedText text={LONG} tooltip="exit code 1 — restarting" data-testid="cell" />);

    await user.hover(screen.getByTestId('cell'));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('exit code 1 — restarting');
  });

  it('treats an exact fit as not clipped', () => {
    // scrollWidth === clientWidth, plus the 1px tolerance for fractional layouts.
    renderText(<TruncatedText text={'0123456789'} data-testid="cell" />);

    expect(screen.getByTestId('cell')).not.toHaveAttribute('data-state');
  });
});
