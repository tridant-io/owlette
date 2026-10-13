/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ApiKeysManager under a plan: minting a key is a pro feature of the minting
 * account (plan.md decision 8), so on a plan without API keys the create
 * control becomes the upgrade note and the empty list offers no second one.
 * The list itself stays, since revoke is never gated.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ApiKeysManager } from '@/components/ApiKeysManager';
import type { PlanResponse } from '@/lib/plan.server';

let mockPlan: PlanResponse | undefined;
jest.mock('@/hooks/usePlan', () => ({
  usePlan: () => ({ plan: mockPlan, loading: false, error: null, refresh: jest.fn() }),
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'owner-uid' } }),
}));
jest.mock('@/hooks/useApiKeys', () => ({
  useApiKeys: () => ({ keys: [], loading: false, refresh: jest.fn(), createKey: jest.fn(), updateKey: jest.fn() }),
}));
jest.mock('@/components/ApiKeyCreateForm', () => ({ ApiKeyCreateForm: () => null }));
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
});
