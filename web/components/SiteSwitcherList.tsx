'use client';

import { useMemo, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { highlightMatch } from '@/components/admin/sites/highlightMatch';
import { SearchRow } from '@/components/SearchRow';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** past this many sites the list has a filter */
export const SITE_FILTER_THRESHOLD = 10;

const FILTER_SELECTOR = '[data-site-filter]';
const ITEM_SELECTOR = '[data-site-item]';

type Surface = 'menu' | 'drawer' | 'popover';

// the filter is a SearchRow, whose rule runs edge to edge, so `filter` holds only what a surface
// adds to it: the menu's row takes back the p-1 its menu pads with, and the drawer's lines up
// with its px-4 rows. a menu marks the focused item, which the pointer focuses too; the
// lists mark the hovered one. over that accent fill in dark the cyan marks and the muted id
// miss aa, so the marked row takes the stronger tone, as in the add-member search
const SURFACE: Record<Surface, { filter: string; list?: string; item: string; id: string; empty: string }> = {
  menu: {
    filter: '-mx-1 -mt-1 mb-1',
    item: 'group flex cursor-pointer items-center justify-between text-foreground focus:bg-accent focus:text-foreground dark:focus:[&_mark]:text-accent-foreground',
    id: 'group-focus:text-accent-foreground/80',
    empty: 'px-2 py-1.5',
  },
  drawer: {
    filter: 'px-4',
    item: 'group flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-accent dark:hover:[&_mark]:text-accent-foreground',
    id: 'group-hover:text-accent-foreground/80',
    empty: 'px-4 py-2.5',
  },
  popover: {
    filter: '',
    list: 'max-h-72 overflow-y-auto p-1',
    item: 'group flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent dark:hover:[&_mark]:text-accent-foreground',
    id: 'group-hover:text-accent-foreground/80',
    empty: 'px-2 py-1.5',
  },
};

/**
 * an escape the filter spends on clearing its text. a radix menu or popover,
 * and the header's drawer, see escape before the filter does, so they ask this
 * before they close: the first escape clears, the next one closes.
 */
export function filterClaimsEscape(event: { key: string; target: EventTarget | null }): boolean {
  const { target } = event;
  return (
    event.key === 'Escape' &&
    target instanceof HTMLInputElement &&
    target.matches(FILTER_SELECTOR) &&
    target.value !== ''
  );
}

/** spread onto the radix menu or popover content that holds the list */
export const siteFilterHostProps = {
  onEscapeKeyDown(event: KeyboardEvent) {
    if (filterClaimsEscape(event)) event.preventDefault();
  },
  // radix focuses a menu itself as the pointer leaves an item, and a key typed
  // there would be typeahead, so that focus goes on to the filter
  onFocus(event: FocusEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    event.currentTarget.querySelector<HTMLInputElement>(FILTER_SELECTOR)?.focus({ preventScroll: true });
  },
};

/**
 * the sites to switch between, with a filter on top past SITE_FILTER_THRESHOLD.
 * `menu` renders the items of the dropdown menu around it, `drawer` full-width
 * rows, `popover` inset rows that scroll under the filter.
 */
export function SiteSwitcherList({
  sites,
  currentSiteId,
  onPick,
  surface,
}: {
  sites: readonly { id: string; name: string }[];
  currentSiteId?: string;
  onPick: (siteId: string) => void;
  surface: Surface;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const styles = SURFACE[surface];

  const showFilter = sites.length > SITE_FILTER_THRESHOLD;
  const query = showFilter ? text.trim() : '';
  const needle = query.toLowerCase();
  const shown = useMemo(
    () => (needle ? sites.filter((s) => s.name.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle)) : sites),
    [sites, needle],
  );

  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);

  function handleFilterKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    // an ime owns these keys while it composes
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      // with nothing to clear, escape is the surface's, and it closes
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      setText('');
      return;
    }
    // every other key but tab is the filter's: a menu around it would take it as typeahead
    if (e.key === 'Tab') return;
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items()[0]?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (query) items()[0]?.click();
    }
  }

  function handleListKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = items();
    const index = all.indexOf(e.target as HTMLElement);
    if (index === -1) return;
    const next = index + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) {
      // up from the first site goes back to the filter
      if (!inputRef.current) return;
      e.preventDefault();
      inputRef.current.focus();
      return;
    }
    // radix moves the focus between a menu's items
    if (surface === 'menu') return;
    e.preventDefault();
    all[next]?.focus();
  }

  return (
    <>
      {showFilter && (
        <SearchRow
          variant="row"
          ref={inputRef}
          data-site-filter=""
          // in a menu a key typed anywhere else is typeahead, so the filter has the focus from the start
          autoFocus={surface === 'menu'}
          value={text}
          onChange={setText}
          onKeyDown={handleFilterKeyDown}
          placeholder="filter sites…"
          aria-label="filter sites"
          className={styles.filter}
        />
      )}
      <div ref={listRef} onKeyDown={handleListKeyDown} className={styles.list}>
        {query && shown.length === 0 ? (
          <p className={cn('text-sm text-muted-foreground wrap-anywhere', styles.empty)}>no sites match “{query}”</p>
        ) : (
          shown.map((site) => {
            const current = site.id === currentSiteId;
            // a site found by its id shows the id, so the row says why it is here
            const byIdOnly = !!needle && !site.name.toLowerCase().includes(needle);
            const content = (
              <>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{highlightMatch(site.name, query)}</span>
                  {byIdOnly && (
                    <span className={cn('truncate text-xs text-muted-foreground', styles.id)}>
                      {highlightMatch(site.id, query)}
                    </span>
                  )}
                </span>
                {current && <Check className="h-4 w-4 flex-shrink-0 text-accent-cyan" />}
              </>
            );
            return surface === 'menu' ? (
              <DropdownMenuItem
                key={site.id}
                data-site-item=""
                aria-current={current || undefined}
                onClick={() => onPick(site.id)}
                className={styles.item}
              >
                {content}
              </DropdownMenuItem>
            ) : (
              <button
                key={site.id}
                type="button"
                data-site-item=""
                aria-current={current || undefined}
                onClick={() => onPick(site.id)}
                className={styles.item}
              >
                {content}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
