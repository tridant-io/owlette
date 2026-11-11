/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the swoop & screens section. each switch PATCHes its own settings route the
 * moment it moves, follows its snapshot, and says something only when the
 * write fails.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SiteSwitches } from '@/components/admin/sites/SiteSwitches';

// the switches follow these snapshots; swoop off and keep awake on are each one's default.
let membersMayWatch = true;
jest.mock('@/hooks/useSwoopSettings', () => ({
  useSwoopSettings: () => ({ settings: { enabled: false, membersMayWatch }, loading: false }),
}));
jest.mock('@/hooks/useDisplaySettings', () => ({
  useDisplaySettings: () => ({ settings: { keepAwake: true }, loading: false }),
}));

jest.mock('@/hooks/useFleetSettings', () => ({
  useFleetSettings: () => ({ settings: { enabled: false, senders: {} }, loading: false }),
}));
jest.mock('@/hooks/useSiteMachines', () => ({
  useSiteMachines: () => ({ machines: [], error: null, refresh: jest.fn() }),
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

const fetchMock = jest.fn();

beforeEach(() => {
  membersMayWatch = true;
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  global.fetch = fetchMock as unknown as typeof fetch;
  toastSuccess.mockReset();
  toastError.mockReset();
});

function renderSwitches() {
  const user = userEvent.setup();
  render(<SiteSwitches siteId="site-a" />);
  return user;
}

const swoopSwitch = () => screen.getByRole('switch', { name: 'swoop' });
const keepAwakeSwitch = () => screen.getByRole('switch', { name: 'keep screens awake' });

describe('the swoop & screens section', () => {
  it('is a panel holding both switches, each following its snapshot', () => {
    renderSwitches();

    const section = screen.getByRole('region', { name: 'swoop & screens' });
    expect(within(section).getByRole('heading', { level: 2 })).toHaveAttribute('id', 'site-section-swoop');
    expect(within(section).getByText('these switches act the moment they move.')).toBeInTheDocument();
    expect(within(section).getByRole('switch', { name: 'swoop' })).toHaveAttribute('id', 'swoop-site-a');
    expect(swoopSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(within(section).getByRole('switch', { name: 'keep screens awake' })).toHaveAttribute(
      'id',
      'keep-awake-site-a',
    );
    expect(keepAwakeSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('machines on this site never sleep, blank or lock')).toBeInTheDocument();
  });

  it.each([
    [
      true,
      "by default, owners and admins watch and control this site's machines remotely, and members watch. change it per person in members.",
    ],
    [
      false,
      "by default, owners and admins watch and control this site's machines remotely; members don't watch. change it per person in members.",
    ],
  ])('says who swoops by default when membersMayWatch is %p', (mayWatch, copy) => {
    membersMayWatch = mayWatch;
    renderSwitches();

    expect(screen.getByText(copy)).toBeInTheDocument();
  });
});

describe('what each switch writes', () => {
  it('swoop PATCHes swoop-settings with enabled', async () => {
    const user = renderSwitches();

    await user.click(swoopSwitch());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sites/site-a/swoop-settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ enabled: true });
  });

  it('keep screens awake PATCHes display-settings with keepAwake', async () => {
    const user = renderSwitches();

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
    const user = renderSwitches();

    await user.click(keepAwakeSwitch());

    expect(keepAwakeSwitch()).toBeDisabled();
    expect(swoopSwitch()).toBeEnabled();
    finish({ ok: true, json: async () => ({}) });
    await waitFor(() => expect(keepAwakeSwitch()).toBeEnabled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts the server detail when a write fails', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ detail: 'capability not granted' }),
    });
    const user = renderSwitches();

    await user.click(keepAwakeSwitch());

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('could not change keep screens awake', {
        description: 'capability not granted',
      }),
    );
    expect(keepAwakeSwitch()).toBeEnabled();
    logged.mockRestore();
  });
});
