/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MemberSearchInput, the add-member search: a textbox that suggests people from
 * the caller's other sites, picks one with the keyboard or the mouse, and
 * otherwise hands up a typed full email. the load-bearing refusal: a full email
 * that is only part of someone else's address is never picked by enter.
 */
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { MemberSearchInput } from '@/components/admin/sites/MemberSearchInput';
import type { MemberCandidate } from '@/lib/memberCandidates';

// radix measures its popover with a ResizeObserver and drives pointers with
// pointer capture; jsdom has neither.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();
window.HTMLElement.prototype.scrollIntoView = jest.fn();

const CANDIDATES: MemberCandidate[] = [
  { uid: 'u-rae', email: 'rae@example.com', displayName: 'rae calloway' },
  { uid: 'u-ravi', email: 'ravi@example.com', displayName: 'ravi shah' },
  { uid: 'u-sal', email: 'sal@example.com', displayName: null },
  { uid: 'u-kim', email: 'kim@example.com', displayName: 'kim ortiz' },
  { uid: 'u-anon', email: null, displayName: null },
];

interface SearchProps {
  candidates?: readonly MemberCandidate[];
  loading?: boolean;
  error?: string | null;
}

function renderSearch({ candidates = CANDIDATES, loading = false, error = null }: SearchProps = {}) {
  const onTargetChange = jest.fn();
  const onSubmit = jest.fn();
  const user = userEvent.setup();
  render(
    <MemberSearchInput
      id="add-member-query"
      describedBy="add-member-query-hint"
      candidates={candidates}
      loading={loading}
      error={error}
      onTargetChange={onTargetChange}
      onSubmit={onSubmit}
    />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  return { user, input, onTargetChange, onSubmit };
}

/** each option's lines: the name (or email, or 'unnamed account'), then the email under a name */
function optionLines(): string[][] {
  return screen.getAllByRole('option').map((o) => Array.from(o.children, (line) => line.textContent ?? ''));
}

function activeIndex(): number {
  return screen.getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');
}

describe('MemberSearchInput suggestions', () => {
  it('opens on focus with the first six people, named by name, then email, then unnamed account', async () => {
    const many: MemberCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      uid: `u-${i}`,
      email: `person${i}@example.com`,
      displayName: null,
    }));
    const { user, input } = renderSearch({ candidates: [CANDIDATES[0], CANDIDATES[4], ...many] });

    await user.click(input);

    expect(screen.getAllByRole('option')).toHaveLength(6);
    expect(optionLines().slice(0, 3)).toEqual([
      ['rae calloway', 'rae@example.com'],
      ['unnamed account'],
      ['person0@example.com'],
    ]);
  });

  it('filters to the typed text and marks where each row matched', async () => {
    const { user, input } = renderSearch();

    await user.type(input, 'ra');

    expect(screen.getByRole('listbox', { name: 'people you can add' })).toBeInTheDocument();
    expect(optionLines()).toEqual([
      ['rae calloway', 'rae@example.com'],
      ['ravi shah', 'ravi@example.com'],
    ]);
    const marks = screen
      .getAllByRole('option')
      .map((o) => Array.from(o.querySelectorAll('mark'), (m) => m.textContent));
    expect(marks).toEqual([
      ['ra', 'ra'],
      ['ra', 'ra'],
    ]);
  });

  it('walks the list with the arrows in both directions and wraps at the ends', async () => {
    const { user, input } = renderSearch();

    await user.type(input, 'ra');
    expect(activeIndex()).toBe(0);

    await user.keyboard('{ArrowUp}');
    expect(activeIndex()).toBe(1);

    await user.keyboard('{ArrowDown}');
    expect(activeIndex()).toBe(0);
  });

  it('picks with the arrows and enter, hands up the uid target, and the next enter submits', async () => {
    const { user, input, onTargetChange, onSubmit } = renderSearch();

    await user.type(input, 'ra');
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'uid', uid: 'u-ravi', label: 'ravi@example.com' });
    expect(input).toHaveValue('ravi@example.com');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('picks on click without taking focus off the input', async () => {
    const { user, input, onTargetChange } = renderSearch();

    await user.type(input, 'kim');
    await user.click(screen.getByRole('option', { name: /kim ortiz/ }));

    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'uid', uid: 'u-kim', label: 'kim@example.com' });
    expect(input).toHaveValue('kim@example.com');
    expect(input).toHaveFocus();
  });

  it('drops a pick as soon as the text changes', async () => {
    const { user, input, onTargetChange } = renderSearch();

    await user.type(input, 'kim');
    await user.keyboard('{Enter}');
    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'uid', uid: 'u-kim', label: 'kim@example.com' });

    await user.keyboard('{Backspace}');
    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'email', email: 'kim@example.co' });

    await user.clear(input);
    expect(onTargetChange).toHaveBeenLastCalledWith(null);
  });
});

describe('MemberSearchInput typed emails', () => {
  it('hands up a full email that matches no one, trimmed, and enter submits it', async () => {
    const { user, input, onTargetChange, onSubmit } = renderSearch();

    await user.type(input, ' new.person@example.org ');

    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'email', email: 'new.person@example.org' });

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('never lets enter pick someone whose address only contains the typed email', async () => {
    const { user, input, onTargetChange, onSubmit } = renderSearch();

    await user.type(input, 'al@example.com');

    // sal@example.com is still offered, but it is not the active option
    expect(optionLines()).toEqual([['sal@example.com']]);
    expect(activeIndex()).toBe(-1);
    expect(input).not.toHaveAttribute('aria-activedescendant');

    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'email', email: 'al@example.com' });
    expect(onTargetChange).not.toHaveBeenCalledWith(expect.objectContaining({ uid: 'u-sal' }));
    expect(input).toHaveValue('al@example.com');
  });

  it('lets an ime commit its candidate with enter instead of picking or submitting', async () => {
    const { user, input, onTargetChange, onSubmit } = renderSearch();

    await user.type(input, 'ra');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onTargetChange).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'uid' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    // and the enter after the ime commits picks as usual
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'uid', uid: 'u-rae', label: 'rae@example.com' });
  });

  it('makes an exact email match, in any case, the uid target and the active option', async () => {
    const { user, input, onTargetChange, onSubmit } = renderSearch();

    await user.type(input, 'RAE@example.com');

    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'uid', uid: 'u-rae', label: 'rae@example.com' });
    expect(screen.getByRole('option', { name: /rae calloway/ })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue('rae@example.com');
  });
});

describe('MemberSearchInput closing', () => {
  function InDialog({ onSubmit }: { onSubmit: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>add member</DialogTitle>
          <DialogDescription>give someone with an owlette account access to this site.</DialogDescription>
          <MemberSearchInput
            id="add-member-query"
            candidates={CANDIDATES}
            loading={false}
            error={null}
            onTargetChange={jest.fn()}
            onSubmit={onSubmit}
          />
        </DialogContent>
      </Dialog>
    );
  }

  it('escape closes only the list, and the dialog around it stays open', async () => {
    const onSubmit = jest.fn();
    const user = userEvent.setup();
    render(<InDialog onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox');

    await user.type(input, 'ra');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'add member' })).toBeInTheDocument();
    expect(input).toHaveValue('ra');
    expect(onSubmit).not.toHaveBeenCalled();

    // with the list closed, escape belongs to the dialog again
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'add member' })).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('opens a closed list again on an arrow key', async () => {
    const { user, input } = renderSearch();

    await user.type(input, 'ra');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(activeIndex()).toBe(0);
  });
});

describe('MemberSearchInput status line', () => {
  it('says no one matches, and asks for a full email until one is typed', async () => {
    const { user, input, onTargetChange } = renderSearch();

    await user.type(input, 'zed');

    expect(
      screen.getByText('no one from your other sites matches “zed”. type their full email to add someone new.'),
    ).toBeInTheDocument();
    // a line, never an option: an empty listbox fails axe
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-controls');
    expect(onTargetChange).toHaveBeenLastCalledWith(null);

    await user.type(input, '@example.com');

    expect(screen.getByText('no one from your other sites matches “zed@example.com”.')).toBeInTheDocument();
    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'email', email: 'zed@example.com' });
  });

  it('says people are loading', async () => {
    const { user, input } = renderSearch({ candidates: [], loading: true });

    await user.click(input);

    expect(screen.getByText('loading people…')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('says the list failed to load, and a full email still becomes the target', async () => {
    const { user, input, onTargetChange } = renderSearch({ candidates: [], error: 'failed to load people' });

    await user.click(input);

    expect(
      screen.getByText('could not load people from your other sites. you can still type a full email.'),
    ).toBeInTheDocument();

    await user.type(input, 'new.person@example.org');
    expect(onTargetChange).toHaveBeenLastCalledWith({ kind: 'email', email: 'new.person@example.org' });
  });
});

describe('MemberSearchInput semantics', () => {
  it('stays a textbox and advertises the list only while it is open', async () => {
    const { user, input } = renderSearch();

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('role');
    expect(input).toHaveAttribute('id', 'add-member-query');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-describedby', 'add-member-query-hint');
    expect(input).toHaveAttribute('placeholder', 'search, or type an email');
    expect(input).not.toHaveAttribute('aria-controls');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    await user.type(input, 'ra');

    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id);
  });
});
