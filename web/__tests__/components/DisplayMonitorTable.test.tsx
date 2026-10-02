/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * DisplayMonitorTable in edit mode: every native control and the icon-only
 * primary star carries a name (scale and orientation selects had none, and the
 * star's label sat on an svg inside the button).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DisplayMonitorTable } from '@/components/charts/DisplayMonitorTable';
import type { MonitorInfo } from '@/hooks/useDisplayState';

function monitor(overrides: Partial<MonitorInfo>): MonitorInfo {
  return {
    id: 'mon-1',
    edidHash: 'edid-1',
    manufacturerId: 'DEL',
    productCode: '0001',
    serialNumber: 'sn-1',
    friendlyName: 'Dell U2720Q',
    position: { x: 0, y: 0 },
    resolution: { width: 1920, height: 1080 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: true,
    connectionType: 'dp',
    adapterLuid: 'luid-1',
    targetId: 1,
    ...overrides,
  };
}

describe('DisplayMonitorTable', () => {
  it('names every editable control and the primary star', () => {
    render(
      <TooltipProvider>
        <DisplayMonitorTable
          monitors={[
            monitor({}),
            monitor({ id: 'mon-2', edidHash: 'edid-2', friendlyName: 'LG 27UK850', primary: false, position: { x: 1920, y: 0 } }),
          ]}
          accentColor="var(--primary)"
          editable
          onUpdateMonitor={jest.fn()}
          modesByEdidHash={{
            'edid-2': { modes: [{ w: 1920, h: 1080, hz: 60 }], dpiScales: [100] },
          }}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole('button', { name: 'primary monitor' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'mark as primary' })).toBeEnabled();
    expect(screen.getAllByRole('combobox', { name: 'scale' })).toHaveLength(2);
    expect(screen.getAllByRole('combobox', { name: 'orientation' })).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: 'resolution' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'refresh rate' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'x position' })).toHaveValue(1920);
  });
});
