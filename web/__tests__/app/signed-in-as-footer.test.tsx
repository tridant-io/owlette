/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * "signed in as <email>" in the footer of the two pages owlette swoop opens in the browser, the
 * app-link approval and the step-up verify page. a break-all on the email stranded its last
 * letter on a line of its own; now the email never wraps: too long for the band, it loses its
 * middle (the start and the domain's tail stay), and "not you? sign in as someone else" sits on a
 * line of its own under it.
 */
import React, { Suspense } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

const EMAIL = 'rosco@theexperiential.com';

const mockSignOut = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: EMAIL }, signOut: mockSignOut }),
}));

const replace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace, prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams('code=pendingcodependingcode'),
}));

jest.mock('@/lib/appLink', () => ({
  ...jest.requireActual('@/lib/appLink'),
  approveAppLink: jest.fn(),
}));

jest.mock('@/components/swoop/SwoopStepUpDialog', () => ({
  useStepUpCeremony: () => ({ pending: null, error: null, submit: jest.fn() }),
  StepUpCodeFields: () => null,
}));
jest.mock('@/lib/swoop/stepUp', () => ({ submitStepUpProof: jest.fn() }));

import AppLinkApprovePage from '@/app/app-link/approve/page';
import SwoopVerifyPage from '@/app/swoop/[siteId]/[machineId]/verify/page';
import { AuthSignedInAs } from '@/components/auth/AuthShell';

beforeEach(() => {
  mockSignOut.mockReset().mockResolvedValue(undefined);
  replace.mockReset();
});

async function renderVerify() {
  const params = Promise.resolve({ siteId: 'site-1', machineId: 'kiosk.lobby' });
  await act(async () =>
    render(
      <Suspense fallback={null}>
        <SwoopVerifyPage params={params} />
      </Suspense>,
    ),
  );
}

describe.each([
  ['the app-link approval', async () => void render(<AppLinkApprovePage />)],
  ['the step-up verify page', renderVerify],
])('the footer of %s', (_page, renderPage) => {
  it('keeps the email on one line, the way out on a line of its own', async () => {
    await renderPage();

    const email = screen.getByTestId('signed-in-email');
    expect(email).toHaveTextContent(EMAIL);
    expect(email).toHaveAttribute('title', EMAIL);
    expect(email).not.toHaveClass('break-all');
    // the start truncates, the domain's tail never shrinks
    expect(email.firstElementChild).toHaveClass('truncate');
    expect(email.firstElementChild).toHaveTextContent('rosco@theexperi');
    expect(email.lastElementChild).toHaveClass('shrink-0');
    expect(email.lastElementChild).toHaveTextContent('ential.com');

    const way = screen.getByTestId('sign-in-as-someone-else');
    expect(way).toHaveTextContent('not you? sign in as someone else');
    // a block row of its own holds "signed in as" and the email; the button comes after it
    const row = email.parentElement!;
    expect(row).toHaveClass('flex');
    expect(row).not.toContainElement(way);
    expect(row.nextElementSibling).toBe(way);
  });

  it('signs out and comes back to this page through the login', async () => {
    window.history.replaceState(null, '', '/somewhere?code=abc');
    await renderPage();

    fireEvent.click(screen.getByTestId('sign-in-as-someone-else'));
    await act(async () => {});

    expect(mockSignOut).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(`/login?redirect=${encodeURIComponent('/somewhere?code=abc')}`);
  });
});

describe('AuthSignedInAs', () => {
  it.each([
    ['a long local part keeps its domain whole', 'a.very.long.local.part@x.io', 'a.very.long.local.part', '@x.io'],
    ['a short email splits at the @', 'a@b.co', 'a', '@b.co'],
    ['a long domain keeps its last ten characters', 'me@mail.department.example.com', 'me@mail.department.e', 'xample.com'],
  ])('%s', (_case, address, head, tail) => {
    render(<AuthSignedInAs email={address} onSwitch={jest.fn()} />);

    const email = screen.getByTestId('signed-in-email');
    expect(email.firstElementChild!.textContent).toBe(head);
    expect(email.lastElementChild!.textContent).toBe(tail);
    expect(email.textContent).toBe(address);
  });
});
