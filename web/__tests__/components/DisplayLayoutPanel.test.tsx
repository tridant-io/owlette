/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for the display layout panel's auto-restore UI: the toggle's permission gate and
 * disabled branches, the setAutoRestore call, the admin/read-only fork of the breaker banner, and
 * the breaker reset button.
 *
 * Peer hooks (useDisplayDraft, useDisplayModes, useDisplayEventFeed, useCommandResult) are mocked
 * inert so the controlled mocks below are the single source of truth — no real Firestore or
 * sessionStorage.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AssignedLayout,
  DisplayAutoRestoreState,
  DisplayProfile,
  MonitorInfo,
} from '@/hooks/useDisplayState';

// Mocks — set up before importing the component under test.
// Keep the pure helpers real; only `useDisplayState` becomes a controllable mock.
jest.mock('@/hooks/useDisplayState', () => {
  const actual = jest.requireActual('@/hooks/useDisplayState');
  return {
    ...actual,
    useDisplayState: jest.fn(),
  };
});

jest.mock('@/hooks/useDisplayActions', () => ({
  useDisplayActions: jest.fn(),
}));

jest.mock('@/hooks/useCommandResult', () => ({
  useCommandResult: jest.fn(),
}));

jest.mock('@/hooks/useDisplayDraft', () => ({
  useDisplayDraft: jest.fn(),
}));

jest.mock('@/hooks/useDisplayModes', () => ({
  useDisplayModes: jest.fn(),
}));

jest.mock('@/hooks/useDisplayEventFeed', () => ({
  useDisplayEventFeed: jest.fn(),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// Stubs for heavy children — jsdom can't satisfy their canvas/DOM-measurement code.
jest.mock('@/components/charts/DisplayCanvas', () => ({
  DisplayCanvas: () => <div data-testid="display-canvas-stub" />,
}));
jest.mock('@/components/charts/DisplayMonitorTable', () => ({
  DisplayMonitorTable: () => <div data-testid="display-monitor-table-stub" />,
}));
jest.mock('@/components/charts/DisplayEditorDialog', () => ({
  DisplayEditorDialog: () => null,
}));
jest.mock('@/components/ConfirmDialog', () => ({
  __esModule: true,
  default: ({
    open,
    title,
    confirmText,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmText: string;
    onConfirm: () => void | Promise<void>;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>{confirmText}</button>
      </div>
    ) : null,
}));

import { DisplayLayoutPanel } from '@/components/charts/DisplayLayoutPanel';
import { useDisplayState } from '@/hooks/useDisplayState';
import { useDisplayActions } from '@/hooks/useDisplayActions';
import { useCommandResult } from '@/hooks/useCommandResult';
import { useDisplayDraft } from '@/hooks/useDisplayDraft';
import { useDisplayModes } from '@/hooks/useDisplayModes';
import { useDisplayEventFeed } from '@/hooks/useDisplayEventFeed';
import { useAuth } from '@/contexts/AuthContext';
import { TooltipProvider } from '@/components/ui/tooltip';

const mockedUseDisplayState = useDisplayState as jest.MockedFunction<typeof useDisplayState>;
const mockedUseDisplayActions = useDisplayActions as jest.MockedFunction<typeof useDisplayActions>;
const mockedUseCommandResult = useCommandResult as jest.MockedFunction<typeof useCommandResult>;
const mockedUseDisplayDraft = useDisplayDraft as jest.MockedFunction<typeof useDisplayDraft>;
const mockedUseDisplayModes = useDisplayModes as jest.MockedFunction<typeof useDisplayModes>;
const mockedUseDisplayEventFeed = useDisplayEventFeed as jest.MockedFunction<typeof useDisplayEventFeed>;
const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

function makeMonitor(overrides: Partial<MonitorInfo> = {}): MonitorInfo {
  return {
    id: 'monitor-1',
    edidHash: 'hash-1',
    manufacturerId: 'DEL',
    productCode: '1234',
    serialNumber: 'SN-1',
    friendlyName: 'Dell U2723QE',
    position: { x: 0, y: 0 },
    resolution: { width: 3840, height: 2160 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: true,
    connectionType: 'dp',
    adapterLuid: 'luid-1',
    targetId: 1,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<DisplayProfile> = {}): DisplayProfile {
  return {
    schemaVersion: 1,
    signatureHash: 'sig-abc',
    capturedAt: 1_700_000_000_000,
    monitors: [makeMonitor()],
    mosaicActive: false,
    ...overrides,
  };
}

function makeAssigned(overrides: Partial<AssignedLayout> = {}): AssignedLayout {
  return {
    monitors: [makeMonitor()],
    capturedAt: 1_700_000_000_000,
    capturedBy: 'admin@example.com',
    ...overrides,
  };
}

function makeAutoRestore(
  overrides: Partial<DisplayAutoRestoreState> = {},
): DisplayAutoRestoreState {
  return {
    enabled: false,
    circuitBreaker: { tripped: false, failures: 0 },
    ...overrides,
  };
}

interface SetupOptions {
  canSiteAdmin?: boolean;
  userEmail?: string | null;
  hasAssignedLayout?: boolean;
  hasLiveProfile?: boolean;
  mosaicActive?: boolean;
  remoteApplyEnabled?: boolean;
  autoRestore?: Partial<DisplayAutoRestoreState>;
}

interface SetupResult {
  setAutoRestore: jest.Mock;
  resetAutoRestoreBreaker: jest.Mock;
  captureLayout: jest.Mock;
  applyLayout: jest.Mock;
  ackLayout: jest.Mock;
  clearLayout: jest.Mock;
  enumerateDisplayModes: jest.Mock;
  testDisplayApply: jest.Mock;
  setRemoteApplyEnabled: jest.Mock;
}

/** Wire all six mocked hooks to a controlled state; returns the action spies. */
function setup(options: SetupOptions = {}): SetupResult {
  const {
    canSiteAdmin = true,
    userEmail = 'admin@example.com',
    hasAssignedLayout = true,
    hasLiveProfile = true,
    mosaicActive = false,
    remoteApplyEnabled = true,
    autoRestore = {},
  } = options;

  // Only `isSiteAdmin` and `user.email` are consumed; cast the partial past AuthContextType.
  mockedUseAuth.mockReturnValue({
    isSiteAdmin: () => canSiteAdmin,
    user: userEmail ? ({ email: userEmail } as never) : null,
  } as unknown as ReturnType<typeof useAuth>);

  mockedUseDisplayState.mockReturnValue({
    profile: hasLiveProfile ? makeProfile({ mosaicActive }) : null,
    assigned: hasAssignedLayout ? makeAssigned() : null,
    autoRestore: makeAutoRestore(autoRestore),
    remoteApplyEnabled,
    loading: false,
    error: null,
  });

  mockedUseDisplayDraft.mockReturnValue({
    draft: null,
    isDirty: false,
    updateMonitor: jest.fn(),
    shiftSecondariesBy: jest.fn(),
    resetToAssigned: jest.fn(),
    resetToLive: jest.fn(),
    clearDraft: jest.fn(),
  });

  mockedUseDisplayModes.mockReturnValue({
    catalogue: null,
    loading: false,
    error: null,
    requestEnumerate: jest.fn(),
  });

  mockedUseDisplayEventFeed.mockReturnValue({
    events: [],
    loading: false,
    error: null,
  });

  // No self-test dispatched by default: null reads as "nothing pending".
  mockedUseCommandResult.mockReturnValue(null);

  const setAutoRestore = jest.fn().mockResolvedValue(undefined);
  const resetAutoRestoreBreaker = jest.fn().mockResolvedValue(undefined);
  const captureLayout = jest.fn().mockResolvedValue(undefined);
  const applyLayout = jest.fn().mockResolvedValue({ commandId: 'cmd', applyId: 'apply' });
  const ackLayout = jest.fn().mockResolvedValue('ack');
  const clearLayout = jest.fn().mockResolvedValue(undefined);
  const enumerateDisplayModes = jest.fn().mockResolvedValue('enum');
  const testDisplayApply = jest.fn().mockResolvedValue('test-cmd');
  const setRemoteApplyEnabled = jest.fn().mockResolvedValue(undefined);

  mockedUseDisplayActions.mockReturnValue({
    captureLayout,
    clearLayout,
    applyLayout,
    ackLayout,
    testDisplayApply,
    enumerateDisplayModes,
    setRemoteApplyEnabled,
    setAutoRestore,
    resetAutoRestoreBreaker,
    applying: false,
  });

  return {
    setAutoRestore,
    resetAutoRestoreBreaker,
    captureLayout,
    applyLayout,
    ackLayout,
    clearLayout,
    enumerateDisplayModes,
    testDisplayApply,
    setRemoteApplyEnabled,
  };
}

// Mirrors layout.tsx: without TooltipProvider every render throws on the panel's Radix tooltips.
function panelElement(capabilities?: Record<string, number>, machineId = 'machine-1') {
  return (
    <TooltipProvider>
      <DisplayLayoutPanel
        machineId={machineId}
        machineName="Lobby Display"
        siteId="site-a"
        capabilities={capabilities}
        onClose={jest.fn()}
      />
    </TooltipProvider>
  );
}

function renderPanel(capabilities?: Record<string, number>) {
  return render(panelElement(capabilities));
}

describe('DisplayLayoutPanel — auto-restore UI', () => {
  it('renders the toggle when canSiteAdmin is true', () => {
    setup({ canSiteAdmin: true });
    renderPanel();
    expect(screen.getByTestId('display-auto-restore-toggle')).toBeInTheDocument();
    expect(screen.getByText('auto-restore')).toBeInTheDocument();
  });

  it('hides the toggle when canSiteAdmin is false', () => {
    setup({ canSiteAdmin: false });
    renderPanel();
    expect(screen.queryByTestId('display-auto-restore-toggle')).not.toBeInTheDocument();
    expect(screen.queryByText('auto-restore')).not.toBeInTheDocument();
  });

  it('toggle calls setAutoRestore(true, userEmail) when initially disabled', async () => {
    const user = userEvent.setup();
    const { setAutoRestore } = setup({
      canSiteAdmin: true,
      userEmail: 'admin@example.com',
      autoRestore: { enabled: false },
    });
    renderPanel();

    await user.click(screen.getByTestId('display-auto-restore-toggle'));

    expect(setAutoRestore).toHaveBeenCalledTimes(1);
    expect(setAutoRestore).toHaveBeenCalledWith(true, 'admin@example.com');
  });

  it('toggle calls setAutoRestore(false, userEmail) when initially enabled', async () => {
    const user = userEvent.setup();
    const { setAutoRestore } = setup({
      canSiteAdmin: true,
      userEmail: 'admin@example.com',
      autoRestore: { enabled: true },
    });
    renderPanel();

    await user.click(screen.getByTestId('display-auto-restore-toggle'));

    expect(setAutoRestore).toHaveBeenCalledTimes(1);
    expect(setAutoRestore).toHaveBeenCalledWith(false, 'admin@example.com');
  });

  it('toggle is disabled when no assigned layout exists', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: false });
    renderPanel();
    const toggle = screen.getByTestId('display-auto-restore-toggle');
    // Assert the DOM `disabled` prop, not Radix's data-disabled attr — the former is what the
    // user actually hits.
    expect(toggle).toBeDisabled();
  });

  it('toggle is disabled when nvidia mosaic is active', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: true, mosaicActive: true });
    renderPanel();
    expect(screen.getByTestId('display-auto-restore-toggle')).toBeDisabled();
  });

  it('toggle is disabled when remote display apply is off', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: true, remoteApplyEnabled: false });
    renderPanel();
    expect(screen.getByTestId('display-auto-restore-toggle')).toBeDisabled();
  });

  it('renders an enable action when remote display apply is off', async () => {
    const user = userEvent.setup();
    const { setRemoteApplyEnabled } = setup({
      canSiteAdmin: true,
      hasAssignedLayout: true,
      remoteApplyEnabled: false,
    });
    renderPanel();

    await user.click(screen.getByTestId('display-enable-remote-apply-button'));
    const dialog = screen.getByRole('dialog', {
      name: /enable restore/i,
    });
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^enable restore$/i }));

    expect(setRemoteApplyEnabled).toHaveBeenCalledWith(true);
  });

  it('renders the admin breaker banner with a reset button when tripped + canSiteAdmin', () => {
    setup({
      canSiteAdmin: true,
      autoRestore: {
        enabled: true,
        circuitBreaker: {
          tripped: true,
          failures: 3,
          lastError: 'monitor disconnected',
        },
      },
    });
    renderPanel();

    expect(screen.getByTestId('display-auto-restore-breaker-banner')).toBeInTheDocument();
    expect(screen.getByTestId('display-auto-restore-reset-button')).toBeInTheDocument();
    // Banner carries the agent's last-error string so admins skip the events tab.
    expect(screen.getByText(/monitor disconnected/)).toBeInTheDocument();
    expect(
      screen.queryByTestId('display-auto-restore-breaker-readonly'),
    ).not.toBeInTheDocument();
  });

  it('renders the read-only breaker banner when tripped + not canSiteAdmin', () => {
    setup({
      canSiteAdmin: false,
      autoRestore: {
        enabled: true,
        circuitBreaker: {
          tripped: true,
          failures: 3,
          lastError: 'apply timeout',
        },
      },
    });
    renderPanel();

    expect(screen.getByTestId('display-auto-restore-breaker-readonly')).toBeInTheDocument();
    expect(
      screen.queryByTestId('display-auto-restore-breaker-banner'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('display-auto-restore-reset-button')).not.toBeInTheDocument();
    expect(screen.getByText(/apply timeout/)).toBeInTheDocument();
  });

  it('renders no breaker banner when the breaker is not tripped', () => {
    setup({
      canSiteAdmin: true,
      autoRestore: {
        enabled: true,
        circuitBreaker: { tripped: false, failures: 0 },
      },
    });
    renderPanel();

    expect(
      screen.queryByTestId('display-auto-restore-breaker-banner'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('display-auto-restore-breaker-readonly'),
    ).not.toBeInTheDocument();
  });

  it('reset button calls resetAutoRestoreBreaker', async () => {
    const user = userEvent.setup();
    const { resetAutoRestoreBreaker } = setup({
      canSiteAdmin: true,
      autoRestore: {
        enabled: true,
        circuitBreaker: {
          tripped: true,
          failures: 3,
          lastError: 'monitor disconnected',
        },
      },
    });
    renderPanel();

    await user.click(screen.getByTestId('display-auto-restore-reset-button'));

    expect(resetAutoRestoreBreaker).toHaveBeenCalledTimes(1);
  });
});

describe('DisplayLayoutPanel — restore capability gate', () => {
  // `capabilities` arrives as a prop off the machines subscription. Anything
  // below displayRemoteApply 1 means the agent cannot dispatch the command, so
  // restore must stay disabled even with a stored layout and restore enabled.
  it('enables restore at displayRemoteApply 1', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: true, remoteApplyEnabled: true });
    renderPanel({ displayRemoteApply: 1 });
    expect(screen.getByTestId('display-recall-button')).toBeEnabled();
  });

  it('disables restore when the agent reports the capability unsupported', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: true, remoteApplyEnabled: true });
    renderPanel({ displayRemoteApply: 0 });
    expect(screen.getByTestId('display-recall-button')).toBeDisabled();
  });

  it('disables restore on an agent that sends no capabilities at all', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: true, remoteApplyEnabled: true });
    renderPanel();
    expect(screen.getByTestId('display-recall-button')).toBeDisabled();
  });

  it('disables restore when the agent writes the capability as a non-number', () => {
    setup({ canSiteAdmin: true, hasAssignedLayout: true, remoteApplyEnabled: true });
    // The map is agent-written and unvalidated, so the declared Record<string, number>
    // is a compile-time claim only — a string must not coerce into "supported".
    renderPanel({ displayRemoteApply: '1' } as unknown as Record<string, number>);
    expect(screen.getByTestId('display-recall-button')).toBeDisabled();
  });
});

describe('DisplayLayoutPanel — apply self-test', () => {
  // The result rides `useCommandResult`, scoped to the dispatched command id:
  // in-flight is "id set, no result yet", and dismiss clears the id (which drops
  // the subscription with it).
  it('disables the test button while the dispatched command is unresolved', async () => {
    const user = userEvent.setup();
    const { testDisplayApply } = setup({ canSiteAdmin: true, remoteApplyEnabled: false });
    renderPanel();

    await user.click(screen.getByTestId('display-test-apply-button'));

    expect(testDisplayApply).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('display-test-apply-button')).toBeDisabled(),
    );
    expect(screen.queryByTestId('display-test-apply-result')).not.toBeInTheDocument();
  });

  it('renders the agent result and dismisses it', async () => {
    const user = userEvent.setup();
    setup({ canSiteAdmin: true, remoteApplyEnabled: false });
    // Mirrors the real hook: a result exists only while its command id is set.
    mockedUseCommandResult.mockImplementation((_siteId, _machineId, commandId) =>
      commandId ? 'helper reachable' : null,
    );
    renderPanel();

    await user.click(screen.getByTestId('display-test-apply-button'));

    const banner = await screen.findByTestId('display-test-apply-result');
    expect(banner).toHaveTextContent('helper reachable');

    await user.click(within(banner).getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByTestId('display-test-apply-result')).not.toBeInTheDocument();
  });

  it('drops the command when the panel switches to another machine', async () => {
    const user = userEvent.setup();
    setup({ canSiteAdmin: true, remoteApplyEnabled: false });
    mockedUseCommandResult.mockImplementation((_siteId, _machineId, commandId) =>
      commandId ? 'helper reachable' : null,
    );
    const { rerender } = renderPanel();

    await user.click(screen.getByTestId('display-test-apply-button'));
    await screen.findByTestId('display-test-apply-result');

    // The dashboard swaps machineId on the same panel instance (no key), so a
    // resolved command must not keep a listener open on the new machine's doc.
    rerender(panelElement(undefined, 'machine-2'));

    expect(mockedUseCommandResult).toHaveBeenLastCalledWith('site-a', 'machine-2', null);
    expect(screen.queryByTestId('display-test-apply-result')).not.toBeInTheDocument();
  });
});

describe('DisplayLayoutPanel — drift dot persistence', () => {
  // The drift dot derives purely from `mode !== 'edit' && hasDrift`, so clicking the 'stored' pill
  // (which only flips activeTab) must not dismiss it. Catches a refactor tying it to activeTab.
  it('keeps the drift dot on the "stored" pill after clicking it', async () => {
    const user = userEvent.setup();

    setup({ canSiteAdmin: true });
    // Same edidHash so the monitor matches; different x so computeDisplayDrift records drift.
    mockedUseDisplayState.mockReturnValue({
      profile: makeProfile({
        monitors: [makeMonitor({ position: { x: 100, y: 0 } })],
      }),
      assigned: makeAssigned({
        monitors: [makeMonitor({ position: { x: 0, y: 0 } })],
      }),
      autoRestore: makeAutoRestore(),
      remoteApplyEnabled: true,
      loading: false,
      error: null,
    });

    renderPanel();

    // aria-label carries the drift count only when the badge renders — a strict proxy for the dot.
    const storedButton = screen.getByRole('button', {
      name: /stored, \d+ display change/,
    });
    expect(storedButton).toBeInTheDocument();

    await user.click(storedButton);

    expect(
      screen.getByRole('button', { name: /stored, \d+ display change/ }),
    ).toBeInTheDocument();
  });
});
