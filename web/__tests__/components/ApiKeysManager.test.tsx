/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ApiKeysManager: creating a key is never gated by a plan here. A key belongs
 * to an account, a plan to a site (adr 0018), and the server checks the key
 * against the site it is used on with every request.
 *
 * Create opens a modal rather than an inline form; a successful create closes
 * it and the one-time reveal shows the raw key in the panel.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeysManager } from '@/components/ApiKeysManager';
import { TooltipProvider } from '@/components/ui/tooltip';

// the least any plan allows, on both stores a gate could read.
const mockFlags = {
  control: false,
  deployments: false,
  swoop: false,
  hoot: false,
  roost: false,
  talons: false,
  webhooks: false,
  api_keys: false,
};
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({
    plan: {
      enforced: true,
      emailVerified: true,
      trial: { status: 'ended', endsAt: null },
      sites: [],
      free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
      foundersRemaining: null,
      linkAvailable: false,
    },
    loading: false,
    error: null,
    refresh: jest.fn(),
  }),
}));
jest.mock('@/hooks/useSitePlan', () => ({
  useSitePlan: () => ({
    plan: {
      enforced: true,
      tier: 'free',
      standing: 'expired',
      inGoodStanding: false,
      flags: mockFlags,
      billing: null,
      period: null,
      isOwner: true,
    },
  }),
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

describe('ApiKeysManager', () => {
  it('offers both create controls whatever the plans say, with no upgrade note', () => {
    render(<ApiKeysManager />);

    expect(screen.getByRole('button', { name: 'create key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'create your first key' })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-gate-inline')).not.toBeInTheDocument();
  });

  it('opens the create form in a modal and closes it on cancel', async () => {
    const user = userEvent.setup();
    render(<ApiKeysManager />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'create your first key' }));
    expect(screen.getByRole('dialog', { name: 'create api key' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'cancel form' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes the modal on a successful create and reveals the raw key once', async () => {
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
    mockCreateKey.mockRejectedValueOnce(new Error('nope'));
    const user = userEvent.setup();
    render(<ApiKeysManager />);

    await user.click(screen.getByRole('button', { name: 'create key' }));
    await user.click(screen.getByRole('button', { name: 'submit form' }));

    expect(screen.getByRole('dialog', { name: 'create api key' })).toBeInTheDocument();
    expect(screen.queryByText('owk_live_raw')).not.toBeInTheDocument();
  });
});
