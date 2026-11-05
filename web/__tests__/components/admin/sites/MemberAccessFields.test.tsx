/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MemberAccessFields, the role and swoop fields the add and change access
 * dialogs share. each select is described by a help line that says what the
 * choice gives on this site, and "by role" stands for a row with no swoop field.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemberAccessFields,
  fromSwoopChoice,
  toSwoopChoice,
  type SwoopChoice,
} from '@/components/admin/sites/MemberAccessFields';
import type { AddableSiteMemberRole } from '@/hooks/useSiteMembers';

// radix select drives pointers with pointer capture and scrolls its items into
// view; jsdom has neither.
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const MEMBER_LINE = 'views machines, takes screenshots and opens live view. no commands and no configuration.';
const ADMIN_LINE =
  'runs the site: everything a member can, plus commands and configuration, swoop settings, deployments, roosts, talons, webhooks, alert rules, pairing machines and managing members.';

const MEMBER_WATCHES = 'by role: a member watches.';
const MEMBERS_DONT_WATCH = "by role: members don't watch on this site.";
const ADMIN_CONTROLS = 'by role: an admin watches and takes control.';
const NO_SWOOP = "can't open swoop on this site's machines.";
const WATCH = 'watches, and never takes control.';
const CONTROL = 'watches, and takes control after confirming a second factor.';

interface FieldsProps {
  idPrefix?: string;
  role?: AddableSiteMemberRole;
  swoop?: SwoopChoice;
  membersMayWatch?: boolean;
  disabled?: boolean;
}

function renderFields({
  idPrefix = 'add-member',
  role = 'member',
  swoop = 'default',
  membersMayWatch = true,
  disabled,
}: FieldsProps = {}) {
  const onRoleChange = jest.fn();
  const onSwoopChange = jest.fn();
  const user = userEvent.setup();
  render(
    <MemberAccessFields
      idPrefix={idPrefix}
      role={role}
      swoop={swoop}
      onRoleChange={onRoleChange}
      onSwoopChange={onSwoopChange}
      membersMayWatch={membersMayWatch}
      disabled={disabled}
    />,
  );
  return { user, onRoleChange, onSwoopChange };
}

const roleSelect = () => screen.getByRole('combobox', { name: 'role' });
const swoopSelect = () => screen.getByRole('combobox', { name: 'swoop' });
const optionNames = () => screen.getAllByRole('option').map((option) => option.textContent);

describe('swoop choices and the stored field', () => {
  it('reads a row with no mode as by role, and each mode as itself', () => {
    expect(toSwoopChoice(null)).toBe('default');
    expect(toSwoopChoice('none')).toBe('none');
    expect(toSwoopChoice('view')).toBe('view');
    expect(toSwoopChoice('control')).toBe('control');
  });

  it('writes by role as no mode, and each mode as itself', () => {
    expect(fromSwoopChoice('default')).toBeNull();
    expect(fromSwoopChoice('none')).toBe('none');
    expect(fromSwoopChoice('view')).toBe('view');
    expect(fromSwoopChoice('control')).toBe('control');
  });

  it.each<SwoopChoice>(['default', 'none', 'view', 'control'])('round-trips %s', (choice) => {
    expect(toSwoopChoice(fromSwoopChoice(choice))).toBe(choice);
  });
});

describe('MemberAccessFields help lines', () => {
  it.each<[AddableSiteMemberRole, SwoopChoice, boolean, string, string]>([
    ['member', 'default', true, MEMBER_LINE, MEMBER_WATCHES],
    ['member', 'default', false, MEMBER_LINE, MEMBERS_DONT_WATCH],
    ['member', 'none', true, MEMBER_LINE, NO_SWOOP],
    ['member', 'none', false, MEMBER_LINE, NO_SWOOP],
    ['member', 'view', true, MEMBER_LINE, WATCH],
    ['member', 'view', false, MEMBER_LINE, WATCH],
    ['member', 'control', true, MEMBER_LINE, CONTROL],
    ['member', 'control', false, MEMBER_LINE, CONTROL],
    ['admin', 'default', true, ADMIN_LINE, ADMIN_CONTROLS],
    ['admin', 'default', false, ADMIN_LINE, ADMIN_CONTROLS],
    ['admin', 'none', true, ADMIN_LINE, NO_SWOOP],
    ['admin', 'none', false, ADMIN_LINE, NO_SWOOP],
    ['admin', 'view', true, ADMIN_LINE, WATCH],
    ['admin', 'view', false, ADMIN_LINE, WATCH],
    ['admin', 'control', true, ADMIN_LINE, CONTROL],
    ['admin', 'control', false, ADMIN_LINE, CONTROL],
  ])('%s with swoop %s, members may watch %s', (role, swoop, membersMayWatch, roleLine, swoopLine) => {
    renderFields({ role, swoop, membersMayWatch });

    expect(roleSelect()).toHaveAccessibleDescription(roleLine);
    expect(swoopSelect()).toHaveAccessibleDescription(swoopLine);
  });
});

describe('MemberAccessFields selects', () => {
  it('labels each select and describes it by its own help line, under the given prefix', () => {
    renderFields({ idPrefix: 'change-access', role: 'admin', swoop: 'view' });

    expect(roleSelect()).toHaveAttribute('id', 'change-access-role');
    expect(roleSelect()).toHaveAttribute('aria-describedby', 'change-access-role-hint');
    expect(document.getElementById('change-access-role-hint')).toHaveTextContent(ADMIN_LINE);
    expect(roleSelect()).toHaveTextContent('admin');

    expect(swoopSelect()).toHaveAttribute('id', 'change-access-swoop');
    expect(swoopSelect()).toHaveAttribute('aria-describedby', 'change-access-swoop-hint');
    expect(document.getElementById('change-access-swoop-hint')).toHaveTextContent(WATCH);
    expect(swoopSelect()).toHaveTextContent('watch');
  });

  it('offers member and admin, and hands up the role chosen', async () => {
    const { user, onRoleChange } = renderFields();

    await user.click(roleSelect());
    expect(optionNames()).toEqual(['member', 'admin']);

    await user.click(screen.getByRole('option', { name: 'admin' }));
    expect(onRoleChange).toHaveBeenCalledWith('admin');
  });

  it('offers by role, no swoop, watch and control, and hands up the choice', async () => {
    const { user, onSwoopChange } = renderFields({ swoop: 'control' });

    await user.click(swoopSelect());
    expect(optionNames()).toEqual(['by role', 'no swoop', 'watch', 'control']);

    await user.click(screen.getByRole('option', { name: 'watch' }));
    expect(onSwoopChange).toHaveBeenLastCalledWith('view');

    await user.click(swoopSelect());
    await user.click(screen.getByRole('option', { name: 'by role' }));
    expect(onSwoopChange).toHaveBeenLastCalledWith('default');
  });

  it('disables both selects when disabled', () => {
    renderFields({ disabled: true });

    expect(roleSelect()).toBeDisabled();
    expect(swoopSelect()).toBeDisabled();
  });
});
