/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * TalonCard — the "why is this talon off?" surface. Scoped to the
 * disabled-reason line: an operator who finds a talon switched off must be told
 * why on the row, without expanding a run. The rest of the row is formatting
 * with its own units or live-data wiring.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

import { TalonCard, type TalonListItem } from '@/app/talons/components/TalonCard';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TALON_DISABLED_REASON_COPY } from '@/lib/talons/types';

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ userPreferences: { timeFormat: '12h' } }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

// The run history only renders once the row is expanded; its Firestore listener
// is not what this file is about.
jest.mock('@/hooks/useTalonRuns', () => ({
  useTalonRuns: () => ({ runs: [], loading: false, error: null }),
}));

function talon(overrides: Partial<TalonListItem> = {}): TalonListItem {
  return {
    id: 't1',
    name: 'lobby wall check',
    enabled: false,
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'none' },
    outputs: [{ type: 'cortex', directive: 'look' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    consecutiveFailures: 1,
    ...overrides,
  };
}

function renderCard(item: TalonListItem) {
  // The row's state dot and every column live inside tooltips; the app mounts
  // the provider once at the layout level.
  return render(
    <TooltipProvider>
      <TalonCard talon={item} siteId="site-a" machines={[]} onEdit={() => {}} />
    </TooltipProvider>,
  );
}

function reasonLine(): HTMLElement | null {
  return screen.queryByTestId('talon-disabled-reason');
}

describe('the disabled reason', () => {
  it.each(Object.entries(TALON_DISABLED_REASON_COPY))(
    'explains %s in words on the row',
    (reason, copy) => {
      renderCard(talon({ disabledReason: reason }));

      expect(reasonLine()).toHaveTextContent(`switched off — ${copy}`);
    },
  );

  it('says nothing when a person paused the talon themselves', () => {
    // The enable toggle clears `disabledReason`, so its absence on a disabled
    // talon means a human made the call — which needs no explanation from us.
    renderCard(talon({ disabledReason: null }));

    expect(reasonLine()).not.toBeInTheDocument();
  });

  it('says nothing on an enabled talon carrying a stale reason', () => {
    renderCard(talon({ enabled: true, disabledReason: 'creator_deleted' }));

    expect(reasonLine()).not.toBeInTheDocument();
  });

  it('renders a reason from a newer build as plain disabled rather than crashing', () => {
    renderCard(talon({ disabledReason: 'reason_from_the_future' }));

    expect(reasonLine()).not.toBeInTheDocument();
    expect(screen.getByText('lobby wall check')).toBeInTheDocument();
  });
});

describe('the reason copy itself', () => {
  it.each(Object.entries(TALON_DISABLED_REASON_COPY))(
    '%s reads in the lowercase voice of the rest of the ui',
    (reason, copy) => {
      expect({ reason, copy, lowercase: /^[a-z]/.test(copy) }).toEqual({
        reason,
        copy,
        lowercase: true,
      });
    },
  );

  it.each(Object.entries(TALON_DISABLED_REASON_COPY))(
    '%s names no field path, code, or backtick',
    (reason, copy) => {
      // Same bar the validator's messages are held to: an operator reads this,
      // not a developer.
      expect({ reason, copy, readable: !/[`[\]_]|createdBy|llm/.test(copy) }).toEqual({
        reason,
        copy,
        readable: true,
      });
    },
  );

  it('creator_access_revoked stays true for a creator limited to some machines, who still has access', () => {
    expect(TALON_DISABLED_REASON_COPY.creator_access_revoked).toBe(
      'the person who created this talon no longer has whole-site access to this site',
    );
  });
});
