/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Account settings: the section nav marked the open section by fill colour
 * only; the CC field was named by its placeholder; its error was a plain red
 * <p> nobody announced; the ✕ on each CC chip had no name; and the password
 * error box was neither announced nor tied to the field it was about.
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
      alertCcEmails: ['ops@example.test'],
      mutedMachines: ['kiosk-9'],
    },
    updateUserProfile: jest.fn(),
    updateUserPhoto: jest.fn(),
    updatePassword: jest.fn(),
    updateUserPreferences: jest.fn(),
    deleteAccount: jest.fn(),
  }),
}));

beforeAll(() => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ configured: false }) })) as unknown as typeof fetch;
});

function renderDialog(initialSection?: 'profile' | 'alerts' | 'security') {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <AccountSettingsDialog open onOpenChange={() => {}} initialSection={initialSection} />
    </TooltipProvider>,
  );
  return user;
}

describe('AccountSettingsDialog', () => {
  it('marks the open section in the nav as current', async () => {
    const user = renderDialog();
    // the phone tab strip and the desktop sidebar both render in jsdom
    for (const tab of screen.getAllByRole('button', { name: /^profile$/ })) {
      expect(tab).toHaveAttribute('aria-current', 'true');
    }
    await user.click(screen.getAllByRole('button', { name: /^alerts$/ })[0]);
    for (const tab of screen.getAllByRole('button', { name: /^alerts$/ })) {
      expect(tab).toHaveAttribute('aria-current', 'true');
    }
    for (const tab of screen.getAllByRole('button', { name: /^profile$/ })) {
      expect(tab).not.toHaveAttribute('aria-current');
    }
  });

  it('labels the email field', () => {
    renderDialog('profile');
    expect(screen.getByRole('textbox', { name: 'email' })).toHaveValue('owner@example.test');
  });

  it('labels the CC field, names chip removers, and announces a CC error against the field', async () => {
    const user = renderDialog('alerts');

    expect(screen.getByRole('button', { name: 'remove ops@example.test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'unmute kiosk-9' })).toBeInTheDocument();

    const cc = screen.getByRole('textbox', { name: 'additional CC recipients' });
    await user.type(cc, 'not-an-email{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent('please enter a valid email address');
    expect(cc).toHaveAttribute('aria-invalid', 'true');
    expect(cc).toHaveAccessibleDescription('please enter a valid email address');
  });

  // a raw palette class reads in one theme only: white body text vanishes on
  // the light panel (light mode, task 3.2)
  it('draws every section and the delete confirmation from theme tokens', async () => {
    const RAW_COLOUR =
      /\b(?:[a-z-]+:)*(?:text|bg|border|ring|fill|stroke|from|to|via|outline|divide|shadow|decoration|placeholder|caret|accent)-(?:red|green|emerald|amber|yellow|orange|blue|sky|cyan|teal|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|lime|indigo|fuchsia)-\d{2,3}\b|\btext-(?:white|gray-900)\b/;
    const rawClasses = () =>
      [...document.body.querySelectorAll('[class]')]
        .flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/))
        .filter((c) => RAW_COLOUR.test(c));

    const user = renderDialog();
    for (const section of ['profile', 'preferences', 'alerts', 'hoot', 'security', 'api', 'danger zone']) {
      await user.click(screen.getAllByRole('button', { name: section })[0]);
      expect({ section, raw: rawClasses() }).toEqual({ section, raw: [] });
    }
    await user.click(screen.getByRole('button', { name: 'delete account' }));
    expect(await screen.findByRole('heading', { name: 'delete account' })).toBeInTheDocument();
    expect(rawClasses()).toEqual([]);
  });

  it('announces a password mismatch and marks the confirm field', async () => {
    const user = renderDialog('security');

    await user.click(screen.getByRole('button', { name: 'update password' }));
    await user.type(screen.getByLabelText('current password'), 'old-secret');
    await user.type(screen.getByLabelText('new password'), 'new-secret-1');
    await user.type(screen.getByLabelText('confirm new password'), 'new-secret-2');
    await user.click(screen.getByRole('button', { name: 'save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('new passwords do not match');
    const confirm = screen.getByLabelText('confirm new password');
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    expect(confirm).toHaveAccessibleDescription('new passwords do not match');
    expect(screen.getByLabelText('new password')).not.toHaveAttribute('aria-invalid');
  });
});
