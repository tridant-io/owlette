/**
 * @jest-environment jsdom
 *
 * An approval's answer that fails in `useOwletteChat`. The click marks the card
 * answered at once; when the request that carries the answer fails, no turn
 * runs the call, and the card read "executing..." until the page was reloaded.
 * The hook goes back to the chat's saved history instead, where the approval is
 * still waiting.
 */

import { renderHook, waitFor } from '@testing-library/react';
import type { HootTarget } from '@/lib/hoot/target';

/** What useChat reports. */
let mockStatus = 'ready';
let mockError: Error | undefined;
let mockMessages: unknown[] = [];
const mockSetMessages = jest.fn();
const mockRegenerate = jest.fn(async () => undefined);

const approval = (state: string, approved?: boolean) => ({
  id: 'a1',
  role: 'assistant',
  parts: [
    {
      type: 'tool-reboot_machine',
      toolCallId: 'call_1',
      state,
      approval: approved === undefined ? { id: 'approval_1' } : { id: 'approval_1', approved },
      input: {},
    },
  ],
});
const USER = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'reboot it' }] };
/** The chat as the server last saved it: the approval still waiting. */
const SAVED = [USER, approval('approval-requested')];
/** The chat in the browser after the click. */
const ANSWERED = [USER, approval('approval-responded', true)];

jest.mock('@/lib/firebase', () => ({ db: {}, storage: null }));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  getDoc: jest.fn(async (ref: { __path?: string }) =>
    /^chats\/[^/]+$/.test(ref?.__path ?? '')
      ? { exists: () => true, data: () => ({ messages: SAVED }) }
      : { exists: () => false, data: () => undefined },
  ),
  getDocs: jest.fn(async () => ({ docs: [] })),
  setDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  startAfter: jest.fn(),
  onSnapshot: jest.fn(() => jest.fn()),
}));

jest.mock('ai', () => ({
  DefaultChatTransport: class {},
  lastAssistantMessageIsCompleteWithApprovalResponses: jest.fn(),
}));

jest.mock('@ai-sdk/react', () => ({
  useChat: jest.fn(() => ({
    messages: mockMessages,
    status: mockStatus,
    error: mockError,
    setMessages: mockSetMessages,
    regenerate: mockRegenerate,
    stop: jest.fn(async () => undefined),
    addToolApprovalResponse: jest.fn(),
  })),
}));

const mockUser = { uid: 'user-1' };
jest.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

const mockToastError = jest.fn();
jest.mock('@/lib/toast', () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }));

import { useOwletteChat } from '@/hooks/useHoot';

const ALL_MACHINES: HootTarget = { machineIds: null };

function mountHook() {
  return renderHook(() => useOwletteChat({ siteId: 'site-A', selection: ALL_MACHINES, includeAutonomous: true }));
}

const failure = (body: Record<string, unknown>) => new Error(JSON.stringify(body));

beforeEach(() => {
  jest.clearAllMocks();
  mockStatus = 'error';
  mockError = undefined;
  mockMessages = [];
  global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as unknown as typeof fetch;
});

describe('useOwletteChat, when the answer to an approval fails', () => {
  it.each([
    ['hoot was switched off in the meantime', failure({ error: 'hoot is switched off on this machine', code: 'hoot_disabled' })],
    ['the server fell over', failure({ error: 'internal error' })],
    ['the request never arrived', new TypeError('Failed to fetch')],
  ])('goes back to the saved history, where the approval still waits: %s', async (_label, error) => {
    mockMessages = ANSWERED;
    mockError = error;

    mountHook();

    await waitFor(() => expect(mockSetMessages).toHaveBeenCalledWith(SAVED));
    expect(mockRegenerate).not.toHaveBeenCalled();
  });

  it('reloads for an approval the server calls stale, and says why', async () => {
    mockMessages = ANSWERED;
    mockError = failure({ error: 'that approval expired', code: 'approval_stale' });

    mountHook();

    await waitFor(() => expect(mockSetMessages).toHaveBeenCalledWith(SAVED));
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/that approval expired/));
  });

  it('leaves the chat as it is when an ordinary send fails', async () => {
    mockMessages = [USER];
    mockError = failure({ error: 'internal error' });

    mountHook();
    await Promise.resolve();

    expect(mockSetMessages).not.toHaveBeenCalled();
  });

  it('still retries a send that lost the turn lock, and reloads nothing', async () => {
    mockMessages = [USER];
    mockError = failure({ error: 'a turn is already running', code: 'turn_active' });

    mountHook();

    await waitFor(() => expect(mockRegenerate).toHaveBeenCalled());
    expect(mockSetMessages).not.toHaveBeenCalled();
  });
});
