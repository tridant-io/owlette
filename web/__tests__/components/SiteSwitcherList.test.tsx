/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * SiteSwitcherList — the list of sites that the header's switcher, its phone
 * drawer and the swoop picker share. past ten sites it has a filter: a site's
 * name or id, in any case, with the match marked and the current site still
 * checked. enter picks the first match and arrow down goes into the list.
 * escape clears the text, and only an escape with nothing left to clear is the
 * surface's to close on. the filter is a search row, not a boxed field, and its
 * x clears the text too. the menu surface and the radix hosts are on trial in
 * PageHeader's suite and SwoopPicker's.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SITE_FILTER_THRESHOLD, SiteSwitcherList, filterClaimsEscape } from '@/components/SiteSwitcherList';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const NAMED = [
  { id: 'elm-gate', name: 'LIVE NATION' },
  { id: 'gallery-n', name: 'Gallery North' },
  { id: 'gallery-s', name: 'Gallery South' },
  { id: 'lobby', name: 'Lobby Wall' },
];
// one past the threshold
const ELEVEN = [
  ...NAMED,
  ...Array.from({ length: SITE_FILTER_THRESHOLD + 1 - NAMED.length }, (_, i) => ({ id: `site-${i}`, name: `Kiosk ${i}` })),
];

function renderList(props: Partial<React.ComponentProps<typeof SiteSwitcherList>> = {}) {
  const onPick = jest.fn();
  const user = userEvent.setup();
  const view = render(<SiteSwitcherList surface="popover" sites={ELEVEN} currentSiteId="lobby" onPick={onPick} {...props} />);
  return { user, onPick, ...view };
}

const filterBox = () => screen.getByRole('textbox', { name: 'filter sites' });
const clearButton = () => screen.queryByRole('button', { name: 'clear filter' });
// every button but the filter's clear button
const siteRows = () => screen.queryAllByRole('button', { name: (name) => name !== 'clear filter' });
const shownNames = () => siteRows().map((button) => button.textContent);

describe('SiteSwitcherList', () => {
  it('has no filter at ten sites, and one at eleven', () => {
    expect(SITE_FILTER_THRESHOLD).toBe(10);
    const { unmount } = renderList({ sites: ELEVEN.slice(0, SITE_FILTER_THRESHOLD) });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(10);
    unmount();

    renderList();
    expect(filterBox()).toHaveAttribute('placeholder', 'filter sites…');
    expect(screen.getAllByRole('button')).toHaveLength(11);
  });

  it('filters by name in any case, and marks the match', async () => {
    const { user } = renderList();

    await user.type(filterBox(), 'GALLERY');

    expect(shownNames()).toEqual(['Gallery North', 'Gallery South']);
    const [north] = siteRows();
    expect(within(north).getByText('Gallery', { selector: 'mark' })).toBeInTheDocument();
    // a name match needs no id beside it
    expect(north).not.toHaveTextContent('gallery-n');
  });

  it('filters by id, and shows the id it matched', async () => {
    const { user } = renderList();

    await user.type(filterBox(), 'Elm-Gate');

    const buttons = siteRows();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('LIVE NATION');
    expect(within(buttons[0]).getByText('elm-gate', { selector: 'mark' })).toBeInTheDocument();
  });

  it('keeps the current site marked while filtering', async () => {
    const { user } = renderList();

    await user.type(filterBox(), 'wall');

    const current = screen.getByRole('button', { name: 'Lobby Wall' });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current.querySelector('svg')).not.toBeNull();
    await user.clear(filterBox());
    expect(screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-current'))).toEqual([
      screen.getByRole('button', { name: 'Lobby Wall' }),
    ]);
  });

  it('says so when no site matches', async () => {
    const { user } = renderList();

    await user.type(filterBox(), 'nowhere');

    expect(siteRows()).toHaveLength(0);
    expect(screen.getByText('no sites match “nowhere”')).toBeInTheDocument();
  });

  it('enter picks the first match, and nothing while the filter is empty', async () => {
    const { user, onPick } = renderList();

    await user.click(filterBox());
    await user.keyboard('{Enter}');
    expect(onPick).not.toHaveBeenCalled();

    await user.keyboard('gallery{Enter}');
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('gallery-n');
  });

  it('a click picks a site', async () => {
    const { user, onPick } = renderList();

    await user.click(screen.getByRole('button', { name: 'Kiosk 2' }));

    expect(onPick).toHaveBeenCalledWith('site-2');
  });

  it('arrow down moves from the filter into the list, and up from its first site comes back', async () => {
    const { user } = renderList();

    await user.type(filterBox(), 'gallery');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Gallery North' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Gallery South' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(filterBox()).toHaveFocus();
  });

  it('escape clears the text first, and only an escape with nothing to clear is left for the surface to close on', async () => {
    // a radix layer, or the header's drawer: it sees escape before the filter does
    const asked: boolean[] = [];
    const onCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') asked.push(filterClaimsEscape(e));
    };
    // and a surface that listens as the key bubbles
    const bubbled = jest.fn();
    document.addEventListener('keydown', onCapture, true);
    try {
      const user = userEvent.setup();
      render(
        <div onKeyDown={(e) => e.key === 'Escape' && bubbled()}>
          <SiteSwitcherList surface="popover" sites={ELEVEN} onPick={jest.fn()} />
        </div>,
      );

      await user.type(filterBox(), 'kiosk');
      await user.keyboard('{Escape}');

      expect(filterBox()).toHaveValue('');
      expect(screen.getAllByRole('button')).toHaveLength(11);
      expect(asked).toEqual([true]);
      expect(bubbled).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');

      expect(asked).toEqual([true, false]);
      expect(bubbled).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onCapture, true);
    }
  });

  it('leaves an escape in any other field alone', () => {
    const other = document.createElement('input');
    other.value = 'still typing';

    expect(filterClaimsEscape({ key: 'Escape', target: other })).toBe(false);
  });

  it('is a search row with a magnifier, not a boxed field', () => {
    renderList();

    expect(filterBox().parentElement?.querySelector('svg.lucide-search')).not.toBeNull();
    expect(filterBox()).toHaveClass('bg-transparent');
    expect(filterBox()).not.toHaveClass('border');
  });

  it('has no clear button while the filter is empty', () => {
    renderList();

    expect(clearButton()).toBeNull();
  });

  it('its x clears the text, keeps the focus in the filter and lists every site again', async () => {
    const { user } = renderList();

    await user.type(filterBox(), 'gallery');
    expect(siteRows()).toHaveLength(2);
    await user.click(clearButton()!);

    expect(filterBox()).toHaveValue('');
    expect(filterBox()).toHaveFocus();
    expect(siteRows()).toHaveLength(ELEVEN.length);
    expect(clearButton()).toBeNull();
  });

  it('in a menu, a key on the x stays there, so the menu never takes it as typeahead; tab goes on', async () => {
    const user = userEvent.setup();
    const reached: string[] = [];
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>sites</DropdownMenuTrigger>
        <DropdownMenuContent onKeyDown={(e) => reached.push(e.key)}>
          <SiteSwitcherList surface="menu" sites={ELEVEN} onPick={jest.fn()} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'sites' }));
    // the filter has the focus as the menu opens, and keeps what is typed in it
    await user.keyboard('kiosk');
    clearButton()!.focus();
    expect(clearButton()).toHaveFocus();

    await user.keyboard('k');
    expect(reached).toEqual([]);

    await user.keyboard('{Tab}');
    expect(reached).toEqual(['Tab']);
  });
});
