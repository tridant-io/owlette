/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * UninstallDialog — the software list is operable from the keyboard.
 *
 * Each row was a clickable <div>: no role, no tab stop, and the chosen row
 * said so only by colour. A keyboard user could not pick software at all,
 * so the uninstall button never enabled for them.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UninstallDialog from '@/components/UninstallDialog';

jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: () => ({ machines: [{ machineId: 'kiosk-1', online: true }] }),
}));

const SOFTWARE = [
  { name: 'TouchDesigner', version: '2023.1', publisher: 'Derivative', install_location: '', uninstall_command: '', installer_type: 'msi', registry_key: '' },
  { name: 'Resolume Arena', version: '7.18', publisher: 'Resolume', install_location: '', uninstall_command: '', installer_type: 'exe', registry_key: '' },
];

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({})),
  getDocs: jest.fn(async () => ({
    forEach: (cb: (doc: { data: () => unknown }) => void) =>
      SOFTWARE.forEach((software) => cb({ data: () => software })),
  })),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

describe('UninstallDialog — software list', () => {
  it('picks software with the keyboard and exposes which one is picked', async () => {
    const user = userEvent.setup();
    render(
      <UninstallDialog open onOpenChange={jest.fn()} siteId="site-A" onCreateUninstall={jest.fn()} />,
    );

    const row = await screen.findByRole('button', { name: /^TouchDesigner/ });
    expect(row).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^uninstall software$/ })).toBeDisabled();

    row.focus();
    await user.keyboard('{Enter}');

    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Resolume Arena/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^uninstall software$/ })).toBeEnabled();

    await user.keyboard(' ');
    expect(row).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the filter clear button', async () => {
    const user = userEvent.setup();
    render(
      <UninstallDialog open onOpenChange={jest.fn()} siteId="site-A" onCreateUninstall={jest.fn()} />,
    );

    await user.type(await screen.findByPlaceholderText('filter software...'), 'touch');
    await user.click(screen.getByRole('button', { name: 'clear filter' }));
    expect(screen.getByPlaceholderText('filter software...')).toHaveValue('');
  });
});
