/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ChangeAccessDialog, the members section's "change access...", with the real
 * role and swoop fields. it seeds from the site role (never the account's) and
 * the row's swoop mode, sends only what changed (by role as null), says which
 * swoop sessions the change ends, and stays open when the save fails.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeAccessDialog, memberLabel } from '@/components/admin/sites/ChangeAccessDialog';
import {
  SiteMemberApiError,
  type SiteMember,
  type UpdateSiteMemberInput,
  type UpdateSiteMemberResult,
} from '@/hooks/useSiteMembers';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

// radix select drives pointers with pointer capture and scrolls its items into
// view; jsdom has neither.
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

type User = ReturnType<typeof userEvent.setup>;
type UpdateMember = jest.Mock<Promise<UpdateSiteMemberResult>, [string, UpdateSiteMemberInput]>;

const SITE_ONLY = 'this changes their access to this site only.';
const CONTROL_ENDS = `${SITE_ONLY} any swoop session they control here ends; watching carries on.`;
const SESSIONS_END = `${SITE_ONLY} any swoop session they are in here ends.`;

function member(overrides: Partial<SiteMember> = {}): SiteMember {
  return {
    uid: 'u-kim',
    email: 'kim@example.com',
    displayName: 'kim ortiz',
    role: 'member',
    globalRole: 'user',
    swoop: null,
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
      member={row}
      membersMayWatch={membersMayWatch}
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

describe('ChangeAccessDialog', () => {
  it('names the person, and says the change is for this site only', () => {
    renderDialog();

    expect(dialog()).toHaveAccessibleDescription("choose kim@example.com's role and swoop on this site.");
    expect(screen.getByText(SITE_ONLY)).toBeInTheDocument();
    expect(roleSelect()).toHaveAttribute('id', 'change-access-role');
    expect(swoopSelect()).toHaveAttribute('id', 'change-access-swoop');
    expect(document.body).not.toHaveTextContent(/account-level|changes the account/i);
  });

  it.each<[string, Partial<SiteMember>, string]>([
    ['their email', {}, "choose kim@example.com's role and swoop on this site."],
    ['their name with no email', { email: null }, "choose kim ortiz's role and swoop on this site."],
    ['this member with neither', { email: null, displayName: null }, "choose this member's role and swoop on this site."],
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
      description: 'kim@example.com is now an admin on this site. swoop: control (by role).',
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
      description: 'kim@example.com is now an admin on this site. swoop: watch.',
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
      description: 'kim@example.com is now a member on this site. swoop: watch (by role).',
    });
  });

  it("says by role gives a member no swoop on a site whose members don't watch", async () => {
    const row = member({ swoop: 'view' });
    const { user, updateMember } = renderDialog({ row, membersMayWatch: false });

    await choose(user, 'swoop', 'by role');
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { swoop: null }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now a member on this site. swoop: no swoop (by role).',
    });
  });

  it('no swoop sends swoop none, and says every swoop session they are in ends', async () => {
    const { user, updateMember } = renderDialog();

    await choose(user, 'swoop', 'no swoop');
    expect(screen.getByText(SESSIONS_END)).toBeInTheDocument();
    await user.click(saveButton());

    expect(sent(updateMember)).toStrictEqual([['u-kim', { swoop: 'none' }]]);
    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now a member on this site. swoop: no swoop.',
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
      description: 'kim@example.com is now an admin on this site. swoop: watch.',
    });
  });

  it('toasts the row as the server wrote it, which a stale seed may not match', async () => {
    // the list showed a member, but someone made them admin meanwhile: a swoop sent alone keeps that role
    const updateMember = mockUpdate((uid) => Promise.resolve({ siteId: 'elm-gate', uid, role: 'admin', swoop: 'view' }));
    const { user } = renderDialog({ updateMember });

    await choose(user, 'swoop', 'watch');
    await user.click(saveButton());

    expect(toast.success).toHaveBeenCalledWith('access updated', {
      description: 'kim@example.com is now an admin on this site. swoop: watch.',
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

    await act(async () => finish({ siteId: 'elm-gate', uid: 'u-kim', role: 'admin', swoop: null }));

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

describe('memberLabel', () => {
  it('is the email, else the name, else this member', () => {
    expect(memberLabel({ email: 'kim@example.com', displayName: 'kim ortiz' })).toBe('kim@example.com');
    expect(memberLabel({ email: null, displayName: 'kim ortiz' })).toBe('kim ortiz');
    expect(memberLabel({ email: null, displayName: null })).toBe('this member');
  });
});
