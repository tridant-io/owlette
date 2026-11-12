/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Settings > hoot: the saved LLM key never leaves the server, so a show-key
 * toggle over an empty field revealed nothing; and hoot mcp, the other way to
 * use hoot, had no place on the page.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';

jest.mock('@/components/MfaFactorsSection', () => ({ MfaFactorsSection: () => null }));
jest.mock('@/components/ApiKeysManager', () => ({ ApiKeysManager: () => null }));
jest.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
jest.mock('@/components/AppearanceControl', () => ({ AppearanceControl: () => null }));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1', email: 'owner@example.test', displayName: 'Ada Lovelace', photoURL: null },
    userPreferences: {
      temperatureUnit: 'C',
      timezone: 'UTC',
      timeFormat: '12h',
      timeDisplayMode: 'machine',
      healthAlerts: true,
      processAlerts: true,
      thresholdAlerts: true,
      cortexAlerts: true,
      displayAlerts: true,
      talonAlerts: true,
      apiKeyAlerts: true,
      alertCcEmails: [],
      mutedMachines: [],
    },
    updateUserProfile: jest.fn(),
    updateUserPhoto: jest.fn(),
    updatePassword: jest.fn(),
    updateUserPreferences: jest.fn(),
    deleteAccount: jest.fn(),
  }),
}));

function mockSavedKey(configured: boolean) {
  global.fetch = jest.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      String(url).includes('/api/settings/llm-key')
        ? configured
          ? { configured: true, provider: 'anthropic', model: null }
          : { configured: false }
        : { models: [] },
  })) as unknown as typeof fetch;
}

function renderHoot() {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <AccountSettingsDialog open onOpenChange={() => {}} initialSection="hoot" />
    </TooltipProvider>,
  );
  return user;
}

describe('settings > hoot: the api key field', () => {
  it('offers no show-key toggle over a saved key it cannot show', async () => {
    mockSavedKey(true);
    renderHoot();

    const field = screen.getByLabelText('api key');
    expect(await screen.findByText('connected')).toBeInTheDocument();
    expect(field).toHaveAttribute('placeholder', 'a key is saved: paste a new one to replace it');
    expect(screen.queryByRole('button', { name: 'show key' })).not.toBeInTheDocument();
  });

  it('shows and hides a key being typed', async () => {
    mockSavedKey(true);
    const user = renderHoot();

    const field = screen.getByLabelText('api key');
    await user.type(field, 'sk-ant-new');
    expect(field).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'show key' }));
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveValue('sk-ant-new');

    await user.click(screen.getByRole('button', { name: 'hide key' }));
    expect(field).toHaveAttribute('type', 'password');
  });
});

describe('settings > hoot: hoot api and hoot mcp', () => {
  it('names both ways to use hoot', () => {
    mockSavedKey(false);
    renderHoot();

    expect(screen.getByRole('heading', { name: /^hoot api/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^hoot mcp/ })).toBeInTheDocument();
  });

  it('gives developers the commands that register the local MCP server, and the guide', () => {
    mockSavedKey(false);
    renderHoot();

    expect(screen.getByText(/for developers/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'claude mcp add hoot -- "C:\\ProgramData\\Owlette\\python\\python.exe" "C:\\ProgramData\\Owlette\\agent\\src\\fleet_mcp.py"',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "claude mcp add hoot -- '/Library/Application Support/Owlette/runtime/python/bin/python3' '/Library/Application Support/Owlette/runtime/agent/src/fleet_mcp.py'",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /hoot mcp guide/ })).toHaveAttribute('href', '/docs/agent/hoot-mcp');
  });
});
