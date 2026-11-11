/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Roosts page detail-panel wiring — behaviours that live in the page component
 * itself, not the panel or hook: the panel REMOUNTS on roost swap (so child
 * state cannot flash stale data), the disappearance gate waits for loading to
 * finish before clearing a selection, and bogus deep links self-clean.
 */
import React from 'react';
import { render } from '@testing-library/react';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

type RoostFixture = {
  id: string;
  name: string;
  schemaVersion: number;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  currentVersionDescription: string | null;
  previousVersionId: string | null;
  versionUrl: string | null;
  versionCounter: number;
  targets: string[];
  createdAt: number;
  updatedAt?: number;
};

type RoostsState = {
  roosts: RoostFixture[];
  loading: boolean;
  error: string | null;
};

let useRoostsReturn: RoostsState = { roosts: [], loading: false, error: null };
const setSelectedRoostIdMock = jest.fn();
let selectedRoostIdValue: string | null = null;
let panelMountCount = 0;
let panelMountedRoostIds: string[] = [];

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    loading: false,
    role: 'admin',
    isSuperadmin: false,
    isSiteAdmin: () => true,
    machineScope: () => null,
    userSites: ['site-a'],
    lastSiteId: 'site-a',
    lastMachineIds: {},
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 0 },
    userPreferences: {
      temperatureUnit: 'C',
      timezone: 'UTC',
      timeFormat: '12h',
      timeDisplayMode: 'machine',
      healthAlerts: true,
      processAlerts: true,
      thresholdAlerts: true,
      cortexAlerts: true,
      mutedMachines: [],
      alertCcEmails: [],
      statsExpanded: true,
      processesExpanded: true,
    },
    signIn: jest.fn(),
    signUp: jest.fn(),
    signInWithGoogle: jest.fn(),
    signOut: jest.fn(),
    updateUserProfile: jest.fn(),
    updateUserPhoto: jest.fn(),
    updatePassword: jest.fn(),
    updateUserPreferences: jest.fn(),
    updateLastSite: jest.fn(),
    updateLastMachine: jest.fn(),
    deleteAccount: jest.fn(),
  }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({
    sites: [{ id: 'site-a', name: 'site a', timezone: 'UTC' }],
    loading: false,
    error: null,
    createSite: jest.fn(),
    updateSite: jest.fn(),
    deleteSite: jest.fn(),
  }),
  useMachines: () => ({ machines: [], profiles: {}, loading: false, error: null }),
  firestoreTsToMs: (ts: unknown) => (typeof ts === 'number' ? ts : 0),
}));

jest.mock('@/hooks/useProjectDistributionPresets', () => ({
  useProjectDistributionPresets: () => ({
    presets: [],
    loading: false,
    error: null,
    createPreset: jest.fn(),
    updatePreset: jest.fn(),
    deletePreset: jest.fn(),
  }),
}));

jest.mock('@/hooks/useRoosts', () => ({
  useRoosts: () => useRoostsReturn,
}));

jest.mock('@/hooks/useSelectedRoost', () => ({
  useSelectedRoost: () => ({
    selectedRoostId: selectedRoostIdValue,
    setSelectedRoostId: setSelectedRoostIdMock,
  }),
}));

jest.mock('@/hooks/useRoostUpload', () => ({
  useRoostUpload: () => ({
    state: { status: 'idle' },
    start: jest.fn(),
    cancel: jest.fn(),
    reset: jest.fn(),
  }),
}));

jest.mock('@/components/roost/RoostDetailPanel', () => ({
  RoostDetailPanel: ({
    roost,
    onClose,
  }: {
    roost: { id: string };
    onClose: () => void;
  }) => {
    React.useEffect(() => {
      panelMountCount += 1;
      panelMountedRoostIds.push(roost.id);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return (
      <div data-testid="panel" data-roost-id={roost.id}>
        <button type="button" onClick={onClose}>close</button>
      </div>
    );
  },
}));

jest.mock('@/components/roost/RoostMobileSheet', () => ({
  RoostMobileSheet: ({
    open,
    children,
  }: {
    open: boolean;
    children?: React.ReactNode;
  }) => (open ? <div data-testid="mobile-sheet">{children}</div> : null),
}));

jest.mock('@/components/RoostTargetRow', () => ({
  RoostStatusPill: () => <span data-testid="status-pill" />,
  RoostTargetsList: () => <div data-testid="targets-list" />,
}));

jest.mock('@/components/EmptyStateUpload', () => ({
  EmptyStateUpload: () => <div data-testid="empty-state" />,
}));

jest.mock('@/components/ProjectDistributionDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="distribution-dialog" /> : null,
}));

jest.mock('@/components/ConfirmDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="confirm-dialog" /> : null,
}));

jest.mock('@/components/MinimizedUploadCard', () => ({
  MinimizedUploadCard: () => <div data-testid="minimized-upload-card" />,
}));

jest.mock('@/components/AccountSettingsDialog', () => ({
  AccountSettingsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="account-settings-dialog" /> : null,
}));

jest.mock('@/components/PageHeader', () => ({
  PageHeader: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}));

jest.mock('@/components/DownloadButton', () => ({
  __esModule: true,
  default: () => <button type="button">download</button>,
}));

jest.mock('@/components/LoadingWord', () => ({
  LoadingWord: () => <span>loading</span>,
}));

const routerPushMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/roosts',
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

// The client subtree directly: `page.tsx`'s default export is a server
// component calling `connection()`, which jsdom cannot run.
import RoostsPage from '@/app/roosts/RoostsPageClient';

function makeRoost(id: string, name: string, targets: string[] = []): RoostFixture {
  return {
    id,
    name,
    schemaVersion: 2,
    currentVersionId: `ver-${id}`,
    currentVersionNumber: 1,
    currentVersionDescription: null,
    previousVersionId: null,
    versionUrl: null,
    versionCounter: 1,
    targets,
    createdAt: 1_700_000_000_000,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useRoostsReturn = { roosts: [], loading: false, error: null };
  selectedRoostIdValue = null;
  panelMountCount = 0;
  panelMountedRoostIds = [];
});

describe('roosts page — detail panel wiring', () => {
  it('remounts the detail panel on roost swap (no stale-data flash)', () => {
    useRoostsReturn = {
      roosts: [makeRoost('A', 'roost-a', ['m1']), makeRoost('B', 'roost-b', ['m2'])],
      loading: false,
      error: null,
    };
    const { rerender } = render(<RoostsPage />);
    expect(panelMountCount).toBe(0);

    selectedRoostIdValue = 'A';
    rerender(<RoostsPage />);
    expect(panelMountCount).toBeGreaterThanOrEqual(1);
    const aMounts = panelMountCount;

    selectedRoostIdValue = 'B';
    rerender(<RoostsPage />);
    expect(panelMountCount).toBeGreaterThan(aMounts);
    expect(panelMountedRoostIds).toContain('A');
    expect(panelMountedRoostIds).toContain('B');
  });

  it('does not clear selection while roosts are still loading', () => {
    useRoostsReturn = { roosts: [], loading: true, error: null };
    selectedRoostIdValue = 'X';
    const { rerender } = render(<RoostsPage />);
    expect(setSelectedRoostIdMock).not.toHaveBeenCalled();

    useRoostsReturn = { roosts: [], loading: false, error: null };
    rerender(<RoostsPage />);
    expect(setSelectedRoostIdMock).toHaveBeenCalledWith(null);
  });

  it('clears a bogus deep-link selection once loading settles', () => {
    useRoostsReturn = {
      roosts: [makeRoost('real', 'roost-real')],
      loading: false,
      error: null,
    };
    selectedRoostIdValue = 'bogus';
    render(<RoostsPage />);
    expect(setSelectedRoostIdMock).toHaveBeenCalledWith(null);
    expect(panelMountCount).toBe(0);
  });
});
