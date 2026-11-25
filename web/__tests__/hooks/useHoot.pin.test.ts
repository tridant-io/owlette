/**
 * @jest-environment jsdom
 *
 * The per-chat target pin in `useOwletteChat` — the value a send is actually
 * addressed with (`lib/hoot/requestBody.ts` covers the body it builds from it).
 *
 * The pin is written when a chat is STARTED or LOADED, and moved afterwards only
 * by a user gesture (`retargetActiveChat`). Nothing keyed on React state identity
 * may move it: `siteMachineIds` is a fresh array on every machine heartbeat and
 * the header's selection is a fresh object on every render, so an effect that
 * re-aimed the pin from them would quietly replace a loaded chat's stored target
 * — or its fail-closed `'invalid'` one — with whatever the header showed, a
 * second or two after the load.
 *
 * The vocabulary half moves the other way: the machines listing lands AFTER the
 * pin on a deep link, so `siteMachineIds` is refreshed in place.
 */

import { renderHook, act } from '@testing-library/react';
import { InvalidChatTargetError } from '@/lib/hoot/requestBody';
import type { HootTarget } from '@/lib/hoot/target';

type PrepareSend = (args: { id?: string; messages: unknown }) => {
  body: Record<string, unknown>;
};

/** The transport closure under test, captured when the hook builds it. */
let mockPrepareSend: PrepareSend | null = null;
/** Data the next `getDoc` on a chat document returns; null = missing. */
let mockChatDoc: Record<string, unknown> | null = null;

// Override jest.setup.js's `{ db: null }` — loadChat early-returns on a null db.
jest.mock('@/lib/firebase', () => ({ db: {}, storage: null }));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  getDoc: jest.fn(async () => ({
    exists: () => mockChatDoc !== null,
    data: () => mockChatDoc ?? undefined,
  })),
  getDocs: jest.fn(),
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
  DefaultChatTransport: class {
    constructor(options: { prepareSendMessagesRequest: PrepareSend }) {
      mockPrepareSend = options.prepareSendMessagesRequest;
    }
  },
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

// No signed-in user: the history, turn-stream and follow-up subscriptions all
// early-return, leaving the pin and the transport as the only moving parts.
jest.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

jest.mock('@/lib/toast', () => ({ toast: { error: jest.fn() } }));

import { useOwletteChat } from '@/hooks/useHoot';

const SITE_ID = 'site-A';
const ALL_MACHINES: HootTarget = { machineIds: null };

const messages = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'status?' }] }];

function mention(text: string) {
  return [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }];
}

/**
 * Mount the hook with the header at "all machines" — the default the picker
 * sits at, and the value that used to overwrite a loaded chat's target.
 */
function mountHook(siteMachineIds: string[] = ['kiosk-01', 'kiosk-02']) {
  return renderHook(
    (props: { selection: HootTarget; siteMachineIds: string[] }) =>
      useOwletteChat({ siteId: SITE_ID, includeAutonomous: true, ...props }),
    { initialProps: { selection: ALL_MACHINES, siteMachineIds } },
  );
}

/** A machines snapshot: same ids, brand-new array, plus a re-rendered selection. */
function heartbeat(
  rerender: (props: { selection: HootTarget; siteMachineIds: string[] }) => void,
  siteMachineIds: string[],
) {
  rerender({ selection: { machineIds: null }, siteMachineIds: [...siteMachineIds] });
}

function send(chatId: string, sent: unknown = messages) {
  if (!mockPrepareSend) throw new Error('transport was never built');
  return mockPrepareSend({ id: chatId, messages: sent });
}

beforeEach(() => {
  mockPrepareSend = null;
  mockChatDoc = null;
});

describe('useOwletteChat target pin', () => {
  it('keeps a loaded chat aimed at its stored machine through a machines refresh', async () => {
    // Legacy single-machine chat, opened while the header sits at "all machines".
    mockChatDoc = { siteId: SITE_ID, targetType: 'machine', targetMachineId: 'kiosk-02' };
    const { result, rerender } = mountHook();

    await act(async () => {
      await result.current.loadChat('chat_loaded');
    });
    // The machines listener's first snapshot, then an agent heartbeat.
    heartbeat(rerender, ['kiosk-01', 'kiosk-02']);
    heartbeat(rerender, ['kiosk-01', 'kiosk-02']);

    const { body } = send('chat_loaded');
    expect(body.target).toEqual({ machineIds: ['kiosk-02'], mentions: [] });
    // The narrowing legacy field for a deploy-skewed instance, never '__site__'.
    expect(body.machineId).toBe('kiosk-02');
    expect(body.siteId).toBe(SITE_ID);
  });

  it('keeps refusing to build a body for a chat whose target was unreadable', async () => {
    // No target fields at all — `readChatTarget` fails closed, and no amount of
    // effect churn may turn that into a send addressed to the whole site.
    mockChatDoc = { siteId: SITE_ID };
    const { result, rerender } = mountHook();

    await act(async () => {
      await result.current.loadChat('chat_broken');
    });
    heartbeat(rerender, ['kiosk-01', 'kiosk-02']);

    expect(() => send('chat_broken')).toThrow(InvalidChatTargetError);
  });

  it('refreshes the mention vocabulary when the machines listing lands late', async () => {
    // A deep link loads the chat before the header's site resolves, so the pin
    // is written with no listing yet.
    mockChatDoc = { siteId: SITE_ID, targetMachineIds: null };
    const { result, rerender } = mountHook([]);

    await act(async () => {
      await result.current.loadChat('chat_deep_link');
    });
    expect(send('chat_deep_link', mention('is @kiosk-02 up?')).body.target).toEqual({
      machineIds: null,
      mentions: [],
    });

    heartbeat(rerender, ['kiosk-01', 'kiosk-02']);

    const { body } = send('chat_deep_link', mention('is @kiosk-02 up?'));
    expect(body.target).toEqual({ machineIds: null, mentions: ['kiosk-02'] });
  });

  it('re-aims the open chat on a gesture, in place', async () => {
    mockChatDoc = { siteId: SITE_ID, targetMachineIds: ['kiosk-02'] };
    const { result } = mountHook();

    await act(async () => {
      await result.current.loadChat('chat_loaded');
    });
    act(() => {
      result.current.retargetActiveChat({ machineIds: ['kiosk-01', 'kiosk-02'] });
    });

    // Same conversation — ticking a machine never starts one.
    expect(result.current.chatId).toBe('chat_loaded');
    const { body } = send('chat_loaded');
    expect(body.target).toEqual({ machineIds: ['kiosk-01', 'kiosk-02'], mentions: [] });
    expect(body.machineId).toBe('kiosk-01');
  });

  it('leaves a chat pinned to another site alone (OWL-48)', async () => {
    mockChatDoc = { siteId: 'site-B', targetType: 'machine', targetMachineId: 'other-1' };
    const { result, rerender } = mountHook();

    await act(async () => {
      await result.current.loadChat('chat_elsewhere');
    });
    act(() => {
      result.current.retargetActiveChat({ machineIds: ['kiosk-01'] });
    });
    heartbeat(rerender, ['kiosk-01', 'kiosk-02']);

    const { body } = send('chat_elsewhere');
    expect(body.siteId).toBe('site-B');
    expect(body.target).toEqual({ machineIds: ['other-1'], mentions: [] });
  });

  it('pins a new chat at the header selection, and holds it', () => {
    const { result, rerender } = mountHook();

    act(() => {
      result.current.startNewChat({ selection: { machineIds: ['kiosk-01'] } });
    });
    const newChatId = result.current.chatId;
    heartbeat(rerender, ['kiosk-01', 'kiosk-02']);

    expect(send(newChatId).body.target).toEqual({ machineIds: ['kiosk-01'], mentions: [] });
  });
});
