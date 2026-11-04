/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * AddMemberDialog, the members section's add dialog, with the real search: a
 * pick adds by uid and a typed full email adds by email, with the role and an
 * optional swoop mode. an untouched dialog writes no swoop field, the toast
 * says when the person was already on the site, a 404 keeps the dialog open,
 * and the copy never calls either role account-level.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddMemberDialog } from '@/components/admin/sites/AddMemberDialog';
import {
  SiteMemberApiError,
  useMemberCandidates,
  type AddSiteMemberInput,
  type AddSiteMemberResult,
} from '@/hooks/useSiteMembers';
import type { MemberCandidate } from '@/lib/memberCandidates';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/hooks/useSiteMembers', () => ({
  ...jest.requireActual('@/hooks/useSiteMembers'),
  useMemberCandidates: jest.fn(),
}));

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
type AddMember = jest.Mock<Promise<AddSiteMemberResult>, [AddSiteMemberInput]>;

const CANDIDATES: MemberCandidate[] = [
  { uid: 'u-rae', email: 'rae@example.com', displayName: 'rae calloway' },
  { uid: 'u-kim', email: 'kim@example.com', displayName: 'kim ortiz' },
];

function added(overrides: Partial<AddSiteMemberResult> = {}): AddSiteMemberResult {
  return {
    uid: 'u-rae',
    siteId: 'elm-gate',
    requestedRole: 'member',
    roleHonored: true,
    globalRole: 'user',
    ...overrides,
  };
}

const mockAdd = (impl: () => Promise<AddSiteMemberResult>): AddMember =>
  jest.fn<Promise<AddSiteMemberResult>, [AddSiteMemberInput]>(impl);

function renderDialog({
  addMember = mockAdd(() => Promise.resolve(added())),
  membersMayWatch = true,
}: { addMember?: AddMember; membersMayWatch?: boolean } = {}) {
  jest.mocked(useMemberCandidates).mockReturnValue({ candidates: CANDIDATES, loading: false, error: null });
  const onOpenChange = jest.fn();
  const user = userEvent.setup();
  render(
    <AddMemberDialog
      siteId="elm-gate"
      membersMayWatch={membersMayWatch}
      onOpenChange={onOpenChange}
      addMember={addMember}
    />,
  );
  return { user, addMember, onOpenChange };
}

const search = () => screen.getByRole('textbox', { name: 'name or email' });
const addButton = () => screen.getByRole('button', { name: 'add member' });
const sent = (addMember: AddMember) => addMember.mock.calls.map(([input]) => input);

async function pickRae(user: User) {
  await user.type(search(), 'rae');
  await user.click(screen.getByRole('option', { name: /rae calloway/ }));
}

async function choose(user: User, field: 'role' | 'swoop', option: string) {
  await user.click(screen.getByRole('combobox', { name: field }));
  await user.click(screen.getByRole('option', { name: option }));
}

describe('AddMemberDialog', () => {
  it('names itself, fetches the people it may offer for this site, and starts as a member by role', () => {
    renderDialog({ membersMayWatch: false });

    expect(useMemberCandidates).toHaveBeenCalledWith('elm-gate');
    const dialog = screen.getByRole('dialog', { name: 'add member' });
    expect(dialog).toHaveAccessibleDescription('give someone with an owlette account access to this site.');
    expect(search()).toHaveAccessibleDescription(
      'pick someone from your other sites, or type the full email they signed up with.',
    );
    expect(screen.getByRole('combobox', { name: 'role' })).toHaveAttribute('id', 'add-member-role');
    expect(screen.getByRole('combobox', { name: 'role' })).toHaveTextContent('member');
    expect(screen.getByRole('combobox', { name: 'swoop' })).toHaveAttribute('id', 'add-member-swoop');
    expect(screen.getByRole('combobox', { name: 'swoop' })).toHaveTextContent('by role');
    expect(screen.getByRole('combobox', { name: 'swoop' })).toHaveAccessibleDescription(
      "by role: members don't watch on this site.",
    );
  });

  it('adds a picked person by uid as a member with no swoop field, toasts member added and closes', async () => {
    const { user, addMember, onOpenChange } = renderDialog();

    await pickRae(user);
    await user.click(addButton());

    expect(sent(addMember)).toStrictEqual([{ uid: 'u-rae', role: 'member' }]);
    expect(toast.success).toHaveBeenCalledWith('member added', {
      description: 'rae@example.com now has member access to this site.',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('adds a typed full email by email, and enter in the search submits it', async () => {
    const { user, addMember, onOpenChange } = renderDialog();

    await user.type(search(), 'new.person@example.org');
    await user.keyboard('{Enter}');

    expect(sent(addMember)).toStrictEqual([{ email: 'new.person@example.org', role: 'member' }]);
    expect(toast.success).toHaveBeenCalledWith('member added', {
      description: 'new.person@example.org now has member access to this site.',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends a swoop mode only when one is chosen', async () => {
    const { user, addMember } = renderDialog();

    await pickRae(user);
    await choose(user, 'swoop', 'control');
    expect(screen.getByRole('combobox', { name: 'swoop' })).toHaveAccessibleDescription(
      'watches, and takes control after confirming a second factor.',
    );
    await user.click(addButton());

    expect(sent(addMember)).toStrictEqual([{ uid: 'u-rae', role: 'member', swoop: 'control' }]);
  });

  it('sends no swoop field once the choice is back on by role', async () => {
    const { user, addMember } = renderDialog();

    await pickRae(user);
    await choose(user, 'swoop', 'no swoop');
    await choose(user, 'swoop', 'by role');
    await user.click(addButton());

    expect(sent(addMember)).toStrictEqual([{ uid: 'u-rae', role: 'member' }]);
  });

  it('adds an admin when admin is chosen, and the toast says admin access', async () => {
    const addMember = mockAdd(() => Promise.resolve(added({ requestedRole: 'admin' })));
    const { user } = renderDialog({ addMember });

    await pickRae(user);
    await choose(user, 'role', 'admin');
    expect(screen.getByRole('combobox', { name: 'swoop' })).toHaveAccessibleDescription(
      'by role: an admin watches and takes control.',
    );
    await user.click(addButton());

    expect(sent(addMember)).toStrictEqual([{ uid: 'u-rae', role: 'admin' }]);
    expect(toast.success).toHaveBeenCalledWith('member added', {
      description: 'rae@example.com now has admin access to this site.',
    });
  });

  it('says someone was already on the site when the server honoured nothing, and closes', async () => {
    const addMember = mockAdd(() => Promise.resolve(added({ roleHonored: false })));
    const { user, onOpenChange } = renderDialog({ addMember });

    await pickRae(user);
    await user.click(addButton());

    expect(toast.info).toHaveBeenCalledWith('already on this site', {
      description: 'rae@example.com was already a member, so nothing changed. change their access from their row.',
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says no account was found on a 404, and keeps the dialog open to fix the email', async () => {
    const addMember = mockAdd(() =>
      Promise.reject(new SiteMemberApiError(404, 'user new.person@example.org not found')),
    );
    const { user, onOpenChange } = renderDialog({ addMember });

    await user.type(search(), 'new.person@example.org');
    await user.click(addButton());

    expect(toast.error).toHaveBeenCalledWith('no account found for that email', {
      description: 'they need an owlette account before they can be added to a site.',
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'add member' })).toBeInTheDocument();
    expect(search()).toHaveValue('new.person@example.org');
    expect(addButton()).toBeEnabled();
  });

  it('toasts any other failure with the server detail, and keeps the dialog open', async () => {
    const addMember = mockAdd(() =>
      Promise.reject(
        new SiteMemberApiError(
          403,
          'adding a member requires the SITE_MEMBER_MANAGE capability on this site',
          'site_member_manage_required',
        ),
      ),
    );
    const { user, onOpenChange } = renderDialog({ addMember });

    await pickRae(user);
    await user.click(addButton());

    expect(toast.error).toHaveBeenCalledWith('could not add member', {
      description: 'adding a member requires the SITE_MEMBER_MANAGE capability on this site',
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(addButton()).toBeEnabled();
  });

  it('keeps add disabled until there is someone to add, and enter adds no one before that', async () => {
    const { user, addMember } = renderDialog();

    expect(addButton()).toBeDisabled();

    // part of a name matches people but picks no one
    await user.type(search(), 'ra');
    expect(addButton()).toBeDisabled();

    await user.clear(search());
    await user.type(search(), 'zed');
    await user.keyboard('{Enter}');
    expect(addButton()).toBeDisabled();
    expect(addMember).not.toHaveBeenCalled();

    await user.type(search(), '@example.com');
    expect(addButton()).toBeEnabled();

    await user.clear(search());
    expect(addButton()).toBeDisabled();
  });

  it('holds add, cancel and the fields while the add runs', async () => {
    let finish!: (result: AddSiteMemberResult) => void;
    const addMember = mockAdd(
      () =>
        new Promise<AddSiteMemberResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { user, onOpenChange } = renderDialog({ addMember });

    await pickRae(user);
    await user.click(addButton());

    expect(screen.getByRole('button', { name: 'adding…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled();
    expect(search()).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'role' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'swoop' })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => finish(added()));

    expect(addMember).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancel closes without adding', async () => {
    const { user, addMember, onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(addMember).not.toHaveBeenCalled();
  });

  it('never says admin is account-level, for either role', async () => {
    const { user } = renderDialog();

    expect(document.body).not.toHaveTextContent(/account-level/i);

    await choose(user, 'role', 'admin');

    expect(screen.getByRole('combobox', { name: 'role' })).toHaveTextContent('admin');
    expect(document.body).not.toHaveTextContent(/account-level/i);
  });
});
