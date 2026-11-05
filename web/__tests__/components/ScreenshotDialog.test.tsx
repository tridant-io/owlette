/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ScreenshotDialog and LiveViewModal: every icon-only control has a name, the
 * fullscreen view is a real modal (focus moves in, Escape closes only it, focus
 * returns to the button that opened it), and the first Escape closes the dialog
 * rather than an auto-opened tooltip.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ScreenshotDialog } from '@/components/ScreenshotDialog';
import { LiveViewModal } from '@/components/LiveViewModal';

const IMAGE_URL = 'data:image/png;base64,iVBORw0KGgo=';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ userPreferences: { timeFormat: '12h' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));

// the machine doc carries the latest capture; live view also reads its liveView block
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  onSnapshot: jest.fn((_ref: unknown, onNext: (snap: unknown) => void) => {
    onNext({ data: () => ({ lastScreenshot: { url: IMAGE_URL, timestamp: 1_700_000_000_000, sizeKB: 120 } }) });
    return () => {};
  }),
}));

jest.mock('@/hooks/useScreenshotHistory', () => ({
  useScreenshotHistory: () => ({
    screenshots: [{ id: 'shot-1', url: IMAGE_URL, timestamp: 1_700_000_000_000, sizeKB: 120 }],
    loading: false,
  }),
}));

jest.mock('@/components/TimezoneChip', () => ({ TimezoneChip: () => null }));

function renderScreenshotDialog() {
  const onOpenChange = jest.fn();
  render(
    <TooltipProvider>
      <ScreenshotDialog
        open
        onOpenChange={onOpenChange}
        machineId="kiosk-01"
        machineName="kiosk-01"
        siteId="site-A"
        isOnline
        onCaptureScreenshot={() => Promise.resolve()}
        lastScreenshot={{ url: IMAGE_URL, timestamp: 1_700_000_000_000, sizeKB: 120 }}
      />
    </TooltipProvider>,
  );
  return { onOpenChange };
}

function renderLiveView() {
  const onOpenChange = jest.fn();
  render(
    <TooltipProvider>
      <LiveViewModal
        open
        onOpenChange={onOpenChange}
        siteId="site-A"
        machineId="kiosk-01"
        machineName="kiosk-01"
        onStartLiveView={() => Promise.resolve()}
        onStopLiveView={() => Promise.resolve()}
      />
    </TooltipProvider>,
  );
  return { onOpenChange };
}

describe('ScreenshotDialog', () => {
  it('names every icon-only control', () => {
    renderScreenshotDialog();

    for (const name of [
      'close',
      'fullscreen',
      'download screenshot',
      'copy to clipboard',
      'hide history',
      'clear history',
      'delete screenshot',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('closes on the first Escape after opening', async () => {
    const { onOpenChange } = renderScreenshotDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: 'close' })).toHaveFocus());

    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens fullscreen as a modal that takes focus, closes on Escape alone, and hands focus back', async () => {
    const { onOpenChange } = renderScreenshotDialog();
    const fullscreenButton = screen.getByRole('button', { name: 'fullscreen' });

    await userEvent.click(fullscreenButton);

    const lightbox = await screen.findByRole('dialog', { name: 'screenshot of kiosk-01' });
    await waitFor(() => expect(within(lightbox).getByRole('button', { name: 'close image' })).toHaveFocus());

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'screenshot of kiosk-01' })).toBeNull());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(fullscreenButton).toHaveFocus();
  });
});

describe('LiveViewModal', () => {
  it('names every icon-only control', () => {
    renderLiveView();

    for (const name of ['close', 'fullscreen', 'download screenshot']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('closes only the fullscreen view on Escape', async () => {
    const { onOpenChange } = renderLiveView();

    await userEvent.click(screen.getByRole('button', { name: 'fullscreen' }));
    await screen.findByRole('dialog', { name: 'live view of kiosk-01' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'live view of kiosk-01' })).toBeNull());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'fullscreen' })).toHaveFocus();
  });
});
