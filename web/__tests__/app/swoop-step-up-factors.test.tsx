/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the viewer page's step-up, from the first refusal to the session: it asks
 * only for the factors the account holds and this page can run, and any answer
 * the server refuses is said in the dialog, which stays open with the code
 * field ready, never on a page whose only way on is back to the dashboard.
 * only fetch and the browser-only parts are faked; the hook is the real one.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import SwoopPage from '@/app/swoop/[siteId]/[machineId]/page';

let factors = { totp: true, passkeys: 0 };

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    mfaFactors: factors,
    user: { uid: 'user-me' },
    isSiteAdmin: () => true,
    isSiteOwner: () => false,
    machineScope: () => null,
    isMachineAdmin: () => true,
    siteRole: () => 'admin',
  }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: () => ({ machines: [], loading: false, error: null }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  useParams: () => ({ siteId: 'site-1', machineId: 'machine-1' }),
}));

jest.mock('@/lib/swoop/clientCaps', () => ({
  probeClientCaps: async () => ({ codecs: ['h264'], hardware: [], playoutDelay: true, webCodecsHevc: false }),
}));

jest.mock('@/lib/swoop/peer', () => ({
  createSwoopIdentity: async () => ({ certificate: {}, fingerprint: 'sha-256 AA:BB' }),
}));

// jsdom has no WebAuthn; a browser that has it is the case under test.
jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: jest.fn(),
}));

const SESSIONS = '/api/sites/site-1/machines/machine-1/swoop/sessions';
const STEP_UP = { status: 401, body: { code: 'step_up_required', detail: 'confirm your identity to take control.' } };

/** the answers the session create gives, in order; the last one repeats. */
let creates: Array<{ status: number; body: unknown }>;
let fetchMock: jest.Mock;
const createBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === SESSIONS)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { mfaProof?: unknown });

beforeEach(() => {
  factors = { totp: true, passkeys: 0 };
  creates = [STEP_UP];
  fetchMock = jest.fn(async (url: string) => {
    if (url !== SESSIONS) return { ok: false, status: 404, json: async () => ({}) } as Response;
    const reply = creates.length > 1 ? creates.shift()! : creates[0];
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  });
}

async function openStepUp() {
  const params = Promise.resolve({ siteId: 'site-1', machineId: 'machine-1' });
  await act(async () => {
    render(
      <TooltipProvider>
        <SwoopPage params={params} />
      </TooltipProvider>,
    );
  });
  await settle();
  return screen.getByRole('dialog');
}

async function confirmCode(dialog: HTMLElement, code: string) {
  fireEvent.change(within(dialog).getByLabelText('authenticator code'), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
  await settle();
}

describe('the step-up offers only what the account holds', () => {
  it('a passkey-only account is offered its passkey and a backup code, never an authenticator code', async () => {
    factors = { totp: false, passkeys: 1 };
    const dialog = await openStepUp();

    expect(within(dialog).getByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('authenticator code')).toBeNull();
    expect(within(dialog).queryByText('or enter a code')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'use a backup code instead' })).toBeInTheDocument();
  });

  it('an authenticator-only account is offered its code and a backup code, never a passkey', async () => {
    const dialog = await openStepUp();

    expect(within(dialog).getByLabelText('authenticator code')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('use a backup code instead')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'use a passkey' })).toBeNull();
  });
});

describe('a refused answer stays in the dialog', () => {
  it('a wrong code is said inline, the dialog stays open with the field ready, and the right code then takes control', async () => {
    creates = [
      STEP_UP,
      { status: 400, body: { error: 'invalid verification code', code: 'invalid_mfa_proof' } },
      { status: 201, body: { data: { sid: 'sid-1' } } },
    ];
    const dialog = await openStepUp();

    await confirmCode(dialog, '111111');

    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent("that code didn't work. try again.");
    expect(within(dialog).getByLabelText('authenticator code')).toBeEnabled();
    expect(within(dialog).getByLabelText('authenticator code')).toHaveValue('');
    // nothing settled behind it: no notice on the stage, so no dead end to land on
    expect(document.querySelector('main p[role="alert"]')).toBeNull();

    await confirmCode(dialog, '222222');

    expect(createBodies().map((body) => body.mfaProof)).toEqual([undefined, { code: '111111' }, { code: '222222' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    [
      'a code from a stale page on an account with no authenticator',
      { status: 400, body: { error: 'this account has no authenticator enrolled.', code: 'totp_not_enrolled' } },
      'this account has no authenticator app. use a passkey or a backup code.',
    ],
    [
      'too many tries',
      { status: 429, body: { error: 'too many attempts. try again in a few minutes.', code: 'mfa_attempts_exceeded' } },
      'too many tries. wait a minute, then try again.',
    ],
    [
      'a step-up still owed after the proof',
      { status: 401, body: { code: 'step_up_required', detail: 'confirm your identity to take control.' } },
      'confirm your identity to take control.',
    ],
  ])('%s is said inline, with no dead end', async (_case, refusal, message) => {
    creates = [STEP_UP, refusal];
    const dialog = await openStepUp();

    await confirmCode(dialog, '111111');

    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    // nothing settled behind it: no notice on the stage, so no dead end to land on
    expect(document.querySelector('main p[role="alert"]')).toBeNull();
  });

  it('a sign-in that lapsed while confirming signs in again and comes back to this machine, ahead of the dashboard', async () => {
    creates = [STEP_UP, { status: 401, body: { code: 'unauthorized', detail: 'no valid session.' } }];
    const dialog = await openStepUp();

    await confirmCode(dialog, '111111');

    expect(screen.queryByRole('dialog')).toBeNull();
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('sign in again to resume.');
    const links = within(notice).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['sign in again', 'back to dashboard']);
    expect(links[0]).toHaveAttribute('href', '/login?redirect=%2Fswoop%2Fsite-1%2Fmachine-1');
  });

  it('cancelling leaves a way straight back to the same confirmation', async () => {
    const dialog = await openStepUp();

    fireEvent.click(within(dialog).getByRole('button', { name: 'cancel' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    const notice = screen.getByRole('alert');

    fireEvent.click(within(notice).getByRole('button', { name: 'try again' }));
    await settle();

    expect(screen.getByRole('dialog')).toHaveTextContent(/confirm it.s you/);
    expect(createBodies()).toHaveLength(2);
  });
});
