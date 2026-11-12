/**
 * what became of one hoot turn, for a caller that started it and waits with no
 * stream to read: a granted machine's task for hoot (ADR 0017). the answer comes
 * from the turn's record at `chats/{chatId}/stream/current` and, once that says
 * complete, from the reply saved on the chat.
 *
 * server-side only.
 */

import type { Timestamp } from 'firebase-admin/firestore';
import { TURN_STALE_MS, streamRef } from '@/lib/hoot/turnStore.server';

export type TurnReading =
  | { status: 'running' }
  | { status: 'complete'; text: string }
  | { status: 'failed'; error: string };

const ENDED_WITHOUT_REPLY: Readonly<Record<string, string>> = {
  cancelled: 'the turn was cancelled',
  superseded: 'a newer turn replaced this one',
};

function failed(error: string): TurnReading {
  return { status: 'failed', error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** how long ago the record was last written; a record with no time reads as stale. */
function idleMs(updatedAt: unknown): number {
  const stamp = updatedAt as Timestamp | undefined;
  return Date.now() - (stamp && typeof stamp.toMillis === 'function' ? stamp.toMillis() : 0);
}

/** the text of the reply this turn saved on the chat, or null when it has saved none. */
function savedReply(messages: unknown, turnId: string): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i];
    if (!isRecord(message) || message.role !== 'assistant') continue;
    // the turn id alone, not readHootTurnMetadata: that refuses a `via` it does
    // not know, and a reply it refused would read as never saved
    const hoot = isRecord(message.metadata) ? message.metadata.hoot : null;
    if (!isRecord(hoot) || hoot.turnId !== turnId) continue;

    const parts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
    return parts
      .filter((part): part is { type: 'text'; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n\n');
  }
  return null;
}

/**
 * read one turn. `running` until it is over; `complete` only with its saved
 * reply in hand; `failed` with a reason a caller can show. throws when
 * firestore does: a read that failed is not a turn that failed.
 */
export async function readTurn(
  db: FirebaseFirestore.Firestore,
  chatId: string,
  turnId: string,
): Promise<TurnReading> {
  const snap = await streamRef(db, chatId).get();
  const record = snap.exists ? (snap.data() ?? {}) : null;

  // a chat holds one record, and a later turn overwrites it
  if (record === null || record.turnId !== turnId) {
    return failed('this turn is no longer the one its chat is running');
  }

  const stale = idleMs(record.updatedAt) >= TURN_STALE_MS;

  if (record.status === 'running') {
    // the runner writes a heartbeat; without one for this long it has died
    return stale ? failed('the turn stopped without finishing') : { status: 'running' };
  }

  if (record.status !== 'complete') {
    if (typeof record.error === 'string' && record.error.length > 0) return failed(record.error);
    return failed(ENDED_WITHOUT_REPLY[String(record.status)] ?? 'the turn failed');
  }

  if (Array.isArray(record.pendingApprovals) && record.pendingApprovals.length > 0) {
    return failed('the turn stopped at a tool that needs a person to approve it, and nobody is there to');
  }

  // the record says complete before the reply is saved, so no reply yet is
  // still running; one that never arrives (a failed save, or a model that
  // answered nothing) is over once the same window has passed
  const chat = await db.collection('chats').doc(chatId).get();
  const reply = savedReply(chat.data()?.messages, turnId);
  if (reply !== null) return { status: 'complete', text: reply };
  return stale ? failed('the turn finished without a saved reply') : { status: 'running' };
}
