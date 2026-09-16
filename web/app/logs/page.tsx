'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrentSite } from '@/hooks/useCurrentSite';
import { NoSitesEmptyState } from '@/components/NoSitesEmptyState';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MultiSelect } from '@/components/ui/multi-select';
import { PageHeader } from '@/components/PageHeader';
import { collection, query, orderBy, limit, getDocs, where, startAfter, Query, DocumentData, Timestamp, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronsUpDown, ChevronsDownUp, Filter, X, Trash2, ScrollText, AlertTriangle, AlertCircle, Camera, Search } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { actionDeleteScope, planActionFilter } from '@/lib/logFilters';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import ConfirmDialog from '@/components/ConfirmDialog';
import { ManageSitesDialog } from '@/components/ManageSitesDialog';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import { AccountSettingsDialog } from '@/components/AccountSettingsDialog';
import DownloadButton from '@/components/DownloadButton';
import { DatePicker } from '@/components/ui/date-picker';
import { formatSiteScopedTimestamp, getDisplayTimezone, zonedTimeToUtcMs } from '@/lib/timeUtils';

interface LogEvent {
  id: string;
  timestamp: Timestamp;
  action: string;
  level: string;
  machineId: string;
  machineName: string;
  processName?: string;
  details?: string;
  userId?: string;
  screenshotUrl?: string;
}

const LOGS_PER_PAGE = 50;

// Date range presets
type DatePreset = 'all' | 'last_hour' | 'last_24h' | 'today' | 'yesterday' | 'last_7' | 'last_30' | 'this_week' | 'this_month' | 'last_month' | 'custom';

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'all', label: 'all time' },
  { value: 'last_hour', label: 'last hour' },
  { value: 'last_24h', label: 'last 24 hours' },
  { value: 'today', label: 'today' },
  { value: 'yesterday', label: 'yesterday' },
  { value: 'last_7', label: 'last 7 days' },
  { value: 'last_30', label: 'last 30 days' },
  { value: 'this_week', label: 'this week' },
  { value: 'this_month', label: 'this month' },
  { value: 'last_month', label: 'last month' },
  { value: 'custom', label: 'custom range' },
];

function getDateRange(preset: DatePreset, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  switch (preset) {
    case 'all':
      return { from: null, to: null };
    case 'last_hour': {
      const d = new Date(now);
      d.setHours(d.getHours() - 1);
      return { from: d, to: now };
    }
    case 'last_24h': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { from: d, to: now };
    }
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'last_7': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'last_30': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'this_week': {
      const d = new Date(now);
      const day = d.getDay();
      // Monday as start of week
      const diff = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - diff);
      return { from: startOfDay(d), to: endOfDay(now) };
    }
    case 'this_month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
    case 'last_month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from, to };
    }
    case 'custom': {
      const from = customFrom ? startOfDay(new Date(customFrom + 'T00:00:00')) : null;
      const to = customTo ? endOfDay(new Date(customTo + 'T00:00:00')) : null;
      return { from, to };
    }
    default:
      return { from: null, to: null };
  }
}

// Bridge the native-string filter state (YYYY-MM-DD) <-> the DatePicker's Date value.
const toYMD = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromYMD = (s: string): Date | undefined => (s ? new Date(s + 'T00:00:00') : undefined);

/**
 * Action-type filter options, grouped for the multi-select. There is no `all`
 * sentinel option: an empty selection means every action. Every `value` is a string a
 * real writer puts in `sites/{siteId}/logs.action` — an option nothing emits is a
 * dead filter, which `scheduled_reboot` was: the agent only ever writes the five
 * `scheduled_reboot_*` outcomes. Wire values keep the legacy "reboot" spelling on
 * purpose (see 9b8b52fd); only the labels say "restart". Display labels match
 * DISPLAY_EVENT_LABEL in lib/emailTemplates.server.ts so the feed, the alert email
 * and the talon tooltip name an event the same way.
 */
const ACTION_TYPE_GROUPS: { group: string | null; options: { value: string; label: string }[] }[] = [
  {
    group: 'agent',
    options: [
      { value: 'agent_started', label: 'agent started' },
      { value: 'agent_stopped', label: 'agent stopped' },
      { value: 'update_success', label: 'agent update succeeded' },
      { value: 'update_failed', label: 'agent update failed' },
      { value: 'update_unknown', label: 'agent update version mismatch' },
      { value: 'watchdog_restart', label: 'watchdog restart' },
      { value: 'watchdog_budget_exhausted', label: 'watchdog budget exhausted' },
      { value: 'unexpected_service_restart', label: 'unexpected service restart' },
    ],
  },
  {
    group: 'processes',
    options: [
      { value: 'process_started', label: 'process started' },
      { value: 'process_restarted', label: 'process restarted' },
      { value: 'process_stopped', label: 'process stopped' },
      { value: 'process_killed', label: 'process killed' },
      { value: 'process_crash', label: 'process crashed' },
      { value: 'process_start_failed', label: 'process start failed' },
      { value: 'process_launch_failed', label: 'process launch failed' },
      { value: 'exe_missing', label: 'executable missing' },
    ],
  },
  { group: 'commands', options: [{ value: 'command_executed', label: 'command executed' }] },
  {
    group: 'deployments',
    options: [
      { value: 'deployment_completed', label: 'deployment completed' },
      { value: 'deployment_failed', label: 'deployment failed' },
      { value: 'deployment_cancelled', label: 'deployment cancelled' },
    ],
  },
  {
    group: 'restarts',
    options: [
      { value: 'scheduled_reboot_announced', label: 'scheduled restart announced' },
      { value: 'scheduled_reboot_success', label: 'scheduled restart completed' },
      { value: 'scheduled_reboot_failed', label: 'scheduled restart failed' },
      { value: 'scheduled_reboot_missed', label: 'scheduled restart missed' },
      { value: 'scheduled_reboot_cancelled', label: 'scheduled restart cancelled' },
      { value: 'external_reboot', label: 'external restart' },
      { value: 'unexpected_reboot', label: 'unexpected restart' },
    ],
  },
  {
    group: 'displays',
    options: [
      { value: 'display_monitor_added', label: 'monitor added' },
      { value: 'display_monitor_removed', label: 'monitor removed' },
      { value: 'display_monitor_swapped', label: 'monitor swapped' },
      { value: 'display_drift', label: 'display drift detected' },
      { value: 'display_sync_lost', label: 'display sync lost' },
      { value: 'display_mosaic_disabled', label: 'nvidia mosaic disabled' },
      { value: 'display_apply_succeeded', label: 'display apply succeeded' },
      { value: 'display_apply_failed', label: 'display apply failed' },
      { value: 'display_apply_refused_mosaic', label: 'display apply refused (mosaic active)' },
      { value: 'display_apply_acked', label: 'display apply acknowledged' },
      { value: 'display_auto_revert_fired', label: 'display auto-reverted' },
      { value: 'display_revert_deferred', label: 'display revert deferred' },
      { value: 'display_auto_restore_fired', label: 'display auto-restored' },
      { value: 'display_auto_restore_skipped_unfixable', label: 'display auto-restore skipped' },
      { value: 'display_auto_restore_circuit_breaker_tripped', label: 'display auto-restore disabled' },
    ],
  },
  {
    group: 'talons',
    options: [
      { value: 'talon_triggered', label: 'talon triggered' },
      { value: 'talon_succeeded', label: 'talon succeeded' },
      { value: 'talon_failed', label: 'talon failed' },
      { value: 'talon_skipped', label: 'talon skipped' },
    ],
  },
];

/** Flat view for value→label lookups (the clear-logs scope copy). */
const ACTION_TYPES = ACTION_TYPE_GROUPS.flatMap((group) => group.options);

/** Selecting this many is the same as selecting none — see `planActionFilter`. */
const ACTION_TYPE_COUNT = ACTION_TYPES.length;

/** Wire value → display label, falling back to the raw value. */
const actionLabel = (value: string) =>
  ACTION_TYPES.find((type) => type.value === value)?.label ?? value;

// Level badges styling
const getLevelBadge = (level: string) => {
  const base = "inline-flex items-center rounded-full px-1.5 text-[11px] font-medium leading-5 whitespace-nowrap";
  switch (level.toLowerCase()) {
    case 'error':
      return <span className={`${base} bg-red-700 text-white`}>error</span>;
    case 'warning':
      return <span className={`${base} bg-yellow-400 text-gray-950`}>warning</span>;
    case 'info':
      return <span className={`${base} bg-accent-cyan text-gray-900`}>info</span>;
    default:
      return <span className={`${base} border border-border text-foreground`}>{level}</span>;
  }
};

const formatAction = (action: string) => {
  return action
    .split('_')
    .join(' ');
};

// While searching, load the whole set matching the server-side filters (not just the
// visible 50). Bounded so a busy site can't trigger an unbounded read.
const SEARCH_POOL_CAP = 2000;

// Firestore query for a site's logs honouring the active filters. Always ordered by
// timestamp desc so the page shows the most recent matches, not an arbitrary
// __name__-ordered slice. Every filter combination is backed by a composite index in
// firestore.indexes.json, so ordering, date window and equality resolve server-side
// — `in` reads as repeated equality, so it needs no index the `==` did not.
//
// Past 30 selected actions the query drops the action clause entirely and the
// caller narrows in memory; see `planActionFilter`.
function buildLogsQuery(
  logsRef: Query,
  filters: {
    actions: string[];
    machine: string;
    level: string;
    datePreset: DatePreset;
    dateFrom: string;
    dateTo: string;
  },
  max: number
): Query {
  const dateRange = getDateRange(filters.datePreset, filters.dateFrom, filters.dateTo);

  let q: Query = query(logsRef, orderBy('timestamp', 'desc'), limit(max));

  const actionPlan = planActionFilter(filters.actions, ACTION_TYPE_COUNT);
  if (actionPlan.inValues) q = query(q, where('action', 'in', actionPlan.inValues));
  if (filters.machine !== 'all') q = query(q, where('machineId', '==', filters.machine));
  if (filters.level !== 'all') q = query(q, where('level', '==', filters.level));
  if (dateRange.from) q = query(q, where('timestamp', '>=', Timestamp.fromDate(dateRange.from)));
  if (dateRange.to) q = query(q, where('timestamp', '<=', Timestamp.fromDate(dateRange.to)));

  return q;
}

// Shared column template so the header and every row line up: chevron · level · time ·
// event · machine · process · details(flex, truncates). Fixed columns ≈664px, so `md` up.
const LOG_COLS =
  'md:grid-cols-[14px_76px_104px_150px_132px_116px_minmax(0,1fr)] md:gap-3';

// Row layout. Below `md` the row is a wrapping stack and the column header is hidden
// (each field reads for itself); from `md` up it is the original fixed grid.
const LOG_GRID = `flex flex-wrap items-center gap-x-2 gap-y-1 md:grid ${LOG_COLS}`;

// Compact relative time ("2m ago"); the absolute stamp shows on hover + when expanded.
function relativeTime(date?: Date): string {
  if (!date) return '';
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

// Memoized so toggling one row doesn't re-render every other row — without it a click
// burns ~100–300ms on a full page before Radix can flip `data-state`, reading as lag.
const LogRow = React.memo(function LogRow({
  log,
  isExpanded,
  onToggle,
  onOpenScreenshot,
  timeDisplayMode,
  userTz,
  siteTz,
  timeFormat,
}: {
  log: LogEvent;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  onOpenScreenshot: (url: string) => void;
  timeDisplayMode: 'user' | 'machine' | 'site';
  userTz?: string;
  siteTz?: string;
  timeFormat: '12h' | '24h';
}) {
  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={() => onToggle(log.id)}
      data-testid={`log-row-${log.id}`}
      className={`group/row hover:bg-card/40 transition-colors border-b border-border last:border-b-0`}
    >
      <CollapsibleTrigger asChild>
        <button type="button" className="w-full px-4 py-3 md:py-2.5 text-left cursor-pointer">
          <div className={`${LOG_GRID} text-sm`}>
            {/* chevron — always visible on touch (there is no hover to reveal it) */}
            <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-all ${isExpanded ? 'opacity-100 rotate-180' : 'opacity-100 md:opacity-0 md:group-hover/row:opacity-100'}`} />
            {/* level */}
            <div className="flex-shrink-0">{getLevelBadge(log.level)}</div>
            {/* time (relative; absolute on hover) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground text-xs whitespace-nowrap truncate cursor-help flex-shrink-0">
                  {relativeTime(log.timestamp?.toDate())}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {formatSiteScopedTimestamp(
                  log.timestamp?.toDate(),
                  timeDisplayMode,
                  userTz,
                  siteTz,
                  timeFormat
                )}
              </TooltipContent>
            </Tooltip>
            {/* event */}
            <TruncatedText text={formatAction(log.action)} className="text-foreground font-medium" />
            {/* machine */}
            <TruncatedText text={log.machineName ?? ''} className="text-foreground" data-testid="log-machine" />
            {/* process — long names are the reason this column has a tooltip at all */}
            <TruncatedText text={log.processName || '—'} className="text-muted-foreground" data-testid="log-process" />
            {/* details preview (flex, truncates) + screenshot indicator — hidden once expanded, where the full details render below (avoids duplicating the text). Below `md` it takes its own full-width line under the other fields. */}
            <div className="flex items-center gap-2 min-w-0 w-full md:w-auto">
              {!isExpanded && log.screenshotUrl && <Camera className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
              {!isExpanded && (log.details ? (
                <TruncatedText text={log.details} className="text-muted-foreground min-w-0" data-testid="log-details" />
              ) : (
                <span className="text-muted-foreground/40">—</span>
              ))}
            </div>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <div className="px-4 pb-3 pt-3 border-t border-border/50 text-sm flex flex-col md:flex-row gap-4 md:gap-6 bg-card">
          <div className="flex-shrink-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 self-start">
            <span className="text-muted-foreground">machine id</span>
            <span className="text-foreground text-xs font-mono break-all">{log.machineId}</span>
            {log.userId && (
              <>
                <span className="text-muted-foreground">user</span>
                <span className="text-foreground text-xs font-mono break-all">{log.userId}</span>
              </>
            )}
            <span className="text-muted-foreground">timestamp</span>
            <span className="text-foreground">
              {formatSiteScopedTimestamp(
                log.timestamp?.toDate(),
                timeDisplayMode,
                userTz,
                siteTz,
                timeFormat
              )}
            </span>
          </div>
          {log.details && (
            <div className="flex-1 min-w-0 border-t md:border-t-0 md:border-l border-border/50 pt-3 md:pt-0 md:pl-6">
              <span className="text-muted-foreground text-xs">details</span>
              <p className="text-foreground mt-1 whitespace-pre-wrap break-words select-text">{log.details}</p>
            </div>
          )}
          {log.screenshotUrl && (
            <div className="flex-shrink-0 border-t md:border-t-0 md:border-l border-border/50 pt-3 md:pt-0 md:pl-6">
              <span className="text-muted-foreground text-xs">crash screenshot</span>
              <button onClick={() => onOpenScreenshot(log.screenshotUrl!)} className="block mt-1">
                <img
                  src={log.screenshotUrl}
                  alt="Crash screenshot"
                  className="rounded border border-border/50 max-w-[200px] max-h-[120px] object-cover hover:opacity-80 transition-opacity cursor-pointer"
                />
              </button>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

export default function LogsPage() {
  const router = useRouter();
  const { user, loading, userPreferences, isSiteAdmin } = useAuth();
  const {
    sites,
    sitesLoading,
    currentSiteId,
    siteTimezone,
    hasNoSites,
    selectSite,
    pickSite,
    createSite,
    updateSite,
    deleteSite,
  } = useCurrentSite();

  // `clear logs` calls DELETE /api/sites/{siteId}/logs, gated on
  // Capability.SITE_LOGS_MANAGE (app/api/sites/[siteId]/logs/route.ts) — admins on
  // their own sites, superadmins anywhere. Same predicate the server evaluates, so a
  // member never sees a control that would 403. Hidden, not disabled, matching the
  // dashboard's write-action gating.
  const canManageLogs = !!currentSiteId && isSiteAdmin(currentSiteId);

  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [lastDoc, setLastDoc] = useState<DocumentData | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const [filterActions, setFilterActions] = useState<string[]>([]);
  const [filterMachine, setFilterMachine] = useState<string>('all');
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [filterDatePreset, setFilterDatePreset] = useState<DatePreset>('all');
  const [filterDateFrom, setFilterDateFrom] = useState<string>('');
  const [filterDateTo, setFilterDateTo] = useState<string>('');
  // Clear-logs dialog date window — independent of the page's view filters.
  const [clearFrom, setClearFrom] = useState<Date | undefined>(undefined);
  const [clearTo, setClearTo] = useState<Date | undefined>(undefined);
  const [showFilters, setShowFilters] = useState(false);

  // Free-text search: `searchQuery` mirrors the input, `searchTerm` is the debounced value
  // the filter runs against, `searchActive` toggles collapsed button ↔ expanded field.
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [searchActive, setSearchActive] = useState(false);
  const [searchCollapsedW, setSearchCollapsedW] = useState<number>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchWrapperRef = useRef<HTMLDivElement>(null);
  const searchBtnRef = useRef<HTMLButtonElement>(null);
  // Full filtered scope loaded on demand while searching (see effect below).
  const [searchPool, setSearchPool] = useState<LogEvent[] | null>(null);
  const [searchPoolLoading, setSearchPoolLoading] = useState(false);
  const [searchPoolTruncated, setSearchPoolTruncated] = useState(false);
  const isSearching = searchTerm.length > 0;

  const [showClearDialog, setShowClearDialog] = useState(false);
  const [screenshotModalUrl, setScreenshotModalUrl] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);

  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);

  // Expanded log rows (multi-expand)
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());

  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const toggleLogExpanded = useCallback((logId: string) => {
    setExpandedLogIds(prev => {
      const next = new Set(prev);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  }, []);

  // Debounce so typing doesn't re-filter/re-render on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setSearchTerm(searchQuery.trim().toLowerCase()), 150);
    return () => clearTimeout(id);
  }, [searchQuery]);

  // Focus the field as it expands.
  useEffect(() => {
    if (searchActive) searchInputRef.current?.focus();
  }, [searchActive]);

  // Measure the collapsed button's natural width so expand/collapse animates between real
  // pixel widths — CSS can't transition to/from `auto`. Measured after paint, so exact.
  useEffect(() => {
    if (searchBtnRef.current) setSearchCollapsedW(searchBtnRef.current.offsetWidth);
  }, []);

  // Collapse back to a button on outside click, but only when empty, so an active search
  // is never silently hidden.
  useEffect(() => {
    if (!searchActive) return;
    const onMouseDown = (e: MouseEvent) => {
      if (searchWrapperRef.current?.contains(e.target as Node)) return;
      if (!searchQuery) setSearchActive(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [searchActive, searchQuery]);

  // Client-side substring filter: Firestore has no full-text query, so match in JS against
  // the search pool (the full filtered set, loaded on demand; on-screen logs until it
  // arrives) over formatted label, raw action, machine, process, level and details.
  const actionPlan = useMemo(
    () => planActionFilter(filterActions, ACTION_TYPE_COUNT),
    [filterActions],
  );

  // Selections too wide for Firestore's `in` are narrowed here instead, so what
  // is on screen always matches the filter however the query was resolved.
  const clientActionSet = useMemo(
    () => (actionPlan.clientSide ? new Set(filterActions) : null),
    [actionPlan, filterActions],
  );

  const filteredLogs = useMemo(() => {
    const base = searchTerm ? (searchPool ?? logs) : logs;
    const scoped = clientActionSet
      ? base.filter(log => clientActionSet.has(log.action))
      : base;
    if (!searchTerm) return scoped;
    return scoped.filter(log =>
      formatAction(log.action).toLowerCase().includes(searchTerm) ||
      log.action.toLowerCase().includes(searchTerm) ||
      log.machineName?.toLowerCase().includes(searchTerm) ||
      log.machineId?.toLowerCase().includes(searchTerm) ||
      log.processName?.toLowerCase().includes(searchTerm) ||
      log.details?.toLowerCase().includes(searchTerm) ||
      log.level.toLowerCase().includes(searchTerm)
    );
  }, [logs, searchPool, searchTerm, clientActionSet]);

  const allExpanded = filteredLogs.length > 0 && filteredLogs.every(l => expandedLogIds.has(l.id));

  const toggleAllExpanded = useCallback(() => {
    if (allExpanded) {
      setExpandedLogIds(new Set());
    } else {
      setExpandedLogIds(new Set(filteredLogs.map(l => l.id)));
    }
  }, [allExpanded, filteredLogs]);

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  const handleSiteChange = (siteId: string) => {
    selectSite(siteId);
  };

  // Real-time logs listener for initial batch
  useEffect(() => {
    if (!db) return;
    if (!currentSiteId) {
      // No site to subscribe to. Once the site list has settled that is terminal, not
      // transient — leaving `logsLoading` true is what pinned site-less accounts on "loading
      // logs..." forever, since only the onSnapshot callbacks clear it. Gated on
      // `!sitesLoading` so it can't flash an empty state while sites are in flight.
      if (!sitesLoading) {
        setLogs([]);
        setLogsLoading(false);
      }
      return;
    }

    setLogsLoading(true);
    setExpandedLogIds(new Set());

    const logsRef = collection(db, 'sites', currentSiteId, 'logs');
    const q = buildLogsQuery(
      logsRef,
      { actions: filterActions, machine: filterMachine, level: filterLevel, datePreset: filterDatePreset, dateFrom: filterDateFrom, dateTo: filterDateTo },
      LOGS_PER_PAGE + 1
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as LogEvent));

      const hasMoreData = docsData.length > LOGS_PER_PAGE;
      setHasMore(hasMoreData);

      // Drop the extra doc fetched for the has-more check.
      const displayLogs = hasMoreData ? docsData.slice(0, LOGS_PER_PAGE) : docsData;
      setLogs(displayLogs);

      if (displayLogs.length > 0) {
        setLastDoc(snapshot.docs[Math.min(LOGS_PER_PAGE - 1, snapshot.docs.length - 1)]);
      }

      setLogsLoading(false);
    }, (error) => {
      console.error('Error in logs listener:', error);
      setLogsLoading(false);
    });

    return () => unsubscribe();
  }, [currentSiteId, sitesLoading, filterActions, filterMachine, filterLevel, filterDatePreset, filterDateFrom, filterDateTo]);

  // While searching, load the full set matching the current server-side filters (capped)
  // so search spans the whole scope. Re-runs on filter change, not per keystroke.
  useEffect(() => {
    if (!isSearching || !currentSiteId || !db) {
      setSearchPool(null);
      setSearchPoolTruncated(false);
      setSearchPoolLoading(false);
      return;
    }

    let cancelled = false;
    setSearchPoolLoading(true);

    (async () => {
      try {
        const logsRef = collection(db, 'sites', currentSiteId, 'logs');
        const q = buildLogsQuery(
          logsRef,
          { actions: filterActions, machine: filterMachine, level: filterLevel, datePreset: filterDatePreset, dateFrom: filterDateFrom, dateTo: filterDateTo },
          SEARCH_POOL_CAP + 1
        );
        const snapshot = await getDocs(q);
        if (cancelled) return;

        const docsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as LogEvent));
        setSearchPoolTruncated(docsData.length > SEARCH_POOL_CAP);
        setSearchPool(docsData.slice(0, SEARCH_POOL_CAP));
      } catch (error) {
        if (!cancelled) {
          console.error('Error loading search pool:', error);
          setSearchPool(null);
        }
      } finally {
        if (!cancelled) setSearchPoolLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // `isSearching` (not `searchTerm`) so we don't refetch on every keystroke.
  }, [isSearching, currentSiteId, filterActions, filterMachine, filterLevel, filterDatePreset, filterDateFrom, filterDateTo]);

  // Infinite scroll — load more logs
  const loadMore = useCallback(async () => {
    if (!currentSiteId || !db || !lastDoc || !hasMore || isFetchingMore) return;

    setIsFetchingMore(true);

    try {
      // Same query as the initial page, advanced past the last loaded doc; reusing
      // buildLogsQuery keeps page N+1 from drifting away from page N.
      const logsRef = collection(db, 'sites', currentSiteId, 'logs');
      const baseQuery = buildLogsQuery(
        logsRef,
        { actions: filterActions, machine: filterMachine, level: filterLevel, datePreset: filterDatePreset, dateFrom: filterDateFrom, dateTo: filterDateTo },
        LOGS_PER_PAGE + 1
      );
      const q = query(baseQuery, startAfter(lastDoc));

      const snapshot = await getDocs(q);
      const docsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as LogEvent));

      const hasMoreData = docsData.length > LOGS_PER_PAGE;
      setHasMore(hasMoreData);

      const newLogs = hasMoreData ? docsData.slice(0, LOGS_PER_PAGE) : docsData;

      if (newLogs.length > 0) {
        setLogs(prev => [...prev, ...newLogs]);
        setLastDoc(snapshot.docs[Math.min(LOGS_PER_PAGE - 1, snapshot.docs.length - 1)]);
      }
    } catch (error) {
      console.error('Error loading more logs:', error);
    } finally {
      setIsFetchingMore(false);
    }
  }, [currentSiteId, lastDoc, hasMore, isFetchingMore, filterActions, filterMachine, filterLevel, filterDatePreset, filterDateFrom, filterDateTo]);

  // IntersectionObserver for infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current;
    // Pause infinite scroll while searching: a short filtered list keeps the
    // sentinel on-screen, which would otherwise auto-load every remaining page.
    if (!sentinel || searchTerm) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isFetchingMore) {
          loadMore();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isFetchingMore, loadMore, searchTerm]);

  const resetFilters = () => {
    setFilterActions([]);
    setFilterMachine('all');
    setFilterLevel('all');
    setFilterDatePreset('all');
    setFilterDateFrom('');
    setFilterDateTo('');
  };

  const handleClearLogs = async () => {
    if (!currentSiteId || !db) return;

    setIsClearing(true);

    try {
      // Resolve the clear-dialog date bounds in the SAME timezone the logs are displayed in,
      // not browser-local — otherwise a cross-timezone admin over-/under-deletes at the day
      // boundary.
      const clearTz = getDisplayTimezone(
        userPreferences.timeDisplayMode || 'machine',
        userPreferences.timezone,
        undefined,
        siteTimezone,
      );
      const since = clearFrom
        ? zonedTimeToUtcMs(clearFrom.getFullYear(), clearFrom.getMonth(), clearFrom.getDate(), 0, 0, 0, 0, clearTz)
        : undefined;
      const until = clearTo
        ? zonedTimeToUtcMs(clearTo.getFullYear(), clearTo.getMonth(), clearTo.getDate(), 23, 59, 59, 999, clearTz)
        : undefined;
      // Exactly what the view is showing. Sending fewer would delete rows the
      // user cannot see; sending none would fall through to `all: true` and
      // delete the whole site's logs.
      const clearActions = actionDeleteScope(filterActions, ACTION_TYPE_COUNT);
      const hasFilters =
        clearActions.length > 0 ||
        filterMachine !== 'all' ||
        filterLevel !== 'all' ||
        since !== undefined ||
        until !== undefined;
      const idempotencySuffix =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const res = await fetch(`/api/sites/${encodeURIComponent(currentSiteId)}/logs`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `dashboard-clear-logs-${idempotencySuffix}`,
        },
        body: JSON.stringify({
          ...(clearActions.length === 1 ? { action: clearActions[0] } : {}),
          ...(clearActions.length > 1 ? { actions: clearActions } : {}),
          ...(filterMachine !== 'all' ? { machineId: filterMachine } : {}),
          ...(filterLevel !== 'all' ? { level: filterLevel } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
          ...(!hasFilters ? { all: true } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.detail || body?.title || 'Failed to clear logs');
      }

      console.log(`Deleted ${body?.deletedCount ?? 0} log entries`);

      // Logs will refresh via the real-time listener
      setLogs([]);

    } catch (error) {
      console.error('Error clearing logs:', error);
    } finally {
      setIsClearing(false);
    }
  };

  // Machine filter options come from the full loaded set, not the search-filtered view,
  // so the dropdown doesn't collapse as you type.
  const uniqueMachines = Array.from(new Set(logs.map(log => log.machineId)));

  // Header stats reflect the currently shown (search-filtered) logs.
  const warningCount = filteredLogs.filter(l => l.level === 'warning').length;
  const errorCount = filteredLogs.filter(l => l.level === 'error').length;

  if (loading || sitesLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground">loading...</div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen pb-8">
      <PageHeader
        currentPage="logs"
        sites={sites}
        currentSiteId={currentSiteId}
        onSiteChange={handleSiteChange}
        onManageSites={() => setManageDialogOpen(true)}
        onAccountSettings={() => setAccountSettingsOpen(true)}
        actionButton={<DownloadButton />}
      />

      {/* Site Management Dialogs */}
      <ManageSitesDialog
        open={manageDialogOpen}
        onOpenChange={setManageDialogOpen}
        sites={sites}
        currentSiteId={currentSiteId}
        onUpdateSite={updateSite}
        onDeleteSite={async (siteId) => {
          await deleteSite(siteId);
          // If we deleted the current site, switch to another one
          if (siteId === currentSiteId) {
            const remainingSites = sites.filter(s => s.id !== siteId);
            if (remainingSites.length > 0) {
              handleSiteChange(remainingSites[0].id);
            }
          }
        }}
        onCreateSite={() => setCreateDialogOpen(true)}
      />

      <CreateSiteDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreateSite={createSite}
        // Focus the new site, matching /deployments, /roosts and /talons — logs omitted this,
        // so a user creating their first site here stayed on the no-sites state.
        onSiteCreated={(siteId) => pickSite(siteId)}
      />

      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={setAccountSettingsOpen}
      />

      {/* Main content */}
      <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
        {/* Section header with inline stats */}
        <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 md:gap-8">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">logs</h2>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 md:gap-8">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${filteredLogs.length > 0 ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-muted text-muted-foreground'}`}>
                  <ScrollText className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{filteredLogs.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">events</p>
                </div>
              </div>

              <div className="hidden md:block h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${warningCount > 0 ? 'bg-yellow-500/10 text-yellow-400' : 'bg-muted text-muted-foreground'}`}>
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${warningCount > 0 ? 'text-yellow-400' : 'text-foreground'}`}>{warningCount}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">warnings</p>
                </div>
              </div>

              <div className="hidden md:block h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${errorCount > 0 ? 'bg-red-500/10 text-red-400' : 'bg-muted text-muted-foreground'}`}>
                  <AlertCircle className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${errorCount > 0 ? 'text-red-400' : 'text-foreground'}`}>{errorCount}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">errors</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
            {filteredLogs.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={toggleAllExpanded}
                    aria-label={allExpanded ? 'collapse all logs' : 'expand all logs'}
                    data-testid="logs-expand-all"
                    className="transition-colors cursor-pointer"
                    size="icon"
                  >
                    {allExpanded ? <ChevronsDownUp className="w-4 h-4" /> : <ChevronsUpDown className="w-4 h-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{allExpanded ? 'collapse all' : 'expand all'}</p>
                </TooltipContent>
              </Tooltip>
            )}
            {/* Expanding search — collapsed it's a button styled like "show filters";
                clicking morphs it into the field, click-outside (when empty) collapses it back. */}
            <div
              ref={searchWrapperRef}
              style={!searchActive && searchCollapsedW ? { width: searchCollapsedW } : undefined}
              className={`relative inline-flex h-9 items-center transition-[width] duration-200 ease-out ${searchActive ? 'w-56 md:w-72' : ''}`}
            >
              <Button
                ref={searchBtnRef}
                variant="outline"
                onClick={() => setSearchActive(true)}
                aria-label="search logs"
                aria-hidden={searchActive}
                tabIndex={searchActive ? -1 : 0}
                className={`gap-2 transition-all duration-200 cursor-pointer ${searchActive ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
              >
                <Search className="w-4 h-4" />
                search
              </Button>
              <div
                aria-hidden={!searchActive}
                className={`absolute inset-0 transition-opacity duration-150 ${searchActive ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              >
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  type="text"
                  placeholder="search logs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearchQuery('');
                      setSearchActive(false);
                    }
                  }}
                  tabIndex={searchActive ? 0 : -1}
                  data-testid="logs-search"
                  className="h-9 w-full pl-9 pr-9 bg-muted border-border"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      searchInputRef.current?.focus();
                    }}
                    aria-label="clear search"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => setShowFilters(!showFilters)}
              aria-expanded={showFilters}
              className="gap-2 transition-colors cursor-pointer"
            >
              <Filter className="w-4 h-4" />
              {showFilters ? 'hide filters' : 'show filters'}
            </Button>
            {canManageLogs && (
              <Button
                onClick={() => setShowClearDialog(true)}
                disabled={isClearing || logs.length === 0}
                variant="outline"
                data-testid="logs-clear"
                className="gap-2 border-red-400/60 text-red-400 hover:bg-red-950/50 hover:text-red-300 dark:hover:bg-red-950/50 dark:hover:text-red-300 transition-colors cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                {isClearing ? 'clearing...' : 'clear logs'}
              </Button>
            )}
          </div>
        </div>

        {/* Filters — animated expand/collapse via Radix Collapsible, reusing the
            shared collapsible-down/up keyframes in globals.css */}
        <Collapsible open={showFilters} onOpenChange={setShowFilters}>
          <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
          <Card className="p-4 bg-card border-border mb-6">
            {/* One row, packed left, with reset pushed to the far edge. The
                custom from/to fields join this row rather than opening a second
                one — there is width to spare, and a whole extra row for two
                date fields reads as a layout accident. */}
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-full sm:w-48">
                <Label className="text-foreground text-sm mb-2 block">action type</Label>
                <MultiSelect
                  groups={ACTION_TYPE_GROUPS}
                  selected={filterActions}
                  onChange={setFilterActions}
                  allLabel="all actions"
                  itemNoun="actions"
                  searchPlaceholder="search actions…"
                  data-testid="logs-filter-action"
                />
              </div>

              <div className="w-full sm:w-40">
                <Label className="text-foreground text-sm mb-2 block">machine</Label>
                <Select value={filterMachine} onValueChange={setFilterMachine}>
                  <SelectTrigger data-testid="logs-filter-machine" className="bg-muted border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">all machines</SelectItem>
                    {uniqueMachines.map(machine => (
                      <SelectItem key={machine} value={machine}>
                        {machine}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="w-full sm:w-32">
                <Label className="text-foreground text-sm mb-2 block">level</Label>
                <Select value={filterLevel} onValueChange={setFilterLevel}>
                  <SelectTrigger data-testid="logs-filter-level" className="bg-muted border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">all levels</SelectItem>
                    <SelectItem value="info">info</SelectItem>
                    <SelectItem value="warning">warning</SelectItem>
                    <SelectItem value="error">error</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="w-full sm:w-40">
                <Label className="text-foreground text-sm mb-2 block">date range</Label>
                <Select value={filterDatePreset} onValueChange={(v) => setFilterDatePreset(v as DatePreset)}>
                  <SelectTrigger data-testid="logs-filter-date" className="bg-muted border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATE_PRESETS.map(preset => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {filterDatePreset === 'custom' && (
                <>
                  <div className="w-full sm:w-36">
                    <Label className="text-foreground text-sm mb-2 block">from</Label>
                    <DatePicker
                      value={fromYMD(filterDateFrom)}
                      onChange={(d) => setFilterDateFrom(d ? toYMD(d) : '')}
                      placeholder="start date"
                    />
                  </div>
                  <div className="w-full sm:w-36">
                    <Label className="text-foreground text-sm mb-2 block">to</Label>
                    <DatePicker
                      value={fromYMD(filterDateTo)}
                      onChange={(d) => setFilterDateTo(d ? toYMD(d) : '')}
                      placeholder="end date"
                    />
                  </div>
                </>
              )}

              <div className="w-full sm:ml-auto sm:w-auto">
                <Button
                  variant="outline"
                  onClick={resetFilters}
                  className="w-full gap-2"
                >
                  <X className="w-4 h-4" />
                  reset filters
                </Button>
              </div>
            </div>
          </Card>
          </CollapsibleContent>
        </Collapsible>

        {/* Search scope notice — only when the matching scope exceeds the cap */}
        {isSearching && searchPoolTruncated && (
          <p className="mb-2 text-xs text-muted-foreground">
            searching the most recent {SEARCH_POOL_CAP.toLocaleString()} logs in scope — add a date or machine filter to reach older entries.
          </p>
        )}

        {/* Logs List */}
        <Card className="bg-card-sunken border-border/60 overflow-hidden py-0 gap-0">
          {!logsLoading && filteredLogs.length > 0 && (
            <div className={`hidden md:grid ${LOG_COLS} items-center px-4 py-3 border-b border-border bg-card-header rounded-t-xl text-[11px] font-medium tracking-wide text-muted-foreground`}>
              <span aria-hidden />
              <span>level</span>
              <span>time</span>
              <span>event</span>
              <span>machine</span>
              <span>process</span>
              <span>details</span>
            </div>
          )}
          <div className="divide-y divide-border">
            {hasNoSites ? (
              <div className="p-8">
                <NoSitesEmptyState action="view logs" />
              </div>
            ) : logsLoading ? (
              <div className="p-8 text-center text-muted-foreground">
                loading logs...
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                {isSearching
                  ? (searchPoolLoading && !searchPool
                      ? 'searching…'
                      : `no events match "${searchQuery.trim()}"`)
                  : 'no logs found for this site'}
              </div>
            ) : (
              filteredLogs.map((log) => (
                <LogRow
                  key={log.id}
                  log={log}
                  isExpanded={expandedLogIds.has(log.id)}
                  onToggle={toggleLogExpanded}
                  onOpenScreenshot={setScreenshotModalUrl}
                  timeDisplayMode={userPreferences.timeDisplayMode || 'machine'}
                  userTz={userPreferences.timezone}
                  siteTz={siteTimezone}
                  timeFormat={userPreferences.timeFormat || '12h'}
                />
              ))
            )}
          </div>
        </Card>

        {/* Infinite scroll sentinel — disabled while searching (see observer effect) */}
        {!searchTerm && <div ref={sentinelRef} className="h-1" />}
        {isFetchingMore && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            loading more...
          </div>
        )}
      </main>

      {/* Screenshot Modal */}
      {screenshotModalUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 cursor-pointer"
          onClick={() => setScreenshotModalUrl(null)}
          onKeyDown={(e) => e.key === 'Escape' && setScreenshotModalUrl(null)}
        >
          <img
            src={screenshotModalUrl}
            alt="Crash screenshot"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setScreenshotModalUrl(null)}
            aria-label="close screenshot"
            className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}

      {/* Clear Logs Confirmation Dialog */}
      <ConfirmDialog
        open={showClearDialog}
        onOpenChange={(o) => {
          setShowClearDialog(o);
          if (!o) {
            setClearFrom(undefined);
            setClearTo(undefined);
          }
        }}
        title="clear event logs"
        description={(() => {
          const scope: string[] = [];
          const scopeActions = actionDeleteScope(filterActions, ACTION_TYPE_COUNT);
          if (scopeActions.length === 1) {
            scope.push(`• action: ${actionLabel(scopeActions[0])}`);
          } else if (scopeActions.length > 1) {
            scope.push(`• actions: ${scopeActions.map(actionLabel).join(', ')}`);
          }
          if (filterMachine !== 'all') scope.push(`• machine: ${filterMachine}`);
          if (filterLevel !== 'all') scope.push(`• level: ${filterLevel}`);
          if (clearFrom) scope.push(`• from: ${clearFrom.toLocaleDateString()}`);
          if (clearTo) scope.push(`• to: ${clearTo.toLocaleDateString()}`);
          const searchNote = searchTerm
            ? `\n\nnote: the search box does NOT limit deletion — only the scope below applies.`
            : '';
          return scope.length > 0
            ? `this will permanently delete logs matching this scope:\n${scope.join('\n')}${searchNote}\n\nthis action cannot be undone.`
            : `with no date range or view filters set, this will permanently delete ALL event logs for this site (across all machines).${searchNote}\n\nthis action cannot be undone.`;
        })()}
        confirmText="clear logs"
        cancelText="cancel"
        onConfirm={handleClearLogs}
        variant="destructive"
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-foreground text-sm mb-1.5 block">from (optional)</Label>
            <DatePicker
              value={clearFrom}
              onChange={setClearFrom}
              placeholder="any start"
              disabled={(d) => (clearTo ? d > clearTo : false)}
            />
          </div>
          <div>
            <Label className="text-foreground text-sm mb-1.5 block">to (optional)</Label>
            <DatePicker
              value={clearTo}
              onChange={setClearTo}
              placeholder="any end"
              disabled={(d) => (clearFrom ? d < clearFrom : false)}
            />
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
