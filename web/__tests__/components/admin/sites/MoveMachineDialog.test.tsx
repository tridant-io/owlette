/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MoveMachineDialog, the machines section's "move to another site". it asks
 * through useMachineMove for the source site, refuses up front an agent too old
 * to follow, says an offline machine follows when it comes back, closes on a
 * request and stays open with the server's words on a refusal.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MoveMachineDialog } from '@/components/admin/sites/MoveMachineDialog';
import { useMachineMove, type MachineMoveResult } from '@/hooks/useMachineMove';
import type { SiteMachine } from '@/hooks/useSiteMachines';
import { MOVE_EXISTS, MOVE_OFFLINE, MOVE_TOO_OLD } from '@/lib/machineMove';
import { toast } from '@/lib/toast';
import { SITE_MOVE_MIN_AGENT_VERSION } from '@/lib/versionUtils';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/hooks/useMachineMove', () => ({ useMachineMove: jest.fn() }));

// radix measures its popovers with a ResizeObserver, drives pointers with
// pointer capture and scrolls select items into view; jsdom has none of them.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const SOURCE = { id: 'elm-gate', name: 'lobby' };
const TARGETS = [
  { id: 'oak-row', name: 'gallery' },
  { id: 'ash-hill', name: 'atrium' },
];

const requestMove = jest.fn<Promise<MachineMoveResult>, [string, string]>();
const cancelMove = jest.fn<Promise<MachineMoveResult>, [string]>();

function hook(busy = false) {
  jest.mocked(useMachineMove).mockReturnValue({ requestMove, cancelMove, busy });
}

beforeEach(() => {
  requestMove.mockResolvedValue({ moveId: 'elm-gate:kiosk-01', status: 'pending', targetSiteId: 'oak-row' });
  hook();
});

function machine(overrides: Partial<SiteMachine> = {}): SiteMachine {
  return {
    id: 'kiosk-01',
    name: 'kiosk',
    online: true,
    lastHeartbeat: null,
    agentVersion: SITE_MOVE_MIN_AGENT_VERSION,
    capabilities: { siteMove: 1 },
    pendingMove: null,
    ...overrides,
  };
}

function renderDialog({ row = machine(), open = true }: { row?: SiteMachine; open?: boolean } = {}) {
  const onOpenChange = jest.fn();
  const onMoved = jest.fn();
  const user = userEvent.setup();
  const view = (isOpen: boolean, current: SiteMachine) => (
    <MoveMachineDialog
      open={isOpen}
      onOpenChange={onOpenChange}
      machine={current}
      sourceSite={SOURCE}
      targetSites={TARGETS}
      onMoved={onMoved}
    />
  );
  const { rerender } = render(view(open, row));
  return {
    user,
    onOpenChange,
    onMoved,
    update: (isOpen: boolean, current = row) => rerender(view(isOpen, current)),
  };
}

const dialog = () => screen.getByRole('dialog', { name: 'move kiosk' });
const siteSelect = () => screen.getByRole('combobox', { name: 'move to' });
const moveButton = () => screen.getByRole('button', { name: 'move machine' });

async function pick(user: ReturnType<typeof userEvent.setup>, site: string) {
  await user.click(siteSelect());
  await user.click(screen.getByRole('option', { name: site }));
}

describe('MoveMachineDialog', () => {
  it('says how soon a move lands, what it takes along and what it deletes, and asks for the source site', () => {
    renderDialog();

    expect(dialog()).toHaveAccessibleDescription(
      "kiosk leaves lobby and joins the site you pick, within seconds while it is online. it needs no restart and nobody at the machine. its processes come with it. its screenshots and command history on lobby are deleted, and members limited to it here lose it.",
    );
    expect(siteSelect()).toHaveTextContent('pick a site');
    expect(useMachineMove).toHaveBeenCalledWith('elm-gate');
  });

  it('keeps move machine disabled until a site is picked', async () => {
    const { user } = renderDialog();

    expect(moveButton()).toBeDisabled();
    await pick(user, 'gallery');

    expect(siteSelect()).toHaveTextContent('gallery');
    expect(moveButton()).toBeEnabled();
  });

  it.each<[string, Partial<SiteMachine>, string]>([
    ['an agent below the minimum', { agentVersion: '4.2.2' }, '4.2.2'],
    ['an agent that reports no move support', { capabilities: null, agentVersion: '4.2.2' }, '4.2.2'],
    ['an agent with no version', { agentVersion: null }, 'unknown'],
  ])('refuses %s up front, with the copy and a disabled button', (_, overrides, shown) => {
    renderDialog({ row: machine({ online: false, ...overrides }) });

    expect(screen.getByText(MOVE_TOO_OLD('kiosk', shown, SITE_MOVE_MIN_AGENT_VERSION))).toBeInTheDocument();
    expect(moveButton()).toBeDisabled();
    expect(siteSelect()).toBeDisabled();
    // nothing to wait for when it can't move at all
    expect(screen.queryByText(MOVE_OFFLINE('kiosk'))).not.toBeInTheDocument();
  });

  it('disables a picked move when a refresh shows the agent too old', async () => {
    const { user, update } = renderDialog();

    await pick(user, 'gallery');
    await act(async () => update(true, machine({ agentVersion: '4.2.2' })));

    expect(moveButton()).toBeDisabled();
    await user.click(moveButton());
    expect(requestMove).not.toHaveBeenCalled();
  });

  it('says an offline machine follows when it comes back, and still lets the move go', async () => {
    const { user } = renderDialog({ row: machine({ online: false }) });

    expect(screen.getByText(MOVE_OFFLINE('kiosk'))).toBeInTheDocument();
    await pick(user, 'gallery');
    expect(moveButton()).toBeEnabled();
    await user.click(moveButton());
    expect(toast.success).toHaveBeenCalledWith('move requested', {
      description: 'kiosk moves to gallery when it is back online.',
    });
  });

  it('says nothing about waiting for an online machine that can move', () => {
    renderDialog();

    expect(screen.queryByText(MOVE_OFFLINE('kiosk'))).not.toBeInTheDocument();
    expect(screen.queryByText(/moving it needs/)).not.toBeInTheDocument();
  });

  it('requests the move to the picked site, toasts where it goes, and closes', async () => {
    const { user, onOpenChange, onMoved } = renderDialog();

    await pick(user, 'atrium');
    await user.click(moveButton());

    expect(requestMove).toHaveBeenCalledTimes(1);
    expect(requestMove).toHaveBeenCalledWith('kiosk-01', 'ash-hill');
    expect(toast.success).toHaveBeenCalledWith('move requested', {
      description: 'kiosk moves to atrium within seconds.',
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(onMoved).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toasts a refusal with the server detail, and stays open with the pick', async () => {
    requestMove.mockRejectedValue(new Error(MOVE_EXISTS('gallery', 'kiosk-01')));
    const { user, onOpenChange, onMoved } = renderDialog();

    await pick(user, 'gallery');
    await user.click(moveButton());

    expect(toast.error).toHaveBeenCalledWith('could not move the machine', {
      description: 'gallery already has a machine named kiosk-01. remove it there first.',
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
    expect(siteSelect()).toHaveTextContent('gallery');
    expect(moveButton()).toBeEnabled();
  });

  it('holds the buttons and the site while the request runs', () => {
    hook(true);
    renderDialog();

    expect(screen.getByRole('button', { name: 'moving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
    expect(siteSelect()).toBeDisabled();
  });

  it('cancel closes without requesting', async () => {
    const { user, onOpenChange } = renderDialog();

    await pick(user, 'gallery');
    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(requestMove).not.toHaveBeenCalled();
  });

  it('starts each open with no site picked', async () => {
    const { user, update } = renderDialog();

    await pick(user, 'gallery');
    await act(async () => update(false));
    await act(async () => update(true));

    expect(siteSelect()).toHaveTextContent('pick a site');
    expect(moveButton()).toBeDisabled();
  });
});
