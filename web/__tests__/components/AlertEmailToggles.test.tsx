/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the built-in alert emails, on /settings/alerts and admin panel → alerts: one
 * switch per category, saved as it moves, put back when the save fails, and
 * following the stored preferences by value.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlertEmailToggles } from '@/components/AlertEmailToggles';

let mockStored: Record<string, boolean>;
const mockUpdate = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  // a fresh object on every call, as a careless caller would hand it
  useAuth: () => ({ userPreferences: { ...mockStored }, updateUserPreferences: mockUpdate }),
}));

beforeEach(() => {
  mockStored = {
    healthAlerts: true,
    processAlerts: true,
    thresholdAlerts: false,
    cortexAlerts: true,
    displayAlerts: true,
    talonAlerts: true,
    apiKeyAlerts: true,
  };
  mockUpdate.mockReset().mockResolvedValue(undefined);
});

it('shows one switch per built-in alert, as stored, and renders once with a fresh preferences object', () => {
  render(<AlertEmailToggles />);

  expect(screen.getAllByRole('switch')).toHaveLength(7);
  expect(screen.getByRole('switch', { name: 'machine offline alerts' })).toBeChecked();
  expect(screen.getByRole('switch', { name: 'threshold alerts' })).not.toBeChecked();
});

it('saves a switch the moment it moves, silently', async () => {
  const user = userEvent.setup();
  render(<AlertEmailToggles />);

  await user.click(screen.getByRole('switch', { name: 'machine offline alerts' }));

  expect(mockUpdate).toHaveBeenCalledWith({ healthAlerts: false }, { silent: true });
  expect(screen.getByRole('switch', { name: 'machine offline alerts' })).not.toBeChecked();
});

it('puts the switch back when the save fails', async () => {
  mockUpdate.mockRejectedValueOnce(new Error('offline'));
  const user = userEvent.setup();
  render(<AlertEmailToggles />);

  await user.click(screen.getByRole('switch', { name: 'process crash alerts' }));

  await waitFor(() => expect(screen.getByRole('switch', { name: 'process crash alerts' })).toBeChecked());
});

it('follows a stored change', () => {
  const { rerender } = render(<AlertEmailToggles />);

  mockStored = { ...mockStored, thresholdAlerts: true };
  rerender(<AlertEmailToggles />);

  expect(screen.getByRole('switch', { name: 'threshold alerts' })).toBeChecked();
});
