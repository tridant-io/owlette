/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /talons hands the editor the live talon, not the copy taken when it opened.
 * Every save carries `enabled`, so a copy taken before the system switched the
 * talon off would switch it back on with the next edit.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import TalonsPage from '@/app/talons/page';
import type { Talon } from '@/hooks/useTalons';

// jsdom ships no ResizeObserver; PipelineConnectors constructs one on mount.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no matchMedia; DayPillSelector reads it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.setPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'user-1' },
    loading: false,
    userPreferences: { timeFormat: '12h' },
    isSiteAdmin: () => true,
  }),
}));

jest.mock('@/hooks/useCurrentSite', () => ({
  useCurrentSite: () => ({
    sites: [{ id: 'site-1', name: 'site 1' }],
    sitesLoading: false,
    currentSiteId: 'site-1',
    currentSite: { id: 'site-1', name: 'site 1', owner: 'user-1' },
    limitedOnly: false,
    selectSite: jest.fn(),
  }),
}));

jest.mock('@/hooks/useFirestore', () => ({ useMachines: () => ({ machines: [] }) }));

let mockTalons: Talon[] = [];
jest.mock('@/hooks/useTalons', () => ({
  useTalons: () => ({ talons: mockTalons, loading: false, error: null }),
}));

jest.mock('@/hooks/useTalonPresets', () => ({
  useTalonPresets: () => ({
    presets: [],
    loading: false,
    error: null,
    createPreset: jest.fn(),
    updatePreset: jest.fn(),
    deletePreset: jest.fn(),
  }),
}));

// the row is its own unit; here it only has to open the editor
jest.mock('@/app/talons/components/TalonCard', () => ({
  TALON_ROW_GRID: '',
  TalonCard: ({ talon, onEdit }: { talon: { name: string }; onEdit: () => void }) => (
    <button type="button" onClick={onEdit}>{`edit ${talon.name}`}</button>
  ),
}));

jest.mock('@/components/plan/UpgradeGate', () => ({
  UpgradeGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePlanGated: () => false,
}));
jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));
jest.mock('@/components/PageHeader', () => ({ PageHeader: () => null }));
jest.mock('@/components/AccountSettingsDialog', () => ({ AccountSettingsDialog: () => null }));
jest.mock('@/components/DownloadButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/FallingFeather', () => ({ FallingFeather: () => null }));
jest.mock('@/components/LoadingWord', () => ({ LoadingWord: () => null }));
jest.mock('@/components/NoSitesEmptyState', () => ({ NoSitesEmptyState: () => null }));

const TALON: Talon = {
  id: 'talon-1',
  schemaVersion: 1,
  name: 'nightly check',
  enabled: true,
  trigger: { type: 'schedule', intervalMinutes: 60 },
  condition: { type: 'none' },
  outputs: [{ type: 'email' }],
  scope: { machineIds: null },
  cooldownMinutes: 60,
  createdBy: 'user-1',
  createdVia: 'ui',
  createdAt: 0,
  updatedAt: 0,
  consecutiveFailures: 9,
};

describe('/talons editor', () => {
  it('saves the switch the live list shows, and keeps the draft when the list moves', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockTalons = [TALON];
    const user = userEvent.setup();
    const { rerender } = render(<TalonsPage />);

    await user.click(screen.getByRole('button', { name: 'edit nightly check' }));
    const name = screen.getByRole('textbox', { name: 'name' });
    await user.clear(name);
    await user.paste('nightly wall check');

    // its tenth failure lands while the editor is open, and the system switches it off
    mockTalons = [
      { ...TALON, enabled: false, disabledReason: 'repeated_failures', consecutiveFailures: 10 },
    ];
    rerender(<TalonsPage />);

    // same form, not re-keyed or closed, so the typed name survives
    expect(screen.getByTestId('talon-editor')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'name' })).toBe(name);
    expect(name).toHaveValue('nightly wall check');

    await user.click(screen.getByTestId('talon-editor-save'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sites/site-1/talons/talon-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'nightly wall check',
      enabled: false,
    });
  }, 15_000);
});
