/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Render tests for RoostDetailPanel — the side-panel container that
 * replaces the inline Collapsible expansion on the roosts page. Verifies
 * the four-section layout, close-button wiring, and that the header
 * dropdown actions fire the same callbacks the row dropdown does.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Roost } from '@/hooks/useRoosts';

jest.mock('@/components/RoostContentsRow', () => ({
  RoostContentsRow: ({ roostId }: { roostId: string }) => (
    <div data-testid="roost-contents-row" data-roost-id={roostId}>contents</div>
  ),
}));
jest.mock('@/components/RoostTargetRow', () => ({
  RoostTargetsList: ({ targets }: { targets: string[] }) => (
    <div data-testid="roost-targets-list" data-target-count={targets.length}>targets</div>
  ),
}));
jest.mock('@/components/roost/VersionHistory', () => ({
  VersionHistory: ({ roostId, onNewVersion }: { roostId: string; onNewVersion?: () => void }) => (
    <div data-testid="version-history" data-roost-id={roostId}>
      {onNewVersion && <button type="button" onClick={onNewVersion}>mock new version</button>}
    </div>
  ),
}));

import { RoostDetailPanel } from '@/components/roost/RoostDetailPanel';

function makeRoost(overrides: Partial<Roost> = {}): Roost {
  return {
    id: 'roost-1',
    name: 'lobby-display',
    schemaVersion: 2,
    currentVersionId: 'ver-abc',
    currentVersionNumber: 3,
    currentVersionDescription: 'fixed broken video',
    previousVersionId: 'ver-prev',
    versionUrl: 'https://example.com/manifest',
    versionCounter: 3,
    extractPath: '~/Documents/Custom/',
    targets: ['lobby-01', 'gallery-02'],
    totalFiles: 12,
    totalSize: 5_000_000,
    createdAt: null,
    updatedAt: undefined,
    createdBy: 'dylan@example.com',
    ...overrides,
  } as Roost;
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof RoostDetailPanel>> = {}) {
  const props = {
    roost: makeRoost(),
    siteId: 'site-a',
    timeDisplayMode: 'machine',
    timezone: 'America/Los_Angeles',
    timeFormat: '12h' as const,
    refreshKey: 0,
    machines: [],
    onClose: jest.fn(),
    onNewVersion: jest.fn(),
    onResync: jest.fn(),
    onDelete: jest.fn(),
    onCopyRoostId: jest.fn(),
    onCopyVersionId: jest.fn(),
    ...overrides,
  };
  const utils = render(<RoostDetailPanel {...props} />);
  return { ...utils, props };
}

describe('RoostDetailPanel', () => {
  it('renders all four sections with a sample roost', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: /lobby-display/i })).toBeInTheDocument();
    expect(screen.getByText('extract path')).toBeInTheDocument();
    expect(screen.getByText('~/Documents/Custom/')).toBeInTheDocument();

    expect(screen.getByTestId('roost-contents-row')).toBeInTheDocument();

    expect(screen.getByText('targets (2)')).toBeInTheDocument();
    const targetsList = screen.getByTestId('roost-targets-list');
    expect(targetsList).toBeInTheDocument();
    expect(targetsList).toHaveAttribute('data-target-count', '2');

    expect(screen.getByTestId('version-history')).toBeInTheDocument();
  });

  it('close button fires onClose', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { props } = renderPanel();
    await user.click(screen.getByRole('button', { name: /close panel/i }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('onNewVersion receives roost-derived NewVersionContext', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { props } = renderPanel();
    await user.click(screen.getByRole('button', { name: /mock new version/i }));
    expect(props.onNewVersion).toHaveBeenCalledTimes(1);
    expect(props.onNewVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        roostId: 'roost-1',
        name: 'lobby-display',
        extractPath: '~/Documents/Custom/',
        targets: ['lobby-01', 'gallery-02'],
        currentVersionNumber: 3,
      }),
    );
  });

  it('offers no new version when the plan leaves roost out', () => {
    renderPanel({ onNewVersion: undefined });
    expect(screen.getByTestId('version-history')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mock new version/i })).toBeNull();
  });

  it('hides the version badge when currentVersionNumber is null', () => {
    renderPanel({ roost: makeRoost({ currentVersionNumber: null, currentVersionId: null }) });
    expect(screen.queryByText(/^v\d+$/)).toBeNull();
  });

  it('header dropdown items fire correct callbacks', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { props } = renderPanel();

    const openMenu = async () => {
      await user.click(screen.getByRole('button', { name: /panel actions/i }));
    };

    await openMenu();
    await user.click(await screen.findByRole('menuitem', { name: /re-sync targets/i }));
    expect(props.onResync).toHaveBeenCalledTimes(1);

    await openMenu();
    await user.click(await screen.findByRole('menuitem', { name: /copy roost id/i }));
    expect(props.onCopyRoostId).toHaveBeenCalledTimes(1);

    await openMenu();
    await user.click(await screen.findByRole('menuitem', { name: /copy version id/i }));
    expect(props.onCopyVersionId).toHaveBeenCalledTimes(1);

    await openMenu();
    await user.click(await screen.findByRole('menuitem', { name: /delete roost/i }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    // Headroom: this opens the Radix menu 4× in sequence, and under parallel-suite CPU load
    // the default 5s jest timeout was the flake source (a timeout, not a failed assertion).
  }, 20000);
});
