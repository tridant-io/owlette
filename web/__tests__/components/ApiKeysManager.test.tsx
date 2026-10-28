/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ApiKeysManager under a plan: minting a key is a pro feature of the minting
 * account (plan.md decision 8), so on a plan without API keys the create
 * control becomes the upgrade note and the empty list offers no second one.
 * The list itself stays, since revoke is never gated.
 *
 * Create opens a modal rather than an inline form; a successful create closes
 * it and the one-time reveal shows the raw key in the panel.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeysManager } from '@/components/ApiKeysManager';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { PlanResponse } from '@/lib/plan.server';

let mockPlan: PlanResponse | undefined;
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: jest.fn() }),
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'owner-uid' } }),
}));
const mockCreateKey = jest.fn();
jest.mock('@/hooks/useApiKeys', () => ({
  useApiKeys: () => ({ keys: [], loading: false, refresh: jest.fn(), createKey: mockCreateKey, updateKey: jest.fn() }),
}));
jest.mock('@/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
// a stand-in form: the manager only owns opening, closing and the reveal
jest.mock('@/components/ApiKeyCreateForm', () => ({
  ApiKeyCreateForm: ({ onSubmit, onCancel }: { onSubmit: (input: unknown) => Promise<void>; onCancel: () => void }) => (
    <div>
      <button type="button" onClick={() => onSubmit({ name: 'ci', scopes: [], ttlDays: 30 })}>
        submit form
      </button>
      <button type="button" onClick={onCancel}>
        cancel form
      </button>
    </div>
  ),
}));
jest.mock('@/components/ApiKeyScopeEditor', () => ({ ApiKeyScopeEditor: () => null }));
jest.mock('@/app/settings/api-keys/KeyCard', () => ({ KeyCard: () => null }));

const FLAGS: PlanResponse['flags'] = {
  control: true,
  deployments: true,
  swoop: true,
  hoot: true,
  roost: true,
  talons: true,
  webhooks: true,
  api_keys: true,
};
const OFF: PlanResponse = {
  enforced: false,
  reason: 'enforcement_off',
  plan: null,
  standing: null,
  limits: { machines: null, sites: null },
  flags: FLAGS,
  activeMachinesThisMonth: null,
};
const CORE: PlanResponse = {
  enforced: true,
  plan: 'core',
  standing: 'active',
  limits: { machines: null, sites: 1 },
  flags: { ...FLAGS, api_keys: false },
  activeMachinesThisMonth: 2,
};

describe('ApiKeysManager', () => {
  it('offers both create controls with plans off', () => {
    mockPlan = OFF;
    render(<ApiKeysManager />);

    expect(screen.getByRole('button', { name: 'create key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'create your first key' })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate-inline')).not.toBeInTheDocument();
  });

  it('puts one upgrade note in place of the create controls on a plan without API keys', () => {
    mockPlan = CORE;
    render(<ApiKeysManager />);

    expect(screen.getByTestId('upgrade-gate-inline')).toHaveTextContent("your plan doesn't include API keys.");
    expect(screen.queryByRole('button', { name: 'create key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'create your first key' })).not.toBeInTheDocument();
    expect(screen.getByText('no api keys yet')).toBeInTheDocument();
  });

  it('opens the create form in a modal and closes it on cancel', async () => {
    mockPlan = OFF;
    const user = userEvent.setup();
    render(<ApiKeysManager />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'create your first key' }));
    expect(screen.getByRole('dialog', { name: 'create api key' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'cancel form' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes the modal on a successful create and reveals the raw key once', async () => {
    mockPlan = OFF;
    mockCreateKey.mockResolvedValueOnce({ key: 'owk_live_raw' });
    const user = userEvent.setup();
    // the reveal card's copy button needs the provider the app shell supplies
    render(
      <TooltipProvider>
        <ApiKeysManager />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'create key' }));
    const dialog = screen.getByRole('dialog', { name: 'create api key' });
    expect(dialog).toHaveTextContent('the raw key is shown once, right after creation.');

    await user.click(screen.getByRole('button', { name: 'submit form' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockCreateKey).toHaveBeenCalledWith({ name: 'ci', scopes: [], ttlDays: 30 });
    expect(screen.getByText('key issued — copy it now. it will not be shown again.')).toBeInTheDocument();
    expect(screen.getByText('owk_live_raw')).toBeInTheDocument();
  });

  it('keeps the modal open when create fails', async () => {
    mockPlan = OFF;
    mockCreateKey.mockRejectedValueOnce(new Error('nope'));
    const user = userEvent.setup();
    render(<ApiKeysManager />);

    await user.click(screen.getByRole('button', { name: 'create key' }));
    await user.click(screen.getByRole('button', { name: 'submit form' }));

    expect(screen.getByRole('dialog', { name: 'create api key' })).toBeInTheDocument();
    expect(screen.queryByText('owk_live_raw')).not.toBeInTheDocument();
  });
});
