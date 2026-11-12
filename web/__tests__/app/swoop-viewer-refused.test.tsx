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
let siteOwner = false;

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    mfaFactors: { totp: true, passkeys: 0 },
    isSiteAdmin: () => siteAdmin,
    isSiteOwner: () => siteOwner,
    machineScope: () => null,
    isMachineAdmin: () => siteAdmin,
    siteRole: () => (siteOwner ? 'owner' : siteAdmin ? 'admin' : 'member'),
  }),
}));

// what the machine read answers, and what it was asked for
const PERMISSION_DENIED = 'Missing or insufficient permissions.';
let machineRead: { machines: unknown[]; loading: boolean; error: string | null };
const machineReads: unknown[][] = [];

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: (...args: unknown[]) => {
    machineReads.push(args);
    return machineRead;
  },
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock('@/lib/swoop/clientCaps', () => ({
  probeClientCaps: async () => ({ codecs: ['h264'], hardware: [], playoutDelay: true, webCodecsHevc: false }),
}));

jest.mock('@/lib/swoop/peer', () => ({
  createSwoopIdentity: async () => ({ certificate: {}, fingerprint: 'sha-256 AA:BB' }),
}));

const SITE = 'site 1';
const refusal = { code: 'swoop_disabled', detail: 'swoop is not enabled for this site.' };
let reply: { status: number; body: unknown };

beforeEach(() => {
  siteAdmin = false;
  siteOwner = false;
  machineRead = { machines: [], loading: false, error: null };
  machineReads.length = 0;
  reply = { status: 403, body: refusal };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = jest.fn(
    async () => ({ ok: false, status: reply.status, json: async () => reply.body }) as Response,
  ) as unknown as typeof fetch;
});

async function mountViewer() {
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
}

async function openViewer() {
  await mountViewer();
  return screen.getByRole('alert');
}

it('a session refused for good says why in the middle, and does not say it is connecting', async () => {
  const notice = await openViewer();
  expect(notice).toHaveTextContent('swoop is not enabled for this site.');
  expect(screen.queryByText(/connecting/i)).toBeNull();
});

it('tells an admin to turn swoop on and links to swoop settings', async () => {
  siteAdmin = true;
  const notice = await openViewer();
  expect(notice).toHaveTextContent('turn it on in swoop settings.');
  expect(within(notice).getByRole('link', { name: 'open swoop settings' })).toHaveAttribute(
    'href',
    '/admin/swoop',
  );
});

it('tells a member who can turn it on, with no settings link', async () => {
  const notice = await openViewer();
  expect(notice).toHaveTextContent('ask a site owner or admin to turn it on.');
  expect(within(notice).queryByRole('link', { name: 'open swoop settings' })).toBeNull();
});

it('a plan without swoop says so and links the owner to the plan, not the switch, and does not retry', async () => {
  siteAdmin = true;
  siteOwner = true;
  reply = {
    status: 402,
    body: { code: 'plan_required', detail: "your plan doesn't include swoop. upgrade to continue.", upgradeUrl: '/settings/plan' },
  };
  const notice = await openViewer();
  expect(notice).toHaveTextContent('swoop is part of pro.');
  expect(within(notice).getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', '/settings/plan');
  expect(notice).not.toHaveTextContent(/turn it on|reconnecting in/);
  expect(within(notice).queryByRole('link', { name: 'open swoop settings' })).toBeNull();
});

it('a member on a site whose plan leaves swoop out is told to ask the owner, with no upgrade link', async () => {
  siteAdmin = true;
  reply = {
    status: 402,
    body: { code: 'plan_required', detail: "your plan doesn't include swoop. upgrade to continue.", upgradeUrl: '/settings/plan' },
  };
  const notice = await openViewer();
  expect(notice).toHaveTextContent('swoop is part of pro. ask the site owner to upgrade.');
  expect(within(notice).queryByRole('link', { name: 'upgrade' })).toBeNull();
});

it('the way back to the dashboard is in the notice and on the bar', async () => {
  const notice = await openViewer();
  expect(within(notice).getByRole('link', { name: 'back to dashboard' })).toHaveAttribute('href', '/dashboard');
  expect(within(screen.getByTestId('session-bar')).getByRole('link', { name: 'back to dashboard' })).toHaveAttribute(
    'href',
    '/dashboard',
  );
});

/**
 * a scoped member may read only their own machines, and the api answers a
 * machine outside their scope as one that is not there. "this machine has left
 * the site" is release 1's, and fires only on its own signals: the create's
 * `machine_not_found` and a record ended as `machine_removed`.
 */
describe('a machine outside the machine scope', () => {
  it('reads only its own machine document, for a whole-site admin too', async () => {
    siteAdmin = true;
    await openViewer();
    expect(machineReads.length).toBeGreaterThan(0);
    for (const args of machineReads) expect(args).toEqual([SITE, ['machine-1']]);
  });

  it('a machine read the rules refuse says nothing about the machine leaving', async () => {
    machineRead = { machines: [], loading: false, error: PERMISSION_DENIED };
    // the session ask is still on its way: only the read has answered
    (globalThis as unknown as { fetch: typeof fetch }).fetch = jest.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    await mountViewer();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/left the site/)).toBeNull();
  });

  it.each([
    ["the wrapper's 404", { code: 'not_found', detail: 'machine not found or no access' }],
    ['a 404 with no code', { detail: 'machine not found or no access' }],
  ])('%s at create is final on its own sentence, with the way back, and never says the machine left', async (_what, body) => {
    machineRead = { machines: [], loading: false, error: PERMISSION_DENIED };
    reply = { status: 404, body };
    const notice = await openViewer();
    expect(notice).toHaveTextContent('machine not found or no access');
    expect(notice).not.toHaveTextContent(/left the site|reconnecting in/);
    expect(within(notice).getByRole('link', { name: 'back to dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("release 1's machine_not_found at create still says the machine has left the site", async () => {
    reply = { status: 404, body: { code: 'machine_not_found', detail: 'machine not found' } };
    const notice = await openViewer();
    expect(notice).toHaveTextContent('this machine has left the site.');
    expect(within(notice).getByRole('link', { name: 'back to dashboard' })).toHaveAttribute('href', '/dashboard');
  });
});
