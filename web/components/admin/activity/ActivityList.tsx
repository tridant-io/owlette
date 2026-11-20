'use client';

import { useId, useMemo, useState } from 'react';
import { Activity as ActivityIcon, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { useActivity, type ActivityRow, type ActivityView } from '@/hooks/useActivity';
import { useSites } from '@/hooks/useFirestore';
import { useUserManagement } from '@/hooks/useUserManagement';
import { useAuth } from '@/contexts/AuthContext';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { SegmentedControl } from '@/components/admin/SegmentedControl';
import { SiteSwitcherList, siteFilterHostProps } from '@/components/SiteSwitcherList';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DatePicker } from '@/components/ui/date-picker';
import { IconButton } from '@/components/ui/icon-button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DATE_PRESETS, fromYMD, toYMD, type DatePreset } from '@/lib/dateRange';
import {
  kindLabel,
  rowFacts,
  rowFullTime,
  rowMeta,
  rowTime,
  rowWhat,
  rowWho,
  type SiteNames,
} from './activityDisplay';

export const ACTIVITY_VIEWS: readonly ActivityView[] = ['all', 'flagged', 'changes', 'refused', 'sign-ins'];

export interface ActivityFilters {
  view: ActivityView;
  userId?: string;
  siteId?: string;
  datePreset: DatePreset;
  // yyyy-mm-dd, read only when datePreset is custom
  dateFrom?: string;
  dateTo?: string;
}

// "no filter" is the list's leading row. its id is empty, which no uid or site id is
const ANY = '';

// light takes the family surface; dark a tint of the solid, as the issue status badges do
const KIND_TONE: Record<ActivityRow['kind'], string> = {
  flagged: 'border-warning-border bg-warning-surface text-warning dark:border-transparent dark:bg-warning-solid/20',
  change: 'border-border bg-transparent text-muted-foreground',
  refused: 'border-warning-border bg-transparent text-warning',
  sign_in: 'border-primary bg-transparent text-primary',
};

function KindBadge({ row }: { row: ActivityRow }) {
  const high = row.kind === 'flagged' && row.severity === 'high';
  return (
    <Badge variant={high ? 'destructive' : 'outline'} className={high ? undefined : KIND_TONE[row.kind]}>
      {kindLabel(row)}
    </Badge>
  );
}

const EMPTY_COPY = { title: 'nothing here', detail: 'no activity matches this view and these filters' };

// one grid, two shapes. a phone: badge and age on the first line, who and what
// under them, the muted line last. md up: one row, age and badge in their own columns.
// cells are placed by line: a col-span utility would reset the col-start beside it
function ActivityItem({
  row,
  open,
  siteNames,
  onToggle,
  onFilter,
}: {
  row: ActivityRow;
  open: boolean;
  siteNames: SiteNames;
  onToggle: () => void;
  onFilter: (next: { userId?: string; siteId?: string }) => void;
}) {
  const person = row.subject ?? row.actor;
  return (
    <Collapsible asChild open={open} onOpenChange={onToggle}>
      <li>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 sm:px-4 md:grid-cols-[4.5rem_9rem_minmax(0,1fr)] md:gap-x-4"
          >
            <span className="col-[2] row-[1] text-right font-mono text-xs tabular-nums text-muted-foreground md:col-[1] md:row-[1/3] md:text-left">
              <time dateTime={new Date(row.at).toISOString()} title={rowFullTime(row)}>
                {rowTime(row)}
              </time>
            </span>
            <span className="col-[1] row-[1] flex md:col-[2] md:row-[1/3]">
              <KindBadge row={row} />
            </span>
            <span className="col-[1/3] row-[2] break-words text-sm md:col-[3] md:row-[1] md:truncate">
              <span className="font-semibold text-foreground">{rowWho(row)}</span>
              <span className="text-foreground"> {rowWhat(row)}</span>
            </span>
            <span className="col-[1/3] row-[3] break-words text-xs text-muted-foreground md:col-[3] md:row-[2] md:truncate">
              {rowMeta(row, siteNames)}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
          <div className="flex flex-col gap-3 px-3 pb-4 pt-1 sm:px-4 md:pl-[6.5rem]">
            <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              {rowFacts(row, siteNames).map(([key, value], i) => (
                <div key={`${key}:${i}`} className="contents">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="break-words font-mono text-xs text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap gap-2">
              {person.type === 'user' && person.id && (
                <Button variant="outline" size="sm" onClick={() => onFilter({ userId: person.id })}>
                  everything from this actor
                </Button>
              )}
              {row.siteId !== null && (
                <Button variant="outline" size="sm" onClick={() => onFilter({ siteId: row.siteId as string })}>
                  everything on this site
                </Button>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

function SkeletonRows() {
  return (
    <ul aria-hidden="true" className="divide-y divide-border">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex items-center gap-4 px-3 py-3.5 sm:px-4">
          <span className="h-3 w-10 rounded bg-muted motion-safe:animate-pulse" />
          <span className="h-5 w-20 rounded-full bg-muted motion-safe:animate-pulse" />
          <span className="flex-1 space-y-2">
            <span className="block h-3.5 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
            <span className="block h-3 w-1/3 rounded bg-muted motion-safe:animate-pulse" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One set of filters' rows. Keyed on them, so a change never shows the last set's rows. */
function ActivityResults({
  filters,
  siteNames,
  onFilter,
}: {
  filters: ActivityFilters;
  siteNames: SiteNames;
  onFilter: (next: ActivityFilters) => void;
}) {
  const { rows, loading, loadingMore, error, hasMore, loadMore, refresh } = useActivity(filters);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border bg-card" aria-busy={loading}>
        {loading ? (
          <>
            <span className="sr-only">loading activity</span>
            <SkeletonRows />
          </>
        ) : error && rows.length === 0 ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <p className="text-sm text-danger">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <ActivityIcon className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">{EMPTY_COPY.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{EMPTY_COPY.detail}</p>
          </div>
        ) : (
          <ul aria-label="activity" className="divide-y divide-border">
            {rows.map((row) => (
              <ActivityItem
                key={row.id}
                row={row}
                open={openId === row.id}
                siteNames={siteNames}
                onToggle={() => setOpenId(openId === row.id ? null : row.id)}
                onFilter={(next) => onFilter({ ...filters, view: 'all', ...next })}
              />
            ))}
          </ul>
        )}
      </div>

      {/* a page can hold no rows yet leave a token, so load more outlives an empty list */}
      {!loading && (hasMore || (error && rows.length > 0)) && (
        <div className="mt-4 flex flex-col items-center gap-2">
          {error && rows.length > 0 && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {hasMore && (
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore && <Loader2 className="motion-safe:animate-spin" />}
              {loadingMore ? 'loading...' : 'load more'}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

// a select with the site switcher's filter, as owlette swoop's site picker is: a combobox
// that opens the list in a popover, styled as the date range's select trigger beside it
function FilterPicker({
  label,
  noun,
  anyLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  noun: string;
  anyLabel: string;
  value?: string;
  options: { value: string; label: string }[];
  onChange: (next?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const items = useMemo(() => {
    // an id from the url that the list has not loaded yet still shows as itself
    const known = value && !options.some((o) => o.value === value) ? [...options, { value, label: value }] : options;
    return known.map((o) => ({ id: o.value, name: o.label }));
  }, [options, value]);
  const leading = useMemo(() => ({ id: ANY, name: anyLabel }), [anyLabel]);
  const current = value ?? ANY;
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown') return;
            e.preventDefault();
            setOpen(true);
          }}
          className="flex h-9 min-w-0 flex-1 basis-36 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:w-52 md:flex-none dark:bg-input/30 dark:hover:bg-input/50"
        >
          <span className="truncate">{value ? items.find((i) => i.id === value)?.name : anyLabel}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        id={listId}
        align="start"
        aria-label={noun}
        className="w-64 min-w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] p-0"
        {...siteFilterHostProps}
      >
        <SiteSwitcherList
          surface="popover"
          noun={noun}
          sites={items}
          leading={leading}
          currentSiteId={current}
          onPick={(next) => {
            setOpen(false);
            onChange(next === ANY ? undefined : next);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// the logs page's presets and custom range; each day picker keeps from at or before to
function DateRangeFilter({ filters, onChange }: { filters: ActivityFilters; onChange: (next: ActivityFilters) => void }) {
  const from = fromYMD(filters.dateFrom ?? '');
  const to = fromYMD(filters.dateTo ?? '');
  return (
    <div className="flex w-full flex-wrap gap-2 md:w-auto md:flex-nowrap">
      <Select value={filters.datePreset} onValueChange={(datePreset) => onChange({ ...filters, datePreset: datePreset as DatePreset })}>
        <SelectTrigger aria-label="date range" className="min-w-0 w-full md:w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DATE_PRESETS.map((preset) => (
            <SelectItem key={preset.value} value={preset.value}>
              {preset.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filters.datePreset === 'custom' && (
        <div className="flex w-full gap-2 md:w-auto">
          <Label htmlFor="activity-from" className="sr-only">
            from
          </Label>
          <DatePicker
            id="activity-from"
            className="min-w-0 flex-1 md:w-40 md:flex-none"
            value={from}
            onChange={(d) => onChange({ ...filters, dateFrom: d ? toYMD(d) : undefined })}
            placeholder="start date"
            disabled={to ? (d) => d > to : undefined}
          />
          <Label htmlFor="activity-to" className="sr-only">
            to
          </Label>
          <DatePicker
            id="activity-to"
            className="min-w-0 flex-1 md:w-40 md:flex-none"
            value={to}
            onChange={(d) => onChange({ ...filters, dateTo: d ? toYMD(d) : undefined })}
            placeholder="end date"
            disabled={from ? (d) => d < from : undefined}
          />
        </div>
      )}
    </div>
  );
}

/** The superadmin's feed of what was done and flagged, one view at a time, newest first. */
export function ActivityList({
  filters,
  onFiltersChange,
}: {
  filters: ActivityFilters;
  onFiltersChange: (filters: ActivityFilters) => void;
}) {
  const { user, userSites, isSuperadmin } = useAuth();
  const { users } = useUserManagement(isSuperadmin);
  const { sites } = useSites(user?.uid, userSites, isSuperadmin);
  // refresh remounts the results, which reads the first page again
  const [reloads, setReloads] = useState(0);

  const userOptions = useMemo(
    () =>
      users
        .filter((u) => u.email)
        .map((u) => ({ value: u.uid, label: u.email }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [users],
  );
  const siteOptions = useMemo(
    () => sites.map((s) => ({ value: s.id, label: s.name || s.id })).sort((a, b) => a.label.localeCompare(b.label)),
    [sites],
  );
  const siteNames = useMemo<SiteNames>(() => Object.fromEntries(siteOptions.map((o) => [o.value, o.label])), [siteOptions]);

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="mx-auto max-w-screen-2xl">
        <AdminPageHeader
          className="mb-3 md:mb-4"
          title="activity"
          description="what people, api keys and machines did across every site, newest first"
          actions={
            <IconButton label="refresh activity" variant="outline" onClick={() => setReloads((n) => n + 1)}>
              <RefreshCw />
            </IconButton>
          }
        />
        {/* a row of their own: five views and the pickers beside the title wrap the views at desktop widths */}
        <div className="mb-4 flex flex-wrap items-center gap-2 md:mb-6 md:gap-3">
          <SegmentedControl
            label="view"
            options={ACTIVITY_VIEWS.map((v) => ({ value: v, label: v }))}
            value={filters.view}
            onChange={(view) => onFiltersChange({ ...filters, view })}
          />
          <div className="flex w-full gap-2 md:w-auto">
            <FilterPicker
              label="user"
              noun="users"
              anyLabel="anyone"
              value={filters.userId}
              options={userOptions}
              onChange={(userId) => onFiltersChange({ ...filters, userId })}
            />
            <FilterPicker
              label="site"
              noun="sites"
              anyLabel="every site"
              value={filters.siteId}
              options={siteOptions}
              onChange={(siteId) => onFiltersChange({ ...filters, siteId })}
            />
          </div>
          <DateRangeFilter filters={filters} onChange={onFiltersChange} />
        </div>
        <ActivityResults
          key={`${filters.view}:${filters.userId ?? ''}:${filters.siteId ?? ''}:${filters.datePreset}:${filters.dateFrom ?? ''}:${filters.dateTo ?? ''}:${reloads}`}
          filters={filters}
          siteNames={siteNames}
          onFilter={onFiltersChange}
        />
      </div>
    </div>
  );
}
