/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the viewer page when the api refuses the session for good (#323): the
 * picture stops saying it is connecting, the refusal is said where it is seen
 * with where to turn swoop on, and the way back to the dashboard is on screen.
 * only fetch and the browser-only parts are faked; the hook is the real one.
 */

import { act, render, screen, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import SwoopPage from '@/app/swoop/[siteId]/[machineId]/page';

let siteAdmin = false;

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mfaFactors: { totp: true, passkeys: 0 }, isSiteAdmin: () => siteAdmin }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: () => ({ machines: [], loading: false, error: null }),
}));

jest.mock('@/lib/swoop/clientCaps', () => ({
  probeClientCaps: async () => ({ codecs: ['h264'], hardware: [], playoutDelay: true, webCodecsHevc: false }),
}));

jest.mock('@/lib/swoop/peer', () => ({
  createSwoopIdentity: async () => ({ certificate: {}, fingerprint: 'sha-256 AA:BB' }),
}));

const SITE = 'site 1';
const refusal = { code: 'swoop_disabled', detail: 'swoop is not enabled for this site.' };

beforeEach(() => {
  siteAdmin = false;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = jest.fn(
    async () => ({ ok: false, status: 403, json: async () => refusal }) as Response,
  ) as unknown as typeof fetch;
});

async function openViewer() {
  const params = Promise.resolve({ siteId: SITE, machineId: 'machine-1' });
  await act(async () => {
    render(
      <TooltipProvider>
        <SwoopPage params={params} />
      </TooltipProvider>,
    );
  });
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  return screen.getByRole('alert');
}

it('a session refused for good says why in the middle, and does not say it is connecting', async () => {
  const notice = await openViewer();
  expect(notice).toHaveTextContent('swoop is not enabled for this site.');
  expect(screen.queryByText(/connecting/i)).toBeNull();
});

it('tells an admin to turn swoop on and links to the site’s settings', async () => {
  siteAdmin = true;
  const notice = await openViewer();
  expect(notice).toHaveTextContent('turn it on in site settings.');
  expect(within(notice).getByRole('link', { name: 'open site settings' })).toHaveAttribute(
    'href',
    '/dashboard?settings=site%201',
  );
});

it('tells a member who can turn it on, with no settings link', async () => {
  const notice = await openViewer();
  expect(notice).toHaveTextContent('ask a site owner or admin to turn it on.');
  expect(within(notice).queryByRole('link', { name: 'open site settings' })).toBeNull();
});

it('the way back to the dashboard is in the notice and on the bar', async () => {
  const notice = await openViewer();
  expect(within(notice).getByRole('link', { name: 'back to dashboard' })).toHaveAttribute('href', '/dashboard');
  expect(within(screen.getByTestId('session-bar')).getByRole('link', { name: 'back to dashboard' })).toHaveAttribute(
    'href',
    '/dashboard',
  );
});
