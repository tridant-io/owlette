/**
 * @jest-environment jsdom
 *
 * `stopRequested` in `useOwletteChat`: stop is pressed long before the stream
 * doc says the turn ended (the runner hears the cancel, then writes it), and the
 * thread line goes solid on the press, not on the doc. It has to clear again on
 * its own: when the doc reports the end, and when the next request goes out.
 */

import { renderHook, act } from '@testing-library/react';
import type { HootTarget } from '@/lib/hoot/target';

type Snapshot = { exists: () => boolean; data: () => Record<string, unknown> | undefined };

/** The `chats/{id}/stream/current` listener, captured when the hook subscribes. */
let mockStreamListener: ((snap: Snapshot) => void) | null = null;
/** What useChat reports; a new request moves it to 'submitted'. */
let mockStatus = 'ready';

jest.mock('@/lib/firebase', () => ({ db: {}, storage: null }));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  getDoc: jest.fn(async () => ({ exists: () => false, data: () => undefined })),
  getDocs: jest.fn(async () => ({ docs: [] })),
  setDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  startAfter: jest.fn(),
  onSnapshot: jest.fn((ref: { __path?: string } | undefined, next: (snap: Snapshot) => void) => {
    if (ref?.__path?.endsWith('/stream/current')) mockStreamListener = next;
    return jest.fn();
  }),
}));

jest.mock('ai', () => ({
  DefaultChatTransport: class {},
  lastAssistantMessageIsCompleteWithApprovalResponses: jest.fn(),
}));

const mockSdkStop = jest.fn(async () => undefined);
jest.mock('@ai-sdk/react', () => ({
  useChat: jest.fn(() => ({
    messages: [],
    status: mockStatus,
    error: undefined,
    setMessages: jest.fn(),
    regenerate: jest.fn(),
    stop: mockSdkStop,
    addToolApprovalResponse: jest.fn(),
  })),
}));

const mockUser = { uid: 'user-1' };
jest.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

jest.mock('@/lib/toast', () => ({ toast: { error: jest.fn() } }));

import { useOwletteChat } from '@/hooks/useHoot';

const ALL_MACHINES: HootTarget = { machineIds: null };

function streamDoc(data: Record<string, unknown>) {
  act(() => {
    mockStreamListener?.({ exists: () => true, data: () => data });
  });
}

const running = () => streamDoc({ status: 'running', turnId: 'turn-1', updatedAt: { toMillis: () => Date.now() } });

function mountHook() {
  return renderHook(() => useOwletteChat({ siteId: 'site-A', selection: ALL_MACHINES }));
}

beforeEach(() => {
  mockStreamListener = null;
  mockStatus = 'ready';
  global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as unknown as typeof fetch;
});

describe('useOwletteChat stopRequested', () => {
  it('is set the moment stop is pressed, while the stream doc still says running', async () => {
    const { result } = mountHook();
    running();
    expect(result.current.turnRunning).toBe(true);
    expect(result.current.stopRequested).toBe(false);

    await act(async () => {
      await result.current.stop();
    });

    expect(mockSdkStop).toHaveBeenCalled();
    expect(result.current.turnRunning).toBe(true);
    expect(result.current.stopRequested).toBe(true);
  });

  it('clears once the stream doc reports the turn over', async () => {
    const { result } = mountHook();
    running();
    await act(async () => {
      await result.current.stop();
    });

    streamDoc({ status: 'cancelled', turnId: 'turn-1' });

    expect(result.current.turnRunning).toBe(false);
    expect(result.current.stopRequested).toBe(false);
  });

  it('clears when the next request goes out, so the next turn shows as running', async () => {
    const { result, rerender } = mountHook();
    running();
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.stopRequested).toBe(true);

    mockStatus = 'submitted';
    rerender();

    expect(result.current.stopRequested).toBe(false);
  });
});
