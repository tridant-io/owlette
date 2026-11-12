/**
 * Chat conversation storage under `chat_conversations/{conversationId}`.
 *
 * The most recent ≤200 messages are embedded on the conversation doc (one cheap read for the
 * common case); older ones spill into `chat_messages/{conversationId}/{messageId}`.
 * `messageCount` is the lifetime total, so consumers can paginate the spill collection.
 *
 * - Timestamps are Firestore `Timestamp`.
 * - Soft delete sets `deletedAt`; lists exclude soft-deleted by default.
 * - Callers pass the ALREADY-FILTERED set of readable site ids — this module is persistence
 *   only and enforces no auth.
 */

import crypto from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';

export const MAX_EMBEDDED_MESSAGES = 200;
export const MAX_TITLE_LENGTH = 100;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const CHAT_CONVERSATIONS_COLLECTION = 'chat_conversations';
export const CHAT_MESSAGES_SUBCOLLECTION = 'chat_messages';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** `Timestamp.now()`, not serverTimestamp — the latter is illegal inside an array element. */
  timestamp: Timestamp;
}

export interface ChatConversation {
  conversationId: string;
  title: string;
  siteId: string;
  machineId?: string;
  ownerUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt?: Timestamp;
  /** Embedded most-recent messages (≤MAX_EMBEDDED_MESSAGES). */
  messages: ChatMessage[];
  /** Lifetime message count, including any rows in the spill subcollection. */
  messageCount: number;
}

export interface CreateConversationInput {
  siteId: string;
  ownerUid: string;
  machineId?: string;
  title?: string;
  initialMessages?: Array<{ role: ChatRole; content: string }>;
}

export interface ListConversationsOptions {
  /** Site IDs the caller may see — empty list yields an empty page. */
  siteIds: string[];
  /** When provided, restricts the list to a single owner (e.g. dashboard "my chats"). */
  ownerUid?: string;
  /** AIP-158 page token (= conversationId of the last item from the previous page). */
  pageToken?: string;
  /** ≤MAX_PAGE_SIZE; defaults to DEFAULT_PAGE_SIZE. */
  pageSize?: number;
  /** When true, includes soft-deleted conversations. Defaults to false. */
  includeDeleted?: boolean;
}

export interface ListConversationsResult {
  conversations: ChatConversation[];
  nextPageToken: string;
}

/** `conv_<24 url-safe chars>` — no hostname/pid leakage, collision-resistant at any chat volume. */
export function generateConversationId(): string {
  return `conv_${crypto.randomBytes(18).toString('base64url')}`;
}

/** Generate a fresh messageId for use in the spill subcollection. */
export function generateMessageId(): string {
  return `msg_${crypto.randomBytes(12).toString('base64url')}`;
}

/** Truncate a title to MAX_TITLE_LENGTH characters, trimming whitespace. */
export function normalizeTitle(raw: unknown, fallback = 'untitled chat'): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, MAX_TITLE_LENGTH);
}

export async function createConversation(
  input: CreateConversationInput,
): Promise<ChatConversation> {
  const db = getAdminDb();
  const conversationId = generateConversationId();
  const now = Timestamp.now();
  const title = normalizeTitle(input.title);

  const seedMessages: ChatMessage[] = (input.initialMessages ?? []).map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: now,
  }));

  const docPayload: Record<string, unknown> = {
    conversationId,
    title,
    siteId: input.siteId,
    ownerUid: input.ownerUid,
    createdAt: now,
    updatedAt: now,
    messages: seedMessages,
    messageCount: seedMessages.length,
  };
  if (input.machineId) docPayload.machineId = input.machineId;

  await db.collection(CHAT_CONVERSATIONS_COLLECTION).doc(conversationId).set(docPayload);

  return {
    conversationId,
    title,
    siteId: input.siteId,
    ownerUid: input.ownerUid,
    machineId: input.machineId,
    createdAt: now,
    updatedAt: now,
    messages: seedMessages,
    messageCount: seedMessages.length,
  };
}

export async function getConversation(
  conversationId: string,
): Promise<ChatConversation | null> {
  const db = getAdminDb();
  const snap = await db.collection(CHAT_CONVERSATIONS_COLLECTION).doc(conversationId).get();
  if (!snap.exists) return null;
  return shapeConversationDoc(snap.data() ?? {});
}

/**
 * List conversations, ordered `updatedAt` desc with the last conversationId as the cursor.
 * Firestore caps `where in` at 30 values, so siteIds are chunked and merged client-side; the
 * merged set is re-sorted, so >30-site orgs still page deterministically.
 */
export async function listConversations(
  options: ListConversationsOptions,
): Promise<ListConversationsResult> {
  if (options.siteIds.length === 0) {
    return { conversations: [], nextPageToken: '' };
  }

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE),
  );

  const db = getAdminDb();
  const baseCol = db.collection(CHAT_CONVERSATIONS_COLLECTION);

  // Resolve the cursor once: its updatedAt drives `startAfter` on every chunk, otherwise each
  // chunk restarts at the top of the index.
  let cursorSnap: FirebaseFirestore.DocumentSnapshot | null = null;
  if (options.pageToken) {
    const snap = await baseCol.doc(options.pageToken).get();
    if (snap.exists) cursorSnap = snap;
  }

  // Firestore "in" clause max is 30.
  const chunks: string[][] = [];
  for (let i = 0; i < options.siteIds.length; i += 30) {
    chunks.push(options.siteIds.slice(i, i + 30));
  }

  const fetchLimit = pageSize + 1; // +1 to detect "has next page"
  const merged: ChatConversation[] = [];
  for (const chunk of chunks) {
    let q: FirebaseFirestore.Query = baseCol
      .where('siteId', 'in', chunk)
      .orderBy('updatedAt', 'desc')
      .limit(fetchLimit);
    if (options.ownerUid) {
      q = baseCol
        .where('siteId', 'in', chunk)
        .where('ownerUid', '==', options.ownerUid)
        .orderBy('updatedAt', 'desc')
        .limit(fetchLimit);
    }
    // soft-deleted rows are dropped after the read, so keep reading this chunk
    // until it yields fetchLimit live rows or runs out; one short read would end
    // pagination early.
    let after = cursorSnap;
    let live = 0;
    for (;;) {
      const snap = await (after ? q.startAfter(after) : q).get();
      for (const d of snap.docs) {
        const shaped = shapeConversationDoc(d.data() ?? {});
        if (!options.includeDeleted && shaped.deletedAt) continue;
        merged.push(shaped);
        live++;
      }
      if (live >= fetchLimit || snap.docs.length < fetchLimit) break;
      after = snap.docs[snap.docs.length - 1];
    }
  }

  merged.sort((a, b) => b.updatedAt.toMillis() - a.updatedAt.toMillis());
  const page = merged.slice(0, pageSize);
  const nextPageToken =
    merged.length > pageSize ? merged[pageSize - 1].conversationId : '';

  return { conversations: page, nextPageToken };
}

export interface AppendMessageInput {
  conversationId: string;
  role: ChatRole;
  content: string;
}

/**
 * Append one message, returning the new `messageCount`. Past MAX_EMBEDDED_MESSAGES the oldest
 * embedded message spills into `chat_messages`. Transactional, so a concurrent append can neither
 * lose a message nor mis-order the spill.
 */
export async function appendMessage(input: AppendMessageInput): Promise<{
  messageCount: number;
  spilled: boolean;
}> {
  const db = getAdminDb();
  const convRef = db.collection(CHAT_CONVERSATIONS_COLLECTION).doc(input.conversationId);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(convRef);
    if (!snap.exists) {
      throw new ChatStorageError(404, 'conversation_not_found', 'conversation not found');
    }
    const data = snap.data() ?? {};
    const messages: ChatMessage[] = Array.isArray(data.messages)
      ? (data.messages as ChatMessage[])
      : [];

    const now = Timestamp.now();
    const newMessage: ChatMessage = {
      role: input.role,
      content: input.content,
      timestamp: now,
    };

    let spilled = false;
    let updatedMessages: ChatMessage[];

    if (messages.length >= MAX_EMBEDDED_MESSAGES) {
      const oldest = messages[0];
      const spillRef = convRef
        .collection(CHAT_MESSAGES_SUBCOLLECTION)
        .doc(generateMessageId());
      txn.set(spillRef, {
        role: oldest.role,
        content: oldest.content,
        timestamp: oldest.timestamp,
        spilledAt: now,
      });
      updatedMessages = [...messages.slice(1), newMessage];
      spilled = true;
    } else {
      updatedMessages = [...messages, newMessage];
    }

    const newCount =
      (typeof data.messageCount === 'number' ? data.messageCount : messages.length) + 1;

    txn.update(convRef, {
      messages: updatedMessages,
      messageCount: newCount,
      updatedAt: now,
    });

    return { messageCount: newCount, spilled };
  });
}

export interface SoftDeleteResult {
  alreadyDeleted: boolean;
  deletedAt: Timestamp;
}

/** Idempotent: a second call returns the original `deletedAt`. Throws ChatStorageError(404). */
export async function softDeleteConversation(
  conversationId: string,
): Promise<SoftDeleteResult> {
  const db = getAdminDb();
  const ref = db.collection(CHAT_CONVERSATIONS_COLLECTION).doc(conversationId);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) {
      throw new ChatStorageError(404, 'conversation_not_found', 'conversation not found');
    }
    const data = snap.data() ?? {};
    if (data.deletedAt instanceof Timestamp) {
      return { alreadyDeleted: true, deletedAt: data.deletedAt };
    }
    const now = Timestamp.now();
    txn.update(ref, { deletedAt: now, updatedAt: now });
    return { alreadyDeleted: false, deletedAt: now };
  });
}

/** Returns the normalized title written. Throws ChatStorageError(404) if absent. */
export async function renameConversation(
  conversationId: string,
  rawTitle: unknown,
): Promise<{ title: string }> {
  const title = normalizeTitle(rawTitle);
  const db = getAdminDb();
  const ref = db.collection(CHAT_CONVERSATIONS_COLLECTION).doc(conversationId);

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) {
      throw new ChatStorageError(404, 'conversation_not_found', 'conversation not found');
    }
    txn.update(ref, { title, updatedAt: FieldValue.serverTimestamp() });
  });

  return { title };
}

export class ChatStorageError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function shapeConversationDoc(data: Record<string, unknown>): ChatConversation {
  const messages = Array.isArray(data.messages)
    ? (data.messages as ChatMessage[]).filter(
        (m) =>
          m &&
          typeof m === 'object' &&
          typeof (m as ChatMessage).role === 'string' &&
          typeof (m as ChatMessage).content === 'string',
      )
    : [];

  const out: ChatConversation = {
    conversationId: typeof data.conversationId === 'string' ? data.conversationId : '',
    title: typeof data.title === 'string' ? data.title : 'untitled chat',
    siteId: typeof data.siteId === 'string' ? data.siteId : '',
    ownerUid: typeof data.ownerUid === 'string' ? data.ownerUid : '',
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt : Timestamp.now(),
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : Timestamp.now(),
    messages,
    messageCount:
      typeof data.messageCount === 'number' ? data.messageCount : messages.length,
  };
  if (typeof data.machineId === 'string') out.machineId = data.machineId;
  if (data.deletedAt instanceof Timestamp) out.deletedAt = data.deletedAt;
  return out;
}

/** List shape: drops `messages` and ISO-stringifies timestamps. Single-conversation GETs keep it. */
export function serializeConversationSummary(c: ChatConversation): Record<string, unknown> {
  return {
    conversationId: c.conversationId,
    title: c.title,
    siteId: c.siteId,
    ...(c.machineId ? { machineId: c.machineId } : {}),
    ownerUid: c.ownerUid,
    createdAt: c.createdAt.toDate().toISOString(),
    updatedAt: c.updatedAt.toDate().toISOString(),
    ...(c.deletedAt ? { deletedAt: c.deletedAt.toDate().toISOString() } : {}),
    messageCount: c.messageCount,
  };
}

export function serializeConversation(c: ChatConversation): Record<string, unknown> {
  return {
    ...serializeConversationSummary(c),
    messages: c.messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp.toDate().toISOString(),
    })),
  };
}
