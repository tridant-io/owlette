/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * CreateSiteDialog — a new site is born on site time
 * (dev/completed/site-time-schedules, wave 3b task 3b.1).
 *
 * The dialog detects the browser's timezone, shows it, lets it be changed, and
 * writes it together with `schedulesFollowSiteTime: true`. Only NEW sites start
 * opted in; the three-state field's other two states belong to sites that
 * already exist, which answer through the dashboard banner instead.
 *
 * THE BRANCH THAT MATTERS MOST is the last one: `true` with no timezone is a
 * state the update action refuses outright, and on create it would silently
 * resolve to UTC — a clock nobody chose, driving every schedule at the site. So
 * a timezone the browser could not resolve drops the FLAG, not the create: the
 * site lands in the legacy "never asked" state and the banner asks later. That
 * fallback is asserted below, along with the fact that it never sends `false`
 * (which would count as a decline and suppress the banner forever).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';

// jsdom ships no ResizeObserver; Radix's popover positioning constructs one
// when the timezone select opens.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let browserTimezone = 'America/New_York';
jest.mock('@/lib/timeUtils', () => {
  const actual = jest.requireActual('@/lib/timeUtils');
  return {
    ...actual,
    // Only the detection is faked — TimezoneSelect keeps the real zone list.
    getBrowserTimezone: () => browserTimezone,
  };
});

// jest.setup mocks `db` to null, which would short-circuit the availability
// check into "Firebase not configured" and leave the submit button disabled.
jest.mock('@/lib/firebase', () => ({ app: null, auth: null, db: {}, isConfigured: true }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({ exists: () => false })),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'creator-uid' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

// plans are covered in CreateSiteDialog.plan.test.tsx; here the account plan never loads.
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: undefined, refresh: jest.fn() }),
}));

async function openDialog() {
  const user = userEvent.setup();
  const onCreateSite = jest.fn().mockResolvedValue('new-site');
  render(
    <TooltipProvider>
      <CreateSiteDialog open onOpenChange={() => {}} onCreateSite={onCreateSite} />
    </TooltipProvider>,
  );
  await screen.findByRole('dialog');
  await user.type(screen.getByLabelText('site name'), 'NYC Office');
  return { user, onCreateSite };
}

/** The availability check is debounced 500ms; the button enables when it lands. */
async function submit(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.getByRole('button', { name: 'create site' });
  await waitFor(() => expect(button).toBeEnabled(), { timeout: 3_000 });
  await user.click(button);
}

describe('the detected timezone', () => {
  beforeEach(() => {
    browserTimezone = 'America/New_York';
  });

  it('is surfaced before anything is created', async () => {
    await openDialog();
    expect(screen.getByTestId('create-site-timezone')).toHaveTextContent('America/New_York');
    expect(screen.getByText('(from your browser)')).toBeInTheDocument();
    expect(
      screen.getByText('scheduled processes at this site run on this clock, on every machine.'),
    ).toBeInTheDocument();
  });

  it('is read-only until the operator asks to change it', async () => {
    const { user } = await openDialog();
    expect(screen.queryByRole('combobox')).toBeNull();

    await user.click(screen.getByRole('button', { name: /change timezone/i }));
    // Named, not just present: the read-only row is text, so the select carries
    // its own (screen-reader-only) label.
    expect(screen.getByRole('combobox', { name: 'site timezone' })).toBeInTheDocument();
  });
});

describe('what the create writes', () => {
  beforeEach(() => {
    browserTimezone = 'America/New_York';
  });

  it('opts the new site into site time, with the timezone it depends on', async () => {
    const { user, onCreateSite } = await openDialog();

    await submit(user);

    await waitFor(() =>
      expect(onCreateSite).toHaveBeenCalledWith(
        expect.any(String),
        'NYC Office',
        'America/New_York',
        true,
        // a plain create: the account plan is not loaded here, so no plan step ran
        undefined,
      ),
    );
  });

  it('writes the timezone the operator picked, not the detected one', async () => {
    const { user, onCreateSite } = await openDialog();

    await user.click(screen.getByRole('button', { name: /change timezone/i }));
    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('search timezones...'), 'Berlin');
    await user.click(await screen.findByRole('button', { name: /Berlin/ }));

    expect(screen.getByTestId('create-site-timezone')).toHaveTextContent('Europe/Berlin');
    // The provenance note goes with it — an overridden zone is not the browser's.
    expect(screen.queryByText('(from your browser)')).toBeNull();

    await submit(user);

    await waitFor(() =>
      expect(onCreateSite).toHaveBeenCalledWith(
        expect.any(String),
        'NYC Office',
        'Europe/Berlin',
        true,
        undefined,
      ),
    );
  });

  it('still creates the site — with NO flag at all — when no timezone could be resolved', async () => {
    browserTimezone = '';
    const { user, onCreateSite } = await openDialog();

    expect(screen.getByTestId('create-site-timezone')).toHaveTextContent('not detected');

    await submit(user);

    await waitFor(() => expect(onCreateSite).toHaveBeenCalled());
    const [, , timezone, flag] = onCreateSite.mock.calls[0];
    expect(timezone).toBeUndefined();
    // `undefined`, never `false`: a site nobody asked must stay askable.
    expect(flag).toBeUndefined();
  });
});
