/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ChangeAccessDialog, the members section's "change access...", with the real
 * role, swoop and machines fields. it seeds from the site role (never the
 * account's), the row's swoop mode and its machine scope, sends only what
 * changed (by role and the whole site as null), says which swoop sessions the
 * change ends and which talons a limit stops, and stays open when the save fails.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeAccessDialog, memberLabel } from '@/components/admin/sites/ChangeAccessDialog';
import {
  SiteMemberApiError,
  type SiteMember,
  type UpdateSiteMemberInput,
  type UpdateSiteMemberResult,
} from '@/hooks/useSiteMembers';
import { useTalonReassign, type SiteAuthoredTalons } from '@/hooks/useTalonReassign';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/hooks/useTalonReassign', () => ({ useTalonReassign: jest.fn() }));

// radix measures its popovers with a ResizeObserver, drives pointers with
// pointer capture and scrolls select items into view; jsdom has none of them.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

type User = ReturnType<typeof userEvent.setup>;
type UpdateMember = jest.Mock<Promise<UpdateSiteMemberResult>, [string, UpdateSiteMemberInput]>;

const SITE_ONLY = 'this changes their access to this site only.';
const CONTROL_ENDS = `${SITE_ONLY} any swoop session they control here ends; watching carries on.`;
const SESSIONS_END = `${SITE_ONLY} any swoop session they are in here ends.`;
const MACHINE_ENDS = `${SITE_ONLY} a swoop session they are in on a machine you take away ends.`;

const MACHINES = [
  { id: 'IN', name: 'lobby wall' },
  { id: 'IN2', name: 'kiosk' },
];

const fetchSiteAuthored = jest.fn<Promise<SiteAuthoredTalons>, [string, string]>();

beforeEach(() => {
  fetchSiteAuthored.mockResolvedValue({ count: 0, talons: [] });
  jest.mocked(useTalonReassign).mockReturnValue({
    fetchSiteAuthored,
    fetchUserAuthored: jest.fn(),
    reassignSiteTalons: jest.fn(),
  });
});

function member(overrides: Partial<SiteMember> = {}): SiteMember {
  return {
    uid: 'u-kim',
    email: 'kim@example.com',
    displayName: 'kim ortiz',
    role: 'member',
    globalRole: 'user',
    swoop: null,
    machineIds: null,
    ...overrides,
  };
}

const mockUpdate = (impl: (uid: string, patch: UpdateSiteMemberInput) => Promise<UpdateSiteMemberResult>) =>
  jest.fn<Promise<UpdateSiteMemberResult>, [string, UpdateSiteMemberInput]>(impl);

// as the PATCH route answers: the row as written, where a field not sent keeps the row's value
function writes(row: SiteMember): UpdateMember {
  return mockUpdate((uid, patch) =>
    Promise.resolve({
      siteId: 'elm-gate',
      uid,
      role: patch.role ?? (row.role === 'admin' ? 'admin' : 'member'),
      swoop: patch.swoop === undefined ? row.swoop : patch.swoop,
      machineIds: patch.machineIds === undefined ? row.machineIds : patch.machineIds,
    }),
  );
}

function renderDialog({
  row = member(),
  membersMayWatch = true,
  updateMember = writes(row),
}: { row?: SiteMember; membersMayWatch?: boolean; updateMember?: UpdateMember } = {}) {
  const onOpenChange = jest.fn();
  const user = userEvent.setup();
  render(
    <ChangeAccessDialog
      siteId="elm-gate"
      member={row}
      membersMayWatch={membersMayWatch}
      machines={MACHINES}
      onOpenChange={onOpenChange}
      updateMember={updateMember}
    />,
  );
  return { user, updateMember, onOpenChange };
}

const dialog = () => screen.getByRole('dialog', { name: 'change access' });
const roleSelect = () => screen.getByRole('combobox', { name: 'role' });
const swoopSelect = () => screen.getByRole('combobox', { name: 'swoop' });
const saveButton = () => screen.getByRole('button', { name: 'save' });
const sent = (updateMember: UpdateMember) => updateMember.mock.calls;

async function choose(user: User, field: 'role' | 'swoop', option: string) {
  await user.click(screen.getByRole('combobox', { name: field }));
  await user.click(screen.getByRole('option', { name: option }));
}

const access = () => screen.getByRole('group', { name: 'access' });
const picker = () => screen.getByTestId('change-access-machines-machines');

async function toggleMachine(user: User, machine: string) {
  await user.click(picker());
  await user.click(await screen.findByRole('checkbox', { name: machine }));
  await user.keyboard('{Escape}');
}

async function limitTo(user: User, machine: string) {
  await user.click(within(access()).getByRole('button', { name: 'some machines' }));
  await toggleMachine(user, machine);
}

describe('ChangeAccessDialog', () => {
  it('names the person, and says the change is for this site only', () => {
    renderDialog();

    expect(dialog()).toHaveAccessibleDescription("choose kim@example.com's role, swoop and access on this site.");
    expect(screen.getByText(SITE_ONLY)).toBeInTheDocument();
    expect(roleSelect()).toHaveAttribute('id', 'change-access-role');
    expect(swoopSelect()).toHaveAttribute('id', 'change-access-swoop');
    expect(document.body).not.toHaveTextContent(/account-level|changes the account/i);
  });

  it.each<[string, Partial<SiteMember>, string]>([
    ['their email', {}, "choose kim@example.com's role, swoop and access on this site."],
    ['their name with no email', { email: null }, "choose kim ortiz's role, swoop and access on this site."],
    ['this member with neither', { email: null, displayName: null }, "choose this member's role, swoop and access on this site."],
  ])('calls the person by %s, never their uid', (_, overrides, description) => {
    renderDialog({ row: member(overrides) });

    expect(dialog()).toHaveAccessibleDescription(description);
    expect(document.body).not.toHaveTextContent('u-kim');
  });

  it.each<[SiteMember['role'], string, SiteMember['swoop'], string, string]>([
    ['admin', 'member', 'view', 'admin', 'watch'],
    ['member', 'admin', null, 'member', 'by role'],
    ['member', 'superadmin', 'control', 'member', 'control'],
    ['admin', 'user', 'none', 'admin', 'no swoop'],
  ])(
    'seeds a site %s (account role %s) with swoop %s from the row, never the account',
    (role, globalRole, swoop, shownRole, shownSwoop) => {
      renderDialog({ row: member({ role, globalRole, swoop }) });

      expect(roleSelect()).toHaveTextContent(shownRole);
      expect(swoopSelect()).toHaveTextContent(shownSwoop);
      expect(saveButton()).toBeDisabled();
    },
  );

  it('keeps save disabled until something changes, and again once it is put back', async () => {
    const { user } = renderDialog();

    expect(saveButton()).toBeDisabled();

    await choose(user, 'role', 'admin');
    expect(saveButton()).toBeEnabled();
    await choose(user, 'role', 'member');
    expect(saveButton()).toBeDisabled();

    await choose(user, 'swoop', 'watch');
    expect(saveButton()).toBeEnabled();
    await choose(user, 'swoop', 'by role');
    expect(saveButton()).toBeDisabled();
  });

  it('sends only the role when only the role changes, toasts the new access and closes', async () => {
    const { user, updateMember, onOpenChange } = renderDialog();

    await choose(user, 'role', 'admin');
    // gaining control ends nothing
    expect(screen.getByText(SITE_ONLY)).toBeInTheDocument();
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { role: 'admin' }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now an admin on this site. swoop: control (by role). access: whole site.',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('holding an admin to watch sends swoop view, and says the control they hold ends', async () => {
    const row = member({ role: 'admin' });
    const { user, updateMember } = renderDialog({ row });

    await choose(user, 'swoop', 'watch');
    expect(screen.getByText(CONTROL_ENDS)).toBeInTheDocument();
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { swoop: 'view' }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now an admin on this site. swoop: watch. access: whole site.',
    });
  });

  it('a member back on by role sends swoop null, and the toast says what their role gives', async () => {
    const row = member({ swoop: 'control' });
    const { user, updateMember } = renderDialog({ row });

    await choose(user, 'swoop', 'by role');
    expect(screen.getByText(CONTROL_ENDS)).toBeInTheDocument();
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { swoop: null }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now a member on this site. swoop: watch (by role). access: whole site.',
    });
  });

  it("says by role gives a member no swoop on a site whose members don't watch", async () => {
    const row = member({ swoop: 'view' });
    const { user, updateMember } = renderDialog({ row, membersMayWatch: false });

    await choose(user, 'swoop', 'by role');
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { swoop: null }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now a member on this site. swoop: no swoop (by role). access: whole site.',
    });
  });

  it('no swoop sends swoop none, and says every swoop session they are in ends', async () => {
    const { user, updateMember } = renderDialog();

    await choose(user, 'swoop', 'no swoop');
    expect(screen.getByText(SESSIONS_END)).toBeInTheDocument();
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { swoop: 'none' }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now a member on this site. swoop: no swoop. access: whole site.',
    });
  });

  it('a demoted admin loses control by role, and the footnote says so', async () => {
    const { user, updateMember } = renderDialog({ row: member({ role: 'admin' }) });

    await choose(user, 'role', 'member');
    expect(screen.getByText(CONTROL_ENDS)).toBeInTheDocument();
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { role: 'member' }]]);
  });

  it('sends a role and a swoop changed together in one patch', async () => {
    const { user, updateMember } = renderDialog();

    await choose(user, 'role', 'admin');
    await choose(user, 'swoop', 'watch');
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { role: 'admin', swoop: 'view' }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now an admin on this site. swoop: watch. access: whole site.',
    });
  });

  it('toasts the row as the server wrote it, which a stale seed may not match', async () => {
    // the list showed a member, but someone made them admin meanwhile: a swoop sent alone keeps that role
    const updateMember = mockUpdate((uid) =>
      Promise.resolve({ siteId: 'elm-gate', uid, role: 'admin', swoop: 'view', machineIds: null }),
    );
    const { user } = renderDialog({ updateMember });

    await choose(user, 'swoop', 'watch');
    await user.click(saveButton());

    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now an admin on this site. swoop: watch. access: whole site.',
    });
  });

  it('toasts a failure with the server detail, and keeps the dialog open with the choice', async () => {
    const updateMember = mockUpdate(() =>
      Promise.reject(
        new SiteMemberApiError(
          403,
          'changing a member requires the SITE_MEMBER_MANAGE capability on this site',
          'site_member_manage_required',
        ),
      ),
    );
    const { user, onOpenChange } = renderDialog({ updateMember });

    await choose(user, 'swoop', 'control');
    await user.click(saveButton());

    expect(toast.error).toHaveBeenCalledWith('could not change their access', {
      description: 'changing a member requires the SITE_MEMBER_MANAGE capability on this site',
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
    expect(swoopSelect()).toHaveTextContent('control');
    expect(saveButton()).toBeEnabled();
  });

  it('holds save, cancel and the fields while the save runs', async () => {
    let finish!: (result: UpdateSiteMemberResult) => void;
    const updateMember = mockUpdate(
      () =>
        new Promise<UpdateSiteMemberResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { user, onOpenChange } = renderDialog({ updateMember });

    await choose(user, 'role', 'admin');
    await user.click(saveButton());

    expect(screen.getByRole('button', { name: 'saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
    expect(roleSelect()).toBeDisabled();
    expect(swoopSelect()).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => finish({ siteId: 'elm-gate', uid: 'u-kim', role: 'admin', swoop: null, machineIds: null }));

    expect(updateMember).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancel closes without saving', async () => {
    const { user, updateMember, onOpenChange } = renderDialog();

    await choose(user, 'role', 'admin');
    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(updateMember).not.toHaveBeenCalled();
  });
});

describe('ChangeAccessDialog machines', () => {
  it('seeds a scoped row with its machines', () => {
    renderDialog({ row: member({ machineIds: ['IN'] }) });

    expect(within(access()).getByRole('button', { name: 'some machines' })).toHaveAttribute('aria-pressed', 'true');
    expect(picker()).toHaveTextContent('lobby wall');
    expect(saveButton()).toBeDisabled();
  });

  it('seeds a whole-site row with the whole site and no picker', () => {
    renderDialog();

    expect(within(access()).getByRole('button', { name: 'whole site' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('change-access-machines-machines')).not.toBeInTheDocument();
  });

  it('some machines then one sends just that one, and the toast names the access', async () => {
    const { user, updateMember } = renderDialog();

    await limitTo(user, 'lobby wall');
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { machineIds: ['IN'] }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now a member on this site. swoop: watch (by role). access: 1 machine.',
    });
  });

  it('the whole site sends null, and the toast says whole site', async () => {
    const { user, updateMember } = renderDialog({ row: member({ machineIds: ['IN', 'IN2'] }) });

    await user.click(within(access()).getByRole('button', { name: 'whole site' }));
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { machineIds: null }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now a member on this site. swoop: watch (by role). access: whole site.',
    });
  });

  it('sends a role change and a narrowing in one patch', async () => {
    const { user, updateMember } = renderDialog({ row: member({ machineIds: ['IN', 'IN2'] }) });

    await choose(user, 'role', 'admin');
    await toggleMachine(user, 'kiosk');
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { role: 'admin', machineIds: ['IN'] }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now an admin on this site. swoop: control (by role). access: 1 machine.',
    });
  });

  it('keeps save disabled at no machines, even beside another change', async () => {
    const { user, updateMember } = renderDialog();

    await choose(user, 'role', 'admin');
    expect(saveButton()).toBeEnabled();

    await user.click(within(access()).getByRole('button', { name: 'some machines' }));
    expect(saveButton()).toBeDisabled();
    await user.click(saveButton());
    expect(updateMember).not.toHaveBeenCalled();
  });

  it('reads the same machines picked in another order as no change', async () => {
    const { user } = renderDialog({ row: member({ machineIds: ['IN', 'IN2'] }) });

    await toggleMachine(user, 'lobby wall');
    expect(saveButton()).toBeEnabled();
    await toggleMachine(user, 'lobby wall');

    expect(saveButton()).toBeDisabled();
  });

  it('drops a picked machine that has left the site from what it sends', async () => {
    const { user, updateMember } = renderDialog({ row: member({ machineIds: ['gone'] }) });

    await toggleMachine(user, 'kiosk');
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { machineIds: ['IN2'] }]]);
  });

  it('keeps save disabled when only a machine that has left the site would be left', async () => {
    const { user, updateMember } = renderDialog({ row: member({ machineIds: ['gone', 'IN'] }) });

    await toggleMachine(user, 'lobby wall');
    expect(saveButton()).toBeDisabled();
    await user.click(saveButton());

    expect(updateMember).not.toHaveBeenCalled();
  });

  it('says a swoop session on a machine taken away ends, only when one is taken away', async () => {
    const { user } = renderDialog({ row: member({ machineIds: ['IN'] }) });

    await toggleMachine(user, 'kiosk');
    expect(screen.getByText(SITE_ONLY)).toBeInTheDocument();

    await toggleMachine(user, 'lobby wall');
    expect(screen.getByText(MACHINE_ENDS)).toBeInTheDocument();

    await user.click(within(access()).getByRole('button', { name: 'whole site' }));
    expect(screen.getByText(SITE_ONLY)).toBeInTheDocument();
  });

  it('says a swoop session ends when the whole site becomes some machines', async () => {
    const { user } = renderDialog();

    await limitTo(user, 'lobby wall');

    expect(screen.getByText(MACHINE_ENDS)).toBeInTheDocument();
  });

  it.each<[number, string]>([
    [1, 'they wrote 1 talon, which stops at its next run once their access is limited. reassign it to keep it.'],
    [3, 'they wrote 3 talons, which stop at their next run once their access is limited. reassign them to keep them.'],
  ])('warns with the count when %i talon(s) they wrote stop once the whole site becomes some machines', async (count, warning) => {
    fetchSiteAuthored.mockResolvedValue({ count, talons: [] });
    const { user } = renderDialog();

    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    await user.click(within(access()).getByRole('button', { name: 'some machines' }));

    expect(await screen.findByText(warning)).toBeInTheDocument();
    expect(fetchSiteAuthored).toHaveBeenCalledWith('elm-gate', 'u-kim');

    await user.click(within(access()).getByRole('button', { name: 'whole site' }));
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    await user.click(within(access()).getByRole('button', { name: 'some machines' }));
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(fetchSiteAuthored).toHaveBeenCalledTimes(1);
  });

  it('warns about nothing when they wrote no talons', async () => {
    const { user } = renderDialog();

    await user.click(within(access()).getByRole('button', { name: 'some machines' }));
    await act(async () => {});

    expect(fetchSiteAuthored).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/they wrote/)).not.toBeInTheDocument();
  });

  it('looks up no talons for someone already limited, whose talons have stopped', async () => {
    const { user } = renderDialog({ row: member({ machineIds: ['IN', 'IN2'] }) });

    await toggleMachine(user, 'kiosk');

    expect(fetchSiteAuthored).not.toHaveBeenCalled();
  });
});

describe('memberLabel', () => {
  it('is the email, else the name, else this member', () => {
    expect(memberLabel({ email: 'kim@example.com', displayName: 'kim ortiz' })).toBe('kim@example.com');
    expect(memberLabel({ email: null, displayName: 'kim ortiz' })).toBe('kim ortiz');
    expect(memberLabel({ email: null, displayName: null })).toBe('this member');
  });
});
