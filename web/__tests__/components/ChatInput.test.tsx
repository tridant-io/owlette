/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ChatInput's `@machine` composer: the list opens on a mention token, filters as
 * it is typed, completes with the keyboard or the mouse, and leaves the caret
 * where typing carries on. The load-bearing part is what it does NOT do — Enter
 * keeps sending whenever the list is closed, and a caller that passes no
 * mention options gets exactly the composer that shipped before this wave.
 *
 * Also the pasted-image strip: named remove buttons, and thumbnails that open
 * a modal lightbox from the keyboard and give focus back on Escape.
 *
 * Radix positions the popover with a ResizeObserver that jsdom does not have.
 * Nothing here depends on layout, so a no-op observer is enough.
 */
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatInput } from '@/app/hoot/components/ChatInput';
import type { MentionMachine } from '@/app/hoot/components/MentionPopover';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const MACHINES: MentionMachine[] = [
  { id: 'kiosk-01', online: true, hootEnabled: true },
  { id: 'kiosk-02', online: false, hootEnabled: true },
  { id: 'studio-01', online: true, hootEnabled: false },
];

function Harness({
  mentionOptions,
  onSubmit,
  clearOnSubmit,
  targetLabel,
}: {
  mentionOptions?: MentionMachine[];
  onSubmit: (e: React.FormEvent) => void;
  /** What the real caller does: `handleSend` empties the box on send. */
  clearOnSubmit?: boolean;
  targetLabel?: string;
}) {
  const [input, setInput] = useState('');
  return (
    <ChatInput
      input={input}
      isLoading={false}
      onInputChange={(e) => setInput(e.target.value)}
      onSubmit={(e) => {
        onSubmit(e);
        if (clearOnSubmit) setInput('');
      }}
      onStop={jest.fn()}
      pendingImages={[]}
      onPasteImage={jest.fn()}
      onRemoveImage={jest.fn()}
      mentionOptions={mentionOptions}
      targetLabel={targetLabel}
    />
  );
}

// No default on the options: `undefined` is itself a case under test — the
// caller that has not wired targeting yet — and a default parameter would
// silently swallow it.
function renderComposer(
  mentionOptions: MentionMachine[] | undefined,
  { clearOnSubmit = false, targetLabel }: { clearOnSubmit?: boolean; targetLabel?: string } = {},
) {
  const onSubmit = jest.fn((e: React.FormEvent) => e.preventDefault());
  const user = userEvent.setup();
  render(
    <Harness
      mentionOptions={mentionOptions}
      onSubmit={onSubmit}
      clearOnSubmit={clearOnSubmit}
      targetLabel={targetLabel}
    />,
  );
  // By its accessible name, not its placeholder: the placeholder names the
  // chat's target and so changes with it.
  const box = screen.getByLabelText('chat message') as HTMLTextAreaElement;
  return { user, onSubmit, box };
}

function optionNames(): string[] {
  return screen.getAllByRole('option').map((o) => o.textContent ?? '');
}

describe('ChatInput placeholder', () => {
  it('names the chat target so the field says where the question lands', () => {
    const { box } = renderComposer(MACHINES, { targetLabel: 'kiosk-01' });

    expect(box).toHaveAttribute('placeholder', 'ask kiosk-01 anything...');
  });

  it('stays generic when there is no target to name', () => {
    // What the view passes while the selection is empty or unreadable — the
    // picker's own "no machines" would read as a question to nobody.
    const { box } = renderComposer(MACHINES);

    expect(box).toHaveAttribute('placeholder', 'ask anything...');
  });
});

describe('ChatInput mention list', () => {
  it('opens on `@` and lists every machine with its status as text', async () => {
    const { user, box } = renderComposer(MACHINES);

    await user.type(box, '@');

    // Named, because axe's aria-input-field-name covers role="listbox".
    expect(screen.getByRole('listbox', { name: 'machines to mention' })).toBeInTheDocument();
    expect(optionNames()).toEqual(['kiosk-01', 'kiosk-02offline', 'studio-01hoot off']);
  });

  // The popover's height is sized to this cap; anything past it would turn the
  // list into a scroll region, which axe rejects on a listbox that is not a
  // combobox popup.
  it('shows at most the eight best matches on a large site', async () => {
    const many: MentionMachine[] = Array.from({ length: 12 }, (_, i) => ({
      id: `kiosk-${String(i + 1).padStart(2, '0')}`,
      online: true,
      hootEnabled: true,
    }));
    const { user, box } = renderComposer(many);

    await user.type(box, '@');

    expect(screen.getAllByRole('option')).toHaveLength(8);
  });

  it('filters to the typed query', async () => {
    const { user, box } = renderComposer(MACHINES);

    await user.type(box, 'restart @stu');

    expect(optionNames()).toEqual(['studio-01hoot off']);
  });

  it('completes with the arrow keys and Enter instead of sending', async () => {
    const { user, onSubmit, box } = renderComposer(MACHINES);

    await user.type(box, '@k');
    expect(optionNames()).toEqual(['kiosk-01', 'kiosk-02offline']);

    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id);

    await user.keyboard('{Enter}');

    expect(box.value).toBe('@kiosk-02 ');
    expect(box.selectionStart).toBe('@kiosk-02 '.length);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('walks the list in both directions and wraps at the ends', async () => {
    const { user, box } = renderComposer(MACHINES);
    const selected = () =>
      screen.getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');

    await user.type(box, '@');
    expect(selected()).toBe(0);

    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe(1);

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(selected()).toBe(2);
  });

  it('completes on click without taking focus off the composer', async () => {
    const { user, box } = renderComposer(MACHINES);

    await user.type(box, 'check @kiosk-0');
    await user.click(screen.getByRole('option', { name: 'kiosk-01' }));

    expect(box.value).toBe('check @kiosk-01 ');
    expect(box).toHaveFocus();
  });

  it('keeps the caret mid-sentence after a completion', async () => {
    const { user, box } = renderComposer(MACHINES);

    await user.type(box, '@kio and reboot');
    // Back to just after "@kio", where the mention is still being typed.
    fireEvent.select(box, { target: { selectionStart: 4, selectionEnd: 4 } });
    await user.keyboard('{Enter}');

    expect(box.value).toBe('@kiosk-01 and reboot');
    expect(box.selectionStart).toBe('@kiosk-01 '.length);
  });

  it('Escape closes the list and the next Enter sends', async () => {
    const { user, onSubmit, box } = renderComposer(MACHINES);

    await user.type(box, '@kio');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box.value).toBe('@kio');

    // Still closed after another keystroke inside the same `@` token.
    await user.type(box, 's');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(box.value).toBe('@kios');
  });

  // The dismissal is remembered by index, and the composer is not remounted
  // between messages — so a send has to release it or the next `@` at the same
  // index (index 0, most often) would never get a list.
  it('offers the list again in the next message after a dismissal', async () => {
    const { user, onSubmit, box } = renderComposer(MACHINES, { clearOnSubmit: true });

    await user.type(box, '@kio');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(box.value).toBe('');

    await user.type(box, '@');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('stays closed while an IME is composing, and opens once it commits', async () => {
    const { user, box } = renderComposer(MACHINES);

    fireEvent.compositionStart(box);
    await user.type(box, '@');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.compositionEnd(box);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('lets an IME commit its candidate with Enter instead of sending', async () => {
    const { onSubmit, box } = renderComposer(MACHINES);

    fireEvent.change(box, { target: { value: 'よろ' } });
    fireEvent.compositionStart(box);
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();

    // And the Enter after the candidate is committed still sends.
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('names the machines a mention will narrow the turn to', async () => {
    const { user, box } = renderComposer(MACHINES);

    expect(screen.queryByText(/this turn/)).not.toBeInTheDocument();

    await user.type(box, '@kiosk-01 and @studio-01 reboot now');

    expect(screen.getByText('this turn → kiosk-01, studio-01')).toBeInTheDocument();
  });

  it('leaves an unknown `@word` as plain text', async () => {
    const { user, box } = renderComposer(MACHINES);

    await user.type(box, 'mail dylan@example.com now');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/this turn/)).not.toBeInTheDocument();
  });

  it('advertises the list to assistive tech only while it is open', async () => {
    const { user, box } = renderComposer(MACHINES);

    expect(box).toHaveAttribute('aria-autocomplete', 'list');
    expect(box).not.toHaveAttribute('aria-controls');
    expect(box).not.toHaveAttribute('aria-activedescendant');

    await user.type(box, '@');

    expect(box).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    expect(box).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);
  });

  it('is the composer that shipped before mentions when no options are passed', async () => {
    const { user, onSubmit, box } = renderComposer(undefined);

    await user.type(box, '@kiosk-01 restart');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/this turn/)).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('ChatInput pasted images', () => {
  const IMAGES = [
    { url: 'https://example.test/a.png', mediaType: 'image/png', uploading: false },
    { url: 'https://example.test/b.png', mediaType: 'image/png', uploading: false },
  ];

  function renderWithImages() {
    const onRemoveImage = jest.fn();
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ChatInput
          input=""
          isLoading={false}
          onInputChange={jest.fn()}
          onSubmit={jest.fn()}
          onStop={jest.fn()}
          pendingImages={IMAGES}
          onPasteImage={jest.fn()}
          onRemoveImage={onRemoveImage}
        />
      </TooltipProvider>,
    );
    return { user, onRemoveImage };
  }

  it('names each remove button after the image it removes', async () => {
    const { user, onRemoveImage } = renderWithImages();

    await user.click(screen.getByRole('button', { name: 'remove pasted image 2' }));

    expect(onRemoveImage).toHaveBeenCalledWith(1);
  });

  it('opens a thumbnail from the keyboard into a dialog, and Escape hands focus back', async () => {
    const { user } = renderWithImages();
    const thumbnail = screen.getByRole('button', { name: 'view pasted image 1' });

    thumbnail.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'pasted image' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'close image' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(thumbnail).toHaveFocus();
  });
});
