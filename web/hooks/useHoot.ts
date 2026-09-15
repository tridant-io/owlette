/**
 * Chat state for the hoot UI: wraps AI SDK v6 useChat with machine/site targeting,
 * conversation history, and async-turn recovery — subscribes to the durable turn doc
 * `chats/{chatId}/stream/current` for reattach after a dead stream, supersede-on-send,
 * tool cancel and stale detection.
 * Final persistence is server-owned by web/lib/hoot/turnRunner.server.ts.
 */

'use client';

import { useChat as useAIChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { type UIMessage, type FileUIPart } from 'ai';
import { uploadChatImage } from '@/lib/chatImageUtils';
import type { PendingImage } from '@/app/hoot/components/ChatInput';
import { UNTITLED_CHAT_TITLE } from '@/lib/hoot/untitledChat';
import {
  buildHootRequestBody,
  readTurnErrorCode,
  type HootChatContext,
} from '@/lib/hoot/requestBody';
import {
  chatTargetFields,
  formatTargetLabel,
  readChatTarget,
  type ChatTargetFields,
  type ChatTargetType,
  type HootTarget,
} from '@/lib/hoot/target';
import { toast } from '@/lib/toast';

export interface ChatConversation {
  id: string;
  title: string;
  siteId: string;
  targetType: ChatTargetType;
  /** The chat's stored selection; `null` = all machines. Display only — the
   *  authoritative read is `readChatTarget` in `loadChat`, which fails closed. */
  targetMachineIds: string[] | null;
  targetMachineId: string | null;
  machineName: string | null;
  source?: 'user' | 'autonomous';
  autonomousSummary?: string | null;
  category?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PAGE_SIZE = 40;

/**
 * Dispatched commands mirrored from `chats/{chatId}/stream/current.toolCommands`,
 * nested `toolCallId -> machineId -> { commandId }` so a site-wide fan-out records every
 * machine (the old flat shape was last-write-wins). Keep in sync with turnStore.server.ts
 * (server-only module — not importable here).
 */
export interface TurnToolCommand {
  commandId: string;
}

/** `toolCallId → machineId → { commandId }` — the per-chat cancel index. */
export type TurnToolCommands = Record<string, Record<string, TurnToolCommand>>;

/**
 * A `scheduled` follow-up on the open chat, as the composer chip renders it.
 * Mirrors `FollowupSummary` in web/lib/hoot/followupStore.server.ts (server-only
 * module — not importable here).
 */
export interface ScheduledFollowup {
  id: string;
  note: string;
  /** Null only if the doc landed before its server timestamp resolved. */
  runAtMs: number | null;
}

/**
 * Data at rest keeps its `cortex` spelling (WIRE_NAMES class A) — the same
 * literal firestore.rules and followupStore.server.ts pin.
 */
const FOLLOWUPS_COLLECTION = 'cortex-followups';

// A chat holds 0–2 scheduled follow-ups in practice; the cap is a guard, not a page size.
const FOLLOWUPS_LIMIT = 10;

// Mirrors TURN_STALE_MS in web/lib/hoot/turnStore.server.ts: a `running` doc whose
// heartbeat is older is a dead runner (deploy-killed) — surfaced as `turnStale`.
const TURN_STALE_MS = 45_000;

// A stale `updatedAt` emits no snapshot — re-check on an interval while running.
const TURN_STALE_RECHECK_MS = 15_000;

// Resubscribe delay after a stream-doc listener error (onSnapshot kills the listener
// when its error callback fires). permission-denied is expected for brand-new chats.
const STREAM_RESUBSCRIBE_MS = 15_000;

/** What `loadChat` found, for a caller that adopts a loaded chat's selection. */
export interface ChatLoadedTarget {
  chatId: string;
  /** The chat's own site; null when the doc doesn't name one (unsendable). */
  siteId: string | null;
  /** `'invalid'` when the stored target was unreadable — send stays refused. */
  target: HootTarget | 'invalid';
}

interface UseChatOptions {
  siteId: string;
  /** The chat's machine selection; `machineIds: null` = every machine, dynamically. */
  selection: HootTarget;
  /** Every machine id in `siteId` — the vocabulary `@mentions` resolve against. */
  siteMachineIds: string[];
  onChatPersisted?: (chatId: string) => void;
  onChatLoaded?: (result: ChatLoadedTarget) => void;
}

export type ChatLoadError = 'not_found';

export function useOwletteChat({
  siteId,
  selection,
  siteMachineIds,
  onChatPersisted,
  onChatLoaded,
}: UseChatOptions) {
  const { user } = useAuth();
  const [chatId, setChatId] = useState<string>(() => generateChatId());
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [inputValue, setInputValue] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [chatLoadError, setChatLoadError] = useState<ChatLoadError | null>(null);
  const loadChatRequestRef = useRef(0);
  const isMountedRef = useRef(true);
  // Unpersisted "new conversation" row, held in a ref so a Firestore snapshot refire
  // doesn't erase the optimistic entry before the first message is saved.
  const draftConvoRef = useRef<ChatConversation | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      loadChatRequestRef.current += 1;
    };
  }, []);

  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreUser, setHasMoreUser] = useState(false);
  const [hasMoreAuto, setHasMoreAuto] = useState(false);
  const lastUserDocRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const lastAutoDocRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);

  const [searchQuery, setSearchQuery] = useState('');

  // Async turn state mirrored from `chats/{chatId}/stream/current`.
  const [toolCommands, setToolCommands] = useState<TurnToolCommands>({});
  const [turnStale, setTurnStale] = useState(false);
  // True while `stream/current` reports a running turn — the UI suppresses
  // approve/deny then, so a reload during an approval-resume can't re-arm the
  // buttons for a tool that is already executing (OWL-47 companion guard).
  const [turnRunning, setTurnRunning] = useState(false);
  // Bumped to resubscribe after a listener error (Firestore kills it on error).
  const [streamSubAttempt, setStreamSubAttempt] = useState(0);
  // Scheduled follow-ups on the open chat — the chips above the composer.
  const [followups, setFollowups] = useState<ScheduledFollowup[]>([]);

  // Use refs so the transport closure always reads the latest values
  const siteIdRef = useRef(siteId);
  const selectionRef = useRef(selection);
  const siteMachineIdsRef = useRef(siteMachineIds);
  const chatIdRef = useRef(chatId);
  const onChatPersistedRef = useRef(onChatPersisted);
  const onChatLoadedRef = useRef(onChatLoaded);
  siteIdRef.current = siteId;
  selectionRef.current = selection;
  siteMachineIdsRef.current = siteMachineIds;
  chatIdRef.current = chatId;
  onChatPersistedRef.current = onChatPersisted;
  onChatLoadedRef.current = onChatLoaded;

  // Live "a turn is running" flag — read in the transport closure, where state is stale.
  const streamRunningRef = useRef(false);
  // Per-chat site/machine pin, written when a chat is started or loaded. The transport
  // reads the ISSUING chat's pin (by transport id), never the live UI refs, so an
  // orphaned instance's send cannot be retargeted by a chat/site switch (OWL-48).
  const chatContextRef = useRef(new Map<string, HootChatContext>());
  // Latest toolCommands; cancelTool reads a call's per-machine commandIds from it.
  const toolCommandsRef = useRef<TurnToolCommands>({});
  // One-shot supersede flag, consumed per request in prepareSendMessagesRequest.
  const forceSupersedeRef = useRef(false);
  // Loop guard for the 409 turn_active auto-retry — re-armed in onFinish.
  const turnActiveRetriedRef = useRef(false);
  // Id of the running turn (null when idle); stop() POSTs it to /api/hoot/stop.
  const currentTurnIdRef = useRef<string | null>(null);
  // One-shot: set on user stop so the reattach branch doesn't resurrect the in-progress
  // message before the doc flips to `cancelled`. Cleared on any terminal status.
  const userStoppedRef = useRef(false);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/hoot',
        // Send full UIMessages; the server rebuilds ModelMessages via convertToModelMessages,
        // which is what lets a tier-3 approval round-trip resume streamText.
        prepareSendMessagesRequest: ({ id, messages }) => {
          // Supersede when this send races an in-flight turn: our own live stream, the 409
          // auto-retry, or a reattached client. The one-shot flag is consumed per request so an
          // automatic approval re-send doesn't inherit it.
          const supersede = forceSupersedeRef.current || streamRunningRef.current;
          forceSupersedeRef.current = false;
          // Throws StaleChatInstanceError for an orphaned instance (chat switched while
          // its response was in flight) — the send dies here instead of retargeting the
          // new conversation. The error lands on the unrendered old instance.
          return buildHootRequestBody({
            transportChatId: id,
            activeChatId: chatIdRef.current,
            pinnedContext: (id && chatContextRef.current.get(id)) || null,
            liveContext: {
              siteId: siteIdRef.current,
              target: selectionRef.current,
              siteMachineIds: siteMachineIdsRef.current,
            },
            messages,
            supersede,
          });
        },
      }),
    []
  );

  const chat = useAIChat({
    id: chatId,
    transport,
    // Once every pending tier-3 approval is answered, re-send so the SDK resumes.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      // The server-side runner is the persist authority (turnRunner.server.ts) — persisting
      // here would race it, and used to persist aborted turns.
      turnActiveRetriedRef.current = false; // turn completed — re-arm the 409 auto-retry
      // onChatPersisted deliberately NOT fired here: an orphaned instance finishing after
      // a chat switch would route the URL to the *current* chat via the live ref. It fires
      // from mergeAndSet when the draft's real doc lands (derived from actual persistence).
    },
  });

  // Ref mirror of the chat so async Firestore callbacks can read live status.
  const chatRef = useRef(chat);
  chatRef.current = chat;

  // Keep the open chat's mention vocabulary current, and ONLY that. The machines
  // listing usually lands after the pin (a deep link loads the chat before the
  // header's site resolves) and arrives as a fresh array on every heartbeat, so
  // this effect runs constantly — which is exactly why it must not touch
  // `target`: re-aiming on state identity would overwrite a loaded chat's
  // stored target, and a fail-closed `'invalid'` one, with whatever the header
  // happened to show. Moving a target is a user gesture — `retargetActiveChat`.
  // A chat pinned to another site keeps its own (empty) vocabulary: this listing
  // is the header's site, not that chat's (OWL-48).
  useEffect(() => {
    const pinned = chatContextRef.current.get(chatId);
    if (!pinned || pinned.siteId !== siteId) return;
    chatContextRef.current.set(chatId, { ...pinned, siteMachineIds });
  }, [chatId, siteId, siteMachineIds]);

  // Re-aim the ACTIVE chat at a new selection: ticking a machine retargets the
  // conversation you are in, and never starts one. The pinned siteId is the
  // whole point of OWL-48, so a chat pinned to another site is left alone, and
  // an unpinned chat is the initial mount's, which the transport addresses from
  // the live context anyway.
  const retargetActiveChat = useCallback((target: HootTarget) => {
    const activeChatId = chatIdRef.current;
    const pinned = chatContextRef.current.get(activeChatId);
    if (!pinned || pinned.siteId !== siteIdRef.current) return;
    chatContextRef.current.set(activeChatId, { ...pinned, target });
  }, []);

  // Re-read the runner-persisted history for the open chat. Used when the server
  // refuses a resume: the local transcript still offers approve/deny buttons for
  // a turn that is no longer the chat's latest.
  const reloadPersistedMessages = useCallback(async () => {
    if (!db) return;
    const forChatId = chatIdRef.current;
    try {
      const snap = await getDoc(doc(db, 'chats', forChatId));
      if (!isMountedRef.current || chatIdRef.current !== forChatId) return;
      const messages = snap.data()?.messages;
      if (Array.isArray(messages)) chatRef.current.setMessages(messages as UIMessage[]);
    } catch (error) {
      console.error('Failed to reload chat history:', error);
    }
  }, []);

  // Auto-retry once when a send lost the turn-lock race (server 409 `turn_active`): force
  // supersede and re-send. The ref guard prevents loops; with supersede forced a second
  // turn_active is impossible, so one retry suffices.
  useEffect(() => {
    if (chat.status !== 'error' || !chat.error) return;
    const code = readTurnErrorCode(String(chat.error.message ?? ''));

    if (code === 'approval_stale') {
      // The approval bound to a turn that is no longer the chat's latest, so the
      // server refused it BEFORE consuming it. It must not reach the supersede
      // retry below — that would re-send a refused approval as a fresh turn.
      void reloadPersistedMessages();
      toast.error('that approval expired — another turn ran in this chat. ask again.');
      return;
    }

    if (code !== 'turn_active') return;
    if (turnActiveRetriedRef.current) return;
    turnActiveRetriedRef.current = true;
    forceSupersedeRef.current = true;
    chatRef.current.regenerate().catch((error) => {
      console.error('Failed to retry superseding send:', error);
    });
  }, [chat.status, chat.error, reloadPersistedMessages]);

  // Live turn subscription — `chats/{chatId}/stream/current`, written by the server-side
  // runner. Powers cancel targets (`toolCommands`), reattach when we hold no HTTP stream
  // (reload mid-turn, or the stream died at a proxy), and `turnStale`.
  useEffect(() => {
    // Reset per-chat turn state before (re)subscribing.
    streamRunningRef.current = false;
    currentTurnIdRef.current = null;
    userStoppedRef.current = false;
    toolCommandsRef.current = {};
    setToolCommands({});
    setTurnStale(false);
    setTurnRunning(false);

    if (!user || !db) return;

    const streamDocRef = doc(db, 'chats', chatId, 'stream', 'current');
    // `updatedAt` (ms) of the currently running doc — staleness input.
    let runningUpdatedAtMs: number | null = null;
    // True once we merged snapshots for a turn we hold no HTTP stream for.
    let reattached = false;
    // Id of the merged in-progress assistant message — detects if the final persist landed.
    let mergedMessageId: string | null = null;
    let staleInterval: ReturnType<typeof setInterval> | null = null;
    let landRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    let resubscribeTimeout: ReturnType<typeof setTimeout> | null = null;

    const recomputeStale = () => {
      setTurnStale(
        streamRunningRef.current &&
          runningUpdatedAtMs !== null &&
          runningUpdatedAtMs < Date.now() - TURN_STALE_MS,
      );
    };

    // After a reattached turn goes terminal, land the runner-persisted history. The runner
    // marks terminal BEFORE its final persist (errored turns never persist), so retry once
    // if the merged message is missing, else keep the merged view — repair recovers on send.
    const landFinalMessages = async (attempt: number) => {
      if (!db) return;
      try {
        const snap = await getDoc(doc(db, 'chats', chatId));
        // Chat may have changed, unmounted or started a live turn during the fetch.
        if (!isMountedRef.current || chatIdRef.current !== chatId) return;
        const status = chatRef.current.status;
        if (status === 'streaming' || status === 'submitted') return;
        const messages = snap.data()?.messages;
        if (!Array.isArray(messages)) return;
        if (
          mergedMessageId !== null &&
          !messages.some((m) => (m as UIMessage | null)?.id === mergedMessageId)
        ) {
          if (attempt === 0) {
            landRetryTimeout = setTimeout(() => void landFinalMessages(1), 1500);
          }
          return;
        }
        chatRef.current.setMessages(messages as UIMessage[]);
      } catch (error) {
        console.error('Failed to load final chat history after reattach:', error);
      }
    };

    const unsubscribe = onSnapshot(
      streamDocRef,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        const running = data?.status === 'running';

        streamRunningRef.current = running;
        setTurnRunning(running);
        // Track the running turn id for stop(); clear the user-stop guard once terminal.
        currentTurnIdRef.current =
          running && typeof data?.turnId === 'string' ? data.turnId : null;
        if (!running) userStoppedRef.current = false;
        runningUpdatedAtMs =
          running && typeof data?.updatedAt?.toMillis === 'function'
            ? (data.updatedAt.toMillis() as number)
            : null;
        recomputeStale();
        // A stale `updatedAt` emits no snapshot — poll while a running doc is held.
        if (running && staleInterval === null) {
          staleInterval = setInterval(recomputeStale, TURN_STALE_RECHECK_MS);
        } else if (!running && staleInterval !== null) {
          clearInterval(staleInterval);
          staleInterval = null;
        }

        // Cancel targets only exist for a live turn — {} once terminal/absent.
        const commands = running
          ? ((data?.toolCommands ?? {}) as TurnToolCommands)
          : {};
        toolCommandsRef.current = commands;
        setToolCommands(commands);

        const chatStatus = chatRef.current.status;
        const hasLiveHttpStream = chatStatus === 'streaming' || chatStatus === 'submitted';

        if (hasLiveHttpStream) {
          // We own a live HTTP stream — never merge lagging Firestore snapshots over it.
          reattached = false;
          mergedMessageId = null;
        } else if (running) {
          // No live stream for a running turn (reload / dead stream): reattach via Firestore.
          reattached = true;
          // ...unless the user just pressed stop: don't resurrect the in-progress message before
          // the doc flips to 'cancelled'. The terminal transition clears the guard.
          const message = userStoppedRef.current ? null : (data?.message as UIMessage | null);
          if (message && typeof message === 'object' && typeof message.id === 'string') {
            mergedMessageId = message.id;
            chatRef.current.setMessages((prev) => {
              const index = prev.findIndex((m) => m.id === message.id);
              if (index === -1) return [...prev, message];
              const next = prev.slice();
              next[index] = message;
              return next;
            });
          }
        } else if (reattached) {
          // The turn we were watching went terminal — land the final history.
          reattached = false;
          void landFinalMessages(0);
        }
      },
      (error) => {
        // The listener is dead once this fires. permission-denied is expected for a brand-new
        // chat (stream reads authorize via the parent chat doc, which the runner creates on its
        // first persist) — resubscribe so turn state goes live; log anything else.
        const code = (error as { code?: string } | null)?.code;
        if (code !== 'permission-denied') {
          console.error('Failed to subscribe to turn stream:', error);
        }
        streamRunningRef.current = false;
        setTurnRunning(false);
        currentTurnIdRef.current = null;
        userStoppedRef.current = false;
        runningUpdatedAtMs = null;
        toolCommandsRef.current = {};
        setToolCommands({});
        setTurnStale(false);
        if (staleInterval !== null) {
          clearInterval(staleInterval);
          staleInterval = null;
        }
        resubscribeTimeout = setTimeout(
          () => setStreamSubAttempt((attempt) => attempt + 1),
          STREAM_RESUBSCRIBE_MS,
        );
      },
    );

    return () => {
      unsubscribe();
      if (staleInterval !== null) clearInterval(staleInterval);
      if (landRetryTimeout !== null) clearTimeout(landRetryTimeout);
      if (resubscribeTimeout !== null) clearTimeout(resubscribeTimeout);
    };
  }, [user, chatId, streamSubAttempt]);

  // Scheduled follow-ups for the open chat, live so a fired or cancelled one drops its
  // chip without a refetch. The `userId` filter is not optional: firestore.rules grant a
  // read only where `resource.data.userId` is the caller, and a query missing that clause
  // is rejected wholesale. Composite index: (chatId, status, userId, runAt).
  useEffect(() => {
    setFollowups([]);
    if (!user || !db) return;

    const followupsQuery = query(
      collection(db, FOLLOWUPS_COLLECTION),
      where('chatId', '==', chatId),
      where('userId', '==', user.uid),
      where('status', '==', 'scheduled'),
      orderBy('runAt', 'asc'),
      limit(FOLLOWUPS_LIMIT),
    );

    return onSnapshot(
      followupsQuery,
      (snapshot) => {
        setFollowups(
          snapshot.docs.map((docSnap) => {
            const data = docSnap.data();
            return {
              id: docSnap.id,
              note: typeof data.note === 'string' ? data.note : '',
              runAtMs:
                typeof data.runAt?.toMillis === 'function'
                  ? (data.runAt.toMillis() as number)
                  : null,
            };
          }),
        );
      },
      (error) => {
        console.error('Failed to subscribe to scheduled follow-ups:', error);
        setFollowups([]);
      },
    );
  }, [user, chatId]);

  // Cancel a scheduled follow-up. Deliberately not optimistic — the chip clears when the
  // doc leaves `scheduled` in the subscription above, so a rejected cancel stays visible.
  // Never throws; the caller owns the in-flight UI state.
  const cancelFollowup = useCallback(async (followupId: string) => {
    try {
      const response = await fetch(
        `/api/hoot/followups/${encodeURIComponent(followupId)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        console.error('Failed to cancel follow-up:', response.status, detail);
      }
    } catch (error) {
      console.error('Failed to cancel follow-up:', error);
    }
  }, []);

  // Cancel a running tool call across every machine it dispatched to (the agent kills each
  // process tree; the card resolves to "cancelled by user"). Per-machine commandIds come
  // from `toolCommands[toolCallId]`. POSTs fire in parallel; failures logged, never thrown.
  const cancelTool = useCallback(async (toolCallId: string) => {
    const perMachine = toolCommandsRef.current[toolCallId];
    if (!perMachine) return;
    await Promise.allSettled(
      Object.entries(perMachine).map(async ([machineId, { commandId }]) => {
        try {
          const response = await fetch('/api/hoot/cancel-tool', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              siteId: siteIdRef.current,
              machineId,
              chatId: chatIdRef.current,
              commandId,
            }),
          });
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            console.error('Failed to cancel tool:', response.status, detail);
          }
        } catch (error) {
          console.error('Failed to cancel tool:', error);
        }
      }),
    );
  }, []);

  // Stop = real server cancel. `chat.stop()` only aborts our local HTTP branch; the
  // detached runner keeps executing and reattach would resurrect the response within ~1s.
  // So POST /api/hoot/stop, set the resurrection guard, then tear down the local stream.
  // Same-origin session auth. Never throws.
  const stop = useCallback(async () => {
    const turnId = currentTurnIdRef.current;
    const running = streamRunningRef.current;
    // Set before any await so a snapshot arriving during the POST is suppressed.
    userStoppedRef.current = true;
    if (running && turnId) {
      try {
        const response = await fetch('/api/hoot/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: chatIdRef.current, turnId }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          console.error('Failed to stop turn:', response.status, detail);
        }
      } catch (error) {
        console.error('Failed to stop turn:', error);
      }
    }
    // Tear down the local HTTP stream regardless of the server round-trip.
    await chatRef.current.stop();
  }, []);

  // Load conversation history (user chats + autonomous chats for the site)
  useEffect(() => {
    if (!user || !db) {
      setLoadingConversations(false);
      return;
    }

    const chatsRef = collection(db, 'chats');

    const userQuery = query(
      chatsRef,
      where('userId', '==', user.uid),
      orderBy('updatedAt', 'desc'),
      limit(PAGE_SIZE)
    );

    // Autonomous chats for this site (no userId, source === 'autonomous')
    const autoQuery = siteId ? query(
      chatsRef,
      where('source', '==', 'autonomous'),
      where('siteId', '==', siteId),
      orderBy('updatedAt', 'desc'),
      limit(PAGE_SIZE)
    ) : null;

    let userConvos: ChatConversation[] = [];
    let autoConvos: ChatConversation[] = [];
    let userLoaded = false;
    let autoLoaded = !autoQuery;

    function mergeAndSet() {
      if (!userLoaded || !autoLoaded) return;
      const all = [...userConvos, ...autoConvos];
      const seen = new Set<string>();
      const deduped = all.filter(c => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      deduped.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      // Keep the unpersisted draft pinned until its doc lands in a snapshot.
      const draft = draftConvoRef.current;
      if (draft) {
        if (seen.has(draft.id)) {
          draftConvoRef.current = null; // persisted now — the real doc supersedes it
          // Fire the persisted callback from actual persistence, and only for the
          // chat that is still active — never from an orphaned turn's live ref.
          if (draft.id === chatIdRef.current) {
            onChatPersistedRef.current?.(draft.id);
          }
        } else {
          deduped.unshift(draft);
        }
      }
      setConversations(deduped);
      setLoadingConversations(false);
    }

    function parseConvo(docSnap: import('firebase/firestore').DocumentSnapshot): ChatConversation | null {
      const data = docSnap.data();
      if (!data) return null;
      if (data.siteId !== siteId) return null;
      return parseConversation(docSnap.id, data);
    }

    const unsubUser = onSnapshot(
      userQuery,
      (snapshot) => {
        userConvos = snapshot.docs.map(parseConvo).filter((c): c is ChatConversation => c !== null);
        const docs = snapshot.docs;
        lastUserDocRef.current = docs.length > 0 ? docs[docs.length - 1] : null;
        setHasMoreUser(docs.length === PAGE_SIZE);
        userLoaded = true;
        mergeAndSet();
      },
      (error) => {
        console.error('Failed to load user conversations:', error);
        userLoaded = true;
        mergeAndSet();
      }
    );

    let unsubAuto: (() => void) | undefined;
    if (autoQuery) {
      unsubAuto = onSnapshot(
        autoQuery,
        (snapshot) => {
          autoConvos = snapshot.docs.map(parseConvo).filter((c): c is ChatConversation => c !== null);
          const docs = snapshot.docs;
          lastAutoDocRef.current = docs.length > 0 ? docs[docs.length - 1] : null;
          setHasMoreAuto(docs.length === PAGE_SIZE);
          autoLoaded = true;
          mergeAndSet();
        },
        (error) => {
          console.error('Failed to load autonomous conversations:', error);
          autoLoaded = true;
          mergeAndSet();
        }
      );
    }

    return () => {
      unsubUser();
      unsubAuto?.();
    };
  }, [user, siteId]);

  const startNewChat = useCallback((overrides?: { siteId?: string; selection?: HootTarget }) => {
    loadChatRequestRef.current += 1;
    const newId = generateChatId();
    setChatId(newId);
    chat.setMessages([]);
    setInputValue('');
    setPendingImages([]);
    setChatLoadError(null);

    // Overrides cover the selector-changed-in-the-same-handler race (a site
    // switch updates state and starts a chat in one handler, before the refs
    // re-render).
    const effectiveSiteId = overrides?.siteId ?? siteIdRef.current;
    const effectiveSelection = overrides?.selection ?? selectionRef.current;

    // Pin the new chat's context for the transport (OWL-48).
    chatContextRef.current.set(newId, {
      siteId: effectiveSiteId,
      target: effectiveSelection,
      siteMachineIds: siteMachineIdsRef.current,
    });

    // Optimistic sidebar entry tracked by id so the snapshot listener preserves it; drop
    // only the previous draft by id, not every row titled "new conversation".
    const previousDraftId = draftConvoRef.current?.id;
    const draft: ChatConversation = {
      id: newId,
      title: UNTITLED_CHAT_TITLE,
      siteId: effectiveSiteId,
      ...draftTargetFields(effectiveSelection),
      source: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    draftConvoRef.current = draft;
    setConversations((prev) => [
      draft,
      ...prev.filter((c) => c.id !== newId && c.id !== previousDraftId),
    ]);
  }, [chat]);

  const loadMoreConversations = useCallback(async () => {
    if (loadingMore || !user || !db) return;
    if (!hasMoreUser && !hasMoreAuto) return;

    setLoadingMore(true);
    try {
      const chatsRef = collection(db, 'chats');
      const newConvos: ChatConversation[] = [];

      if (hasMoreUser && lastUserDocRef.current) {
        const moreUserQuery = query(
          chatsRef,
          where('userId', '==', user.uid),
          orderBy('updatedAt', 'desc'),
          startAfter(lastUserDocRef.current),
          limit(PAGE_SIZE)
        );
        const snapshot = await getDocs(moreUserQuery);
        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          if (data && data.siteId === siteId) {
            newConvos.push(parseConversation(docSnap.id, data));
          }
        }
        lastUserDocRef.current = snapshot.docs.length > 0
          ? snapshot.docs[snapshot.docs.length - 1]
          : null;
        setHasMoreUser(snapshot.docs.length === PAGE_SIZE);
      }

      if (hasMoreAuto && lastAutoDocRef.current && siteId) {
        const moreAutoQuery = query(
          chatsRef,
          where('source', '==', 'autonomous'),
          where('siteId', '==', siteId),
          orderBy('updatedAt', 'desc'),
          startAfter(lastAutoDocRef.current),
          limit(PAGE_SIZE)
        );
        const snapshot = await getDocs(moreAutoQuery);
        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          if (data) {
            newConvos.push(parseConversation(docSnap.id, data));
          }
        }
        lastAutoDocRef.current = snapshot.docs.length > 0
          ? snapshot.docs[snapshot.docs.length - 1]
          : null;
        setHasMoreAuto(snapshot.docs.length === PAGE_SIZE);
      }

      if (newConvos.length > 0) {
        setConversations((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          const unique = newConvos.filter((c) => !seen.has(c.id));
          const merged = [...prev, ...unique];
          merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          return merged;
        });
      }
    } catch (error) {
      console.error('Failed to load more conversations:', error);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, user, siteId, hasMoreUser, hasMoreAuto]);

  const hasMoreConversations = hasMoreUser || hasMoreAuto;

  // NOTE: every setMessages below goes through `chatRef.current`, never the
  // captured `chat`. @ai-sdk/react keys its Chat instance on `id`
  // (`useMemo(() => new Chat(...), [chatKey])`), so `setChatId` above swaps in a
  // NEW Chat on the next render. A post-await `chat.setMessages(...)` would
  // write the loaded history into the PREVIOUS conversation's orphaned
  // instance: the conversation opens, the header is right, and the transcript
  // renders empty. `chatRef` is mirrored every render, so it is the live one.
  const loadChat = useCallback(
    async (conversationId: string) => {
      const requestId = loadChatRequestRef.current + 1;
      loadChatRequestRef.current = requestId;
      setChatId(conversationId);
      setInputValue('');
      setChatLoadError(null);
      chat.setMessages([]);

      if (db) {
        try {
          const chatDoc = await getDoc(doc(db, 'chats', conversationId));
          if (!isMountedRef.current || requestId !== loadChatRequestRef.current) return;
          if (!chatDoc.exists()) {
            setChatLoadError('not_found');
            chatRef.current.setMessages([]);
            return;
          }

          const data = chatDoc.data();
          setChatLoadError(null);
          // Pin the loaded chat's own context for the transport (OWL-48) — a
          // send into this conversation must target ITS site and ITS machines,
          // not whatever the header shows by the time the request fires.
          //
          // FAIL CLOSED: a target that can't be read pins `'invalid'`, which
          // refuses to build a body until the user picks machines. This used to
          // default to the site sentinel, so a chat doc the client couldn't
          // parse dispatched to EVERY machine in the site.
          const chatSiteId = typeof data?.siteId === 'string' ? data.siteId : null;
          const read = readChatTarget(data);
          const target: HootTarget | 'invalid' =
            chatSiteId !== null && read.ok ? read.target : 'invalid';
          chatContextRef.current.set(conversationId, {
            siteId: chatSiteId ?? siteIdRef.current,
            target,
            // Mentions resolve against the CHAT's site, and only the live site's
            // listing is loaded here — a chat from elsewhere gets none until the
            // header follows it there.
            siteMachineIds: chatSiteId === siteIdRef.current ? siteMachineIdsRef.current : [],
          });
          onChatLoadedRef.current?.({ chatId: conversationId, siteId: chatSiteId, target });
          if (data?.messages && Array.isArray(data.messages)) {
            chatRef.current.setMessages(data.messages as UIMessage[]);
          } else {
            chatRef.current.setMessages([]);
          }
        } catch (error) {
          if (!isMountedRef.current || requestId !== loadChatRequestRef.current) return;
          // permission-denied is expected when the URL points at a chat the user can't access
          // (firestore.rules) — surface as not_found without logging noise.
          const code = (error as { code?: string } | null)?.code;
          if (code !== 'permission-denied') {
            console.error('Failed to load chat messages:', error);
          }
          setChatLoadError('not_found');
          chatRef.current.setMessages([]);
        }
      }
    },
    [chat]
  );

  const deleteChat = useCallback(
    async (conversationId: string) => {
      loadChatRequestRef.current += 1;

      const isEmptyNew = conversations.find(
        (c) => c.id === conversationId && c.title === UNTITLED_CHAT_TITLE
      );

      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (draftConvoRef.current?.id === conversationId) {
        draftConvoRef.current = null;
      }

      if (conversationId === chatId) {
        if (isEmptyNew) {
          // Deleted an empty "new conversation" — reset state without creating another one
          const newId = generateChatId();
          setChatId(newId);
          chat.setMessages([]);
          setInputValue('');
          setChatLoadError(null);
        } else {
          startNewChat();
        }
      }

      // Firestore delete is a no-op when the doc was never persisted.
      if (db) {
        try {
          await deleteDoc(doc(db, 'chats', conversationId));
        } catch (error) {
          console.error('Failed to delete chat:', error);
        }
      }
    },
    [chatId, conversations, startNewChat, chat]
  );

  const renameChat = useCallback(
    async (conversationId: string, newTitle: string) => {
      const trimmed = newTitle.trim();
      if (!trimmed) return;

      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, title: trimmed } : c))
      );

      if (db) {
        try {
          await setDoc(doc(db, 'chats', conversationId), { title: trimmed }, { merge: true });
        } catch (error) {
          console.error('Failed to rename chat:', error);
        }
      }
    },
    []
  );

  // Sending while our own stream is live supersedes the running turn: flag the request and
  // abort the local stream first — the SDK allows one active response per chat, and the
  // aborted request's teardown would clear the new one's state. The macrotask yield lets
  // that teardown complete before the next send.
  const supersedeLiveStream = useCallback(async () => {
    if (chatRef.current.status !== 'streaming' && chatRef.current.status !== 'submitted') return;
    forceSupersedeRef.current = true;
    await chatRef.current.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, []);

  const handleSend = useCallback(async () => {
    const readyImages = pendingImages.filter((i) => !i.uploading);
    if (!inputValue.trim() && readyImages.length === 0) return;

    const files: FileUIPart[] = readyImages.map((i) => ({
      type: 'file' as const,
      mediaType: i.mediaType,
      url: i.url,
    }));

    await supersedeLiveStream();

    if (files.length > 0) {
      chat.sendMessage({ text: inputValue || '', files });
    } else {
      chat.sendMessage({ text: inputValue });
    }
    setInputValue('');
    setPendingImages([]);
    setChatLoadError(null);
  }, [inputValue, pendingImages, chat, supersedeLiveStream]);

  // Edit a prior user message and re-send from there: drop it and everything after, then
  // send the new text as a fresh turn. Linear branch — the runner's persist overwrites the
  // discarded tail. Images on the original carry over.
  const editMessage = useCallback(
    async (messageId: string, newText: string) => {
      const trimmed = newText.trim();
      if (!trimmed) return;

      // Abort/supersede a live turn first so the list is settled before branching.
      await supersedeLiveStream();

      const messages = chatRef.current.messages;
      const index = messages.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      const original = messages[index];
      if (original.role !== 'user') return;

      const files = original.parts.filter(
        (p): p is FileUIPart => p.type === 'file',
      );

      chat.setMessages(messages.slice(0, index));
      setChatLoadError(null);

      if (files.length > 0) {
        chat.sendMessage({ text: trimmed, files });
      } else {
        chat.sendMessage({ text: trimmed });
      }
    },
    [chat, supersedeLiveStream],
  );

  const handlePasteImage = useCallback(
    async (blob: Blob) => {
      if (!user) return;

      const previewUrl = URL.createObjectURL(blob);
      const placeholderIndex = pendingImages.length;

      setPendingImages((prev) => [
        ...prev,
        { url: '', mediaType: 'image/jpeg', uploading: true, previewUrl },
      ]);

      try {
        const { url, mediaType } = await uploadChatImage(user.uid, chatId, blob);
        setPendingImages((prev) =>
          prev.map((img, i) =>
            i === placeholderIndex
              ? { url, mediaType, uploading: false, previewUrl }
              : img,
          ),
        );
      } catch (error) {
        console.error('Failed to upload chat image:', error);
        setPendingImages((prev) => prev.filter((_, i) => i !== placeholderIndex));
        URL.revokeObjectURL(previewUrl);
      }
    },
    [user, chatId, pendingImages.length],
  );

  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const img = prev[index];
      if (img?.previewUrl) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const isLoading = chat.status === 'streaming' || chat.status === 'submitted';

  // Patch categories for conversations outside the snapshot window.
  const updateConversationCategories = useCallback((results: Record<string, string>) => {
    setConversations((prev) =>
      prev.map((c) => (results[c.id] ? { ...c, category: results[c.id] } : c))
    );
  }, []);

  const displayedConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const lower = searchQuery.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(lower));
  }, [conversations, searchQuery]);

  return {
    messages: chat.messages,
    isLoading,
    error: chat.error,
    setMessages: chat.setMessages,
    // Real server-side cancel (POST /api/hoot/stop), not the raw SDK stop.
    stop,
    status: chat.status,
    // Re-run the last turn — recovers from a dropped/failed stream.
    regenerate: chat.regenerate,
    // Edit a prior user message and branch the conversation from there.
    editMessage,

    // Tier-3 tool approval; the SDK resumes once every pending approval is answered.
    addToolApprovalResponse: chat.addToolApprovalResponse,

    // Async turn state (chats/{chatId}/stream/current).
    // `toolCallId → machineId → { commandId }` for the running turn ({} when none).
    toolCommands,
    // Cancel a running tool call across every machine it dispatched to.
    cancelTool,
    // Running turn whose heartbeat is >45s old — runner likely killed by a deploy.
    turnStale,
    // A turn is live per the stream doc — the UI suppresses approve/deny while set.
    turnRunning,

    // Scheduled follow-ups on this chat (`cortex-followups`, owner-read), soonest first.
    followups,
    // Cancel one by id — DELETE /api/hoot/followups/{id}.
    cancelFollowup,

    input: inputValue,
    setInput: setInputValue,
    handleSend,

    pendingImages,
    handlePasteImage,
    removePendingImage,

    chatId,
    chatLoadError,
    conversations: displayedConversations,
    loadingConversations,
    startNewChat,
    // Point the open chat at a new selection, in place — no new conversation.
    retargetActiveChat,
    loadChat,
    deleteChat,
    renameChat,

    hasMoreConversations,
    loadingMore,
    loadMoreConversations,

    updateConversationCategories,

    searchQuery,
    setSearchQuery,
  };
}

function generateChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One sidebar row from a chat document — the single parser the history listener
 * and both `loadMore` branches share. DISPLAY ONLY: `loadChat` owns the
 * authoritative, fail-closed target read that a send is addressed with.
 */
function parseConversation(id: string, data: DocumentData): ChatConversation {
  const read = readChatTarget(data);
  const storedType: unknown = data.targetType;
  return {
    id,
    title: data.title || UNTITLED_CHAT_TITLE,
    siteId: data.siteId,
    // Legacy docs predate 'machines' and many predate the field entirely.
    targetType: storedType === 'site' || storedType === 'machines' ? storedType : 'machine',
    targetMachineIds: read.ok ? read.target.machineIds : null,
    targetMachineId: data.targetMachineId || null,
    machineName: data.machineName || null,
    source: data.source || 'user',
    autonomousSummary: data.autonomousSummary || null,
    category: data.category || undefined,
    createdAt: data.createdAt?.toDate?.() || new Date(),
    updatedAt: data.updatedAt?.toDate?.() || new Date(),
  };
}

/**
 * Target fields for the optimistic draft row. An empty selection is legal
 * transiently (D-G, send disabled) but has no encoding, so it is labelled rather
 * than handed to `chatTargetFields`, which throws on it. The row is local: the
 * runner writes the real fields when the chat first persists.
 */
function draftTargetFields(target: HootTarget): ChatTargetFields {
  if (target.machineIds !== null && target.machineIds.length === 0) {
    return {
      targetType: 'machines',
      targetMachineIds: [],
      targetMachineId: null,
      machineName: formatTargetLabel([]),
    };
  }
  return chatTargetFields(target);
}
