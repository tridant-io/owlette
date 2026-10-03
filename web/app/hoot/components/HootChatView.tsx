'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, useMachines } from '@/hooks/useFirestore';
import { useOwletteChat, type ChatConversation, type ChatLoadedTarget } from '@/hooks/useHoot';
import {
  useHootSidebarPrefs,
  HOOT_SIDEBAR_DEFAULT_WIDTH,
  HOOT_SIDEBAR_MAX_WIDTH,
  HOOT_SIDEBAR_MIN_WIDTH,
} from '@/hooks/useHootSidebarPrefs';
import { PageHeader } from '@/components/PageHeader';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Plus, MessageSquare, Trash2, KeyRound, Check, X, Zap, Search, Loader2, Pencil, ChevronRight, ChevronsDownUp, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, RotateCw, Clock, Share2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ChatWindow } from './ChatWindow';
import { ChatInput } from './ChatInput';
import { MachineTargetPicker } from './MachineTargetPicker';
import { HootPowerToggle } from './HootPowerToggle';
import { HootApprovalToggle } from './HootApprovalToggle';
import { ShareChatDialog } from './ShareChatDialog';
import { ConversationResizeHandle } from './ConversationResizeHandle';
import { FallingFeather } from '@/components/FallingFeather';
import { LoadingWord } from '@/components/LoadingWord';
import { isUntitledChat } from '@/lib/hoot/untitledChat';
import {
  SITE_TARGET_ID,
  effectiveFanOut,
  formatTargetLabel,
  normalizeSelection,
  type HootTarget,
} from '@/lib/hoot/target';
import type { LastMachineSelection } from '@/contexts/AuthContext';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { HootIcon } from '@/components/icons/HootIcon';

/** Arrow-key nudge for the sidebar resize handle; Shift multiplies it there. */
const SIDEBAR_RESIZE_STEP = 16;
/**
 * Custom property carrying the conversation panel's width. A variable rather
 * than a plain inline width because a drag writes it straight to the DOM node —
 * see `handleResize`.
 */
const PANEL_WIDTH_VAR = '--hoot-panel-w';

/**
 * Every machine in the site, DYNAMICALLY (`machineIds: null`) — what a chat
 * targets until the user says otherwise, and what a machine added later joins.
 */
const ALL_MACHINES: HootTarget = { machineIds: null };

/**
 * Nothing ticked. Legal while the user is picking (D-G) and while a chat's own
 * target is unreadable — send is refused either way, and it is never persisted
 * or dispatched.
 */
const NO_MACHINES: HootTarget = { machineIds: [] };

/**
 * The cross-device preference (`users/{uid}.lastMachineIds[siteId]`) as a
 * target. Entries predating multi-machine targeting are a single id or the site
 * sentinel; AuthContext has already dropped anything that is neither a string
 * nor a non-empty list of them. `null` means "no usable preference stored".
 */
function storedSelectionToTarget(stored: LastMachineSelection | undefined): HootTarget | null {
  if (typeof stored === 'string') {
    return stored === SITE_TARGET_ID ? ALL_MACHINES : { machineIds: [stored] };
  }
  if (Array.isArray(stored) && stored.length > 0) return { machineIds: [...stored] };
  return null;
}

/** The inverse: "all machines" keeps writing the sentinel old entries used. */
function selectionToStored(target: HootTarget): LastMachineSelection {
  return target.machineIds ?? SITE_TARGET_ID;
}

/**
 * A conversation row's target, for the sidebar. `targetMachineIds` is null both
 * for a site-wide chat and for a doc whose target could not be read, so the
 * stored type breaks the tie rather than labelling an unreadable chat "all
 * machines" — the one label that would overstate its reach.
 */
function conversationTargetLabel(conversation: ChatConversation): string {
  const ids = conversation.targetMachineIds;
  if (ids !== null) {
    // A talon machine chat stores the machine's DISPLAY name rather than its id
    // (`hootOutput.server.ts`), and that is the label it carries everywhere else
    // — both sides of a share included. It stands in for ONE id only: for two or
    // more, the stored name is the same collapsed list `formatTargetLabel`
    // builds, and for a site chat it is `All Machines` in title case.
    if (ids.length === 1 && conversation.machineName) return conversation.machineName;
    return formatTargetLabel(ids);
  }
  if (conversation.targetType === 'site') return formatTargetLabel(null);
  return conversation.machineName || 'unknown machine';
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

/**
 * Forward-looking counterpart to timeAgo, for a follow-up's `runAt`. A due
 * follow-up reads "any moment": the sweep runs on a one-minute cadence, so a
 * countdown that hit zero would sit at "in 0s" until it fires.
 */
function timeUntil(runAtMs: number, nowMs: number): string {
  const seconds = Math.floor((runAtMs - nowMs) / 1000);
  if (seconds <= 0) return 'any moment';
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

/** Group conversations by category for sidebar display. */
function groupConversationsByCategory(
  conversations: ChatConversation[]
): { label: string; conversations: ChatConversation[] }[] {
  const groups: Record<string, ChatConversation[]> = {};

  for (const convo of conversations) {
    const label = convo.category || 'General';
    (groups[label] ??= []).push(convo);
  }

  // Sort groups: most recently updated first, "General" always last
  return Object.entries(groups)
    .sort(([a, aConvos], [b, bConvos]) => {
      if (a === 'General') return 1;
      if (b === 'General') return -1;
      const aLatest = Math.max(...aConvos.map((c) => c.updatedAt.getTime()));
      const bLatest = Math.max(...bConvos.map((c) => c.updatedAt.getTime()));
      return bLatest - aLatest;
    })
    .map(([label, convos]) => ({ label, conversations: convos }));
}

interface HootChatViewProps {
  initialChatId?: string;
}

export function HootChatView({ initialChatId }: HootChatViewProps) {
  const router = useRouter();
  const { user, userSites, isSuperadmin, isSiteAdmin, loading: authLoading, lastSiteId, lastMachineIds, updateLastSite, updateLastMachine } = useAuth();
  const { sites, loading: sitesLoading } = useSites(user?.uid, userSites, isSuperadmin);

  const [currentSiteId, setCurrentSiteId] = useState<string>('');
  // What the user ticked, verbatim. Pruning against the site's machines happens
  // in a memo below, never here: a selection restored from a chat doc arrives
  // before the machine listing it would be pruned against.
  const [selection, setSelection] = useState<HootTarget>(ALL_MACHINES);
  // The chat whose stored target could not be read, if any. Such a chat refuses
  // to build a request body at all (requestBody.ts), so the header says so and
  // send stays off until the user picks machines — never a silent fall back to
  // every machine in the site.
  const [unreadableChatId, setUnreadableChatId] = useState<string | null>(null);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<'profile' | 'hoot'>('profile');
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [categorizingAll, setCategorizingAll] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Sidebar expand/collapse state and width persist per-device to Firestore.
  const {
    sidebarOpen,
    setSidebarOpen,
    collapsedGroups,
    setCollapsedGroups,
    sidebarWidth,
    setSidebarWidth,
    hydrated: prefsHydrated,
  } = useHootSidebarPrefs();
  const panelRef = useRef<HTMLElement>(null);
  // A resize in flight touches the DOM node only and re-renders nothing: this
  // component owns the chat transcript, which re-parses every message's markdown
  // when it renders, so a pointermove routed through React state would have the
  // column trailing the pointer on any real conversation. The width goes on as a
  // custom property, and the transition comes off in the same breath or a 300ms
  // ease would do the trailing instead.
  const handleResize = useCallback((next: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transitionProperty = 'none';
    panel.style.setProperty(PANEL_WIDTH_VAR, `${next}px`);
  }, []);
  // Commit hands the width back to React (and to Firestore) and restores the
  // transition, so collapse/expand still animates.
  const handleResizeCommit = useCallback((next: number) => {
    panelRef.current?.style.removeProperty('transition-property');
    setSidebarWidth(next);
  }, [setSidebarWidth]);
  // Hydration corrects the width (and the collapsed state) a few hundred ms in.
  // With the transition already live that correction plays as a slide on every
  // visit, so it's enabled a frame later — by which time the corrected width has
  // painted.
  const [animatePanel, setAnimatePanel] = useState(false);
  useEffect(() => {
    if (!prefsHydrated) return;
    const raf = requestAnimationFrame(() => setAnimatePanel(true));
    return () => cancelAnimationFrame(raf);
  }, [prefsHydrated]);
  // Below `md` the list moves into a left-slide sheet. Transient on purpose —
  // unlike `sidebarOpen` it is NOT persisted; a sheet that reopened itself every
  // visit would bury the chat behind an overlay.
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);
  // Viewport branch between the desktop aside and the mobile sheet. `md:hidden`
  // is NOT enough — Radix portals overlay + content into document.body, escaping
  // wrapper classes — and JS gating keeps the list mounted on exactly ONE surface,
  // which the single sidebarScrollRef / loadMoreSentinelRef require. Starts `true`
  // so SSR and hydration agree; the effect corrects it on mount.
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    const onChange = () => {
      sync();
      // Crossing up to desktop unmounts the sheet; clear the flag so coming back
      // down doesn't reopen it over the chat.
      if (mq.matches) setMobileConversationsOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const { machines, loading: machinesLoading } = useMachines(currentSiteId);

  const siteMachineIds = useMemo(() => machines.map((m) => m.machineId), [machines]);
  // An EMPTY listing counts as "not known yet", not as "this site has none":
  // the listener returns empty for a site still attaching (and for every render
  // with no Firestore configured), and pruning against it would empty a valid
  // selection. A site that really has no machines can't be sent to anyway.
  const machinesLoaded = !machinesLoading && machines.length > 0;
  // The header's selection as it applies to THIS site: ids that have left it
  // drop out, and a set covering every machine collapses back to the dynamic
  // "all". A memo, not an effect — deriving state in an effect is both a render
  // loop and a lint error (react-hooks/set-state-in-effect).
  const siteSelection = useMemo(
    () => normalizeSelection(selection, siteMachineIds, machinesLoaded),
    [selection, siteMachineIds, machinesLoaded],
  );
  // One shape for the picker and the composer's `@` vocabulary. `cortexEnabled`
  // is the kill switch (absent means on, matching the server's default).
  const machineOptions = useMemo(
    () =>
      machines.map((m) => ({
        id: m.machineId,
        online: m.online,
        hootEnabled: m.cortexEnabled !== false,
      })),
    [machines],
  );

  // Set once a loaded chat has handed over its own selection, so the stored
  // preference below can't overwrite it when the sites list resolves late. The
  // pin — not the header — addresses a send, so a header that disagreed with it
  // would name machines the next turn doesn't reach.
  const selectionAdoptedRef = useRef(false);

  // Site of a deep-linked chat the header could not follow yet, applied below
  // once the sites listing lands. A chat read is ONE Firestore hop and fires on
  // mount; `useSites` is two behind it (the user doc and the membership listener
  // first), so on a cold load `sites` is still empty when the chat arrives and
  // "is this site one of mine" cannot be answered. Dropping the site there left
  // the header on `lastSiteId` with the chat's own machines pruned away against
  // it — a conversation open with send disabled and a picker naming another
  // site's machines.
  const pendingChatSiteIdRef = useRef<string | null>(null);

  // Load saved site from Firestore (cross-browser) or localStorage (same-browser fallback)
  useEffect(() => {
    if (sites.length === 0 || currentSiteId) return;

    // A chat the URL points at outranks the stored preference: it is the thing
    // on screen, and its machines are the ones the picker has to show.
    const pendingChatSiteId = pendingChatSiteIdRef.current;
    if (pendingChatSiteId && sites.some((s) => s.id === pendingChatSiteId)) {
      pendingChatSiteIdRef.current = null;
      setCurrentSiteId(pendingChatSiteId);
      return;
    }

    const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
    const siteId = savedSite && sites.some((s) => s.id === savedSite) ? savedSite : sites[0].id;
    setCurrentSiteId(siteId);
    if (selectionAdoptedRef.current) return;
    const stored = storedSelectionToTarget(lastMachineIds[siteId]);
    if (stored) setSelection(stored);
  }, [sites, currentSiteId, lastSiteId, lastMachineIds]);

  const handleSiteChange = (siteId: string) => {
    const nextSelection = storedSelectionToTarget(lastMachineIds[siteId]) ?? ALL_MACHINES;
    setCurrentSiteId(siteId);
    setSelection(nextSelection);
    updateLastSite(siteId);
    // Start a fresh chat. Unlike a change of TARGET — which continues the
    // conversation in place — the active chat is bound to the OLD site (it has
    // already left the sidebar and can't be sent to), so keeping it in front
    // only invites a cross-site send (OWL-48).
    handleNewChat({ siteId, selection: nextSelection });
  };

  const suppressNextChatRouteRef = useRef(false);
  const skipNextLandingResetRef = useRef(false);
  // Id of the routed chat we've navigated away from while the URL still points at
  // it. router.push is async, so initialChatId lags at the stale id while
  // activeChatId is already the new chat, and reloading it would steal selection.
  // A boolean flag is insufficient: the load effect re-runs on *every* render
  // (useChat rebuilds `loadChat` each time), so it would be spent before the
  // pathname commits. Cleared once initialChatId moves off this id.
  const staleRoutedChatIdRef = useRef<string | null>(null);
  const previousChatIdRef = useRef<string | null>(null);
  const previousInitialChatIdRef = useRef<string | undefined>(initialChatId);

  const handleChatPersisted = useCallback((persistedChatId: string) => {
    if (!initialChatId) {
      router.replace(`/hoot/${encodeURIComponent(persistedChatId)}`);
    }
  }, [initialChatId, router]);

  // A chat carries its own target: adopt it into the header so the picker shows
  // what the next turn in THIS conversation will reach. Deliberately not
  // persisted — opening a conversation is not a change of preference.
  const handleChatLoaded = useCallback((loaded: ChatLoadedTarget) => {
    // A deep link can point at a chat in another site. Follow it in the header
    // rather than showing this site's machines beside that chat's transcript —
    // the conversation stays pinned to its own site either way (OWL-48), and
    // following it must NOT start a new chat. Before the sites listing lands the
    // header can't move yet, so the site is remembered and the restore effect
    // above applies it.
    if (loaded.siteId && loaded.siteId !== currentSiteId) {
      if (sites.some((s) => s.id === loaded.siteId)) {
        pendingChatSiteIdRef.current = null;
        setCurrentSiteId(loaded.siteId);
      } else {
        pendingChatSiteIdRef.current = loaded.siteId;
      }
    } else {
      pendingChatSiteIdRef.current = null;
    }
    if (loaded.target === 'invalid') {
      // The picker ticks NOTHING for this chat (see `target` below) — it must
      // not show machines this chat would reach, least of all "all machines".
      // The site selection underneath is deliberately left standing: it is what
      // the NEXT conversation starts from, and the paths that start one from
      // here (browser-back, deleting this chat) never reach `handleNewChat`.
      setUnreadableChatId(loaded.chatId);
      return;
    }
    // Only a chat that HAS a readable selection hands one over; an unreadable
    // one must still let the site's stored preference land underneath it.
    selectionAdoptedRef.current = true;
    setUnreadableChatId(null);
    setSelection(loaded.target);
  }, [currentSiteId, sites]);

  const chat = useOwletteChat({
    siteId: currentSiteId,
    // The SITE selection, not what the picker shows: this is what a new chat is
    // pinned from, and the paths that start one without going through
    // `handleNewChat` (the landing reset, `deleteChat`) read exactly this. An
    // unreadable chat's empty picker is display state and must not follow them
    // into the next conversation.
    selection: siteSelection,
    siteMachineIds,
    onChatPersisted: handleChatPersisted,
    onChatLoaded: handleChatLoaded,
  });
  const activeChatId = chat.chatId;
  const loadChat = chat.loadChat;
  const retargetActiveChat = chat.retargetActiveChat;

  // Scoped to the chat it was read from, so it retires with that conversation:
  // starting, deleting or opening another chat drops it without a reset of its
  // own — including the browser-back landing reset, which never goes through
  // handleNewChat.
  const targetUnreadable = unreadableChatId !== null && unreadableChatId === chat.chatId;

  // What the picker shows and what the next turn in THIS chat reaches. A chat
  // whose stored target could not be read ticks nothing — derived rather than
  // written into `selection`, so leaving that conversation restores the site's
  // selection instead of carrying an empty picker into the next one.
  const target = targetUnreadable ? NO_MACHINES : siteSelection;

  // Keep the open chat's pin in step with a selection the SITE pruned. The pin
  // is what a send is addressed with (OWL-48) and nothing else re-reads it, so
  // a stored preference — or a chat's own stored target — naming a machine that
  // has since left the site would otherwise sit there while the picker showed
  // only the survivors, and every turn in that chat would 400 on the unknown id
  // with nothing on screen to explain it.
  //
  // `normalizeSelection` returns the SAME object when it changed nothing
  // (target.ts), so this fires exactly when pruning happened; `retargetActiveChat`
  // writes a ref, so there is no render to loop on, and its own guard leaves a
  // chat pinned to another site alone. Two cases are skipped because re-aiming
  // them would replace a specific refusal with a vaguer one: an unreadable chat,
  // whose pin is the fail-closed `'invalid'`, and a selection that pruned away
  // to NOTHING, which has no encoding at all (D-G) and already shows as "pick at
  // least one machine to send" with send disabled.
  useEffect(() => {
    if (!machinesLoaded || targetUnreadable || siteSelection === selection) return;
    if (siteSelection.machineIds !== null && siteSelection.machineIds.length === 0) return;
    retargetActiveChat(siteSelection);
  }, [machinesLoaded, retargetActiveChat, selection, siteSelection, targetUnreadable]);

  // Ticking a machine re-aims the conversation you are in: same id, same
  // history, and the NEXT turn goes to the new set. It must never call
  // handleNewChat — that was the one-target-per-chat model, where the only way
  // to change target was to abandon the conversation.
  const handleTargetChange = useCallback((next: HootTarget) => {
    setSelection(next);
    // The user has now said what this chat targets, so the unreadable stored
    // one no longer decides anything.
    setUnreadableChatId(null);
    // D-G: an empty set is a transient picking state, never a preference.
    const isEmpty = next.machineIds !== null && next.machineIds.length === 0;
    if (currentSiteId && !isEmpty) {
      updateLastMachine(currentSiteId, selectionToStored(next));
    }
    retargetActiveChat(next);
  }, [currentSiteId, retargetActiveChat, updateLastMachine]);

  // Which machines this selection points at. "All" is dynamic, so it is the
  // whole listing — including any machine that joined the site since.
  const targetedMachines = useMemo(() => {
    const ids = target.machineIds;
    return ids === null ? machines : machines.filter((m) => ids.includes(m.machineId));
  }, [machines, target]);

  // The single-machine path — process context in the prompt, unwrapped tool
  // output, the power toggle and the exact offline copy — keys off the
  // EFFECTIVE set, which is how a ONE-MACHINE SITE keeps it while showing "all
  // machines" (the same rule the server resolves a turn with).
  const singleTargetMachine =
    !effectiveFanOut(target, machines.length) && targetedMachines.length === 1
      ? targetedMachines[0]
      : null;

  // `[]` is legal while the user is picking (D-G) — with send disabled, and
  // never persisted or sent.
  const isEmptySelection = target.machineIds !== null && target.machineIds.length === 0;
  const sendDisabled = targetUnreadable || isEmptySelection;

  const targetWarning = useMemo((): string | null => {
    if (targetUnreadable) return 'pick machines for this chat — its saved target could not be read';
    if (isEmptySelection) return 'pick at least one machine to send';
    // Nothing to say about reachability until this site's machines are known.
    if (targetedMachines.length === 0) return null;

    if (singleTargetMachine) {
      // Pinned verbatim by e2e, and the copy this screen has always shown for a
      // single machine.
      if (!singleTargetMachine.online) {
        return 'machine is offline — tool calls will not be delivered';
      }
      if (singleTargetMachine.cortexEnabled === false) {
        return 'hoot is off on this machine — tool calls will not be delivered';
      }
      return null;
    }

    const offline = targetedMachines.filter((m) => !m.online).length;
    const hootOff = targetedMachines.filter((m) => m.online && m.cortexEnabled === false).length;
    const skipped = offline + hootOff;
    if (skipped === 0) return null;
    if (skipped === targetedMachines.length) {
      return hootOff === 0
        ? 'no machines online — tool calls will not be delivered'
        : 'no machines with hoot on are online — tool calls will not be delivered';
    }
    return `${skipped} of ${targetedMachines.length} machines will be skipped — offline or hoot off`;
  }, [targetUnreadable, isEmptySelection, targetedMachines, singleTargetMachine]);

  useEffect(() => {
    // Pathname committed (initialChatId moved off the stale id) — navigation
    // window over, so retire the guard.
    if (staleRoutedChatIdRef.current !== null && initialChatId !== staleRoutedChatIdRef.current) {
      staleRoutedChatIdRef.current = null;
    }
    if (!initialChatId || initialChatId === activeChatId) return;
    // Stale id from an in-flight navigation; reloading it would steal selection
    // from the just-created chat.
    if (initialChatId === staleRoutedChatIdRef.current) return;
    void loadChat(initialChatId);
  }, [initialChatId, activeChatId, loadChat]);

  useEffect(() => {
    const previousChatId = previousChatIdRef.current;
    previousChatIdRef.current = activeChatId;

    if (!previousChatId || previousChatId === activeChatId) return;
    if (suppressNextChatRouteRef.current) {
      suppressNextChatRouteRef.current = false;
      return;
    }

    if (initialChatId && activeChatId !== initialChatId) {
      router.replace(`/hoot/${encodeURIComponent(activeChatId)}`);
    }
  }, [activeChatId, initialChatId, router]);

  // Landing transition: URL going from a routed chat back to /hoot (browser back,
  // or a deletion) starts a fresh chat. Skipped when handleNewChat /
  // handleDeleteChat already started one. The persistent layout never remounts
  // this component, so it fires on the initialChatId prop change, not on mount.
  useEffect(() => {
    const previousInitialChatId = previousInitialChatIdRef.current;
    previousInitialChatIdRef.current = initialChatId;

    if (initialChatId || !previousInitialChatId) return;
    if (skipNextLandingResetRef.current) {
      skipNextLandingResetRef.current = false;
      return;
    }

    suppressNextChatRouteRef.current = true;
    chat.startNewChat();
  }, [chat, initialChatId]);

  // Reset error dismissed state when a new error arrives
  useEffect(() => {
    if (chat.error) setErrorDismissed(false);
  }, [chat.error]);

  // Per-commandId cancel-in-flight state. Lives here (next to the async
  // handler) — ChatWindow just derives a per-card boolean from the Set.
  const [cancelPendingCommandIds, setCancelPendingCommandIds] = useState<Set<string>>(new Set());
  const cancelTool = chat.cancelTool;
  const handleCancelTool = useCallback(async (commandId: string) => {
    setCancelPendingCommandIds((prev) => {
      const next = new Set(prev);
      next.add(commandId);
      return next;
    });
    try {
      await cancelTool(commandId);
    } finally {
      setCancelPendingCommandIds((prev) => {
        const next = new Set(prev);
        next.delete(commandId);
        return next;
      });
    }
  }, [cancelTool]);

  // Per-followupId cancel-in-flight state, mirroring the tool-cancel pair above.
  const [cancelPendingFollowupIds, setCancelPendingFollowupIds] = useState<Set<string>>(new Set());
  const cancelFollowup = chat.cancelFollowup;
  const handleCancelFollowup = useCallback(async (followupId: string) => {
    setCancelPendingFollowupIds((prev) => {
      const next = new Set(prev);
      next.add(followupId);
      return next;
    });
    try {
      await cancelFollowup(followupId);
    } finally {
      setCancelPendingFollowupIds((prev) => {
        const next = new Set(prev);
        next.delete(followupId);
        return next;
      });
    }
  }, [cancelFollowup]);

  // Clock for the chips' relative time, which would otherwise freeze at the render
  // that created them. Only ticks while a follow-up is actually scheduled.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasFollowups = chat.followups.length > 0;
  useEffect(() => {
    if (!hasFollowups) return;
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [hasFollowups]);

  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  const handleNewChat = useCallback((overrides?: { siteId?: string; selection?: HootTarget }) => {
    // The sheet is the only route to "new conversation" on mobile, so starting one
    // must dismiss it. No-op on desktop, where the flag is never set.
    setMobileConversationsOpen(false);
    if (initialChatId) {
      // Back to the landing URL until the chat persists (handleChatPersisted
      // replaces to /hoot/{id}). suppress stops the URL-sync effect pushing the
      // unsaved id; skipNextLandingReset stops a *second* new chat.
      suppressNextChatRouteRef.current = true;
      skipNextLandingResetRef.current = true;
      staleRoutedChatIdRef.current = initialChatId;
      router.push('/hoot');
    }

    // No selection override for the unreadable case: the empty picker is
    // display state, and the hook already holds this site's selection — the
    // same value the landing reset and `deleteChat` start their chat from.
    chat.startNewChat(overrides);
    sidebarScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [chat, initialChatId, router]);

  const handleConversationClick = useCallback((conversationId: string) => {
    // Mobile: picking a conversation means the user is done with the list.
    setMobileConversationsOpen(false);
    // Expand the selected conversation's group so its row is actually visible.
    const convo = conversationsRef.current.find((c) => c.id === conversationId);
    if (convo && !isUntitledChat(convo.title)) {
      const label = convo.category || 'General';
      setCollapsedGroups((prev) => {
        if (!prev.has(label)) return prev;
        const next = new Set(prev);
        next.delete(label);
        return next;
      });
    }
    router.push(`/hoot/${encodeURIComponent(conversationId)}`);
  }, [router, setCollapsedGroups]);

  const handleDeleteChat = useCallback((conversationId: string) => {
    const deletedRouteChat = conversationId === initialChatId;
    if (deletedRouteChat) {
      suppressNextChatRouteRef.current = true;
      skipNextLandingResetRef.current = true;
      staleRoutedChatIdRef.current = conversationId;
    }

    void chat.deleteChat(conversationId);

    if (deletedRouteChat) {
      router.replace('/hoot');
    }
  }, [chat, initialChatId, router]);

  // Infinite scroll: auto-load more conversations when the sentinel scrolls into view
  const { hasMoreConversations, loadingMore, loadMoreConversations } = chat;
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const root = sidebarScrollRef.current;
    if (!sentinel || !root || !hasMoreConversations || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreConversations();
      },
      { root, rootMargin: '200px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `isDesktop` / `mobileConversationsOpen` are deps though unread: they decide
    // WHICH surface holds the scroller and sentinel, and remounting the list swaps
    // the nodes these refs point at — without them the observer binds a detached
    // node (or never attaches when the list first mounts inside the sheet).
  }, [hasMoreConversations, loadingMore, loadMoreConversations, isDesktop, mobileConversationsOpen]);

  // Latest conversations, readable from event handlers without re-subscribing.
  const conversationsRef = useRef(chat.conversations);
  conversationsRef.current = chat.conversations;

  // Nudge the active conversation row into view when the active chat changes, and
  // when the list moves between the desktop aside and the mobile sheet so a
  // freshly-opened sheet lands on the current conversation. DOM only, no state.
  useEffect(() => {
    if (!chat.chatId) return;
    const raf = requestAnimationFrame(() => {
      sidebarScrollRef.current
        ?.querySelector<HTMLElement>('[data-active-conversation="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [chat.chatId, isDesktop, mobileConversationsOpen]);

  // Skip "new conversation" entries — the API requires a title or first message to categorize
  const uncategorizedIds = chat.conversations
    .filter((c) => !c.category && !isUntitledChat(c.title))
    .map((c) => c.id);

  // Drive collapse-all/expand-all off the *actual* visible group labels so the
  // icon and the action never disagree.
  const visibleGroupLabels = groupConversationsByCategory(
    chat.conversations.filter((c) => !isUntitledChat(c.title)),
  ).map((g) => g.label);
  const allGroupsCollapsed =
    visibleGroupLabels.length > 0 && visibleGroupLabels.every((l) => collapsedGroups.has(l));

  // Category of the active conversation — flags a collapsed section holding it.
  const activeConvo = chat.conversations.find((c) => c.id === chat.chatId);
  const activeCategoryLabel = activeConvo && !isUntitledChat(activeConvo.title)
    ? (activeConvo.category || 'General')
    : null;

  // A share freezes this conversation as it stands, so it needs one that exists,
  // has something in it, and has nothing in flight — a snapshot taken mid-turn
  // would publish a half-written reply and a tool call with no outcome.
  // Autonomous chats are out entirely: they have no owner, and the share routes
  // authorize the chat's owner and nobody else.
  const canShare = Boolean(
    currentSiteId &&
    activeConvo &&
    activeConvo.source !== 'autonomous' &&
    chat.messages.length > 0 &&
    !chat.isLoading &&
    !chat.turnRunning
  );

  const categorizeAll = async () => {
    if (categorizingAll || uncategorizedIds.length === 0) return;
    setCategorizingAll(true);
    try {
      const res = await fetch('/api/hoot/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatIds: uncategorizedIds, siteId: currentSiteId }),
      });
      // Patch locally: loadMore conversations aren't watched by the snapshot listener.
      if (res.ok) {
        const { results } = await res.json() as { results: Record<string, string> };
        if (results && Object.keys(results).length > 0) {
          chat.updateConversationCategories(results);
        }
      }
    } catch {
      // silent
    } finally {
      setCategorizingAll(false);
    }
  };

  // Has this user configured an LLM API key? Only their OWN key can run a chat —
  // a leftover `sites/{siteId}/settings/llm` doc must not answer this.
  useEffect(() => {
    if (!user || !db) return;
    async function checkApiKey() {
      try {
        const userKeyDoc = await getDoc(doc(db!, 'users', user!.uid, 'settings', 'llm'));
        setHasApiKey(userKeyDoc.exists());
      } catch {
        // If we can't read the settings doc, assume no key configured
        setHasApiKey(false);
      }
    }
    checkApiKey();
  }, [user, accountSettingsOpen]);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  const showConversationNotFound = Boolean(initialChatId && chat.chatLoadError === 'not_found');

  // The desktop aside animates its width ↔ `0`, so children carry that width as a
  // fixed size to stop content reflowing mid-collapse — from the same variable
  // the aside uses, so a drag moves them with it. In the sheet the shell owns the
  // width and a fixed child would leave a gap.
  const conversationPanelClass = isDesktop ? '' : 'w-full min-w-0';
  const conversationPanelStyle = isDesktop
    ? { width: `var(${PANEL_WIDTH_VAR})`, minWidth: `var(${PANEL_WIDTH_VAR})` }
    : undefined;

  if (authLoading || sitesLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <FallingFeather />
        <div className="text-muted-foreground"><LoadingWord /></div>
      </div>
    );
  }

  if (!user) return null;

  return (
    // `h-dvh`, not `h-screen`: on iOS Safari `100vh` is the URL-bar-collapsed
    // height, so the shell overflows and pushes the composer below the fold.
    <div className="h-dvh flex flex-col">
      <PageHeader
        currentPage="hoot"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => {}}
        onAccountSettings={() => setAccountSettingsOpen(true)}
      />

      <div className="flex-1 flex min-h-0 relative max-w-screen-2xl mx-auto w-full gap-3 p-3 md:p-4">

        {/* No API key overlay */}
        {hasApiKey === false && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="text-center max-w-md px-4">
              <HootIcon className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">hoot</h3>
              <p className="text-sm text-muted-foreground mb-6">
                debug, diagnose, and manage your remote machines.
              </p>
              <div className="rounded-lg border border-border bg-secondary p-5">
                <KeyRound className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground mb-3">
                  hoot requires an LLM API key. add your anthropic or openai key in account settings.
                </p>
                <button
                  onClick={() => { setSettingsInitialSection('hoot'); setAccountSettingsOpen(true); }}
                  className="text-xs px-4 py-2 rounded-md bg-accent-cyan text-primary-foreground font-medium hover:bg-accent-cyan/90 transition-colors cursor-pointer"
                >
                  open account settings
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Conversation list. Above `md` this is the collapsible aside beside
            the chat; below it, the same children render inside a left-slide
            sheet reached from the header button. Exactly one surface mounts at
            a time — see ConversationPanelShell. */}
        <ConversationPanelShell
          isDesktop={isDesktop}
          sidebarOpen={sidebarOpen}
          width={sidebarWidth}
          animate={animatePanel}
          panelRef={panelRef}
          mobileOpen={mobileConversationsOpen}
          onMobileOpenChange={setMobileConversationsOpen}
          resizeHandle={
            <ConversationResizeHandle
              width={sidebarWidth}
              min={HOOT_SIDEBAR_MIN_WIDTH}
              max={HOOT_SIDEBAR_MAX_WIDTH}
              step={SIDEBAR_RESIZE_STEP}
              defaultWidth={HOOT_SIDEBAR_DEFAULT_WIDTH}
              onResize={handleResize}
              onCommit={handleResizeCommit}
            />
          }
        >
          <div
            className={`${conversationPanelClass} h-12 px-2 border-b border-border flex items-center gap-1`}
            style={conversationPanelStyle}
          >
            {searchOpen ? (
              /* Search mode: compact new chat + expanded input */
              <>
                <Button
                  onClick={() => handleNewChat()}
                  variant="ghost"
                  size="icon"
                  aria-label="new hoot"
                  className="h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    autoFocus
                    placeholder="search..."
                    aria-label="search conversations"
                    value={chat.searchQuery}
                    onChange={(e) => chat.setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        chat.setSearchQuery('');
                        setSearchOpen(false);
                      }
                    }}
                    className="h-8 pl-7 pr-7 text-base md:text-xs bg-secondary border-border"
                  />
                  <IconButton
                    label="close search"
                    tooltip={false}
                    variant="ghost"
                    onClick={() => { chat.setSearchQuery(''); setSearchOpen(false); }}
                    className="absolute right-0.5 top-1/2 -translate-y-1/2 size-7 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </IconButton>
                </div>
              </>
            ) : (
              /* Default: new conversation button + section toggle + search icon */
              <>
                <Button
                  onClick={() => handleNewChat()}
                  variant="ghost"
                  size="sm"
                  className="flex-1 min-w-0 h-8 justify-start text-foreground"
                >
                  <Plus className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">new hoot</span>
                </Button>
                {!chat.searchQuery && chat.conversations.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={() => {
                          setCollapsedGroups(allGroupsCollapsed ? new Set() : new Set(visibleGroupLabels));
                        }}
                        variant="ghost"
                        size="icon"
                        aria-label={allGroupsCollapsed ? 'expand conversation groups' : 'collapse conversation groups'}
                        className="h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                      >
                        {allGroupsCollapsed ? (
                          <ChevronsUpDown className="h-4 w-4" />
                        ) : (
                          <ChevronsDownUp className="h-4 w-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{allGroupsCollapsed ? 'expand all' : 'collapse all'}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={() => setSearchOpen(true)}
                      variant="ghost"
                      size="icon"
                      aria-label="search conversations"
                      className="h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                    >
                      <Search className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>search conversations</p>
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>

          <div
            ref={sidebarScrollRef}
            className={`${conversationPanelClass} flex-1 overflow-y-auto ${isDesktop ? 'border-r border-border' : ''}`}
            style={conversationPanelStyle}
          >
            {chat.conversations.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {chat.searchQuery ? 'no matches' : 'no conversations yet'}
              </div>
            ) : chat.searchQuery ? (
              /* Flat list when searching — no grouping */
              <div className="py-1">
                {chat.conversations.map((convo) => (
                  <ConversationItem
                    key={convo.id}
                    conversation={convo}
                    isActive={convo.id === chat.chatId}
                    onClick={() => handleConversationClick(convo.id)}
                    onDelete={() => handleDeleteChat(convo.id)}
                    onRename={(title) => chat.renameChat(convo.id, title)}
                  />
                ))}
              </div>
            ) : (
              /* New conversations pinned to top, then grouped by category */
              <div className="py-1">
                {/* Unsaved "New conversation" entries always at top */}
                {chat.conversations
                  .filter((c) => isUntitledChat(c.title))
                  .map((convo) => (
                    <ConversationItem
                      key={convo.id}
                      conversation={convo}
                      isActive={convo.id === chat.chatId}
                      onClick={() => handleConversationClick(convo.id)}
                      onDelete={() => handleDeleteChat(convo.id)}
                      onRename={(title) => chat.renameChat(convo.id, title)}
                    />
                  ))}
                {groupConversationsByCategory(
                  chat.conversations.filter((c) => !isUntitledChat(c.title))
                ).map((group) => {
                  const isCollapsed = collapsedGroups.has(group.label);
                  // Highlight the header of the group holding the active chat.
                  const containsActive = group.label === activeCategoryLabel;
                  return (
                    <Collapsible
                      key={group.label}
                      open={!isCollapsed}
                      onOpenChange={(open) => setCollapsedGroups((prev) => {
                        const next = new Set(prev);
                        if (open) next.delete(group.label);
                        else next.add(group.label);
                        return next;
                      })}
                    >
                      <CollapsibleTrigger asChild>
                        <button
                          // btn-sweep, not a flat hover tint: these are the only
                          // clickable rows in the sidebar that were fading in a
                          // colour while every Button in the app sweeps.
                          className="btn-sweep w-full flex items-center gap-1 px-3 py-2.5 mt-1.5 first:mt-0 cursor-pointer"
                        >
                          <ChevronRight className={`h-3 w-3 transition-transform ${isCollapsed ? '' : 'rotate-90'} ${containsActive ? 'text-accent-cyan' : 'text-muted-foreground/50'}`} />
                          <span className={`text-xs font-medium uppercase tracking-wider ${containsActive ? 'text-accent-cyan' : 'text-muted-foreground'}`}>
                            {group.label}
                          </span>
                          {containsActive && isCollapsed && (
                            <>
                              <span className="h-1.5 w-1.5 rounded-full bg-accent-cyan flex-shrink-0" aria-hidden />
                              <span className="sr-only">contains the current conversation</span>
                            </>
                          )}
                          <span className="text-xs text-muted-foreground dark:text-muted-foreground/80 ml-auto">
                            {group.conversations.length}
                          </span>
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
                        {group.conversations.map((convo) => (
                          <ConversationItem
                            key={convo.id}
                            conversation={convo}
                            isActive={convo.id === chat.chatId}
                            onClick={() => handleConversationClick(convo.id)}
                            onDelete={() => handleDeleteChat(convo.id)}
                            onRename={(title) => chat.renameChat(convo.id, title)}
                          />
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}

                {/* Categorize uncategorized conversations */}
                {uncategorizedIds.length > 0 && (
                  <div className="py-2 text-center border-t border-border/50 mt-1">
                    <button
                      onClick={categorizeAll}
                      disabled={categorizingAll}
                      className="text-sm text-accent-cyan hover:text-accent-cyan-hover transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      {categorizingAll ? (
                        <><Loader2 className="h-3 w-3 animate-spin" /> categorizing {uncategorizedIds.length}...</>
                      ) : (
                        <>categorize {uncategorizedIds.length} unsorted</>
                      )}
                    </button>
                  </div>
                )}

                {/* Infinite scroll sentinel + loading indicator */}
                {chat.hasMoreConversations && (
                  <div
                    ref={loadMoreSentinelRef}
                    className="py-3 flex items-center justify-center"
                    aria-hidden={!chat.loadingMore}
                  >
                    {chat.loadingMore && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/50" />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </ConversationPanelShell>

        {/* Main Chat Area */}
        <main className="flex-1 flex flex-col min-h-0 rounded-lg border border-border bg-card overflow-hidden">
          <h1 className="sr-only">hoot</h1>
          {/* Machine selector bar — matches sidebar header height above `md`
              (`md:h-12` + `md:py-0` keep that row pixel-identical). Below it the
              row wraps instead: the target selector, the offline warning and the
              approval/power toggles cannot share a single 366px line. */}
          <div className="min-h-12 md:h-12 px-3 py-2 md:py-0 border-b border-border flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-2">
            {/* Two icon controls, one per breakpoint: below `md` the only entry
                point to conversation history and "new conversation" (both live
                in the sheet at that width), above it the sidebar collapse. Both
                take the same props and classes as the sidebar header's search
                and collapse-all icons — one family of icon controls across the
                two panes, sharing the ghost sweep and the 32px box instead of
                each holding a hover tint of its own. */}
            <Button
              onClick={() => setMobileConversationsOpen(true)}
              variant="ghost"
              size="icon"
              aria-label="conversations"
              className="md:hidden h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => setSidebarOpen((prev) => !prev)}
                  variant="ghost"
                  size="icon"
                  aria-label={sidebarOpen ? 'hide hoot sidebar' : 'show hoot sidebar'}
                  className="hidden md:inline-flex h-8 w-8 min-w-8 text-muted-foreground hover:text-foreground"
                >
                  {sidebarOpen ? (
                    <PanelLeftClose className="h-4 w-4" />
                  ) : (
                    <PanelLeftOpen className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{sidebarOpen ? 'hide sidebar' : 'show sidebar'}</p>
              </TooltipContent>
            </Tooltip>
            <MachineTargetPicker
              machines={machineOptions}
              selection={target}
              onChange={handleTargetChange}
            />

            {targetWarning && (
              <span className="min-w-0 text-xs text-warning">{targetWarning}</span>
            )}

            <div className="ml-auto flex items-center gap-2">
              {canShare && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="share conversation"
                      onClick={() => setShareOpen(true)}
                    >
                      <Share2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>share</p>
                  </TooltipContent>
                </Tooltip>
              )}
              {currentSiteId && isSiteAdmin(currentSiteId) && (
                <HootApprovalToggle siteId={currentSiteId} />
              )}
              {currentSiteId && singleTargetMachine && (
                <HootPowerToggle siteId={currentSiteId} machine={singleTargetMachine} />
              )}
            </div>
          </div>

          {/* Messages */}
          {showConversationNotFound ? (
            <ConversationNotFoundState onStartNew={() => handleNewChat()} />
          ) : (
            <ChatWindow
              messages={chat.messages}
              isLoading={chat.isLoading}
              hasApiKey={hasApiKey}
              onOpenSettings={() => setAccountSettingsOpen(true)}
              onToolApproval={(id, approved) => chat.addToolApprovalResponse({ id, approved })}
              onEditMessage={chat.editMessage}
              /* Fallback only: a message stamped with its own turn metadata
                 names the machines THAT turn reached (5.3). This labels the
                 older ones, which carry none. */
              approvalTargetLabel={formatTargetLabel(target.machineIds)}
              toolCommands={chat.toolCommands}
              onCancelTool={handleCancelTool}
              cancelPendingCommandIds={cancelPendingCommandIds}
              turnStale={chat.turnStale}
              turnRunning={chat.turnRunning}
              turnErrored={Boolean(chat.error)}
            />
          )}

          {/* Error display */}
          {chat.error && !errorDismissed && (
            <div role="alert" className="px-4 py-2 bg-danger-surface border-t border-danger-border/50">
              <div className="flex items-center gap-2 max-w-3xl mx-auto">
                <p className="text-xs text-danger flex-1">
                  {(() => {
                    const msg = chat.error?.message || 'Unknown error';
                    try {
                      const parsed = JSON.parse(msg);
                      return parsed.error || msg;
                    } catch {
                      return msg;
                    }
                  })()}
                </p>
                {/* Re-run the failed turn: regenerate() drops the interrupted
                    assistant message (and any stuck "executing…" tool card) and
                    streams a fresh response from the last user message. */}
                <button
                  onClick={() => { setErrorDismissed(true); void chat.regenerate(); }}
                  className="flex items-center gap-1 text-xs text-danger hover:text-foreground transition-colors cursor-pointer flex-shrink-0"
                >
                  <RotateCw className="h-3 w-3" />
                  retry
                </button>
                <button
                  onClick={() => setErrorDismissed(true)}
                  aria-label="dismiss error"
                  className="text-danger hover:text-foreground transition-colors cursor-pointer flex-shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Scheduled follow-ups on this chat. The hook's subscription is live, so a
              chip clears itself the moment the sweep fires or a cancel lands — nothing
              here is optimistic. */}
          {!showConversationNotFound && chat.followups.length > 0 && (
            <div className="px-4 pt-3 flex flex-wrap items-center gap-2">
              {chat.followups.map((followup) => {
                const pending = cancelPendingFollowupIds.has(followup.id);
                const when = followup.runAtMs !== null ? timeUntil(followup.runAtMs, nowMs) : null;
                return (
                  <span
                    key={followup.id}
                    title={followup.note || undefined}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    <Clock className="h-3 w-3 flex-shrink-0" />
                    <span>
                      follow-up scheduled{when ? ` · ${when}` : ''} ·{' '}
                      <button
                        type="button"
                        onClick={() => { void handleCancelFollowup(followup.id); }}
                        disabled={pending}
                        aria-label={followup.note ? `cancel follow-up: ${followup.note}` : 'cancel follow-up'}
                        className="inline-flex items-center gap-1 align-middle hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {pending && <Loader2 className="h-3 w-3 animate-spin" />}
                        cancel
                      </button>
                    </span>
                  </span>
                );
              })}
            </div>
          )}

          {/* Input */}
          {!showConversationNotFound && (
            <ChatInput
              input={chat.input}
              isLoading={chat.isLoading}
              onInputChange={(e) => chat.setInput(e.target.value)}
              onSubmit={(e) => {
                e.preventDefault();
                chat.handleSend();
              }}
              onStop={chat.stop}
              pendingImages={chat.pendingImages}
              onPasteImage={chat.handlePasteImage}
              onRemoveImage={chat.removePendingImage}
              mentionOptions={machineOptions}
              /* No target, no send: an empty selection has no encoding and an
                 unreadable one refuses to build a body at all (requestBody.ts).
                 `targetWarning` beside the picker says which it is. */
              sendDisabled={sendDisabled}
              /* Same label as the picker's trigger — and nothing at all when
                 there is no target to name, so the field never reads "ask no
                 machines anything". */
              targetLabel={sendDisabled ? undefined : formatTargetLabel(target.machineIds)}
            />
          )}
        </main>
      </div>

      {/* Dialogs */}
      <ShareChatDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        chatId={chat.chatId}
        siteId={currentSiteId}
        title={activeConvo?.title ?? ''}
        targetLabel={activeConvo?.machineName ?? null}
        messages={chat.messages}
      />
      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={(open) => { setAccountSettingsOpen(open); if (!open) setSettingsInitialSection('profile'); }}
        initialSection={settingsInitialSection}
      />
    </div>
  );
}

/**
 * Surface for the conversation list: the collapsible aside above `md`, a
 * left-slide sheet below it (no room for a 256px column beside a usable chat
 * pane, and history / "new conversation" would otherwise be unreachable on a
 * phone).
 *
 * Built on the `@radix-ui/react-dialog` primitives, not `components/ui/dialog` —
 * its `DialogContent` is a centred modal that fights an edge-anchored panel. Esc,
 * overlay-click-to-close and the focus trap come from Radix.
 *
 * The branch is a JS media query, not `md:hidden`, and the branches are mutually
 * exclusive: Radix portals into document.body where wrapper classes don't reach,
 * and the caller's single sidebarScrollRef / loadMoreSentinelRef would point at
 * whichever copy mounted last if both surfaces rendered.
 */
function ConversationPanelShell({
  isDesktop,
  sidebarOpen,
  width,
  animate,
  panelRef,
  mobileOpen,
  onMobileOpenChange,
  resizeHandle,
  children,
}: {
  isDesktop: boolean;
  sidebarOpen: boolean;
  width: number;
  /** Held off until the stored prefs land; a drag kills it on the node itself. */
  animate: boolean;
  panelRef: React.Ref<HTMLElement>;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  resizeHandle: React.ReactNode;
  children: React.ReactNode;
}) {
  if (isDesktop) {
    return (
      // `relative` anchors the resize handle beside the right edge.
      <aside
        ref={panelRef}
        data-testid="hoot-conversation-panel"
        style={{
          [PANEL_WIDTH_VAR]: `${width}px`,
          width: sidebarOpen ? `var(${PANEL_WIDTH_VAR})` : 0,
        } as React.CSSProperties}
        className={`relative bg-card flex-col hidden md:flex rounded-lg border border-border ${animate ? 'transition-all duration-300 ease-in-out' : 'transition-none'} ${sidebarOpen ? '' : 'border-0'}`}
      >
        {/* Collapsed there is no edge to grab, and nothing to resize. */}
        {sidebarOpen && resizeHandle}
        {/* The clip lives on this wrapper rather than the <aside>: children carry
            a fixed width so they can't reflow mid-collapse, and the handle has to
            be able to sit outside the panel, clear of the list's scrollbar. */}
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-lg">
          {children}
        </div>
      </aside>
    );
  }

  return (
    <DialogPrimitive.Root open={mobileOpen} onOpenChange={onMobileOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-xs flex-col bg-card border-r border-border shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left">
          <div className="h-12 px-3 flex flex-shrink-0 items-center justify-between border-b border-border">
            <DialogPrimitive.Title className="text-sm font-medium text-foreground">
              conversations
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="close conversations"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ConversationNotFoundState({ onStartNew }: { onStartNew: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md px-4">
        <MessageSquare className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-2">
          conversation not found
        </h2>
        <p className="text-sm text-muted-foreground mb-6">
          this conversation doesn&apos;t exist or you don&apos;t have access to it
        </p>
        <button
          type="button"
          onClick={onStartNew}
          className="text-xs px-4 py-2 rounded-md bg-accent-cyan text-primary-foreground font-medium hover:bg-accent-cyan/90 transition-colors cursor-pointer"
        >
          start new chat
        </button>
      </div>
    </div>
  );
}

function ConversationItem({
  conversation,
  isActive,
  onClick,
  onDelete,
  onRename,
}: {
  conversation: ChatConversation;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 bg-danger-surface border-y border-danger-border/30">
        <p className="text-xs text-danger flex-1 truncate">delete?</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
                setConfirming(false);
              }}
              aria-label={`confirm delete ${conversation.title}`}
              className="p-1 rounded hover:bg-danger-border/50 transition-colors cursor-pointer"
            >
              <Check className="h-3.5 w-3.5 text-danger" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>confirm delete</p>
          </TooltipContent>
        </Tooltip>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(false);
          }}
          aria-label={`cancel delete ${conversation.title}`}
          className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 bg-accent/30 border-y border-border">
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRename(editValue);
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          aria-label="conversation title"
          className="flex-1 text-base md:text-sm bg-secondary rounded px-2 py-1 outline-none border border-border focus:border-accent-cyan min-w-0"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
            onClick={(e) => {
              e.stopPropagation();
              onRename(editValue);
              setEditing(false);
            }}
            aria-label={`save rename ${conversation.title}`}
            className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
          >
              <Check className="h-3.5 w-3.5 text-accent-cyan" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>save</p>
          </TooltipContent>
        </Tooltip>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(false);
          }}
          aria-label={`cancel rename ${conversation.title}`}
          className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-active-conversation={isActive ? 'true' : undefined}
      className={`group relative flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors ${
        isActive ? 'bg-accent' : ''
      }`}
    >
      {/* The open-conversation control is a real <button> (keyboard- and
          screen-reader-accessible) with the rename/delete buttons as SIBLINGS,
          not nested inside it — nesting interactive controls is a serious axe
          violation (nested-interactive) and fails the hoot a11y gate. */}
      <button
        type="button"
        onClick={onClick}
        aria-current={isActive ? 'true' : undefined}
        className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent-cyan focus-visible:ring-inset"
      >
        {conversation.source === 'autonomous' ? (
          <Zap className="h-3.5 w-3.5 text-accent-cyan flex-shrink-0" />
        ) : (
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {/* Only the open conversation gets full-strength text: a column of
                pure-white titles gives the eye nothing to land on. */}
            <p
              className={`text-sm truncate transition-colors ${
                isActive ? 'text-foreground' : 'text-foreground/70 group-hover:text-foreground/90'
              }`}
            >
              {conversation.title}
            </p>
            {conversation.source === 'autonomous' && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan font-medium flex-shrink-0">
                auto
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <span className="truncate">{conversationTargetLabel(conversation)}</span>
            <span className="text-muted-foreground flex-shrink-0">· {timeAgo(conversation.updatedAt)}</span>
          </p>
        </div>
      </button>
      {/* Above `md` these ride OVER the row's right edge rather than sitting in
          flow: in flow they reserved ~48px of every row even at opacity 0, and
          that width came out of the title, which is the one thing worth reading
          here. On hover — or keyboard focus, which never fires hover — they fade
          in behind a frosted scrim, so the title dissolves under them instead of
          being truncated early. `pointer-events-none` while hidden keeps the
          invisible strip from eating clicks meant for the row.

          `focus-within` on THIS element, never `group-focus-within`: the row's
          own open-conversation button keeps focus after a click, so keying off
          the group left the icons stuck on the selected row after the pointer
          had gone. Here it answers only to the two buttons it contains.

          Below `md` they stay in flow and always visible: touch devices never
          fire hover, so an overlay there would cover the title permanently and
          these controls would be invisible but still tappable. */}
      <div className="flex items-center gap-1.5 transition-opacity duration-150 md:absolute md:inset-y-0 md:right-0 md:pl-12 md:pr-2 md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto md:focus-within:opacity-100 md:focus-within:pointer-events-auto">
        {/* Blur only — no tint. A backdrop-filter applies evenly across its
            element and stops dead at the edge, so this layer exists to be
            MASKED: the mask fades the blur itself into the title instead of
            ending it in a seam. Legibility comes from the chips on the buttons,
            not from darkening the text underneath. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 hidden backdrop-blur-[3px] [-webkit-mask-image:linear-gradient(to_left,black_45%,transparent)] [mask-image:linear-gradient(to_left,black_45%,transparent)] md:block"
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditValue(conversation.title);
            setEditing(true);
          }}
          aria-label={`rename ${conversation.title}`}
          /* Opaque chip: the blur softens the title behind these but doesn't
             dim it, so each glyph needs a solid ground of its own to read against. */
          className="relative p-1 rounded bg-card hover:bg-accent transition-colors cursor-pointer"
        >
          <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground transition-colors" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
          aria-label={`delete ${conversation.title}`}
          className="relative p-1 rounded bg-card hover:bg-danger-border/60 transition-colors cursor-pointer"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-danger transition-colors" />
        </button>
      </div>
    </div>
  );
}
