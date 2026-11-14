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
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ScreenshotDialog } from '@/components/ScreenshotDialog';
import { LiveViewModal } from '@/components/LiveViewModal';

const IMAGE_URL = 'data:image/png;base64,iVBORw0KGgo=';
const CAPTURED_MS = 1_700_000_000_000;

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ userPreferences: { timeFormat: '12h' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));

// the machine doc carries the latest capture; live view also reads its liveView block.
// a machine missing from mockMachineDocs holds the default capture; null means a machine
// never captured. every snapshot builds a new timestamp object, as firestore does.
const mockMachineDocs: Record<string, { url: string } | null> = {};
const mockListeners: { machineId: string; onNext: (snap: unknown) => void }[] = [];
function mockSnapshotOf(machineId: string) {
  const shot = machineId in mockMachineDocs ? mockMachineDocs[machineId] : { url: 'data:image/png;base64,iVBORw0KGgo=' };
  return {
    data: () =>
      shot ? { lastScreenshot: { url: shot.url, timestamp: { toMillis: () => 1_700_000_000_000 }, sizeKB: 120 } } : {},
  };
}
jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ machineId: path[3] })),
  onSnapshot: jest.fn((ref: { machineId: string }, onNext: (snap: unknown) => void) => {
    const listener = { machineId: ref.machineId, onNext };
    mockListeners.push(listener);
    onNext(mockSnapshotOf(ref.machineId));
    return () => {
      mockListeners.splice(mockListeners.indexOf(listener), 1);
    };
  }),
}));

let mockHistory = [{ id: 'shot-1', url: IMAGE_URL, timestamp: CAPTURED_MS, sizeKB: 120 }];
jest.mock('@/hooks/useScreenshotHistory', () => ({
  useScreenshotHistory: () => ({ screenshots: mockHistory, loading: false }),
}));

beforeEach(() => {
  for (const id of Object.keys(mockMachineDocs)) delete mockMachineDocs[id];
  mockHistory = [{ id: 'shot-1', url: IMAGE_URL, timestamp: CAPTURED_MS, sizeKB: 120 }];
});

/** the next heartbeat: every open listener gets a fresh snapshot of its machine. */
function heartbeat() {
  act(() => {
    for (const { machineId, onNext } of [...mockListeners]) onNext(mockSnapshotOf(machineId));
  });
}

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

  it("opened on the next machine, shows nothing of the last one's and captures that machine", () => {
    mockMachineDocs['kiosk-02'] = null;
    const capture = jest.fn(() => Promise.resolve());
    // the dashboard mounts one dialog and swaps its target, with no lastScreenshot to pass.
    // kiosk-01 is offline so its open shows its picture rather than capturing a new one.
    const dialog = (machineId: string, open: boolean, isOnline: boolean) => (
      <TooltipProvider>
        <ScreenshotDialog
          open={open}
          onOpenChange={() => {}}
          machineId={machineId}
          machineName={machineId}
          siteId="site-A"
          isOnline={isOnline}
          onCaptureScreenshot={capture}
        />
      </TooltipProvider>
    );
    const { rerender } = render(dialog('kiosk-01', true, false));
    expect(screen.getByRole('img', { name: 'screenshot of kiosk-01' })).toHaveAttribute('src', IMAGE_URL);

    rerender(dialog('kiosk-01', false, false));
    rerender(dialog('kiosk-02', true, true));

    expect(screen.queryByRole('img', { name: 'screenshot of kiosk-02' })).toBeNull();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('keeps a picked history screenshot through a heartbeat', async () => {
    mockHistory = [
      { id: 'shot-1', url: IMAGE_URL, timestamp: CAPTURED_MS, sizeKB: 120 },
      { id: 'shot-0', url: 'data:image/png;base64,b2xk', timestamp: CAPTURED_MS - 60_000, sizeKB: 77 },
    ];
    renderScreenshotDialog();

    await userEvent.click(screen.getByText(/77KB/).closest('button')!);
    expect(screen.getByRole('img', { name: 'screenshot of kiosk-01' })).toHaveAttribute('src', 'data:image/png;base64,b2xk');

    // same capture, new timestamp object: nothing new arrived
    heartbeat();

    expect(screen.getByRole('img', { name: 'screenshot of kiosk-01' })).toHaveAttribute('src', 'data:image/png;base64,b2xk');
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

  it("opened on the next machine, shows nothing of the last one's", () => {
    mockMachineDocs['kiosk-02'] = null;
    const modal = (machineId: string, open: boolean) => (
      <TooltipProvider>
        <LiveViewModal
          open={open}
          onOpenChange={() => {}}
          siteId="site-A"
          machineId={machineId}
          machineName={machineId}
          onStartLiveView={() => Promise.resolve()}
          onStopLiveView={() => Promise.resolve()}
        />
      </TooltipProvider>
    );
    const { rerender } = render(modal('kiosk-01', true));
    expect(screen.getByRole('img', { name: 'live view of kiosk-01' })).toHaveAttribute('src', IMAGE_URL);

    rerender(modal('kiosk-01', false));
    rerender(modal('kiosk-02', true));

    expect(screen.queryByRole('img', { name: 'live view of kiosk-02' })).toBeNull();
    expect(screen.getByText(/to begin a live preview of this machine/)).toBeInTheDocument();
  });
});
