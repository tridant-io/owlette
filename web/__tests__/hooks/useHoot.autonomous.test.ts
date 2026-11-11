/**
 * @jest-environment jsdom
 *
 * `includeAutonomous` in `useOwletteChat`. Autonomous hoot chats are whole-site
 * (rules 2.12.0), so a scoped member's read of them is refused: with the option
 * off the sidebar lists only the person's own chats, finishes loading on that
 * one query, and "load more" never pages the autonomous list.
 */

import { renderHook, act } from '@testing-library/react';
import type { HootTarget } from '@/lib/hoot/target';

type Constraint = { where?: [string, string, unknown] };
type Query = { ref: { path?: string }; constraints: Constraint[] };
type FakeDoc = { id: string; data: () => Record<string, unknown> };
type Listener = { query: Query; next: (snap: { docs: FakeDoc[] }) => void };

/** Every `onSnapshot` on a query of the `chats` collection, in subscribe order. */
let mockChatListeners: Listener[] = [];

jest.mock('@/lib/firebase', () => ({ db: {}, storage: null }));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn((_db: unknown, path: string) => ({ path })),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => undefined })),
  getDocs: jest.fn(async () => ({ docs: [] })),
  setDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn((ref: unknown, ...constraints: unknown[]) => ({ ref, constraints })),
  where: jest.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
  orderBy: jest.fn(() => ({})),
  limit: jest.fn(() => ({})),
  startAfter: jest.fn(() => ({})),
  onSnapshot: jest.fn((ref: Query | undefined, next: Listener['next']) => {
    if (ref?.ref?.path === 'chats') mockChatListeners.push({ query: ref, next });
    return jest.fn();
  }),
}));

jest.mock('ai', () => ({
  DefaultChatTransport: class {},
  lastAssistantMessageIsCompleteWithApprovalResponses: jest.fn(),
}));

jest.mock('@ai-sdk/react', () => ({
  useChat: jest.fn(() => ({
    messages: [],
    status: 'ready',
    error: undefined,
    setMessages: jest.fn(),
    regenerate: jest.fn(),
    stop: jest.fn(),
    addToolApprovalResponse: jest.fn(),
  })),
}));

const mockUser = { uid: 'user-1' };
jest.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

jest.mock('@/lib/toast', () => ({ toast: { error: jest.fn() } }));

import { getDocs } from 'firebase/firestore';
import { useOwletteChat } from '@/hooks/useHoot';

const mockGetDocs = getDocs as unknown as jest.Mock;

const SITE_ID = 'site-A';
const ALL_MACHINES: HootTarget = { machineIds: null };
// useHoot's PAGE_SIZE: a full page means there may be more
const PAGE_SIZE = 40;

function isAutonomous(q: Query): boolean {
  return q.constraints.some((c) => c.where?.[0] === 'source' && c.where[2] === 'autonomous');
}

function isUsers(q: Query): boolean {
  return q.constraints.some((c) => c.where?.[0] === 'userId' && c.where[2] === mockUser.uid);
}

function chats(prefix: string, count: number, source: 'user' | 'autonomous'): FakeDoc[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    data: () => ({ siteId: SITE_ID, title: `${prefix} ${i}`, source }),
  }));
}

/** Fires the latest listener of the given kind with these docs. */
function fire(kind: 'user' | 'autonomous', docs: FakeDoc[]) {
  const match = kind === 'user' ? isUsers : isAutonomous;
  const listener = [...mockChatListeners].reverse().find((l) => match(l.query));
  if (!listener) throw new Error(`no ${kind} listener`);
  act(() => listener.next({ docs }));
}

function mountHook(includeAutonomous: boolean) {
  return renderHook(
    (props: { includeAutonomous: boolean }) =>
      useOwletteChat({
        siteId: SITE_ID,
        selection: ALL_MACHINES,
        siteMachineIds: [],
        includeAutonomous: props.includeAutonomous,
      }),
    { initialProps: { includeAutonomous } },
  );
}

beforeEach(() => {
  mockChatListeners = [];
});

describe('useOwletteChat includeAutonomous', () => {
  it('with false, runs only the user query and finishes loading on it', () => {
    const { result } = mountHook(false);

    expect(mockChatListeners).toHaveLength(1);
    expect(isUsers(mockChatListeners[0].query)).toBe(true);
    expect(mockChatListeners.some((l) => isAutonomous(l.query))).toBe(false);

    fire('user', chats('mine', 1, 'user'));

    expect(result.current.loadingConversations).toBe(false);
    expect(result.current.conversations.map((c) => c.id)).toEqual(['mine-0']);
  });

  it('with true, runs both queries and waits for both, as today', () => {
    const { result } = mountHook(true);

    expect(mockChatListeners).toHaveLength(2);
    expect(mockChatListeners.filter((l) => isUsers(l.query))).toHaveLength(1);
    expect(mockChatListeners.filter((l) => isAutonomous(l.query))).toHaveLength(1);

    fire('user', chats('mine', 1, 'user'));
    expect(result.current.loadingConversations).toBe(true);

    fire('autonomous', chats('auto', 1, 'autonomous'));
    expect(result.current.loadingConversations).toBe(false);
    expect(result.current.conversations.map((c) => c.id).sort()).toEqual(['auto-0', 'mine-0']);
  });

  it('with false, loadMore pages only the user chats', async () => {
    const { result } = mountHook(false);
    fire('user', chats('mine', PAGE_SIZE, 'user'));

    await act(async () => {
      await result.current.loadMoreConversations();
    });

    expect(mockGetDocs).toHaveBeenCalledTimes(1);
    expect(isUsers(mockGetDocs.mock.calls[0][0])).toBe(true);
  });

  it('with true, loadMore pages both lists, as today', async () => {
    const { result } = mountHook(true);
    fire('user', chats('mine', PAGE_SIZE, 'user'));
    fire('autonomous', chats('auto', PAGE_SIZE, 'autonomous'));

    await act(async () => {
      await result.current.loadMoreConversations();
    });

    const paged = mockGetDocs.mock.calls.map(([q]) => q as Query);
    expect(paged).toHaveLength(2);
    expect(paged.some(isUsers)).toBe(true);
    expect(paged.some(isAutonomous)).toBe(true);
  });

  it('drops an autonomous page left over from before the switch to false', async () => {
    const { result, rerender } = mountHook(true);
    fire('user', chats('mine', 1, 'user'));
    fire('autonomous', chats('auto', PAGE_SIZE, 'autonomous'));
    expect(result.current.hasMoreConversations).toBe(true);

    rerender({ includeAutonomous: false });

    expect(result.current.hasMoreConversations).toBe(false);
    await act(async () => {
      await result.current.loadMoreConversations();
    });
    expect(mockGetDocs).not.toHaveBeenCalled();
  });
});
