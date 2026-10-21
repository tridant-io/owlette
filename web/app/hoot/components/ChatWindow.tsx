'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type UIMessage } from 'ai';
import { ArrowUp, Pencil } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { HootMarkdown } from '@/components/hoot/HootMarkdown';
import { ToolCallCard } from './ToolCallCard';
import { CopyButton } from './CopyButton';
import { ImageLightbox } from '@/components/ImageLightbox';
import { SynapticIndicator } from './SynapticIndicator';
import { getRandomSuggestions } from '../data/suggestedQuestions';
import { YOU_TRANSLATIONS } from '@/lib/dashboardConstants';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { HootIcon } from '@/components/icons/HootIcon';
import { useScrollFade } from '@/hooks/useScrollFade';
import { ADVISOR_MODEL_NAME, ADVISOR_TOOL_NAME } from '@/lib/llmModels';
import { formatTargetLabel, readHootTurnMetadata, type HootTurnMetadata } from '@/lib/hoot/target';

type MessagePart = UIMessage['parts'][number];

function isToolPart(part: MessagePart): boolean {
  return part.type.startsWith('tool-') || part.type === 'dynamic-tool';
}

/** v6: static tool parts are typed 'tool-{name}', dynamic ones carry `toolName`. */
function toolNameOf(part: MessagePart): string {
  return part.type === 'dynamic-tool'
    ? ((part as { toolName?: string }).toolName || 'unknown')
    : part.type.slice(5);
}

/** the tool the newest reply is held on for approval, if it is. */
function awaitedApprovalTool(message: UIMessage | undefined, turnRunning: boolean): string | null {
  if (!message || message.role !== 'assistant' || turnRunning) return null;
  const part = message.parts.find(
    (p) => isToolPart(p) && (p as { state?: string }).state === 'approval-requested',
  );
  return part ? toolNameOf(part) : null;
}

/**
 * what the reply log reads out once a turn ends: the reply's last text part —
 * after an approval resume, the earlier text was already read — or nothing.
 * the markers that only style the text (fences, backticks, bold, heading
 * hashes) are dropped so a screen reader does not spell them out; pipes stay,
 * since in a command they carry meaning.
 */
function finishedReplyAnnouncement(messages: UIMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return '';
  const texts = last.parts.filter(
    (p): p is { type: 'text'; text: string } => p.type === 'text' && p.text.trim().length > 0,
  );
  const text = texts[texts.length - 1]?.text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`|\*\*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
  return text ? `hoot replied: ${text}` : '';
}

/**
 * Whether a message has anything to render. Claude Sonnet 5 and Opus 5 think before
 * they answer, so an assistant message can hold nothing but an empty-text thinking
 * part for a while.
 */
function hasVisibleContent(message: UIMessage): boolean {
  return message.parts.some(
    (part) =>
      (part.type === 'text' && part.text.trim().length > 0) ||
      part.type === 'file' ||
      isToolPart(part),
  );
}

/** Set comparison: the resolver's order follows the site listing, not the intent. */
function sameMachines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const known = new Set(a);
  return b.every((id) => known.has(id));
}

/**
 * Whether the server stamped a target on this turn AT ALL — true even when
 * `readHootTurnMetadata` then rejects the blob (a forged re-send, or a list past
 * the reader's cap, which a site-wide turn on a large site produces today). Such
 * a turn must not borrow the fallback label: that one follows the live header
 * selector, and naming the wrong machines on a tier-3 approval is worse than
 * naming none.
 */
function hasHootStamp(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false;
  const hoot = (metadata as { hoot?: unknown }).hoot;
  return typeof hoot === 'object' && hoot !== null;
}

function pickYouTranslation(messageId: string) {
  let hash = 0;
  for (let i = 0; i < messageId.length; i++) hash = (hash * 31 + messageId.charCodeAt(i)) | 0;
  return YOU_TRANSLATIONS[Math.abs(hash) % YOU_TRANSLATIONS.length];
}

interface ChatWindowProps {
  messages: UIMessage[];
  isLoading: boolean;
  hasApiKey?: boolean | null;
  onOpenSettings?: () => void;
  /** Approve/deny a pending tier-3 tool call by its approvalId. */
  onToolApproval?: (approvalId: string, approved: boolean) => void;
  /** Edit a prior user message and re-send, branching from that point. */
  onEditMessage?: (messageId: string, newText: string) => void;
  /**
   * Where tool calls run, shown in the approval prompt (machine / "all machines")
   * — the FALLBACK only, and only for turns carrying NO stamp at all. Each turn
   * is labelled from its own `metadata.hoot`; this label follows the live
   * selector, so it is right only for turns that predate per-turn targeting.
   */
  approvalTargetLabel?: string;
  /** Dispatched agent commands keyed by toolCallId → machineId → { commandId } — the cancel index. */
  toolCommands?: Record<string, Record<string, { commandId: string }>>;
  /** Cancel a running tool by its toolCallId (fans out to every machine it dispatched to). */
  onCancelTool?: (toolCallId: string) => void;
  /** toolCallIds with a cancel in flight; the pending state itself lives in HootChatView. */
  cancelPendingCommandIds?: Set<string>;
  /** The active turn's runner died (server restarted) — show the interrupted notice. */
  turnStale?: boolean;
  /**
   * A turn is live per the stream doc. Approve/deny is suppressed while set: after a
   * reload during an approval-resume, the persisted part can still read
   * `approval-requested` although the approved tool is already executing — re-arming
   * the buttons there is the OWL-47 double-execution window.
   */
  turnRunning?: boolean;
  /** The last turn failed. The error banner explains it, so its empty reply is not shown. */
  turnErrored?: boolean;
  /** The suggestions fill the composer, so they go when there is no composer to fill. */
  hideSuggestions?: boolean;
}

export function ChatWindow({ messages, isLoading, onToolApproval, onEditMessage, approvalTargetLabel, toolCommands, onCancelTool, cancelPendingCommandIds, turnStale, turnRunning, turnErrored, hideSuggestions }: ChatWindowProps) {
  const { user } = useAuth();
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Messages dissolve under the header rather than being cut mid-line by it.
  // The hook keeps `containerRef` pointed at the same node for the autoscroll.
  const scrollerRef = useScrollFade(containerRef);
  const isUserScrolledUp = useRef(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestions = useMemo(() => getRandomSuggestions(4), []);

  const lastMessage = messages[messages.length - 1];
  // A reply is in flight while this tab streams it — or, after a reload, while the
  // stream doc says its turn is live and not stale.
  const inFlight = isLoading || (Boolean(turnRunning) && !turnStale);
  const thinking = inFlight && Boolean(lastMessage) && (lastMessage.role === 'user' || !hasVisibleContent(lastMessage));
  const approvalTool = awaitedApprovalTool(lastMessage, Boolean(turnRunning));

  // screen readers hear a reply once, when its turn ends: a live region over the
  // streaming transcript would read out every token. set while rendering, on the
  // in-flight edge, so a chat that opens already answered stays quiet.
  const [wasInFlight, setWasInFlight] = useState(inFlight);
  const [replyAnnouncement, setReplyAnnouncement] = useState('');
  if (inFlight !== wasInFlight) {
    setWasInFlight(inFlight);
    setReplyAnnouncement(inFlight || turnErrored ? '' : finishedReplyAnnouncement(messages));
  }

  // kept mounted through the empty state, so the first "thinking" is heard too:
  // a live region announces changes, not its own arrival.
  const announcer = (
    <div className="sr-only">
      <div role="status">
        {thinking ? 'hoot is thinking' : approvalTool ? `hoot needs your approval to run ${approvalTool}` : ''}
      </div>
      <div role="log" aria-label="hoot replies">{replyAnnouncement}</div>
    </div>
  );

  // Each assistant turn carries the machines it actually ran on. Read once per
  // render — `readHootTurnMetadata` validates an untrusted blob, and both the
  // approval cards and the retarget captions need the result — and flag the turns
  // that moved, since a chat now aims at a different set from one turn to the next.
  const turnTargets = useMemo(() => {
    const byMessageId = new Map<string, HootTurnMetadata>();
    const stamped = new Set<string>();
    const retargeted = new Set<string>();
    let previous: string[] | null = null;
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (hasHootStamp(message.metadata)) stamped.add(message.id);
      const meta = readHootTurnMetadata(message.metadata);
      // An unstamped turn (an old chat, or one mid-deploy) is passed over rather
      // than treated as a change: the comparison is against the last turn whose
      // target is actually known.
      if (!meta) continue;
      byMessageId.set(message.id, meta);
      if (previous && !sameMachines(previous, meta.machineIds)) retargeted.add(message.id);
      previous = meta.machineIds;
    }
    return { byMessageId, stamped, retargeted };
  }, [messages]);

  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const saveEdit = (messageId: string) => {
    const text = editText.trim();
    if (!text) return;
    onEditMessage?.(messageId, text);
    cancelEdit();
  };

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    // "Near bottom" = within 100px of the bottom edge
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    isUserScrolledUp.current = !nearBottom;
    setShowScrollTop(el.scrollTop > 200);
  };

  const scrollToTop = () => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (!isUserScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  // Grow the edit box with its text, as the composer does: collapse to the
  // 3-row floor, then take the content height. A layout effect, so the box
  // never paints at the floor first. Under border-box `height` counts the
  // borders and scrollHeight does not — left out, the box comes up 2px short
  // and shows a scrollbar. `max-h-[40vh]` caps it; past that it scrolls.
  // Unlike the composer, this box sits inside the chat's scroller: the collapse
  // shortens the scroller for the measuring layout, one resting near its bottom
  // is clamped, and regrowing the box does not give the position back.
  useLayoutEffect(() => {
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    const scroller = containerRef.current;
    const scrollTop = scroller?.scrollTop ?? 0;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
    if (scroller) scroller.scrollTop = scrollTop;
  }, [editingId, editText]);

  // Open the edit with the caret after the text, where an edit usually starts.
  // Focus alone leaves it before the first character; the scroll keeps it in
  // view when the text overflows the cap.
  useLayoutEffect(() => {
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    const end = textarea.value.length;
    textarea.focus();
    textarea.setSelectionRange(end, end);
    textarea.scrollTop = textarea.scrollHeight;
  }, [editingId]);

  if (messages.length === 0) {
    return (
      <>
      {announcer}
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <HootIcon className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-2">hoot</h2>
          <p className="text-sm text-muted-foreground">
            debug, diagnose, and manage your remote machines.
            i can run commands, check configs, and investigate issues you can&apos;t see from the dashboard.
          </p>

          {!hideSuggestions && (
            <div className="mt-4 grid grid-cols-2 gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.text}
                  className="text-xs text-left px-3 py-2 rounded-md border border-border bg-secondary hover:bg-accent transition-colors text-muted-foreground cursor-pointer"
                  onClick={() => {
                    const input = document.querySelector<HTMLTextAreaElement>('[data-chat-input]');
                    if (input) {
                      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        'value'
                      )?.set;
                      nativeInputValueSetter?.call(input, suggestion.text);
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.focus();
                    }
                  }}
                >
                  {suggestion.text}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      </>
    );
  }

  return (
    <>
    {announcer}
    <div className="relative flex-1 min-h-0 flex flex-col">
      {/* Scroll to top button */}
      <button
        type="button"
        onClick={scrollToTop}
        aria-label="Back to top"
        className={`absolute top-3 right-4 z-10 flex items-center justify-center h-8 min-w-8 px-2 rounded-full border border-border bg-background/80 backdrop-blur text-muted-foreground hover:text-foreground hover:bg-accent shadow-sm cursor-pointer transition-opacity duration-200 overflow-hidden group/scrolltop ${
          showScrollTop ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <ArrowUp className="h-4 w-4 flex-shrink-0" />
        <span className="max-w-0 group-hover/scrolltop:max-w-[120px] group-hover/scrolltop:ml-1.5 overflow-hidden whitespace-nowrap text-xs transition-[max-width,margin] duration-200">
          back to top
        </span>
      </button>

      <div ref={scrollerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      <div ref={topRef} />

      <ImageLightbox src={expandedImage} alt="pasted image" onClose={() => setExpandedImage(null)} />

      {messages.map((message, index) => {
        const isUser = message.role === 'user';
        const isEditing = isUser && editingId === message.id;
        const emptyReply = !isUser && !hasVisibleContent(message);
        const turnMeta = turnTargets.byMessageId.get(message.id);
        // A stamped turn owns its label outright, so the header's fallback is
        // withheld even when the stamp turned out to be unreadable.
        const turnTargetLabel = turnTargets.stamped.has(message.id) ? undefined : approvalTargetLabel;
        // The newest reply with nothing to show yet is the model thinking: the
        // indicator below stands in for it — or, once the turn is stale or has failed,
        // the interrupted notice or the error banner does.
        if (emptyReply && index === messages.length - 1 && (inFlight || turnStale || turnErrored)) {
          return null;
        }
        return (
        <div key={message.id} className="max-w-3xl mx-auto">
          <div className={`group flex gap-3 ${isUser ? 'justify-end' : ''}`}>
            {/* Hoot: avatar + rail column on the left */}
            {!isUser && (
              <div className="flex-shrink-0 flex flex-col items-center">
                <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
                  <HootIcon className="h-4 w-4 text-foreground" />
                </div>
                <div className="mt-1 flex-1 w-0.5 bg-accent-cyan/25" />
              </div>
            )}

            {/* Content. A user bubble shrinks to fit under a 75% cap, but the
                edit form takes the whole row — shrink-to-fit left the textarea
                at its intrinsic ~20-column width. */}
            <div className={`min-w-0 ${isUser && !isEditing ? 'max-w-[75%]' : 'flex-1'}`}>
              <div className={`flex items-center gap-2 h-7 text-sm font-semibold text-foreground mb-1 ${isUser ? 'justify-end' : ''}`}>
                {/*
                  Three tooltip triggers stand shoulder to shoulder in this row.
                  Hoverable content keeps a tooltip open while the pointer is
                  judged to be travelling towards it, and a trigger refuses to
                  open while that flag is set — with the neighbour an inch away
                  it falls inside the grace area, so moving along the row left
                  the first tooltip up and never opened the second. None of
                  these are worth hovering into, so the row turns it off. The
                  delay matches the app-wide provider in `app/layout.tsx`;
                  nesting one resets it to Radix's slower default otherwise.
                */}
                <TooltipProvider disableHoverableContent delayDuration={300}>
                {(() => {
                  const fullText = message.parts
                    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                    .map((p) => p.text)
                    .join('\n\n')
                    .trim();
                  const copyBtn = fullText.length > 0 ? (
                    <CopyButton
                      value={fullText}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-2 rounded-sm transition-opacity"
                    />
                  ) : null;
                  // Edit pencil — user messages only, hidden while streaming or editing.
                  const editBtn = isUser && onEditMessage && !isLoading && !isEditing ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => { setEditText(fullText); setEditingId(message.id); }}
                          aria-label="edit message"
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-2 rounded-sm transition-opacity text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>edit &amp; resend</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : null;
                  const label = isUser ? (() => {
                    const t = pickYouTranslation(message.id);
                    return (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help">{t.text}</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>you ({t.language})</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })() : <span>hoot</span>;
                  return isUser ? <>{editBtn}{copyBtn}{label}</> : <>{label}{copyBtn}</>;
                })()}
                </TooltipProvider>
              </div>

              {isEditing ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    ref={editTextareaRef}
                    aria-label="edit message"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        saveEdit(message.id);
                      } else if (e.key === 'Escape') {
                        cancelEdit();
                      }
                    }}
                    rows={3}
                    className="w-full max-h-[40vh] resize-none rounded-lg border border-border bg-secondary px-4 py-3 text-base md:text-sm leading-relaxed text-foreground text-left focus:outline-none focus:ring-2 focus:ring-accent-cyan/50 focus:border-accent-cyan"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={cancelEdit}>
                      cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => saveEdit(message.id)}
                      disabled={!editText.trim()}
                    >
                      save &amp; resend
                    </Button>
                  </div>
                </div>
              ) : (
              <div className={isUser ? 'opacity-80 text-right' : ''}>
              {/* Where this turn went, noted only when it moved: a transcript that
                  reads as one conversation can have gone to different machines. */}
              {turnMeta && turnTargets.retargeted.has(message.id) && (
                <p className="mb-1.5 text-xs text-muted-foreground">
                  targets changed — {formatTargetLabel(turnMeta.machineIds)}
                </p>
              )}
              {/* Render parts (text + images + tool calls) */}
              {message.parts.map((part, i) => {
              if (part.type === 'text') {
                return <HootMarkdown key={i} text={part.text} />;
              }

              if (part.type === 'file') {
                const filePart = part as { type: 'file'; mediaType?: string; url?: string };
                const imageUrl = filePart.mediaType?.startsWith('image/') ? filePart.url : undefined;
                if (imageUrl) {
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setExpandedImage(imageUrl)}
                      aria-label="view pasted image"
                      className={`block max-w-sm my-1 rounded-lg cursor-pointer hover:opacity-90 transition-opacity${isUser ? ' ml-auto' : ''}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imageUrl} alt="" loading="lazy" className="max-w-full rounded-lg border border-border" />
                    </button>
                  );
                }
                return null;
              }

              if (isToolPart(part)) {
                const toolPart = part as {
                  type: string; toolName?: string; toolCallId?: string;
                  args?: unknown; input?: unknown; output?: unknown; errorText?: string; state?: string;
                  approval?: { id: string; approved?: boolean };
                };
                const toolName = toolNameOf(part);
                const args = (toolPart.args || toolPart.input || {}) as Record<string, unknown>;
                const state = toolPart.state;
                // 'output-error' carries the message in `errorText` (not `output`);
                // surface it as an { error } result so the card renders the failed state.
                const result = state === 'output-error'
                  ? { error: toolPart.errorText || 'tool execution failed' }
                  : toolPart.output;
                const hasResult = state === 'output-available' || state === 'output-error' || state === 'result' || toolPart.output !== undefined;

                // Tier-3 approval gate (AI SDK human-in-the-loop):
                //   approval-requested            → show approve/deny
                //   approval-responded (denied) / output-denied → declined
                //   approval-responded (approved) → resuming → loading until output
                // With a live turn, an `approval-requested` part is stale UI state
                // (the resume is already executing server-side) — render it as
                // running instead of re-arming approve/deny.
                const awaitingApproval = state === 'approval-requested' && !turnRunning;
                const denied = state === 'output-denied'
                  || (state === 'approval-responded' && toolPart.approval?.approved === false);
                const approvalId = toolPart.approval?.id;
                const running = !hasResult && !awaitingApproval && !denied;

                // hoot consulting a stronger model mid-answer. The advice is
                // encrypted and nothing ran on a machine, so a note, not a card. A
                // consultation is only under way while its reply is in flight; one a
                // stop or an error cut off never gets its result.
                if (toolName === ADVISOR_TOOL_NAME) {
                  const consulting = running && inFlight && index === messages.length - 1;
                  return (
                    <p key={i} className="flex items-center gap-2 my-2 text-xs text-muted-foreground">
                      {consulting && <SynapticIndicator />}
                      {consulting
                        ? `consulting ${ADVISOR_MODEL_NAME}...`
                        : running || state === 'output-error'
                          ? `couldn't consult ${ADVISOR_MODEL_NAME}`
                          : `consulted ${ADVISOR_MODEL_NAME}`}
                    </p>
                  );
                }

                // Cancel only for a running tool that actually dispatched agent
                // commands (toolCallId present in toolCommands with ≥1 machine).
                // It fans out to every machine the call targeted, hence keyed by
                // toolCallId rather than a single commandId.
                const toolCallId = running ? toolPart.toolCallId : undefined;
                const cancellable = Boolean(
                  toolCallId && Object.keys(toolCommands?.[toolCallId] ?? {}).length > 0,
                );

                return (
                  <ToolCallCard
                    key={i}
                    toolName={toolName}
                    args={args}
                    result={hasResult ? result : undefined}
                    isLoading={running}
                    approvalState={awaitingApproval ? 'requested' : denied ? 'denied' : undefined}
                    approvalTargetLabel={turnTargetLabel}
                    approvalTargetMachineIds={turnMeta?.machineIds}
                    approvalTargetDynamic={turnMeta?.dynamic}
                    onApprove={awaitingApproval && approvalId ? () => onToolApproval?.(approvalId, true) : undefined}
                    onDeny={awaitingApproval && approvalId ? () => onToolApproval?.(approvalId, false) : undefined}
                    onCancel={cancellable && toolCallId && onCancelTool ? () => onCancelTool(toolCallId) : undefined}
                    cancelPending={cancellable && toolCallId ? cancelPendingCommandIds?.has(toolCallId) : undefined}
                  />
                );
              }

              return null;
              })}
              {emptyReply && (
                <p className="text-xs text-muted-foreground border-l-2 border-border pl-3">
                  no reply came back. if you didn&apos;t stop this turn, the model may have declined the request — try rephrasing it.
                </p>
              )}
              </div>
              )}
            </div>

            {/* User: avatar + rail column on the right */}
            {isUser && (
              <div className="flex-shrink-0 flex flex-col items-center">
                <UserAvatar user={user} size="sm" />
                <div className="mt-1 flex-1 w-0.5 bg-muted-foreground/25" />
              </div>
            )}
          </div>
        </div>
        );
      })}

      {/* Interrupted-turn notice — the turn runner died (server restarted)
          mid-turn; the next send repairs history and recovers tool results. */}
      {turnStale && (
        <div className="max-w-3xl mx-auto">
          <p className="text-xs text-muted-foreground border-l-2 border-border pl-3">
            this turn was interrupted (server restarted) — send a message to continue; completed tool results will be recovered.
          </p>
        </div>
      )}

      {/* Loading indicator — up until the reply has something to show */}
      {thinking && (
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 border-l-2 pl-3 border-accent-cyan/40">
            <div className="flex-shrink-0">
              <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center">
                <HootIcon className="h-4 w-4 text-foreground" />
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <SynapticIndicator />
              thinking...
            </div>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
      </div>
    </div>
    </>
  );
}
