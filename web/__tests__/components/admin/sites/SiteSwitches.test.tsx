/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * a site's two immediate switches: swoop, in the site's row on admin panel →
 * swoop → settings, and keep screens awake, on the site's machines section. each
 * PATCHes its own settings route the moment it moves, follows its snapshot, and
 * says something only when the write fails.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeepScreensAwakeSwitch, SwoopSwitch } from '@/components/admin/sites/SiteSwitches';

// the switches follow these snapshots; swoop off and keep awake on are each one's default.
jest.mock('@/hooks/useSwoopSettings', () => ({
  useSwoopSettings: () => ({ settings: { enabled: false }, loading: false }),
}));
jest.mock('@/hooks/useDisplaySettings', () => ({
  useDisplaySettings: () => ({ settings: { keepAwake: true }, loading: false }),
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
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  global.fetch = fetchMock as unknown as typeof fetch;
  toastSuccess.mockReset();
  toastError.mockReset();
});

// both at once, so each test also proves a write moves only its own switch
function renderSwitches() {
  const user = userEvent.setup();
  render(
    <>
      <SwoopSwitch siteId="site-a" siteName="Alpha" />
      <KeepScreensAwakeSwitch siteId="site-a" />
    </>,
  );
  return user;
}

const swoopSwitch = () => screen.getByRole('switch', { name: 'swoop on Alpha' });
const keepAwakeSwitch = () => screen.getByRole('switch', { name: 'keep screens awake' });

describe('the switches', () => {
  it('each follows its snapshot, with its own id and copy', () => {
    renderSwitches();

    expect(swoopSwitch()).toHaveAttribute('id', 'swoop-site-a');
    expect(swoopSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(keepAwakeSwitch()).toHaveAttribute('id', 'keep-awake-site-a');
    expect(keepAwakeSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('machines on this site never sleep, blank or lock')).toBeInTheDocument();
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

  it('encodes the site id in the route', async () => {
    const user = userEvent.setup();
    render(<SwoopSwitch siteId="elm gate" siteName="Alpha" />);

    await user.click(swoopSwitch());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sites/elm%20gate/swoop-settings');
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
