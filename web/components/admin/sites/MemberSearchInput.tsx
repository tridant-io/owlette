'use client';

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { highlightMatch } from '@/components/admin/sites/highlightMatch';
import {
  candidateLabel,
  isFullEmail,
  rankMemberCandidates,
  type MemberCandidate,
} from '@/lib/memberCandidates';
import { cn } from '@/lib/utils';

export type AddMemberTarget = { kind: 'uid'; uid: string; label: string } | { kind: 'email'; email: string };

// six two-line rows fit without a scroll region: axe's scrollable-region-focusable
// would otherwise demand a tab stop on the list (see MentionPopover)
const OPTION_LIMIT = 6;

function hasEmail(candidate: MemberCandidate, email: string): boolean {
  return !!candidate.email && candidate.email.toLowerCase() === email.toLowerCase();
}

// focus never enters the list: the input drives it with aria-activedescendant
function keepFocusInInput(event: Event): void {
  event.preventDefault();
}

export function MemberSearchInput({
  id,
  describedBy,
  candidates,
  loading,
  error,
  disabled,
  onTargetChange,
  onSubmit,
}: {
  id: string;
  describedBy?: string;
  candidates: readonly MemberCandidate[];
  loading: boolean;
  error: string | null;
  disabled?: boolean;
  onTargetChange: (target: AddMemberTarget | null) => void;
  onSubmit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  // null keeps the default active option until an arrow key moves it
  const [highlight, setHighlight] = useState<number | null>(null);

  const query = text.trim();
  const fullEmail = isFullEmail(text);
  const options = useMemo(() => rankMemberCandidates(text, candidates, OPTION_LIMIT), [text, candidates]);

  let status: string | null = null;
  if (loading) {
    status = 'loading people…';
  } else if (error) {
    status = 'could not load people from your other sites. you can still type a full email.';
  } else if (query && options.length === 0) {
    const askForEmail = fullEmail ? '' : ' type their full email to add someone new.';
    status = `no one from your other sites matches “${query}”.${askForEmail}`;
  }

  const showing = open && !disabled && (options.length > 0 || status !== null);

  // a full email makes only its exact match active, so enter never adds someone
  // whose address merely contains the typed one
  const defaultIndex = fullEmail ? options.findIndex((c) => hasEmail(c, query)) : 0;
  const activeIndex =
    options.length === 0 ? -1 : highlight === null ? defaultIndex : Math.min(highlight, options.length - 1);
  const active = activeIndex >= 0 ? options[activeIndex] : null;

  const listboxId = `${id}-listbox`;
  const optionId = (candidate: MemberCandidate) => `${id}-option-${candidate.uid}`;

  function targetFor(next: string): AddMemberTarget | null {
    const trimmed = next.trim();
    const exact = trimmed ? candidates.find((c) => hasEmail(c, trimmed)) : undefined;
    if (exact) return { kind: 'uid', uid: exact.uid, label: candidateLabel(exact) };
    return isFullEmail(trimmed) ? { kind: 'email', email: trimmed } : null;
  }

  function close() {
    setOpen(false);
    setHighlight(null);
  }

  function pick(candidate: MemberCandidate) {
    const label = candidateLabel(candidate);
    setText(label);
    close();
    onTargetChange({ kind: 'uid', uid: candidate.uid, label });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // an ime owns enter and the arrows while it composes
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showing) {
        setOpen(true);
        return;
      }
      if (options.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const from = activeIndex === -1 ? (step === 1 ? -1 : 0) : activeIndex;
      setHighlight((from + step + options.length) % options.length);
      return;
    }
    if (e.key === 'Enter') {
      // enter is the search's in both branches, so a form around it never submits twice
      e.preventDefault();
      if (showing && active) pick(active);
      else onSubmit();
    }
  }

  return (
    <Popover
      open={showing}
      // radix reports escape and outside interaction here; escape closes only
      // this top layer, so a dialog around the search stays open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="email"
          autoComplete="off"
          // a textbox, not a combobox: the axe gate rejects a combobox role in a form row
          aria-autocomplete="list"
          aria-controls={showing && options.length > 0 ? listboxId : undefined}
          aria-activedescendant={showing && active ? optionId(active) : undefined}
          aria-describedby={describedBy}
          placeholder="search, or type an email"
          value={text}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            setHighlight(null);
            setOpen(true);
            onTargetChange(targetFor(next));
          }}
          onKeyDown={handleKeyDown}
          // 16px below md: ios zooms the page into any field smaller than that
          className="border-border bg-secondary text-base text-foreground placeholder:text-muted-foreground md:text-sm"
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        aria-label="people you can add"
        onOpenAutoFocus={keepFocusInInput}
        onCloseAutoFocus={keepFocusInInput}
        // the input anchors the list but sits outside it, so a press on the input
        // would otherwise read as outside and close the list it is typing into
        onInteractOutside={(e) => {
          if (e.target === inputRef.current) e.preventDefault();
        }}
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] border-border bg-secondary p-1"
      >
        {/* only with options: an empty listbox fails axe */}
        {options.length > 0 && (
          <ul role="listbox" id={listboxId} aria-label="people you can add">
            {options.map((candidate, index) => {
              const isActive = index === activeIndex;
              return (
                <li
                  key={candidate.uid}
                  id={optionId(candidate)}
                  role="option"
                  aria-selected={isActive}
                  // a mousedown would move focus off the input the list belongs to
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(candidate)}
                  // over the active row's accent fill in dark, the muted small print (4.40:1) and
                  // the cyan marks (3.58:1) miss aa, so that row alone takes the stronger tone
                  className={cn(
                    'cursor-pointer rounded-sm px-2 py-1.5 text-foreground',
                    isActive && 'bg-accent dark:[&_mark]:text-accent-foreground',
                  )}
                >
                  <div className="text-sm wrap-anywhere">
                    {highlightMatch(candidate.displayName || candidate.email || 'unnamed account', text)}
                  </div>
                  {candidate.displayName && candidate.email && (
                    <div
                      className={cn(
                        'text-xs wrap-anywhere',
                        isActive ? 'text-accent-foreground/80' : 'text-muted-foreground',
                      )}
                    >
                      {highlightMatch(candidate.email, text)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {status && <p className="px-2 py-1.5 text-xs text-muted-foreground wrap-anywhere">{status}</p>}
      </PopoverContent>
    </Popover>
  );
}
