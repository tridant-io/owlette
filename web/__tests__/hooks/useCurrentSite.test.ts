/**
 * @jest-environment jsdom
 *
 * `useCurrentSite({ wholeSiteOnly: true })` for the pages that span a site
 * (talons, roost, deploy): sites where the caller is limited to some machines
 * drop out of the list before anything is derived from it, the selection falls
 * back to the first whole-site site, and a caller left with none is told apart
 * from a caller with no sites at all (`limitedOnly`).
 */
import { renderHook } from '@testing-library/react';
import type { Site } from '@/hooks/useFirestore';

const SITES: Site[] = [
  { id: 'scoped-a', name: 'scoped a', createdAt: 0 },
  { id: 'whole-b', name: 'whole b', createdAt: 0, timezone: 'Europe/Berlin' },
  { id: 'whole-c', name: 'whole c', createdAt: 0 },
];

let mockSites: Site[] = SITES;
let mockSitesLoading = false;
let mockScopes: Record<string, string[]> = {};
let mockLastSiteId: string | null = null;

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({ sites: mockSites, loading: mockSitesLoading, error: null }),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    userSites: mockSites.map((s) => s.id),
    isSuperadmin: false,
    lastSiteId: mockLastSiteId,
    updateLastSite: jest.fn(),
    machineScope: (siteId: string) => mockScopes[siteId] ?? null,
  }),
}));

import { useCurrentSite } from '@/hooks/useCurrentSite';

beforeEach(() => {
  mockSites = SITES;
  mockSitesLoading = false;
  mockScopes = { 'scoped-a': ['m1'] };
  mockLastSiteId = null;
  localStorage.clear();
});

describe('useCurrentSite({ wholeSiteOnly: true })', () => {
  it('leaves out the sites where the caller is limited to some machines', () => {
    const { result } = renderHook(() => useCurrentSite({ wholeSiteOnly: true }));

    expect(result.current.sites.map((s) => s.id)).toEqual(['whole-b', 'whole-c']);
    expect(result.current.hasNoSites).toBe(false);
    expect(result.current.limitedOnly).toBe(false);
  });

  it('falls back to the first whole-site site when the last site is scoped', () => {
    mockLastSiteId = 'scoped-a';

    const { result } = renderHook(() => useCurrentSite({ wholeSiteOnly: true }));

    expect(result.current.currentSiteId).toBe('whole-b');
    expect(result.current.currentSite?.name).toBe('whole b');
    expect(result.current.siteTimezone).toBe('Europe/Berlin');
  });

  it('keeps a last site that is whole', () => {
    mockLastSiteId = 'whole-c';

    const { result } = renderHook(() => useCurrentSite({ wholeSiteOnly: true }));

    expect(result.current.currentSiteId).toBe('whole-c');
  });

  it('gives hasNoSites and limitedOnly when every site is scoped', () => {
    mockScopes = { 'scoped-a': ['m1'], 'whole-b': ['m2'], 'whole-c': [] };

    const { result } = renderHook(() => useCurrentSite({ wholeSiteOnly: true }));

    expect(result.current.sites).toEqual([]);
    expect(result.current.currentSiteId).toBe('');
    expect(result.current.hasNoSites).toBe(true);
    expect(result.current.limitedOnly).toBe(true);
  });

  it('gives hasNoSites but not limitedOnly to a caller with no sites at all', () => {
    mockSites = [];

    const { result } = renderHook(() => useCurrentSite({ wholeSiteOnly: true }));

    expect(result.current.hasNoSites).toBe(true);
    expect(result.current.limitedOnly).toBe(false);
  });

  it('claims neither while the sites are loading', () => {
    mockSitesLoading = true;
    mockScopes = { 'scoped-a': ['m1'], 'whole-b': ['m2'], 'whole-c': ['m3'] };

    const { result } = renderHook(() => useCurrentSite({ wholeSiteOnly: true }));

    expect(result.current.hasNoSites).toBe(false);
    expect(result.current.limitedOnly).toBe(false);
  });
});

describe('useCurrentSite()', () => {
  it('keeps every site, scoped or not, and the last site the caller was on', () => {
    mockLastSiteId = 'scoped-a';

    const { result } = renderHook(() => useCurrentSite());

    expect(result.current.sites.map((s) => s.id)).toEqual(['scoped-a', 'whole-b', 'whole-c']);
    expect(result.current.currentSiteId).toBe('scoped-a');
    expect(result.current.limitedOnly).toBe(false);
  });
});
