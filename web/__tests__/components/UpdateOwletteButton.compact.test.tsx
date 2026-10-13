/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * UpdateOwletteButton's compact form, which the dashboard's machines heading
 * uses: below sm only the icon and the count show, so the button carries its
 * name in aria-label. Without `compact` it renders as it does on deployments.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { UpdateOwletteButton } from '@/components/UpdateOwletteButton';
import type { Machine } from '@/hooks/useFirestore';

const OUTDATED = { machineId: 'kiosk-1', online: true } as Machine;

jest.mock('@/hooks/useOwletteUpdates', () => ({
  useOwletteUpdates: () => ({
    outdatedMachines: [OUTDATED],
    latestVersion: '4.1.7',
    totalMachinesNeedingUpdate: 1,
    isLoading: false,
    updateMachines: jest.fn(),
    updatingMachines: new Set(),
    cancelUpdate: jest.fn(),
    staleMachines: new Set(),
  }),
}));

jest.mock('@/lib/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

describe('UpdateOwletteButton', () => {
  it('compact: names itself, and hides the words below sm while the count stays', () => {
    render(<UpdateOwletteButton siteId="site-A" machines={[OUTDATED]} compact />);

    const button = screen.getByRole('button', { name: 'update owlette to v4.1.7' });
    expect(screen.getByText('update owlette')).toHaveClass('hidden', 'sm:inline-flex');
    expect(screen.getByText('to v4.1.7')).toHaveClass('hidden', 'sm:inline-flex');
    expect(button).toHaveTextContent('1');
  });

  it('full: the words carry the name, always shown', () => {
    render(<UpdateOwletteButton siteId="site-A" machines={[OUTDATED]} />);

    const button = screen.getByRole('button', { name: /update owlette/ });
    expect(button).not.toHaveAttribute('aria-label');
    expect(screen.getByText('update owlette')).not.toHaveClass('hidden');
    expect(screen.getByText('to v4.1.7')).not.toHaveClass('hidden');
  });
});
