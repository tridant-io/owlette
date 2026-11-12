/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /deployments offers only what the routes will do: the cancel x on a target
 * that has not started installing, retry on a target whose install failed, and
 * a toast that says why when the server refuses anyway: in the page's words when
 * the machine moved on, in the server's otherwise.
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from '@/lib/toast';
import { machinesInActiveHours } from '@/components/ActiveHoursDeployConfirm';
import DeploymentsPage from '@/app/deployments/page';

window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    loading: false,
    userPreferences: {},
    isSiteAdmin: () => true,
    machineScope: () => null,
  }),
}));

jest.mock('@/hooks/useCurrentSite', () => ({
  useCurrentSite: () => ({
    sites: [{ id: 'site-A', name: 'site A' }],
    sitesLoading: false,
    currentSiteId: 'site-A',
    currentSite: { id: 'site-A', name: 'site A', owner: 'u1' },
    siteTimezone: undefined,
    hasNoSites: false,
    limitedOnly: false,
    selectSite: jest.fn(),
  }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  ...jest.requireActual('@/hooks/useFirestore'),
  useMachines: () => ({ machines: [] }),
}));

jest.mock('@/hooks/useUninstall', () => ({ useUninstall: () => ({ createUninstall: jest.fn() }) }));

jest.mock('@/components/plan/UpgradeGate', () => ({
  UpgradeGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePlanGated: () => false,
}));

jest.mock('@/components/ActiveHoursDeployConfirm', () => ({
  ActiveHoursDeployConfirm: () => null,
  machinesInActiveHours: jest.fn(() => []),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));

const mockDeployments = [
  {
    id: 'dep-1',
    name: 'vlc rollout',
    installer_name: 'vlc.exe',
    installer_url: 'https://example.com/vlc.exe',
    silent_flags: '/S',
    status: 'in_progress',
    createdAt: 2,
    targets: [
      { machineId: 'm-pending', status: 'pending' },
      { machineId: 'm-closing', status: 'closing_processes' },
      { machineId: 'm-downloading', status: 'downloading', progress: 30 },
      { machineId: 'm-installing', status: 'installing', progress: 60 },
      { machineId: 'm-install-failed', status: 'failed', error: 'checksum mismatch', failedCommandType: 'install_software' },
      { machineId: 'm-uninstall-failed', status: 'failed', error: 'uninstaller exited 1603', failedCommandType: 'uninstall_software' },
    ],
  },
  {
    id: 'dep-2',
    name: 'obs removal',
    installer_name: 'obs.exe',
    installer_url: 'https://example.com/obs.exe',
    silent_flags: '/S',
    status: 'partial',
    createdAt: 1,
    targets: [
      { machineId: 'm-done', status: 'uninstalled' },
      // failed before failedCommandType was recorded: the agent's nameless-uninstall answer
      { machineId: 'm-legacy-uninstall', status: 'failed', error: 'Error: Software name and uninstall command required' },
    ],
  },
];

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  onSnapshot: jest.fn((ref: { path: string }, onNext: (snap: unknown) => void) => {
    const docs = ref.path.endsWith('/deployments') ? mockDeployments : [];
    onNext({ forEach: (each: (doc: unknown) => void) => docs.forEach((d) => each({ id: d.id, data: () => d })) });
    return () => {};
  }),
}));

jest.mock('@/components/PageHeader', () => ({ PageHeader: () => null }));
jest.mock('@/components/AccountSettingsDialog', () => ({ AccountSettingsDialog: () => null }));
jest.mock('@/components/DownloadButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/DeploymentDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/UninstallDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/UpdateOwletteButton', () => ({ UpdateOwletteButton: () => null }));

const fetchMock = jest.fn();

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});

function refuse(status: number, problem: { code?: string; detail: string }) {
  fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ title: 'refused', ...problem }) });
}

async function expand(name: string) {
  render(<DeploymentsPage />);
  await userEvent.click(await screen.findByRole('button', { name: `details for ${name}` }));
}

async function openMenu(name: string) {
  render(<DeploymentsPage />);
  await userEvent.click(await screen.findByRole('button', { name: `deployment actions for ${name}` }));
  return screen.findByRole('menu');
}

describe('cancel', () => {
  it('offers the x only on a target that has not started installing', async () => {
    await expand('vlc rollout');

    for (const machineId of ['m-pending', 'm-closing', 'm-downloading']) {
      expect(screen.getByRole('button', { name: `cancel deployment to ${machineId}` })).toBeInTheDocument();
    }
    for (const machineId of ['m-installing', 'm-install-failed']) {
      expect(screen.queryByRole('button', { name: `cancel deployment to ${machineId}` })).not.toBeInTheDocument();
    }
  });

  it('says on the x that an installer already running finishes', async () => {
    await expand('vlc rollout');

    await userEvent.hover(screen.getByRole('button', { name: 'cancel deployment to m-downloading' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'cancel this machine. an installer that is already running finishes',
    );
  });

  it('cancels only the machine clicked', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ cancelled: 1 }) });
    await expand('vlc rollout');

    await userEvent.click(screen.getByRole('button', { name: 'cancel deployment to m-downloading' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sites/site-A/deployments/dep-1/cancel');
    expect(JSON.parse(String(init.body))).toEqual({ machines: ['m-downloading'] });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says in plain words when the machine moved on before the cancel reached it', async () => {
    refuse(409, {
      code: 'no_cancellable_targets',
      detail: 'no targets in `pending`, `closing_processes` or `downloading` state matching the machines filter',
    });
    await expand('vlc rollout');

    await userEvent.click(screen.getByRole('button', { name: 'cancel deployment to m-pending' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "m-pending has already started installing or finished, so it can't be cancelled",
      ),
    );
  });

  it('enables the x again after a refused cancel', async () => {
    refuse(409, { code: 'no_cancellable_targets', detail: 'every target is already past the queued phase or terminal' });
    await expand('vlc rollout');
    const x = screen.getByRole('button', { name: 'cancel deployment to m-pending' });

    await userEvent.click(x);

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(x).toBeEnabled());
  });

  it("keeps the server's reason for any other cancel failure", async () => {
    refuse(404, { detail: 'deployment dep-1 not found on site site-A' });
    await expand('vlc rollout');

    await userEvent.click(screen.getByRole('button', { name: 'cancel deployment to m-pending' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('deployment dep-1 not found on site site-A'));
  });

  it('sends one cancel for a double click', async () => {
    let land: (response: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    await expand('vlc rollout');
    const x = screen.getByRole('button', { name: 'cancel deployment to m-pending' });

    await userEvent.click(x);
    await userEvent.click(x);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(x).toBeDisabled();
    land({ ok: true, status: 200, json: async () => ({ cancelled: 1 }) });
    await waitFor(() => expect(x).toBeEnabled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('retry', () => {
  it('offers retry this machine only on a target whose install failed', async () => {
    await expand('vlc rollout');

    expect(screen.getByRole('button', { name: 'retry deployment to m-install-failed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'retry deployment to m-uninstall-failed' })).not.toBeInTheDocument();
    // the reason stays on the line
    expect(screen.getByText('uninstaller exited 1603')).toBeInTheDocument();
  });

  it('offers no retry failed when every failed target failed an uninstall', async () => {
    const menu = await openMenu('obs removal');

    expect(within(menu).queryByRole('menuitem', { name: /retry failed/ })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /uninstall software/ })).toBeInTheDocument();
  });

  it('retry failed asks about active hours only for the machines it retries', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ retried: 1 }) });
    const menu = await openMenu('vlc rollout');

    await userEvent.click(within(menu).getByRole('menuitem', { name: /retry failed/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('retrying deployment for 1 machine(s)'));
    expect(machinesInActiveHours).toHaveBeenCalledWith([], ['m-install-failed']);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sites/site-A/deployments/dep-1/retry');
  });

  it('says in plain words when the machine moved on before the retry reached it', async () => {
    refuse(409, { code: 'no_failed_targets', detail: 'no targets in `failed` state matching the machines filter' });
    await expand('vlc rollout');

    await userEvent.click(screen.getByRole('button', { name: 'retry deployment to m-install-failed' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'm-install-failed is no longer a failed install, so nothing was retried',
      ),
    );
  });

  it('says in plain words when every failed machine moved on before retry failed reached it', async () => {
    refuse(409, {
      code: 'no_failed_targets',
      detail: 'every target this retry matched left `failed` while it ran; nothing was queued',
    });
    const menu = await openMenu('vlc rollout');

    await userEvent.click(within(menu).getByRole('menuitem', { name: /retry failed/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'the machines this retry picked are no longer failed installs, so nothing was retried',
      ),
    );
  });

  it("keeps the server's reason for any other retry failure", async () => {
    const detail = 'download failed with http 404';
    refuse(422, { code: 'fetch_failed', detail });
    await expand('vlc rollout');

    await userEvent.click(screen.getByRole('button', { name: 'retry deployment to m-install-failed' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(detail));
  });
});
