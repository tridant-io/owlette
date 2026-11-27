/**
 * a superadmin without a member row reads a site and changes only the allowlist
 * (adr 0021): `useMemberLock` says so, and the banner carries the one hint and
 * the link to add themselves.
 */
import { render, renderHook, screen } from '@testing-library/react';

let mockAuth: Record<string, unknown> = {};
let mockDemo: unknown = null;
jest.mock('@/contexts/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('@/contexts/DemoContext', () => ({ useDemoContext: () => mockDemo }));

import { useMemberLock } from '@/hooks/useMemberLock';
import { ADD_YOURSELF_PATH, MEMBER_LOCK_HINT, MemberLockBanner, MemberLockSection } from '@/components/MemberLock';

const viewer = (role: string, memberOf: string[], resolved = true) => ({
  role,
  userSites: resolved ? memberOf : undefined,
  isSiteMember: (siteId: string) => memberOf.includes(siteId),
});

beforeEach(() => {
  mockDemo = null;
});

describe('useMemberLock', () => {
  it.each([
    ['a superadmin without a row', viewer('superadmin', []), true],
    ['a superadmin with one', viewer('superadmin', ['site-a']), false],
    ['a member', viewer('member', ['site-a']), false],
    ['a superadmin whose access has not resolved', viewer('superadmin', [], false), false],
  ])('%s → %s', (_label, auth, locked) => {
    mockAuth = auth;
    expect(renderHook(() => useMemberLock('site-a')).result.current).toBe(locked);
  });

  it('never locks the demo, whose site takes no writes from anyone', () => {
    mockAuth = viewer('superadmin', []);
    mockDemo = { demo: true };
    expect(renderHook(() => useMemberLock('site-a')).result.current).toBe(false);
  });

  it('never locks without a site', () => {
    mockAuth = viewer('superadmin', []);
    expect(renderHook(() => useMemberLock('')).result.current).toBe(false);
  });
});

describe('the member lock', () => {
  it('shows the hint and the link to add yourself to a locked superadmin', () => {
    mockAuth = viewer('superadmin', []);
    render(<MemberLockBanner siteId="site-a" />);

    expect(screen.getByTestId('member-lock')).toHaveTextContent(MEMBER_LOCK_HINT);
    expect(screen.getByRole('link', { name: 'add yourself' })).toHaveAttribute('href', ADD_YOURSELF_PATH);
  });

  it('shows nothing to a member', () => {
    mockAuth = viewer('superadmin', ['site-a']);
    render(<MemberLockBanner siteId="site-a" />);

    expect(screen.queryByTestId('member-lock')).not.toBeInTheDocument();
  });

  it("disables a section's controls and keeps its links", () => {
    mockAuth = viewer('superadmin', []);
    render(
      <MemberLockSection siteId="site-a">
        <button type="button">save</button>
        <a href="/elsewhere">read more</a>
      </MemberLockSection>,
    );

    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'read more' })).toHaveAttribute('href', '/elsewhere');
  });

  it("leaves a member's section alone", () => {
    mockAuth = viewer('superadmin', ['site-a']);
    render(
      <MemberLockSection siteId="site-a">
        <button type="button">save</button>
      </MemberLockSection>,
    );

    expect(screen.getByRole('button', { name: 'save' })).toBeEnabled();
    expect(screen.queryByTestId('member-lock')).not.toBeInTheDocument();
  });
});
