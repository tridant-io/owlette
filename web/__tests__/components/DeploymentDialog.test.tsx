/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * DeploymentDialog's checkboxes had no names: each sat in a clickable <div>
 * beside a <span> holding the machine or process name, so a screen reader
 * heard "checkbox, not checked" for every row. The template toolbar's icon
 * buttons were named only by a tooltip (or nothing at all).
 *
 * Deploying to a guarded windows machine inside its active hours asks for a
 * reason first: its agent refuses the install otherwise.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeploymentDialog from '@/components/DeploymentDialog';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('@/hooks/useFirestore', () => {
  // guarded windows agents on UTC: one inside its active hours whatever hour the suite runs at, one clear of them
  const hour = new Date().getUTCHours();
  const guarded = (machineId: string, start: number) => ({
    machineId,
    online: true,
    processes: [],
    capabilities: { activeHoursGuard: 1 },
    activeHours: { start, end: (start + 2) % 24, source: 'policy' },
    machineTimezone: 'UTC',
  });
  const machines = [
    {
      machineId: 'kiosk-1',
      online: true,
      processes: [{ id: 'p1', name: 'TouchDesigner', exe_path: 'C:\\TD\\TouchDesigner.exe' }],
    },
    { machineId: 'kiosk-2', online: false, processes: [] },
    guarded('kiosk-show', hour),
    guarded('kiosk-later', (hour + 2) % 24),
  ];
  return { useMachines: () => ({ machines }) };
});

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
  return { SHA256_HEX_RE: /^[a-f0-9]{64}$/, useInstallerChecksum: () => checksum, mockChecksum: checksum };
});
const { mockChecksum } = jest.requireMock('@/hooks/useInstallerChecksum') as {
  mockChecksum: { sha256Checksum: string };
};

jest.mock('@/components/InstallerChecksumStatus', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

function renderDialog(onCreateDeployment: jest.Mock = jest.fn()) {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <DeploymentDialog
        open
        onOpenChange={() => {}}
        siteId="site-a"
        templates={[]}
        onCreateDeployment={onCreateDeployment}
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

describe('DeploymentDialog — active hours', () => {
  beforeEach(() => {
    mockChecksum.sha256Checksum = 'ab'.repeat(32);
  });
  afterEach(() => {
    mockChecksum.sha256Checksum = '';
  });

  async function chooseAndDeploy(machineIds: string[]) {
    const onCreateDeployment = jest.fn().mockResolvedValue('deploy-1');
    const user = renderDialog(onCreateDeployment);
    await user.type(screen.getByLabelText('installer URL'), 'https://example.com/app.exe');
    for (const id of machineIds) await user.click(screen.getByText(id));
    await user.click(screen.getByRole('button', { name: `deploy to ${machineIds.length} machines` }));
    return { user, onCreateDeployment };
  }

  it('deploys straight away when no chosen machine is inside its active hours', async () => {
    const { onCreateDeployment } = await chooseAndDeploy(['kiosk-1', 'kiosk-later']);

    expect(screen.queryByRole('dialog', { name: 'deploy inside active hours?' })).not.toBeInTheDocument();
    expect(onCreateDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ installer_url: 'https://example.com/app.exe' }),
      ['kiosk-1', 'kiosk-later'],
      undefined,
    );
  });

  it('names the machines inside their active hours and deploys only with a reason, sent as the override', async () => {
    const { user, onCreateDeployment } = await chooseAndDeploy(['kiosk-1', 'kiosk-show']);

    const confirm = screen.getByRole('dialog', { name: 'deploy inside active hours?' });
    const listed = within(within(confirm).getByRole('list', { name: 'machines inside active hours' })).getAllByRole(
      'listitem',
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toHaveTextContent('kiosk-show');
    expect(onCreateDeployment).not.toHaveBeenCalled();

    await user.type(within(confirm).getByLabelText('reason'), 'venue closed today');
    await user.click(within(confirm).getByRole('button', { name: 'deploy anyway' }));

    expect(onCreateDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ installer_url: 'https://example.com/app.exe' }),
      ['kiosk-1', 'kiosk-show'],
      { override: { reason: 'venue closed today' } },
    );
  });

  it('cancel goes back to the deployment with the choice intact and sends nothing', async () => {
    const { user, onCreateDeployment } = await chooseAndDeploy(['kiosk-show', 'kiosk-later']);

    const confirm = screen.getByRole('dialog', { name: 'deploy inside active hours?' });
    await user.click(within(confirm).getByRole('button', { name: 'cancel' }));

    expect(screen.queryByRole('dialog', { name: 'deploy inside active hours?' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /kiosk-show/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'deploy to 2 machines' })).toBeInTheDocument();
    expect(onCreateDeployment).not.toHaveBeenCalled();
  });
});
