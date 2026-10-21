'use client';

/**
 * Publish a conversation as a read-only link.
 *
 * The preview is not a mock-up: it runs `buildShareSnapshot` — the same builder
 * the API runs on the persisted chat — through `SharedConversation`, the same
 * renderer `/share/{token}` uses. What the owner reads here is what a reader
 * gets, which is the point: assistant TEXT can quote hostnames, paths and log
 * lines even though tool inputs and outputs never leave the machine.
 *
 * Every request goes through `useChatShares`; nothing here touches Firestore.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UIMessage } from 'ai';
import { Check, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { FormError } from '@/components/ui/form-error';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SharedConversation } from '@/components/hoot/SharedConversation';
import { buildShareSnapshot } from '@/lib/hoot/shareSnapshot';
import {
  DEFAULT_SHARE_EXPIRY_DAYS,
  SHARE_EXPIRY_OPTIONS_DAYS,
  shareUrl,
  type ChatShareSummary,
  type ShareExpiry,
  type ShareExpiryDays,
} from '@/lib/hoot/shareTypes';
import { useChatShares } from '@/hooks/useChatShares';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';

/** Radix Select speaks strings; `null` (never expires) needs a value of its own. */
const NEVER_VALUE = 'never';

/** How long "copied to clipboard" stays up beside a freshly created link. */
const COPIED_NOTICE_MS = 4000;

const CREATED_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/**
 * When a link was made, to the minute. Lowercased to match the house voice —
 * the meridiem is the only capital `toLocaleString` produces.
 */
function formatCreated(ms: number): string {
  return new Date(ms).toLocaleString(undefined, CREATED_FORMAT).toLowerCase();
}

/**
 * Accessible names for a row's buttons. Date AND time to the second: two links
 * created on the same day — even in the same minute — are routine, and
 * identical accessible names make them indistinguishable to a screen reader
 * and ambiguous to a role query.
 */
function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function messageCountLabel(count: number): string {
  return `${count} message${count === 1 ? '' : 's'}`;
}

/**
 * Copy text that does not exist yet — the share URL arrives with `create()`'s
 * response — without losing the click that asked for it. Safari drops a
 * click's user activation across a network request and Firefox honours it for
 * about five seconds, so `writeText` after the await is unreliable. A
 * `ClipboardItem` holding a promise lets the write start inside the gesture
 * and complete when the text lands; `writeText` is the fallback where that is
 * unsupported or refused.
 *
 * Call it synchronously from the click handler. Resolves `true` once the text
 * is on the clipboard and `false` otherwise — including when `text` resolves to
 * `null`, which writes nothing. Never rejects.
 */
async function copyWhenReady(text: Promise<string | null>): Promise<boolean> {
  const canWritePending =
    typeof window.ClipboardItem === 'function' &&
    typeof navigator.clipboard?.write === 'function';
  if (canWritePending) {
    const blob = text.then((value) => {
      if (value === null) throw new Error('nothing to copy');
      return new Blob([value], { type: 'text/plain' });
    });
    // The write consumes this rejection — unless the browser refuses up front
    // and never reads the item, which would leave it unhandled.
    blob.catch(() => undefined);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      // Refused, or no support for a pending item: try the plain write.
    }
  }
  try {
    const value = await text;
    if (value === null) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

interface ShareChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string;
  siteId: string;
  title: string;
  /** Machine name, or "All Machines" for a site-wide chat. `null` when unknown. */
  targetLabel: string | null;
  messages: UIMessage[];
}

export function ShareChatDialog({
  open,
  onOpenChange,
  chatId,
  siteId,
  title,
  targetLabel,
  messages,
}: ShareChatDialogProps) {
  const { shares, loading, creating, error, list, create, revoke } = useChatShares(
    chatId,
    siteId,
  );
  const [expiry, setExpiry] = useState<string>(String(DEFAULT_SHARE_EXPIRY_DAYS));
  const [created, setCreated] = useState<ChatShareSummary | null>(null);
  // The token whose URL the create click copied. Keyed by token so the notice
  // can only ever describe the link in the box: a revoke, a reopen or a newer
  // link each hide it without being told to.
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  // The inventories start closed on every visit: they are reference material,
  // and the preview under them is what the owner is actually here to read.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The dialog stays mounted with the chat view, so `messages` keeps changing as
  // a turn streams — building the snapshot unconditionally would rebuild it once
  // per token. Only an open dialog needs the preview or the counts.
  const snapshot = useMemo(
    () => buildShareSnapshot({ title, targetLabel, messages: open ? messages : [] }),
    [open, title, targetLabel, messages],
  );

  useEffect(() => {
    if (!open) return;
    // Reopening starts clean: a link created in a previous visit is already in
    // "active links", and leaving it in the box would read as a fresh one.
    setCreated(null);
    setCopiedToken(null);
    setExpiry(String(DEFAULT_SHARE_EXPIRY_DAYS));
    setDetailsOpen(false);
    void list();
  }, [open, list]);

  // A few seconds is enough to have said it; closing the dialog cancels the
  // timer along with everything else it shows.
  useEffect(() => {
    if (!open || copiedToken === null) return;
    const timer = setTimeout(() => setCopiedToken(null), COPIED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [open, copiedToken]);

  const handleCreate = useCallback(async () => {
    const expiresInDays: ShareExpiry =
      expiry === NEVER_VALUE ? null : (Number(expiry) as ShareExpiryDays);
    const origin = window.location.origin;
    const pending = create(expiresInDays);
    // Started before anything is awaited, so the write still carries this click.
    const copied = copyWhenReady(
      pending.then((share) => (share ? shareUrl(origin, share.token) : null)),
    );
    const share = await pending;
    if (!share) return;
    setCreated(share);
    if (await copied) {
      setCopiedToken(share.token);
      toast.success('link created and copied to clipboard');
    } else {
      // The box below still offers the link and its own copy button.
      toast.success('link created');
    }
  }, [create, expiry]);

  const handleRevoke = useCallback(
    async (token: string) => {
      setRevokingToken(token);
      try {
        if (!(await revoke(token))) return;
        // Revoking the link still shown in the box must clear it — a dead URL
        // beside a copy button is worse than no URL at all.
        setCreated((prev) => (prev?.token === token ? null : prev));
        toast.success('link revoked');
      } finally {
        setRevokingToken(null);
      }
    },
    [revoke],
  );

  const isEmpty = snapshot.messages.length === 0;
  // Every `window` read below sits behind state that only a client can reach —
  // a click, or a list loaded once the dialog opens — so none of them can run
  // during a server render.
  const createdUrl = created ? shareUrl(window.location.origin, created.token) : null;
  const showCopied = created !== null && copiedToken === created.token;
  // A list of several links may give up rows to a short viewport, and only
  // once the preview is down to its minimum (see its shrink factor). Anything
  // shorter keeps its natural height.
  const linksCanShrink = !loading && shares.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A flex column capped at 90vh: every section keeps its natural height
          and the preview absorbs the rest, so a link box, an error or a new
          row resizes the preview rather than scrolling the dialog. The
          container's own overflow only engages on a viewport too short for
          even the minimums, where the footer must stay reachable. The gap is
          tighter than shadcn's for the same reason: on a 768p laptop every
          section's spacing comes out of the preview. */}
      <DialogContent className="flex max-h-[90vh] flex-col gap-2 overflow-y-auto sm:max-w-2xl">
        {/* The two inventories open on demand. Everything a reader gets is in
            the preview below, and leading with four lists of small print buried
            that — the summary sentence plus a "more" is the same promise in one
            line. Collapsed by default, and the preview grows into the space. */}
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="shrink-0">
          <DialogHeader>
            <DialogTitle>share this conversation</DialogTitle>
            <DialogDescription>
              anyone with the link can read it. it&apos;s a snapshot — later messages are
              not included.{' '}
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="cursor-pointer text-accent-cyan underline-offset-2 transition-colors hover:text-accent-cyan-hover hover:underline"
                >
                  {detailsOpen ? 'less' : 'more'}
                </button>
              </CollapsibleTrigger>
            </DialogDescription>
          </DialogHeader>

          <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
            <div className="grid gap-4 pt-3 sm:grid-cols-2">
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-foreground">what&apos;s included</h3>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>your messages and hoot&apos;s replies, as text</li>
              {/* One line however long the title is — chat titles run to 100
                  characters, and the lines they wrap to here come out of the
                  preview's height. Clipped visually only: the full title is
                  still in the DOM for a screen reader. */}
              <li className="truncate">the title &quot;{snapshot.title}&quot;</li>
              {/* One line for every shape the label takes: a machine, a set of
                  them ("kiosk-01, kiosk-02 +3") or "All Machines". It is the
                  chat's stored `machineName`, which a multi-machine chat writes
                  as that collapsed list (chatTargetFields, lib/hoot/target.ts). */}
              {snapshot.targetLabel !== null && (
                <li>the target name &quot;{snapshot.targetLabel}&quot;</li>
              )}
              <li>
                tool calls as one line each — name and outcome (
                {snapshot.collapsedToolCalls} collapsed)
              </li>
            </ul>
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-foreground">
              what&apos;s not included
            </h3>
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>images and screenshots ({snapshot.omitted.images} left out)</li>
              <li>tool inputs and outputs</li>
              <li>system messages</li>
            </ul>
          </section>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* The chat panel's own surface (HootChatView's <main>), so the preview
            reads as the conversation rather than as part of the dialog.

            From `sm` up it shrinks first and by far the most — flex items give
            up space in proportion to shrink × size — so the links list keeps
            its rows until this reaches its minimum. Below `sm` the sections
            around it nearly fill the viewport on their own: paying for them
            would leave a few lines to read a conversation in, so there the
            preview keeps its own cap and the dialog scrolls instead — a phone's
            overlay scrollbar, not the bar this pass is removing.

            Focusable because it is the only scroll region: nothing inside it
            takes focus, so a keyboard reader has no other way to scroll it. */}
        <div
          role="region"
          aria-label="share preview"
          tabIndex={0}
          className="max-h-[40vh] min-h-20 shrink-0 overflow-y-auto rounded-lg border border-border bg-card p-4 sm:max-h-none sm:shrink-1000"
        >
          <SharedConversation messages={snapshot.messages} variant="preview" />
        </div>

        {/* Under the preview, not above it: it is a caption on what was just
            read, and above it the warning was asking the owner to check
            something they hadn't been shown yet. */}
        <p className="shrink-0 text-xs text-warning">
          hoot&apos;s replies can quote machine details — hostnames, file paths, log lines.
          read the preview before you share.
        </p>

        <div className="shrink-0">
          {createdUrl && (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label="share link"
                value={createdUrl}
                className="font-mono text-xs"
              />
              <CopyButton value={createdUrl} iconSize="sm" />
              <Button variant="link" size="sm" asChild>
                <a href={createdUrl} target="_blank" rel="noopener noreferrer">
                  open
                </a>
              </Button>
            </div>
          )}

          {/* Always in the tree: a live region only announces changes made after
              it is there. Its line is reserved while the link box shows, so the
              notice clearing does not shift the dialog under the pointer. */}
          <p
            role="status"
            aria-live="polite"
            className={cn(
              'flex items-center gap-1.5 text-xs text-success',
              createdUrl && 'mt-1.5 h-4',
            )}
          >
            {showCopied && (
              <>
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                copied to clipboard
              </>
            )}
          </p>
        </div>

        <section
          className={cn(
            'flex flex-col border-t border-border pt-3',
            // Heading plus one full row: a squeezed list is still a list.
            linksCanShrink ? 'min-h-[4.25rem]' : 'shrink-0',
          )}
        >
          <h3 className="mb-1.5 shrink-0 text-xs font-medium text-foreground">active links</h3>
          {loading ? (
            <p className="text-xs text-muted-foreground">loading links…</p>
          ) : shares.length === 0 ? (
            <p className="text-xs text-muted-foreground">no active links</p>
          ) : (
            // Its own scroll, capped at four rows, so a long list cannot starve
            // the preview.
            <ul className="max-h-[8.75rem] space-y-1 overflow-y-auto">
              {shares.map((share) => {
                const createdAt = formatDateTime(share.createdAt);
                return (
                  <li
                    key={share.token}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      created {formatCreated(share.createdAt)} ·{' '}
                      {share.expiresAt === null
                        ? 'never expires'
                        : `expires ${formatDate(share.expiresAt)}`}{' '}
                      · {messageCountLabel(share.messageCount)}
                    </span>
                    {/* Lowercased because this name is also the visible tooltip. */}
                    <CopyButton
                      value={shareUrl(window.location.origin, share.token)}
                      iconSize="sm"
                      tooltipLabel={`copy link created ${createdAt.toLowerCase()}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`revoke link created ${createdAt}`}
                      disabled={revokingToken === share.token}
                      onClick={() => void handleRevoke(share.token)}
                    >
                      revoke
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <DialogFooter className="shrink-0 sm:items-center">
          {/* The expiry belongs with the action it qualifies, not in a row of
              its own above the link box — and an error belongs beside the
              request that failed. Both live in the footer's left half, where
              neither costs the preview any height. */}
          <div className="flex flex-wrap items-center gap-2 sm:mr-auto">
            <span className="text-xs text-muted-foreground">link expires in</span>
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger size="sm" aria-label="link expires in" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHARE_EXPIRY_OPTIONS_DAYS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {days} days
                  </SelectItem>
                ))}
                <SelectItem value={NEVER_VALUE}>never (until revoked)</SelectItem>
              </SelectContent>
            </Select>
            <FormError message={error} />
            {isEmpty && (
              <span className="text-xs text-muted-foreground">nothing to share yet</span>
            )}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={creating || isEmpty}>
            {creating && <Loader2 className="h-4 w-4 animate-spin" />}
            create link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
