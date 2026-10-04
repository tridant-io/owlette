/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ManageSitesDialog — the site's switches (dev/active/keep-screens-awake, task 2.2).
 *
 * swoop and keep screens awake live in the site's edit panel, behind the same
 * site-admin gate as the pencil, and never in the machines panel. Each PATCHes
 * its own settings route the moment it moves, outside the panel's save, and
 * says something only when the write fails.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';

let siteAdmin = true;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isSiteAdmin: () => siteAdmin, isSiteOwner: () => false }),
}));

jest.mock('@/hooks/useUserManagement', () => ({
  useUserManagement: () => ({ users: [] }),
}));

// the switches follow these snapshots; swoop off and keep awake on are each one's default.
jest.mock('@/hooks/useSwoopSettings', () => ({
  useSwoopSettings: () => ({ settings: { enabled: false }, loading: false }),
}));
jest.mock('@/hooks/useDisplaySettings', () => ({
  useDisplaySettings: () => ({ settings: { keepAwake: true }, loading: false }),
}));

// the real list fetches its machines; only where the switches are not matters here.
jest.mock('@/components/SiteMachinesList', () => ({
  SiteMachinesList: () => <div data-testid="site-machines-list" />,
}));

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('@/lib/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: jest.fn(),
    warning: jest.fn(),
  },
}));

const SITE = { id: 'site-a', name: 'Site A', timezone: 'UTC' };

const fetchMock = jest.fn();

beforeEach(() => {
  siteAdmin = true;
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  global.fetch = fetchMock as unknown as typeof fetch;
  toastSuccess.mockReset();
  toastError.mockReset();
});

function renderDialog() {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <ManageSitesDialog
        open
        onOpenChange={() => {}}
        sites={[SITE]}
        currentSiteId={SITE.id}
        onUpdateSite={jest.fn()}
        onDeleteSite={jest.fn()}
        onCreateSite={jest.fn()}
      />
    </TooltipProvider>,
  );
  return user;
}

async function openEditPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'edit Site A' }));
}

const swoopSwitch = () => screen.getByRole('switch', { name: 'swoop' });
const keepAwakeSwitch = () => screen.getByRole('switch', { name: 'keep screens awake' });

describe('where the switches live', () => {
  it('puts both in the edit panel, each following its snapshot', async () => {
    const user = renderDialog();
    expect(screen.queryByRole('switch')).toBeNull();

    await openEditPanel(user);

    expect(swoopSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(keepAwakeSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByText("let admins watch and control this site's machines remotely"),
    ).toBeInTheDocument();
    expect(screen.getByText('machines on this site never sleep, blank or lock')).toBeInTheDocument();
  });

  it('keeps them out of the machines panel', async () => {
    const user = renderDialog();

    await user.click(screen.getByRole('button', { name: 'machines on Site A' }));

    expect(screen.getByTestId('site-machines-list')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('shows a member neither switch and no pencil', async () => {
    siteAdmin = false;
    const user = renderDialog();

    expect(screen.queryByRole('button', { name: 'edit Site A' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'machines on Site A' }));

    expect(screen.getByTestId('site-machines-list')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('what each switch writes', () => {
  it('swoop PATCHes swoop-settings with enabled', async () => {
    const user = renderDialog();
    await openEditPanel(user);

    await user.click(swoopSwitch());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sites/site-a/swoop-settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ enabled: true });
  });

  it('keep screens awake PATCHes display-settings with keepAwake', async () => {
    const user = renderDialog();
    await openEditPanel(user);

    await user.click(keepAwakeSwitch());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sites/site-a/display-settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ keepAwake: false });
  });

  it('disables a switch while its write is in flight, and says nothing on success', async () => {
    let finish: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const user = renderDialog();
    await openEditPanel(user);

    await user.click(keepAwakeSwitch());

    expect(keepAwakeSwitch()).toBeDisabled();
    expect(swoopSwitch()).toBeEnabled();
    finish({ ok: true, json: async () => ({}) });
    await waitFor(() => expect(keepAwakeSwitch()).toBeEnabled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts the server reason when a write fails', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ detail: 'capability not granted' }),
    });
    const user = renderDialog();
    await openEditPanel(user);

    await user.click(keepAwakeSwitch());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('capability not granted'));
    expect(keepAwakeSwitch()).toBeEnabled();
    logged.mockRestore();
  });
});
