'use client';

/**
 * Drag handle for the desktop conversation list, living in the gutter beside its
 * right edge.
 *
 * Fully controlled: `onResize` is the live channel (every pointermove, every
 * keypress) and `onCommit` fires once when the interaction ends, so the caller
 * can keep the Firestore write off the move path.
 *
 * Pointer capture, not window listeners — the browser keeps routing moves here
 * once the drag starts, including over the chat pane and past the window edge,
 * and releases on its own if the pointer is cancelled.
 */

import { useEffect, useRef, useState } from 'react';

/** Shift makes an arrow press cover ground without giving up fine control. */
const SHIFT_MULTIPLIER = 5;

interface ConversationResizeHandleProps {
  width: number;
  min: number;
  max: number;
  /** Arrow-key nudge in px. */
  step: number;
  /** Width a double-click restores. */
  defaultWidth: number;
  /** Live width, as often as the interaction demands — display only, no write. */
  onResize: (width: number) => void;
  /** End of the interaction: the width worth persisting. */
  onCommit: (width: number) => void;
}

export function ConversationResizeHandle({
  width,
  min,
  max,
  step,
  defaultWidth,
  onResize,
  onCommit,
}: ConversationResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  // Width this interaction has produced so far. The `width` prop lags a key
  // auto-repeat (the next keydown can arrive before React re-renders), and it is
  // also what tells `commit` whether anything actually moved.
  const pendingRef = useRef<number | null>(null);
  // The same value, for rendering. `width` is the COMMITTED pref and doesn't move
  // until the interaction ends, so aria-valuenow would otherwise stay silent
  // through a run of arrow presses — the one moment it has to speak.
  const [pending, setPending] = useState<number | null>(null);

  // A drag that travels over the chat pane would otherwise select its text.
  // Restored by the cleanup, so an unmount mid-drag can't leave it stuck.
  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [dragging]);

  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));

  const apply = (value: number) => {
    const next = clamp(value);
    pendingRef.current = next;
    setPending(next);
    onResize(next);
  };

  const commit = () => {
    const next = pendingRef.current;
    pendingRef.current = null;
    // Nothing moved — a bare click, a modifier release, or a blur with no
    // interaction behind it. Don't spend a write.
    if (next === null) return;
    setPending(null);
    onCommit(next);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only: a context-menu drag would capture the pointer and
    // never deliver the matching pointerup.
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width };
    setDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    apply(drag.startWidth + (e.clientX - drag.startX));
  };

  const handlePointerEnd = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    commit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = pendingRef.current ?? width;
    const delta = e.shiftKey ? step * SHIFT_MULTIPLIER : step;
    if (e.key === 'ArrowLeft') apply(current - delta);
    else if (e.key === 'ArrowRight') apply(current + delta);
    else if (e.key === 'Home') apply(min);
    else if (e.key === 'End') apply(max);
    else return;
    // Arrows and Home/End would otherwise scroll the conversation list.
    e.preventDefault();
  };

  const reset = () => {
    apply(defaultWidth);
    commit();
  };

  return (
    // A focusable separator is a window-splitter widget, so axe's
    // `aria-required-attr` (critical, and the /hoot route runs an axe gate)
    // demands aria-valuenow alongside the min/max.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="resize conversation list"
      aria-valuenow={pending ?? width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onDoubleClick={reset}
      onKeyDown={handleKeyDown}
      onKeyUp={commit}
      // Focus leaving mid-keypress (a click into the chat, an alt-tab while an
      // arrow auto-repeats) never delivers the keyup, which would strand the
      // width unwritten and leave the caller mid-interaction.
      onBlur={commit}
      // The strip fills the gutter BETWEEN the panel and the chat rather than
      // sitting on the panel's own edge, where it would cover the conversation
      // list's scrollbar (`scrollbar-width: thin` is ~11px) and take the thumb's
      // clicks. `touch-none` because preventDefault does not stop a touch pan —
      // a touchscreen laptop is above the `md` breakpoint this mounts at, and the
      // browser would otherwise claim a slightly diagonal drag and cancel it.
      //
      // The offset is the gutter (the panel's `mr-3`, 0.75rem) PLUS its 1px border:
      // an absolute right is measured from the containing block's PADDING box, so
      // a plain `-right-3` starts the strip 1px inside the panel's own edge and
      // lands the centre line 5px into a 12px gutter. Do not "simplify" it back.
      className="group absolute inset-y-0 -right-[calc(0.75rem_+_1px)] z-20 w-3 cursor-col-resize touch-none outline-none"
    >
      {/* The line is a positioned child so appearing on hover costs no layout. */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-accent-cyan transition-opacity ${
          dragging
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-60 group-focus-visible:opacity-100'
        }`}
      />
    </div>
  );
}
