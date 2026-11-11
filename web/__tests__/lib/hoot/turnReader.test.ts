/** @jest-environment node */

/**
 * what a waiting caller is told about its hoot turn (lib/hoot/turnReader.server.ts),
 * over an in-memory admin-sdk fake holding the two docs it reads: the turn's
 * record at `chats/{chatId}/stream/current` and the chat itself.
 */

import { readTurn } from '@/lib/hoot/turnReader.server';
import { TURN_STALE_MS } from '@/lib/hoot/turnStore.server';

type Data = Record<string, unknown>;

const CHAT = 'chat-1';
const TURN = 'turn_abc';
const NOW = 1_800_000_000_000;

let docs: Map<string, Data>;
let reads: string[];
let readError: Error | null;

function docRef(path: string) {
  return {
    collection: (name: string) => ({ doc: (id: string) => docRef(`${path}/${name}/${id}`) }),
    get: async () => {
      if (readError) throw readError;
      reads.push(path);
      const data = docs.get(path);
      return { exists: data !== undefined, data: () => data };
    },
  };
}

const db = {
  collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
} as unknown as FirebaseFirestore.Firestore;

function at(ms: number) {
  return { toMillis: () => ms };
}

/** the turn's record, last written `idleMs` ago. */
function record(status: string, idleMs = 0, extra: Data = {}) {
  docs.set(`chats/${CHAT}/stream/current`, { status, turnId: TURN, updatedAt: at(NOW - idleMs), ...extra });
}

function reply(turnId: string, parts: unknown[]) {
  return { id: `msg-${turnId}`, role: 'assistant', parts, metadata: { hoot: { turnId } } };
}

function saveChat(messages: unknown[]) {
  docs.set(`chats/${CHAT}`, { messages });
}

beforeEach(() => {
  docs = new Map();
  reads = [];
  readError = null;
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a turn that is not the chat\'s current one', () => {
  it('fails when the chat has no record', async () => {
    expect(await readTurn(db, CHAT, TURN)).toEqual({
      status: 'failed',
      error: 'this turn is no longer the one its chat is running',
    });
  });

  it('fails when a later turn has overwritten the record, whatever that turn is doing', async () => {
    record('running', 0, { turnId: 'turn_later' });
    saveChat([reply(TURN, [{ type: 'text', text: 'an old answer' }])]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({
      status: 'failed',
      error: 'this turn is no longer the one its chat is running',
    });
  });
});

describe('a running turn', () => {
  it('is running while its heartbeat is fresh', async () => {
    record('running', TURN_STALE_MS - 1);

    expect(await readTurn(db, CHAT, TURN)).toEqual({ status: 'running' });
    // nothing to read on the chat until the record says complete
    expect(reads).toEqual([`chats/${CHAT}/stream/current`]);
  });

  it('fails once the heartbeat is as old as a dead runner\'s', async () => {
    record('running', TURN_STALE_MS);

    expect(await readTurn(db, CHAT, TURN)).toEqual({
      status: 'failed',
      error: 'the turn stopped without finishing',
    });
  });

  it('reads a record with no time on it as stale', async () => {
    docs.set(`chats/${CHAT}/stream/current`, { status: 'running', turnId: TURN });

    expect((await readTurn(db, CHAT, TURN)).status).toBe('failed');
  });
});

describe('a turn that ended without completing', () => {
  it('fails with the error the runner recorded', async () => {
    record('error', 0, { error: 'the model provider refused the request' });

    expect(await readTurn(db, CHAT, TURN)).toEqual({
      status: 'failed',
      error: 'the model provider refused the request',
    });
  });

  it.each([
    ['error', 'the turn failed'],
    ['cancelled', 'the turn was cancelled'],
    ['superseded', 'a newer turn replaced this one'],
    ['something-else', 'the turn failed'],
  ])('fails a %s turn that recorded no error', async (status, error) => {
    record(status);
    saveChat([reply(TURN, [{ type: 'text', text: 'half an answer' }])]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({ status: 'failed', error });
  });
});

describe('a completed turn', () => {
  it('is complete with the reply it saved, text parts only', async () => {
    record('complete');
    saveChat([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'how is the lobby?' }] },
      reply(TURN, [
        { type: 'step-start' },
        { type: 'text', text: 'checking the lobby.' },
        { type: 'tool-get_metrics', state: 'output-available', toolCallId: 'c1', output: { cpu: 12 } },
        { type: 'text', text: 'cpu is at 12%.' },
      ]),
    ]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({
      status: 'complete',
      text: 'checking the lobby.\n\ncpu is at 12%.',
    });
  });

  it('picks its own reply out of a chat that holds other turns\' replies', async () => {
    record('complete');
    saveChat([
      reply('turn_earlier', [{ type: 'text', text: 'an earlier answer' }]),
      reply(TURN, [{ type: 'text', text: 'this answer' }]),
    ]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({ status: 'complete', text: 'this answer' });
  });

  it('is complete with no text when the reply holds none', async () => {
    record('complete');
    saveChat([reply(TURN, [{ type: 'tool-get_metrics', state: 'output-available', toolCallId: 'c1' }])]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({ status: 'complete', text: '' });
  });

  it.each([
    ['the chat does not exist yet', () => {}],
    ['the chat holds no messages', () => saveChat([])],
    ['the chat holds only another turn\'s reply', () => saveChat([reply('turn_earlier', [{ type: 'text', text: 'x' }])])],
    ['the chat\'s messages are malformed', () => docs.set(`chats/${CHAT}`, { messages: 'nope' })],
  ])('is still running in the window before the reply is saved: %s', async (_name, arrange) => {
    record('complete', TURN_STALE_MS - 1);
    arrange();

    expect(await readTurn(db, CHAT, TURN)).toEqual({ status: 'running' });
  });

  it('fails once that window has passed with no reply saved', async () => {
    record('complete', TURN_STALE_MS);
    saveChat([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'how is the lobby?' }] }]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({
      status: 'failed',
      error: 'the turn finished without a saved reply',
    });
  });

  it('returns a reply saved late, however old the record is', async () => {
    record('complete', TURN_STALE_MS * 10);
    saveChat([reply(TURN, [{ type: 'text', text: 'a late answer' }])]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({ status: 'complete', text: 'a late answer' });
  });

  it('fails a turn that ended waiting on an approval, without reading the chat', async () => {
    record('complete', 0, { pendingApprovals: ['call_1'] });
    saveChat([reply(TURN, [{ type: 'text', text: 'i need your approval to restart it.' }])]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({
      status: 'failed',
      error: 'the turn stopped at a tool that needs a person to approve it, and nobody is there to',
    });
    expect(reads).toEqual([`chats/${CHAT}/stream/current`]);
  });

  it('reads an empty approvals list as none', async () => {
    record('complete', 0, { pendingApprovals: [] });
    saveChat([reply(TURN, [{ type: 'text', text: 'done' }])]);

    expect(await readTurn(db, CHAT, TURN)).toEqual({ status: 'complete', text: 'done' });
  });
});

describe('a read that fails', () => {
  it('throws, so a failed read is never taken for a failed turn', async () => {
    readError = new Error('firestore unavailable');

    await expect(readTurn(db, CHAT, TURN)).rejects.toThrow('firestore unavailable');
  });
});
