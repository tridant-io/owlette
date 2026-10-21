/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * DeploymentDialog's checkboxes had no names: each sat in a clickable <div>
 * beside a <span> holding the machine or process name, so a screen reader
 * heard "checkbox, not checked" for every row. The template toolbar's icon
 * buttons were named only by a tooltip (or nothing at all).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeploymentDialog from '@/components/DeploymentDialog';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: () => ({
    machines: [
      {
        machineId: 'kiosk-1',
        online: true,
        processes: [{ id: 'p1', name: 'TouchDesigner', exe_path: 'C:\\TD\\TouchDesigner.exe' }],
      },
      { machineId: 'kiosk-2', online: false, processes: [] },
    ],
  }),
}));

jest.mock('@/hooks/useSystemPresets', () => ({
  useSystemPresets: () => ({ presets: [], categories: [] }),
}));

// one stable object: the dialog's reset effect depends on resetChecksum's identity
jest.mock('@/hooks/useInstallerChecksum', () => {
  const checksum = {
    sha256Checksum: '',
    checksumStatus: 'idle',
    resetChecksum: () => {},
    adoptChecksum: () => {},
  };
  return { SHA256_HEX_RE: /^[a-f0-9]{64}$/, useInstallerChecksum: () => checksum };
});

jest.mock('@/components/InstallerChecksumStatus', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

function renderDialog() {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <DeploymentDialog
        open
        onOpenChange={() => {}}
        siteId="site-a"
        templates={[]}
        onCreateDeployment={jest.fn()}
        onCreateTemplate={jest.fn()}
        onUpdateTemplate={jest.fn()}
        onDeleteTemplate={jest.fn()}
      />
    </TooltipProvider>,
  );
  return user;
}

describe('DeploymentDialog — named controls', () => {
  it('names each target machine checkbox and toggles it once per click on its row text', async () => {
    const user = renderDialog();

    const kiosk = screen.getByRole('checkbox', { name: /kiosk-1/ });
    expect(kiosk).not.toBeChecked();

    // the row text, not the box: one click must select once, not select-then-deselect
    await user.click(screen.getByText('kiosk-1'));
    expect(kiosk).toBeChecked();
    expect(screen.getByRole('button', { name: 'deploy to 1 machine' })).toBeInTheDocument();

    await user.click(kiosk);
    expect(kiosk).not.toBeChecked();
  });

  it('groups the target machines under their visible heading', () => {
    renderDialog();
    expect(screen.getByRole('group', { name: /target machines/ })).toBeInTheDocument();
  });

  it('names the managed process checkboxes', async () => {
    const user = renderDialog();
    await user.click(screen.getByText('kiosk-1'));
    const disclosure = screen.getByRole('button', { name: /close running processes/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    const process = screen.getByRole('checkbox', { name: /TouchDesigner/ });
    await user.click(screen.getByText('TouchDesigner'));
    expect(process).toBeChecked();
  });

  it('names the template toolbar icon buttons and labels the template field', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'new template' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'rename template' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'save as new template' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'template' })).toBeInTheDocument();
  });
});
