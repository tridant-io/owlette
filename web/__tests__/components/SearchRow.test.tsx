/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * SearchRow — the one search the menus and hoot share (owner, 2026-11-05). a
 * `row` tops a menu: no box, a rule under it. a `field` is enclosed and
 * rounded, and its focus only tints its border. the x clears the text through
 * onChange and gives the focus back; under `always` it stays for a search the
 * x also closes. a key on the x never reaches the menu around it, where it
 * would be typeahead.
 */

import React, { createRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchRow } from '@/components/SearchRow';

type HostProps = Partial<React.ComponentProps<typeof SearchRow>> & { initial?: string };

// every caller holds the text itself
function Host({ initial = '', onChange, ...props }: HostProps) {
  const [value, setValue] = useState(initial);
  return (
    <SearchRow
      placeholder="filter things…"
      aria-label="filter things"
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const input = () => screen.getByRole('textbox', { name: 'filter things' });
const wrapper = () => input().parentElement!;

describe('SearchRow', () => {
  it('a row runs edge to edge with a rule under it, not a box', () => {
    render(<Host />);

    expect(wrapper()).toHaveClass('border-b', 'focus-within:border-ring', 'border-border', 'px-3', 'py-2');
    expect(wrapper()).not.toHaveClass('border');
    expect(wrapper()).not.toHaveClass('rounded-md');
  });

  it('a field is enclosed and rounded, and focus only tints its border', () => {
    render(<Host variant="field" />);

    expect(wrapper()).toHaveClass('rounded-md', 'border', 'border-border', 'focus-within:border-ring');
    expect(wrapper()).not.toHaveClass('border-b');
    // a border tint, not a glow
    expect(wrapper().className).not.toMatch(/:ring-/);
  });

  it('is a magnifier and a plain field that hands back the string', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Host onChange={onChange} />);

    expect(wrapper().querySelector('svg.lucide-search')).not.toBeNull();
    expect(input()).toHaveClass('bg-transparent');
    expect(input()).not.toHaveClass('border');
    expect(input()).toHaveAttribute('placeholder', 'filter things…');
    expect(input()).toHaveAttribute('type', 'text');
    expect(input()).toHaveAttribute('autocomplete', 'off');

    await user.type(input(), 'abc');

    // the types first: a change event in here would crash the diff of the next line
    expect(onChange.mock.calls.map(([next]) => typeof next)).toEqual(['string', 'string', 'string']);
    expect(onChange.mock.calls).toEqual([['a'], ['ab'], ['abc']]);
  });

  it('passes the rest of its props to the input', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    render(<Host id="the-filter" data-site-filter="" autoFocus onKeyDown={(e) => keys.push(e.key)} />);

    expect(input()).toHaveAttribute('id', 'the-filter');
    expect(input()).toHaveAttribute('data-site-filter', '');
    expect(input()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(keys).toEqual(['Enter']);
  });

  it('shows the x only while there is text, by default', async () => {
    const user = userEvent.setup();
    render(<Host />);

    expect(screen.queryByRole('button', { name: 'clear filter' })).toBeNull();
    await user.type(input(), 'a');
    expect(screen.getByRole('button', { name: 'clear filter' })).toBeInTheDocument();
  });

  it('keeps the x under always, even with no text', () => {
    render(<Host clear="always" clearLabel="close search" />);

    expect(screen.getByRole('button', { name: 'close search' })).toBeInTheDocument();
  });

  it('its x empties the text through onChange, focuses the input, then calls onClear', async () => {
    const user = userEvent.setup();
    const log: unknown[] = [];
    render(
      <Host
        initial="gallery"
        onChange={(next) => log.push(['change', next])}
        onClear={() => log.push(['clear', document.activeElement === input()])}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'clear filter' }));

    expect(log).toEqual([
      ['change', ''],
      ['clear', true],
    ]);
    expect(input()).toHaveValue('');
    expect(input()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'clear filter' })).toBeNull();
  });

  it('keeps a key on the x from the wrapper around it, but lets tab go on', async () => {
    const user = userEvent.setup();
    const reached: string[] = [];
    render(
      <div onKeyDown={(e) => reached.push(e.key)}>
        <Host initial="kiosk" />
      </div>,
    );
    screen.getByRole('button', { name: 'clear filter' }).focus();

    await user.keyboard('k{ArrowDown}');
    expect(reached).toEqual([]);

    await user.keyboard('{Tab}');
    expect(reached).toEqual(['Tab']);
  });

  it('forwards its ref to the input', () => {
    const ref = createRef<HTMLInputElement>();
    render(<SearchRow ref={ref} value="" onChange={() => {}} aria-label="filter things" />);

    expect(ref.current).toBe(input());
  });

  it("merges a caller's class, so its padding replaces the row's", () => {
    render(<Host className="px-4" />);

    expect(wrapper()).toHaveClass('px-4', 'py-2', 'border-b');
    expect(wrapper()).not.toHaveClass('px-3');
  });
});
