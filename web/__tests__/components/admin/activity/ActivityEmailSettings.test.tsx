/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The superadmin-only activity email card on admin → alerts: the switch, the
 * address chips and the add field. It runs on the real `useActivityEmailSettings`,
 * so the tests answer its fetches the way the settings route does.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityEmailSettings } from '@/components/admin/activity/ActivityEmailSettings';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const fetchMock = jest.fn();
let originalFetch: typeof global.fetch;
let stored: { enabled: boolean; recipients: string[]; fallback: string | null };

// answers GET with the stored settings and PUT by storing what it was sent
function serve() {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      stored = { ...stored, ...JSON.parse(String(init.body)) };
    }
    return jsonResponse(stored);
  });
}

const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(init.body));

async function renderCard() {
  const user = userEvent.setup();
  render(<ActivityEmailSettings />);
  await screen.findByRole('switch', { name: 'activity findings' });
  return user;
}

beforeEach(() => {
  originalFetch = global.fetch;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof global.fetch;
  stored = { enabled: true, recipients: [], fallback: 'admin@example.test' };
  serve();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (toast.error as jest.Mock).mockClear();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('ActivityEmailSettings', () => {
  it('shows the title, the description and the link to the feed', async () => {
    await renderCard();
    expect(screen.getByText('activity findings')).toBeInTheDocument();
    expect(
      screen.getByText('emails when a detection rule flags activity: high findings at once, the rest in a daily digest'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'see what was flagged' })).toHaveAttribute('href', '/admin/activity?view=flagged');
  });

  it('says where mail goes when no address is set', async () => {
    await renderCard();
    expect(screen.getByText('no addresses set: emails go to admin@example.test')).toBeInTheDocument();
  });

  it('says nothing is sent when no address and no fallback', async () => {
    stored.fallback = null;
    await renderCard();
    expect(screen.getByText('no addresses set and no fallback address: nothing is sent')).toBeInTheDocument();
  });

  it('lists the stored addresses as removable chips and drops the empty line', async () => {
    stored.recipients = ['a@example.test', 'b@example.test'];
    await renderCard();
    expect(screen.getByText('a@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'remove b@example.test' })).toBeInTheDocument();
    expect(screen.queryByText(/no addresses set/)).not.toBeInTheDocument();
  });

  it('adds an address with the button and saves the list', async () => {
    const user = await renderCard();
    await user.type(screen.getByPlaceholderText('add an email address'), ' Ann@Example.test ');
    await user.click(screen.getByRole('button', { name: 'add' }));

    expect(await screen.findByRole('button', { name: 'remove ann@example.test' })).toBeInTheDocument();
    expect(puts()).toEqual([{ enabled: true, recipients: ['ann@example.test'] }]);
    expect(screen.getByPlaceholderText('add an email address')).toHaveValue('');
  });

  it('adds with Enter', async () => {
    const user = await renderCard();
    await user.type(screen.getByPlaceholderText('add an email address'), 'bob@example.test{Enter}');
    await screen.findByRole('button', { name: 'remove bob@example.test' });
    expect(puts()).toHaveLength(1);
  });

  it('refuses an invalid address inline and saves nothing', async () => {
    const user = await renderCard();
    await user.type(screen.getByPlaceholderText('add an email address'), 'nope{Enter}');

    expect(screen.getByText('that is not an email address')).toBeInTheDocument();
    expect(puts()).toEqual([]);
    expect(screen.getByPlaceholderText('add an email address')).toHaveValue('nope');
  });

  it('refuses a duplicate, whatever its case', async () => {
    stored.recipients = ['a@example.test'];
    const user = await renderCard();
    await user.type(screen.getByPlaceholderText('add an email address'), 'A@example.test{Enter}');

    expect(screen.getByText('already on the list')).toBeInTheDocument();
    expect(puts()).toEqual([]);
  });

  it('stops at ten addresses', async () => {
    stored.recipients = Array.from({ length: 10 }, (_, i) => `p${i}@example.test`);
    await renderCard();
    expect(screen.getByPlaceholderText('add an email address')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'add' })).toBeDisabled();
    expect(screen.getByText('up to 10 addresses')).toBeInTheDocument();
  });

  it('removes an address and saves the shorter list', async () => {
    stored.recipients = ['a@example.test', 'b@example.test'];
    const user = await renderCard();
    await user.click(screen.getByRole('button', { name: 'remove a@example.test' }));

    await waitFor(() => expect(screen.queryByText('a@example.test')).not.toBeInTheDocument());
    expect(puts()).toEqual([{ enabled: true, recipients: ['b@example.test'] }]);
  });

  it('saves the switch as it moves', async () => {
    stored.recipients = ['a@example.test'];
    const user = await renderCard();
    const toggle = screen.getByRole('switch', { name: 'activity findings' });
    expect(toggle).toBeChecked();

    await user.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(puts()).toEqual([{ enabled: false, recipients: ['a@example.test'] }]);
  });

  it('rolls back and toasts when a save fails', async () => {
    stored.recipients = ['a@example.test'];
    const user = await renderCard();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? jsonResponse({ detail: 'superadmin access required' }, 403) : jsonResponse(stored),
    );

    await user.click(screen.getByRole('button', { name: 'remove a@example.test' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('could not save activity emails', {
      description: 'superadmin access required',
    });
    expect(screen.getByRole('button', { name: 'remove a@example.test' })).toBeInTheDocument();
  });

  it('disables the controls while a save is in flight', async () => {
    const user = await renderCard();
    let finish: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(jsonResponse(stored)),
    );

    await user.click(screen.getByRole('switch', { name: 'activity findings' }));

    expect(screen.getByRole('switch', { name: 'activity findings' })).toBeDisabled();
    expect(screen.getByPlaceholderText('add an email address')).toBeDisabled();
    finish(jsonResponse({ ...stored, enabled: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'activity findings' })).toBeEnabled());
  });
});
