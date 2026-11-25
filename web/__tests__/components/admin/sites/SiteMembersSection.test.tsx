/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * SiteMembersSection, a site's members section: the table of members with
 * their site role, effective swoop and machine scope, the row menus (change
 * access on rows other than your own and the owner's, remove on every row but
 * the owner's), removal with talon successors from the site's own owners and
 * admins, the owner refusal matched by its code, and the add and change access
 * dialogs mounted only while open, with the site's machines.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SiteMembersSection } from '@/components/admin/sites/SiteMembersSection';
import type { AddMemberDialog } from '@/components/admin/sites/AddMemberDialog';
import type { ChangeAccessDialog } from '@/components/admin/sites/ChangeAccessDialog';
import { useSiteMachines, type SiteMachine } from '@/hooks/useSiteMachines';
import {
  SiteMemberApiError,
  useSiteMembers,
  type RemoveSiteMemberResult,
  type SiteMember,
  type UseSiteMembersResult,
} from '@/hooks/useSiteMembers';
import { useSwoopSettings } from '@/hooks/useSwoopSettings';
import { useTalonReassign, type SiteAuthoredTalons } from '@/hooks/useTalonReassign';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'me' } }),
}));

jest.mock('@/hooks/useSiteMembers', () => ({
  ...jest.requireActual('@/hooks/useSiteMembers'),
  useSiteMembers: jest.fn(),
}));

jest.mock('@/hooks/useTalonReassign', () => ({ useTalonReassign: jest.fn() }));

jest.mock('@/hooks/useSwoopSettings', () => ({ useSwoopSettings: jest.fn() }));

jest.mock('@/hooks/useSiteMachines', () => ({ useSiteMachines: jest.fn() }));

type AddDialogProps = Parameters<typeof AddMemberDialog>[0];
type AccessDialogProps = Parameters<typeof ChangeAccessDialog>[0];

let mockAddDialog: AddDialogProps | undefined;
jest.mock('@/components/admin/sites/AddMemberDialog', () => ({
  AddMemberDialog: (props: AddDialogProps) => {
    mockAddDialog = props;
    return <div role="dialog" aria-label="add member" />;
  },
}));

let mockAccessDialog: AccessDialogProps | undefined;
jest.mock('@/components/admin/sites/ChangeAccessDialog', () => ({
  ...jest.requireActual('@/components/admin/sites/ChangeAccessDialog'),
  ChangeAccessDialog: (props: AccessDialogProps) => {
    mockAccessDialog = props;
    return <div role="dialog" aria-label="change access" />;
  },
}));

// radix measures its menus with a ResizeObserver, drives pointers with pointer
// capture and scrolls select items into view; jsdom has none of them.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.setPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

type User = ReturnType<typeof userEvent.setup>;

function member(uid: string, overrides: Partial<SiteMember>): SiteMember {
  return {
    uid,
    email: null,
    displayName: null,
    role: 'member',
    globalRole: 'user',
    swoop: null,
    machineIds: null,
    ...overrides,
  };
}

function machine(id: string, name: string): SiteMachine {
  return { id, name, online: true, lastHeartbeat: null, agentVersion: null };
}

const MACHINES = [machine('IN', 'lobby wall'), machine('IN2', 'kiosk')];

const OLIVE = member('u-olive', { email: 'olive@example.com', displayName: 'olive park', role: 'owner' });
// the signed-in admin
const ME = member('me', { email: 'me@example.com', role: 'admin' });
// an admin held to watch
const ADA = member('u-ada', { email: 'ada@example.com', displayName: 'ada lin', role: 'admin', swoop: 'view' });
// a member by role, limited to one machine
const KIM = member('u-kim', { email: 'kim@example.com', displayName: 'kim ortiz', machineIds: ['IN'] });
// a member set to control, whose account role is admin: a grant elsewhere that is nothing here. one of
// their two machines has left the site
const MAX = member('u-max', {
  displayName: 'max reyes',
  globalRole: 'admin',
  swoop: 'control',
  machineIds: ['IN2', 'gone'],
});
// no email and no name on file, and every machine they had has gone
const GHOST = member('u-ghost', { machineIds: [] });

const MEMBERS = [OLIVE, ME, ADA, KIM, MAX, GHOST];

let hook: UseSiteMembersResult;
const fetchSiteAuthored = jest.fn<Promise<SiteAuthoredTalons>, [string, string]>();

function removed(overrides: Partial<RemoveSiteMemberResult> = {}): RemoveSiteMemberResult {
  return { siteId: 'elm-gate', uid: 'u-kim', wasMember: true, talonCount: 0, reassignedTalonIds: [], ...overrides };
}

beforeEach(() => {
  mockAddDialog = undefined;
  mockAccessDialog = undefined;
  hook = {
    members: MEMBERS,
    loading: false,
    error: null,
    refresh: jest.fn(() => Promise.resolve()),
    addMember: jest.fn(),
    updateMember: jest.fn(),
    removeMember: jest.fn(() => Promise.resolve(removed())),
  };
  jest.mocked(useSiteMembers).mockImplementation(() => hook);
  fetchSiteAuthored.mockResolvedValue({ count: 0, talons: [] });
  jest.mocked(useTalonReassign).mockReturnValue({
    fetchSiteAuthored,
    fetchUserAuthored: jest.fn(),
    reassignSiteTalons: jest.fn(),
  });
  watching(true);
  jest.mocked(useSiteMachines).mockReturnValue({ machines: MACHINES, error: null, refresh: jest.fn() });
});

function watching(membersMayWatch: boolean) {
  jest.mocked(useSwoopSettings).mockReturnValue({
    settings: { enabled: true, excludedMachineIds: [], membersMayWatch, indicator: 'banner' },
    loading: false,
  });
}

function renderSection() {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <SiteMembersSection siteId="elm-gate" />
    </TooltipProvider>,
  );
  return user;
}

// each person's row, found by the first line it shows
function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('tr');
  if (!row) throw new Error(`no row shows ${text}`);
  return row;
}

function cellOf(text: string, column: 'member' | 'role' | 'swoop' | 'access' | 'actions'): HTMLElement {
  const index = screen.getAllByRole('columnheader').findIndex((header) => header.textContent === column);
  return within(rowOf(text)).getAllByRole('cell')[index];
}

async function openMenu(user: User, name: string): Promise<(string | null)[]> {
  await user.click(screen.getByRole('button', { name: `options for ${name}` }));
  const menu = await screen.findByRole('menu');
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent);
}

async function startRemoving(user: User, name: string) {
  await openMenu(user, name);
  await user.click(screen.getByRole('menuitem', { name: 'remove...' }));
}

describe('the frame and the table', () => {
  it('is a section named members, fed by this site', () => {
    renderSection();

    expect(screen.getByRole('region', { name: 'members' })).toHaveTextContent(
      'the people who can reach this site, their role, their swoop and their access.',
    );
    expect(useSiteMembers).toHaveBeenCalledWith('elm-gate');
    expect(useSwoopSettings).toHaveBeenCalledWith('elm-gate');
    expect(useSiteMachines).toHaveBeenCalledWith('elm-gate');
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'member',
      'role',
      'swoop',
      'access',
      'actions',
    ]);
  });

  it('badges each site role, and marks your own row', () => {
    renderSection();

    expect(cellOf('olive park', 'role')).toHaveTextContent(/^owner$/);
    expect(cellOf('me@example.com', 'role')).toHaveTextContent(/^admin$/);
    expect(cellOf('ada lin', 'role')).toHaveTextContent(/^admin$/);
    expect(cellOf('kim ortiz', 'role')).toHaveTextContent(/^member$/);
    expect(within(cellOf('me@example.com', 'member')).getByText('you')).toBeInTheDocument();
    expect(within(cellOf('kim ortiz', 'member')).queryByText('you')).toBeNull();
    expect(within(cellOf('kim ortiz', 'member')).getByText('kim@example.com')).toBeInTheDocument();
    expect(cellOf('no email on file', 'role')).toHaveTextContent(/^member$/);
  });

  it('reads a superadmin row as admin, and never says superadmin', () => {
    hook.members = [member('u-sam', { email: 'sam@example.com', role: 'superadmin' })];
    renderSection();

    expect(cellOf('sam@example.com', 'role')).toHaveTextContent(/^admin$/);
    expect(document.body).not.toHaveTextContent(/superadmin/i);
  });

  it('says so while loading, and shows no table', () => {
    hook = { ...hook, members: [], loading: true };
    renderSection();

    expect(screen.getByText('loading members...')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the error with a retry, and no table', async () => {
    hook = { ...hook, members: [], error: 'failed to load members' };
    const user = renderSection();

    expect(screen.getByText('failed to load members')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'retry' }));
    expect(hook.refresh).toHaveBeenCalledTimes(1);
  });

  it('says no members found on an empty site', () => {
    hook.members = [];
    renderSection();

    expect(screen.getByRole('cell', { name: 'no members found' })).toBeInTheDocument();
  });
});

describe('the swoop column', () => {
  it('says a member by role watches, marked by role', () => {
    renderSection();

    expect(cellOf('kim ortiz', 'swoop')).toHaveTextContent(/^watch · by role · 1 machine$/);
    expect(within(cellOf('kim ortiz', 'swoop')).getByText('· by role')).toHaveClass('text-muted-foreground');
  });

  it("says a member by role has no swoop on a site whose members don't watch", () => {
    watching(false);
    renderSection();

    expect(cellOf('kim ortiz', 'swoop')).toHaveTextContent(/^no swoop · by role · 1 machine$/);
  });

  it('shows an explicit mode as itself: control on a member, watch on an admin held to view', () => {
    watching(false);
    renderSection();

    expect(cellOf('max reyes', 'swoop')).toHaveTextContent(/^control · 2 machines$/);
    expect(cellOf('ada lin', 'swoop')).toHaveTextContent(/^watch · whole site$/);
  });

  it('says an admin by role controls', () => {
    renderSection();

    expect(cellOf('me@example.com', 'swoop')).toHaveTextContent(/^control · by role · whole site$/);
  });

  it("reads control on the owner's row and nothing more", () => {
    watching(false);
    renderSection();

    expect(cellOf('olive park', 'swoop')).toHaveTextContent(/^control · whole site$/);
  });
});

describe('the access column', () => {
  it('reads whole site, a count of machines, or no machines', () => {
    renderSection();

    expect(cellOf('olive park', 'access')).toHaveTextContent(/^whole site$/);
    expect(cellOf('ada lin', 'access')).toHaveTextContent(/^whole site$/);
    expect(cellOf('kim ortiz', 'access')).toHaveTextContent(/^1 machine$/);
    expect(cellOf('max reyes', 'access')).toHaveTextContent(/^2 machines$/);
    expect(cellOf('no email on file', 'access')).toHaveTextContent(/^no machines$/);
  });

  it('shows from md up, and below md rides the role line after the swoop', () => {
    renderSection();

    expect(cellOf('kim ortiz', 'access')).toHaveClass('hidden', 'md:table-cell');
    expect(within(cellOf('kim ortiz', 'swoop')).getByText('· 1 machine')).toHaveClass('md:hidden');
  });

  it("lists a scoped row's machines by name in a tooltip, and an id the site no longer has as the id", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SiteMembersSection siteId="elm-gate" />
      </TooltipProvider>,
    );

    await userEvent.hover(within(cellOf('max reyes', 'access')).getByText('2 machines'));

    const tooltip = await screen.findByRole('tooltip');
    expect(within(tooltip).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['kiosk', 'gone']);
  });

  it("says when the machines couldn't load, since the access picker would list none", async () => {
    const refreshMachines = jest.fn();
    jest.mocked(useSiteMachines).mockReturnValue({
      machines: null,
      error: 'failed to load machines (500)',
      refresh: refreshMachines,
    });
    render(
      <TooltipProvider delayDuration={0}>
        <SiteMembersSection siteId="elm-gate" />
      </TooltipProvider>,
    );

    expect(screen.getByText("machines couldn't load: failed to load machines (500)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'reload machines' }));
    expect(refreshMachines).toHaveBeenCalledTimes(1);
  });

  it('names a scope by its ids until the machines load', async () => {
    jest.mocked(useSiteMachines).mockReturnValue({ machines: null, error: null, refresh: jest.fn() });
    render(
      <TooltipProvider delayDuration={0}>
        <SiteMembersSection siteId="elm-gate" />
      </TooltipProvider>,
    );

    await userEvent.hover(within(cellOf('kim ortiz', 'access')).getByText('1 machine'));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('IN');
  });

  it('gives the whole site and no machines no tooltip', () => {
    renderSection();

    // a tooltip trigger carries radix's data-state
    expect(within(cellOf('kim ortiz', 'access')).getByText('1 machine')).toHaveAttribute('data-state');
    expect(within(cellOf('ada lin', 'access')).getByText('whole site')).not.toHaveAttribute('data-state');
    expect(within(cellOf('no email on file', 'access')).getByText('no machines')).not.toHaveAttribute('data-state');
  });
});

describe('row menus', () => {
  it("shows a dash on the owner's row, with no options", () => {
    renderSection();

    expect(cellOf('olive park', 'actions')).toHaveTextContent(/^—$/);
    expect(screen.queryByRole('button', { name: 'options for olive@example.com' })).toBeNull();
  });

  it('offers remove on your own row, and no change access', async () => {
    const user = renderSection();

    expect(await openMenu(user, 'me@example.com')).toEqual(['remove...']);
  });

  it.each<[string, string]>([
    ['a member by role', 'kim@example.com'],
    ['an admin', 'ada@example.com'],
    ['a member with no email, by name', 'max reyes'],
    ['a member with neither, by uid', 'u-ghost'],
  ])('offers change access and remove on %s', async (_, name) => {
    const user = renderSection();

    expect(await openMenu(user, name)).toEqual(['change access...', 'remove...']);
  });

  it('labels its options member options', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <SiteMembersSection siteId="elm-gate" />
      </TooltipProvider>,
    );

    await userEvent.hover(screen.getByRole('button', { name: 'options for kim@example.com' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('member options');
  });
});

describe('adding and changing access', () => {
  it('mounts the add dialog only while open, with the site, its watch default and the hook', async () => {
    watching(false);
    const user = renderSection();

    expect(screen.queryByRole('dialog', { name: 'add member' })).toBeNull();
    expect(mockAddDialog).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'add member' }));

    expect(screen.getByRole('dialog', { name: 'add member' })).toBeInTheDocument();
    expect(mockAddDialog).toMatchObject({
      siteId: 'elm-gate',
      membersMayWatch: false,
      machines: MACHINES,
      addMember: hook.addMember,
    });

    act(() => mockAddDialog?.onOpenChange(false));
    expect(screen.queryByRole('dialog', { name: 'add member' })).toBeNull();
  });

  it("mounts change access on that person's row only while open", async () => {
    const user = renderSection();

    expect(screen.queryByRole('dialog', { name: 'change access' })).toBeNull();

    await openMenu(user, 'kim@example.com');
    await user.click(screen.getByRole('menuitem', { name: 'change access...' }));

    expect(screen.getByRole('dialog', { name: 'change access' })).toBeInTheDocument();
    expect(mockAccessDialog).toMatchObject({
      siteId: 'elm-gate',
      member: KIM,
      membersMayWatch: true,
      machines: MACHINES,
      updateMember: hook.updateMember,
    });

    act(() => mockAccessDialog?.onOpenChange(false));
    expect(screen.queryByRole('dialog', { name: 'change access' })).toBeNull();
  });

  it('hands both dialogs no machines while the machines load', async () => {
    jest.mocked(useSiteMachines).mockReturnValue({ machines: null, error: null, refresh: jest.fn() });
    const user = renderSection();

    await user.click(screen.getByRole('button', { name: 'add member' }));
    expect(mockAddDialog?.machines).toEqual([]);

    await openMenu(user, 'kim@example.com');
    await user.click(screen.getByRole('menuitem', { name: 'change access...' }));
    expect(mockAccessDialog?.machines).toEqual([]);
  });
});

describe('removing a member', () => {
  it('refuses your own row with a reason, and opens nothing', async () => {
    const user = renderSection();

    await startRemoving(user, 'me@example.com');

    expect(toast.error).toHaveBeenCalledWith('cannot remove yourself', {
      description: 'ask another admin on this site to remove your access.',
    });
    expect(screen.queryByRole('dialog', { name: 'remove member' })).toBeNull();
    expect(fetchSiteAuthored).not.toHaveBeenCalled();
  });

  it('confirms by name, then removes them and toasts', async () => {
    const user = renderSection();

    await startRemoving(user, 'kim@example.com');

    const dialog = screen.getByRole('dialog', { name: 'remove member' });
    expect(dialog).toHaveAccessibleDescription('remove kim@example.com from this site?');
    expect(dialog).toHaveTextContent(
      'they lose access to this site and everything on it. their account and any other sites they belong to are untouched.',
    );
    expect(fetchSiteAuthored).toHaveBeenCalledWith('elm-gate', 'u-kim');

    await user.click(within(dialog).getByRole('button', { name: 'remove member' }));

    expect(hook.removeMember).toHaveBeenCalledWith('u-kim', undefined);
    expect(toast.success).toHaveBeenCalledWith('member removed', {
      description: 'kim@example.com no longer has access to this site.',
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'remove member' })).toBeNull();
  });

  it("offers only the site's owners and admins as talon successors, never the account's role", async () => {
    fetchSiteAuthored.mockResolvedValue({
      count: 2,
      talons: [
        { id: 't-1', name: 'nightly restart', enabled: true },
        { id: 't-2', name: 'morning report', enabled: true },
      ],
    });
    hook.removeMember = jest.fn(() => Promise.resolve(removed({ talonCount: 2, reassignedTalonIds: ['t-1', 't-2'] })));
    const user = renderSection();

    await startRemoving(user, 'kim@example.com');
    expect(await screen.findByText('this person wrote 2 talons')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'reassign to' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'nobody — let these talons stop',
      'ada@example.com',
      'me@example.com',
      'olive@example.com',
    ]);

    await user.click(screen.getByRole('option', { name: 'ada@example.com' }));
    await user.click(screen.getByRole('button', { name: 'remove member' }));

    expect(hook.removeMember).toHaveBeenCalledWith('u-kim', 'u-ada');
    expect(toast.success).toHaveBeenCalledWith('talons reassigned', {
      description: '2 talons moved to a new author.',
    });
  });

  it('never offers the person being removed as their own successor', async () => {
    fetchSiteAuthored.mockResolvedValue({ count: 1, talons: [{ id: 't-1', name: 'nightly restart', enabled: true }] });
    const user = renderSection();

    await startRemoving(user, 'ada@example.com');
    await screen.findByText('this person wrote 1 talon');
    await user.click(screen.getByRole('combobox', { name: 'reassign to' }));

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'nobody — let these talons stop',
      'me@example.com',
      'olive@example.com',
    ]);
  });

  it('warns about the person in the dialog, not one opened earlier whose lookup answered late', async () => {
    let answerKim!: (found: SiteAuthoredTalons) => void;
    fetchSiteAuthored.mockImplementation((_siteId, uid) =>
      uid === 'u-kim'
        ? new Promise<SiteAuthoredTalons>((resolve) => {
            answerKim = resolve;
          })
        : Promise.resolve({ count: 0, talons: [] }),
    );
    const user = renderSection();

    await startRemoving(user, 'kim@example.com');
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    await startRemoving(user, 'ada@example.com');
    await act(async () => answerKim({ count: 3, talons: [] }));

    expect(screen.getByRole('dialog', { name: 'remove member' })).toHaveAccessibleDescription(
      'remove ada@example.com from this site?',
    );
    expect(screen.queryByText('this person wrote 3 talons')).toBeNull();
  });

  it("matches the owner's refusal by its code", async () => {
    hook.removeMember = jest.fn(() =>
      Promise.reject(
        new SiteMemberApiError(
          409,
          'the site owner cannot be removed via this endpoint; transfer ownership first via POST /api/sites/{siteId}/transfer-ownership',
          'cannot_remove_owner',
        ),
      ),
    );
    const user = renderSection();

    await startRemoving(user, 'kim@example.com');
    await user.click(screen.getByRole('button', { name: 'remove member' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('cannot remove the site owner', {
        description: 'transfer site ownership first, then remove them.',
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('toasts any other refusal with its detail, even one that mentions an owner', async () => {
    hook.removeMember = jest.fn(() =>
      Promise.reject(
        new SiteMemberApiError(
          403,
          'ask a site owner: removing a member requires the SITE_MEMBER_MANAGE capability on this site',
          'site_member_manage_required',
        ),
      ),
    );
    const user = renderSection();

    await startRemoving(user, 'kim@example.com');
    await user.click(screen.getByRole('button', { name: 'remove member' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('could not remove member', {
        description: 'ask a site owner: removing a member requires the SITE_MEMBER_MANAGE capability on this site',
      }),
    );
    expect(toast.error).not.toHaveBeenCalledWith('cannot remove the site owner', expect.anything());
  });

  it('cancel removes no one', async () => {
    const user = renderSection();

    await startRemoving(user, 'kim@example.com');
    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(hook.removeMember).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'remove member' })).toBeNull();
  });
});
