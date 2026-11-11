/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * admin panel → sites → a site: its loading, not-found and member-only states,
 * the header with the site ID and the caller's role, one section at a time
 * (danger zone for owners and superadmins only), and where a delete sends the
 * caller. the four sections and the keep screens awake switch are stubs; each
 * has its own test. swoop's switch lives on /admin/swoop/settings, and its old
 * section link goes there.
 */

import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Site } from '@/hooks/useFirestore';
import type { SiteSection } from '@/lib/siteSettingsPath';
import { SiteSettings } from '@/components/admin/sites/SiteSettings';
import SiteSettingsPage from '@/app/admin/sites/[siteId]/page';

let mockAuth: {
  isSuperadmin: boolean;
  adminOf: string[];
  ownerOf: string[];
  scopes?: Record<string, string[]>;
} = { isSuperadmin: false, adminOf: [], ownerOf: [] };
const mockUserSites = ['site-a', 'site-b', 'site-c'];
jest.mock('@/contexts/AuthContext', () => ({
  // as AuthContext: an owner administers their site, a superadmin administers and
  // owns every site, a scoped row administers nothing (isSiteAdmin and isSiteOwner
  // mean the whole site), and each render's gates read that render's standing
  useAuth: () => {
    const auth = mockAuth;
    const scopeOf = (siteId: string) => (auth.isSuperadmin ? null : (auth.scopes?.[siteId] ?? null));
    return {
      user: { uid: 'me' },
      userSites: mockUserSites,
      isSuperadmin: auth.isSuperadmin,
      isSiteAdmin: (siteId: string) =>
        auth.isSuperadmin ||
        (scopeOf(siteId) === null && (auth.adminOf.includes(siteId) || auth.ownerOf.includes(siteId))),
      isSiteOwner: (siteId: string) => auth.isSuperadmin || (scopeOf(siteId) === null && auth.ownerOf.includes(siteId)),
      machineScope: scopeOf,
      siteRole: (siteId: string) =>
        auth.ownerOf.includes(siteId) ? 'owner' : auth.adminOf.includes(siteId) ? 'admin' : 'member',
    };
  },
}));

let mockSites: { sites: Site[]; loading: boolean };
const mockUseSites = jest.fn();
const mockUpdateSite = jest.fn();
const mockDeleteSite = jest.fn();
jest.mock('@/hooks/useFirestore', () => ({
  useSites: (...args: unknown[]) => {
    mockUseSites(...args);
    return { ...mockSites, error: null, updateSite: mockUpdateSite, deleteSite: mockDeleteSite };
  },
}));

interface GeneralProps {
  site: Site;
  onSave: unknown;
}
interface DangerProps {
  site: Site;
  onDelete: (siteId: string) => Promise<void>;
  onDeleted: () => void;
}
let mockGeneral: GeneralProps | undefined;
let mockDanger: DangerProps | undefined;
jest.mock('@/components/admin/sites/SiteGeneralSection', () => ({
  SiteGeneralSection: (props: GeneralProps) => {
    mockGeneral = props;
    return <div data-testid="general-section" data-site={props.site.id} />;
  },
}));
jest.mock('@/components/admin/sites/SiteMembersSection', () => ({
  SiteMembersSection: ({ siteId }: { siteId: string }) => <div data-testid="members-section" data-site={siteId} />,
}));
jest.mock('@/components/SiteMachinesList', () => ({
  SiteMachinesList: ({ siteId }: { siteId: string }) => <div data-testid="machines-section" data-site={siteId} />,
}));
jest.mock('@/components/admin/sites/SiteSwitches', () => ({
  KeepScreensAwakeSwitch: ({ siteId }: { siteId: string }) => <div data-testid="keep-awake-switch" data-site={siteId} />,
}));
jest.mock('@/components/admin/sites/SiteDangerZone', () => ({
  SiteDangerZone: (props: DangerProps) => {
    mockDanger = props;
    return <div data-testid="danger-section" data-site={props.site.id} />;
  },
}));

const mockReplace = jest.fn();
let mockSearch = '';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

function site(id: string, name: string, extra: Partial<Site> = {}): Site {
  return { id, name, createdAt: 0, ...extra };
}

const ALPHA = site('site-a', 'Alpha', { timezone: 'Europe/Berlin' });
const BRAVO = site('site-b', 'bravo');
const CHARLIE = site('site-c', 'Charlie');

beforeEach(() => {
  // admin of site-a, a member of site-b, the owner of site-c
  mockAuth = { isSuperadmin: false, adminOf: ['site-a'], ownerOf: ['site-c'] };
  mockSites = { sites: [ALPHA, BRAVO, CHARLIE], loading: false };
  mockDeleteSite.mockResolvedValue(undefined);
  mockSearch = '';
  mockGeneral = undefined;
  mockDanger = undefined;
});

function renderSettings(siteId: string, section: SiteSection = 'general') {
  const user = userEvent.setup();
  const onSectionChange = jest.fn();
  const onDeleted = jest.fn();
  const element = () => (
    <SiteSettings siteId={siteId} section={section} onSectionChange={onSectionChange} onDeleted={onDeleted} />
  );
  const view = render(element());
  return { user, container: view.container, rerender: () => view.rerender(element()), onSectionChange, onDeleted };
}

async function openPage(siteId: string) {
  const user = userEvent.setup();
  await act(async () => {
    render(<SiteSettingsPage params={Promise.resolve({ siteId })} />);
  });
  return user;
}

/** what the danger zone does on its confirm, with the props of the render the click landed in */
function confirmDelete(): Promise<void> {
  if (!mockDanger) throw new Error('no danger zone rendered');
  const { site: target, onDelete, onDeleted } = mockDanger;
  return onDelete(target.id).then(onDeleted);
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sectionGroup = () => screen.getByRole('group', { name: 'site settings sections' });
const sectionNames = () => within(sectionGroup()).getAllByRole('button').map((button) => button.textContent);

describe('states', () => {
  it("reads the caller's sites through useSites", () => {
    renderSettings('site-a');

    expect(mockUseSites).toHaveBeenCalledWith('me', mockUserSites, false);
  });

  it('shows a skeleton while the sites load', () => {
    mockSites = { sites: [], loading: true };
    renderSettings('site-a');

    expect(screen.getByText('loading site')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('group', { name: 'site settings sections' })).toBeNull();
  });

  it("says site not found for a site the caller can't reach", () => {
    renderSettings('site-x');

    expect(screen.getByRole('heading', { level: 1, name: 'site not found' })).toBeInTheDocument();
    const id = screen.getByText('site-x');
    expect(id).toHaveClass('font-mono');
    expect(id.parentElement).toHaveTextContent('nothing you can reach answers to site-x.');
    expect(screen.queryByRole('group', { name: 'site settings sections' })).toBeNull();
  });

  it('refuses a member by the site name, with no sections', () => {
    renderSettings('site-b');

    expect(screen.getByRole('heading', { level: 1, name: 'bravo' })).toBeInTheDocument();
    expect(
      screen.getByText("you're a member of bravo. ask its owner or an admin to change its settings."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'site settings sections' })).toBeNull();
    expect(screen.queryByTestId(/-section$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^copy site ID/ })).toBeNull();
  });

  it.each([
    ['admin', 'site-a', 'Alpha'],
    ['member', 'site-b', 'bravo'],
  ])('tells a scoped %s the settings need the whole site, with no sections', (_role, siteId, name) => {
    mockAuth.scopes = { [siteId]: ['m1'] };
    renderSettings(siteId);

    expect(screen.getByRole('heading', { level: 1, name })).toBeInTheDocument();
    expect(
      screen.getByText(
        `your access to ${name} is limited to some machines, and its settings need the whole site. ask its owner or an admin.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/you're a member/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'site settings sections' })).toBeNull();
    expect(screen.queryByTestId(/-section$/)).toBeNull();
  });
});

describe('the header', () => {
  it('names the site and shows an admin their role', () => {
    renderSettings('site-a');

    expect(screen.getByRole('heading', { level: 1, name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'copy site ID site-a' })).toHaveTextContent('site-a');
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.queryByText('owner')).toBeNull();
  });

  it('shows an owner the owner badge', () => {
    renderSettings('site-c');

    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.queryByText('admin')).toBeNull();
  });

  it('gives a superadmin no role badge, and every section', () => {
    mockAuth = { isSuperadmin: true, adminOf: [], ownerOf: [] };
    renderSettings('site-b');

    expect(screen.getByRole('heading', { level: 1, name: 'bravo' })).toBeInTheDocument();
    expect(screen.queryByText('owner')).toBeNull();
    expect(screen.queryByText('admin')).toBeNull();
    expect(sectionNames()).toEqual(['general', 'members', 'machines', 'danger zone']);
  });
});

describe('sections', () => {
  it('gives an admin three sections, with no danger zone', () => {
    renderSettings('site-a');

    expect(sectionNames()).toEqual(['general', 'members', 'machines']);
  });

  it('gives an owner four, the danger zone last', () => {
    renderSettings('site-c');

    expect(sectionNames()).toEqual(['general', 'members', 'machines', 'danger zone']);
  });

  it('renders general for an admin who asks for the danger zone', () => {
    renderSettings('site-a', 'danger');

    expect(within(sectionGroup()).getByRole('button', { name: 'general', pressed: true })).toBeInTheDocument();
    expect(screen.getByTestId('general-section')).toHaveAttribute('data-site', 'site-a');
    expect(screen.queryByTestId('danger-section')).toBeNull();
  });

  it('calls onSectionChange with the section clicked', async () => {
    const { user, onSectionChange } = renderSettings('site-a');

    await user.click(screen.getByRole('button', { name: 'machines' }));

    expect(onSectionChange).toHaveBeenCalledTimes(1);
    expect(onSectionChange).toHaveBeenCalledWith('machines');
  });

  it.each([
    ['general', 'general', 'general-section'],
    ['members', 'members', 'members-section'],
    ['machines', 'machines', 'machines-section'],
    ['danger', 'danger zone', 'danger-section'],
  ] as const)('%s renders that section for the site, and only that one', (section, label, testId) => {
    renderSettings('site-c', section);

    expect(within(sectionGroup()).getByRole('button', { name: label, pressed: true })).toBeInTheDocument();
    expect(screen.getByTestId(testId)).toHaveAttribute('data-site', 'site-c');
    expect(screen.getAllByTestId(/-section$/)).toHaveLength(1);
  });

  it("hands general the site and useSites' updateSite", () => {
    renderSettings('site-a');

    expect(mockGeneral?.site).toBe(ALPHA);
    expect(mockGeneral?.onSave).toBe(mockUpdateSite);
  });

  it('puts the machines list in its own panel', () => {
    renderSettings('site-a', 'machines');

    const panel = screen.getByRole('region', { name: 'machines' });
    expect(within(panel).getByRole('heading', { level: 2 })).toHaveAttribute('id', 'site-section-machines');
    expect(panel).toHaveTextContent("restart or remove this site's machines. add one from the dashboard's + button.");
    expect(within(panel).getByTestId('machines-section')).toHaveAttribute('data-site', 'site-a');
  });

  it('holds keep screens awake in the machines section, above the list', () => {
    renderSettings('site-a', 'machines');

    const screens = screen.getByRole('region', { name: 'screens' });
    expect(within(screens).getByRole('heading', { level: 2 })).toHaveAttribute('id', 'site-section-screens');
    expect(screens).toHaveTextContent('this switch acts the moment it moves.');
    expect(within(screens).getByTestId('keep-awake-switch')).toHaveAttribute('data-site', 'site-a');
    const regions = screen.getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'));
    expect(regions).toEqual(['site-section-screens', 'site-section-machines']);
  });

  it.each(['general', 'members', 'danger'] as const)('has no keep screens awake in %s', (section) => {
    renderSettings('site-c', section);

    expect(screen.queryByTestId('keep-awake-switch')).toBeNull();
  });

  it("links general to the site's swoop settings", () => {
    renderSettings('site-a');

    const features = screen.getByRole('region', { name: 'features' });
    expect(features).toHaveTextContent('these keep their settings on their own page in the admin panel.');
    expect(within(features).getByRole('link', { name: 'swoop settings' })).toHaveAttribute(
      'href',
      '/admin/swoop/settings?site=site-a',
    );
  });

  it('links swoop settings from general only', () => {
    renderSettings('site-a', 'machines');

    expect(screen.queryByRole('link', { name: 'swoop settings' })).toBeNull();
  });

  it("hands the danger zone the site, and its delete goes to useSites' deleteSite", async () => {
    renderSettings('site-c', 'danger');

    expect(mockDanger?.site).toBe(CHARLIE);
    await act(() => mockDanger!.onDelete('site-c'));
    expect(mockDeleteSite).toHaveBeenCalledWith('site-c');
  });
});

describe('deleting the site', () => {
  it('tells the caller false when it was the only site they administer, and renders nothing after', async () => {
    mockAuth = { isSuperadmin: false, adminOf: [], ownerOf: ['site-c'] };
    const { container, rerender, onDeleted } = renderSettings('site-c', 'danger');

    await act(() => confirmDelete());

    expect(onDeleted).toHaveBeenCalledWith(false);
    expect(container).toBeEmptyDOMElement();

    // the list catches up while the caller navigates: still nothing, not "site not found"
    mockAuth = { isSuperadmin: false, adminOf: [], ownerOf: [] };
    mockSites = { sites: [ALPHA, BRAVO], loading: false };
    rerender();
    expect(container).toBeEmptyDOMElement();
  });

  it('tells the caller true when they administer another site', async () => {
    const { onDeleted } = renderSettings('site-c', 'danger');

    await act(() => confirmDelete());

    expect(onDeleted).toHaveBeenCalledWith(true);
  });

  it('tells a superadmin true, with no other site listed', async () => {
    mockAuth = { isSuperadmin: true, adminOf: [], ownerOf: [] };
    mockSites = { sites: [CHARLIE], loading: false };
    const { onDeleted } = renderSettings('site-c', 'danger');

    await act(() => confirmDelete());

    expect(onDeleted).toHaveBeenCalledWith(true);
  });

  it("holds the site while the delete runs, though the cascade drops it and the caller's row first", async () => {
    const request = deferred();
    mockDeleteSite.mockReturnValue(request.promise);
    const { container, rerender, onDeleted } = renderSettings('site-c', 'danger');

    let confirm!: Promise<void>;
    act(() => {
      confirm = confirmDelete();
    });
    mockAuth = { isSuperadmin: false, adminOf: ['site-a'], ownerOf: [] };
    mockSites = { sites: [ALPHA, BRAVO], loading: true };
    rerender();

    expect(screen.getByRole('heading', { level: 1, name: 'Charlie' })).toBeInTheDocument();
    expect(screen.getByTestId('danger-section')).toHaveAttribute('data-site', 'site-c');
    expect(screen.queryByText('loading site')).toBeNull();
    expect(screen.queryByText('site not found')).toBeNull();

    await act(async () => {
      request.resolve();
      await confirm;
    });

    expect(onDeleted).toHaveBeenCalledWith(true);
    expect(container).toBeEmptyDOMElement();
  });

  it('lets the site go when the delete fails', async () => {
    const request = deferred();
    mockDeleteSite.mockReturnValue(request.promise);
    const { rerender, onDeleted } = renderSettings('site-c', 'danger');

    let attempt!: Promise<void>;
    act(() => {
      attempt = mockDanger!.onDelete('site-c');
    });
    mockSites = { sites: [ALPHA, BRAVO], loading: false };
    rerender();
    expect(screen.getByTestId('danger-section')).toBeInTheDocument();

    await act(async () => {
      request.reject(new Error('the request timed out'));
      await expect(attempt).rejects.toThrow('the request timed out');
    });

    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'site not found' })).toBeInTheDocument();
  });
});

describe('/admin/sites/[siteId]', () => {
  it('opens the section in the url, under a link back to the sites', async () => {
    mockSearch = 'section=members';
    await openPage('site-a');

    expect(screen.getByRole('link', { name: 'sites' })).toHaveAttribute('href', '/admin/sites');
    expect(within(sectionGroup()).getByRole('button', { name: 'members', pressed: true })).toBeInTheDocument();
    expect(screen.getByTestId('members-section')).toHaveAttribute('data-site', 'site-a');
  });

  it('opens general for a section it does not know', async () => {
    mockSearch = 'section=billing';
    await openPage('site-a');

    expect(screen.getByTestId('general-section')).toHaveAttribute('data-site', 'site-a');
  });

  it("sends the old swoop section to the site's swoop settings, rendering nothing on the way", async () => {
    mockSearch = 'section=swoop';
    await openPage('site a');

    expect(mockReplace).toHaveBeenCalledWith('/admin/swoop/settings?site=site%20a');
    expect(screen.queryByRole('group', { name: 'site settings sections' })).toBeNull();
    expect(screen.queryByTestId(/-section$/)).toBeNull();
  });

  it('replaces the url on a section change, without scrolling', async () => {
    const user = await openPage('site-a');

    await user.click(screen.getByRole('button', { name: 'machines' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/sites/site-a?section=machines', { scroll: false });

    await user.click(screen.getByRole('button', { name: 'general' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/admin/sites/site-a', { scroll: false });
  });

  it('sends a deleted site’s owner back to the sites when they administer another', async () => {
    mockSearch = 'section=danger';
    await openPage('site-c');

    await act(() => confirmDelete());

    expect(mockReplace).toHaveBeenCalledWith('/admin/sites');
  });

  it('sends them to the dashboard when no administered site is left', async () => {
    mockAuth = { isSuperadmin: false, adminOf: [], ownerOf: ['site-c'] };
    mockSearch = 'section=danger';
    await openPage('site-c');

    await act(() => confirmDelete());

    expect(mockReplace).toHaveBeenCalledWith('/dashboard');
  });
});
