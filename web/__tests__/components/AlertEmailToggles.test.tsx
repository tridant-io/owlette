/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the built-in alert emails, on /settings/alerts, admin panel → alerts and the
 * account-settings dialog: how they arrive and one switch per category, each
 * saved as it moves, put back when the save fails, and following the stored
 * preferences by value.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlertEmailToggles } from '@/components/AlertEmailToggles';

let mockStored: Record<string, boolean | string>;
// the zone the account holds; userPreferences.timezone falls back to the browser's when it holds none
let mockStoredTimezone: string | null;
const mockUpdate = jest.fn();
// radix select drives its trigger with pointer capture and scrolls the active item into view
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

jest.mock('@/contexts/AuthContext', () => ({
  // a fresh object on every call, as a careless caller would hand it
  useAuth: () => ({ userPreferences: { ...mockStored }, storedTimezone: mockStoredTimezone, updateUserPreferences: mockUpdate }),
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
    alertDelivery: 'daily',
    timezone: 'America/New_York',
  };
  mockStoredTimezone = 'America/New_York';
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

describe('alert emails arrive', () => {
  const delivery = () => screen.getByRole('combobox', { name: 'alert emails arrive' });

  it('reads the stored choice and names the timezone a daily digest uses', () => {
    render(<AlertEmailToggles />);

    expect(delivery()).toHaveTextContent('daily digest');
    expect(screen.getByText(/one email at 8:00 am your time/)).toBeInTheDocument();
    expect(screen.getByText('America/New_York')).toBeInTheDocument();
    expect(screen.getByText(/talon and api key emails always arrive as they happen/)).toBeInTheDocument();
  });

  it('saves a new choice the moment it is picked, silently', async () => {
    const user = userEvent.setup();
    render(<AlertEmailToggles />);

    await user.click(delivery());
    await user.click(await screen.findByRole('option', { name: 'as it happens' }));

    expect(mockUpdate).toHaveBeenCalledWith({ alertDelivery: 'immediate' }, { silent: true });
    expect(delivery()).toHaveTextContent('as it happens');
    expect(screen.queryByText('America/New_York')).not.toBeInTheDocument();
  });

  it('puts the choice back when the save fails', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<AlertEmailToggles />);

    await user.click(delivery());
    await user.click(await screen.findByRole('option', { name: 'weekly digest' }));

    await waitFor(() => expect(delivery()).toHaveTextContent('daily digest'));
  });

  it('names UTC, the zone the digest uses, when the account holds none, whatever the browser says', () => {
    mockStoredTimezone = null;
    render(<AlertEmailToggles />);

    expect(screen.getByText('UTC')).toBeInTheDocument();
    expect(screen.queryByText('America/New_York')).not.toBeInTheDocument();
    expect(screen.getByText(/set your timezone/)).toBeInTheDocument();
  });

  it('links the timezone where the page holds its picker', async () => {
    const onChangeTimezone = jest.fn();
    const user = userEvent.setup();
    render(<AlertEmailToggles onChangeTimezone={onChangeTimezone} />);

    await user.click(screen.getByRole('button', { name: 'change' }));

    expect(onChangeTimezone).toHaveBeenCalledTimes(1);
  });

  it('follows a stored change', () => {
    const { rerender } = render(<AlertEmailToggles />);

    mockStored = { ...mockStored, alertDelivery: 'hourly' };
    rerender(<AlertEmailToggles />);

    expect(delivery()).toHaveTextContent('hourly digest');
  });
});
