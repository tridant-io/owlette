'use client';

/**
 * the phone's own keyboard, typing on the machine, and the key row it lacks.
 *
 * a phone opens its keyboard only for a field, and the stage is not one, so a
 * hidden field sits in the stage (fullscreen holds only the stage) and the
 * bar's keyboard button focuses it. what is typed into it is read back after
 * each change and sent as a us keyboard's keys (`lib/swoop/phoneKeyboard.ts`);
 * `input.ts` leaves the field's own key events alone.
 *
 * the key row rides the top of the phone's keyboard, on the visual viewport's
 * bottom edge: escape, tab, the arrows, and ctrl, alt and the system key,
 * which stay down for the next key and are lit while they do. its buttons
 * never take focus, which would close the keyboard under the finger.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, TextCursorInput } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BarTooltip } from '@/components/swoop/BarTooltip';
import type { MachineOsFamily } from '@/lib/machineOs';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { FIELD_SENTINEL, keysFor, textChange } from '@/lib/swoop/phoneKeyboard';

/** the field is put back to its sentinel past this, between words, so it never grows. */
const FIELD_LIMIT = 64;
const FIELD_SELECTOR = '[data-swoop-keyboard]';

const subscribeNever = (): (() => void) => () => {};
const NOTHING_ARMED: readonly string[] = [];
const nothingArmed = (): readonly string[] => NOTHING_ARMED;
const closed = (): boolean => false;

/**
 * the machine's names for its modifiers, which the row sends as written. short
 * forms of `modifierName`'s (`modifierLegend.ts`), kept apart because ten keys
 * share the row's width on the narrowest phone.
 */
const MODIFIERS: Readonly<Record<MachineOsFamily, ReadonlyArray<readonly [string, string]>>> = {
  windows: [
    ['ControlLeft', 'ctrl'],
    ['AltLeft', 'alt'],
    ['MetaLeft', 'win'],
  ],
  macos: [
    ['ControlLeft', 'ctrl'],
    ['AltLeft', 'opt'],
    ['MetaLeft', 'cmd'],
  ],
  linux: [
    ['ControlLeft', 'ctrl'],
    ['AltLeft', 'alt'],
    ['MetaLeft', 'super'],
  ],
};

const ARROWS = [
  ['ArrowLeft', 'left', ArrowLeft],
  ['ArrowUp', 'up', ArrowUp],
  ['ArrowDown', 'down', ArrowDown],
  ['ArrowRight', 'right', ArrowRight],
] as const;

const fieldOf = (session: SwoopSession | null): HTMLTextAreaElement | null =>
  session?.stage.querySelector<HTMLTextAreaElement>(FIELD_SELECTOR) ?? null;

/** whether the phone keyboard is up: its field has focus. */
function useFieldFocused(session: SwoopSession | null): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!session) return () => {};
      session.stage.addEventListener('focusin', listener);
      session.stage.addEventListener('focusout', listener);
      return () => {
        session.stage.removeEventListener('focusin', listener);
        session.stage.removeEventListener('focusout', listener);
      };
    },
    [session],
  );
  return useSyncExternalStore(
    subscribe,
    () => fieldOf(session) !== null && document.activeElement === fieldOf(session),
    closed,
  );
}

/** how far the phone's keyboard covers the layout viewport's bottom, in css pixels. */
function useKeyboardInset(open: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || !viewport) return;
    const sync = () => setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
    };
  }, [open]);
  return inset;
}

/** the bar's way to the phone keyboard; on a touch screen only, where there is no other. */
export function SwoopPhoneKeyboardButton({ session }: { session: SwoopSession | null }) {
  const open = useFieldFocused(session);
  const enabled = session !== null && session.ctl;
  return (
    <BarTooltip label="type with this phone's keyboard" short="keyboard" className="pointer-fine:hidden">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="type with this phone's keyboard"
        aria-pressed={open}
        disabled={!enabled}
        // focus inside the tap: a phone opens its keyboard only for a gesture's own focus
        onClick={() => (open ? fieldOf(session)?.blur() : fieldOf(session)?.focus())}
      >
        <TextCursorInput aria-hidden />
      </Button>
    </BarTooltip>
  );
}

export function SwoopPhoneKeyboard({ session, osFamily }: { session: SwoopSession | null; osFamily: MachineOsFamily }) {
  const capture = swoopInputCapture(session);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const last = useRef(FIELD_SENTINEL);
  const composing = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const open = useFieldFocused(session);
  const inset = useKeyboardInset(open);
  const armed = useSyncExternalStore(
    capture?.onArmedKeysChange ?? subscribeNever,
    capture ? () => capture.armedKeys : nothingArmed,
    nothingArmed,
  );

  // a watcher types nothing
  if (!capture) return null;

  const reset = (field: HTMLTextAreaElement): void => {
    field.value = FIELD_SENTINEL;
    last.current = FIELD_SENTINEL;
  };

  const onInput = (field: HTMLTextAreaElement): void => {
    const { backspaces, typed } = textChange(last.current, field.value);
    last.current = field.value;
    for (let i = 0; i < backspaces; i += 1) capture.typeKey('Backspace', false);
    const { keys, dropped } = keysFor(typed);
    for (const key of keys) capture.typeKey(key.code, key.shift);
    if (dropped > 0) setNote("some characters have no key on a US keyboard, so they weren't sent.");
    // between words, never mid-composition, which a reset would break
    const settled = !composing.current && (typed.includes('\n') || field.value.length > FIELD_LIMIT);
    if (!field.value.startsWith(FIELD_SENTINEL) || settled) reset(field);
  };

  const key = (code: string, label: string, sticky: boolean, Icon?: typeof ArrowLeft) => (
    <Button
      key={code}
      variant="ghost"
      size="sm"
      aria-label={label}
      aria-pressed={sticky ? armed.includes(code) : undefined}
      // lit by the ghost variant's own pressed style
      className="h-9 min-w-0 flex-1 basis-0 px-0 text-xs"
      // the field keeps focus, so the keyboard stays up
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!sticky) capture.typeKey(code, false);
        // a second tap on a lit modifier lets it go
        else if (armed.includes(code)) capture.releaseArmedKey(code);
        else capture.holdNextKey(code);
      }}
    >
      {Icon ? <Icon aria-hidden /> : label}
    </Button>
  );

  return (
    <>
      <textarea
        ref={fieldRef}
        data-swoop-keyboard
        aria-label="type on the machine"
        rows={1}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        // 16px, below which ios zooms the page into a focused field
        className="pointer-events-none absolute bottom-0 left-0 h-px w-px resize-none text-base opacity-0"
        onFocus={(event) => {
          reset(event.currentTarget);
          setNote(null);
        }}
        // a modifier lit on the row goes with it: unseen, it turned the next tap into ctrl+click
        onBlur={() => {
          for (const code of capture.armedKeys) capture.releaseArmedKey(code);
        }}
        onInput={(event) => onInput(event.currentTarget)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
      />
      {open && (
        <div
          data-testid="swoop-key-row"
          className="fixed inset-x-0 z-30 border-t border-border bg-card"
          style={{ bottom: inset }}
        >
          {note && <p className="px-3 pt-1.5 text-xs text-muted-foreground">{note}</p>}
          {/* ten keys sharing the width, so the narrowest phone shows every one */}
          <div className="flex items-center gap-0.5 px-1 py-1">
            {key('Escape', 'esc', false)}
            {key('Tab', 'tab', false)}
            {MODIFIERS[osFamily].map(([code, label]) => key(code, label, true))}
            {ARROWS.map(([code, label, Icon]) => key(code, label, false, Icon))}
            <Button
              variant="ghost"
              size="sm"
              aria-label="hide the keyboard"
              className="h-9 min-w-0 flex-1 basis-0 px-0"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => fieldRef.current?.blur()}
            >
              <ChevronDown aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
