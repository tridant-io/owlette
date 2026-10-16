'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Inbox, Loader2, RefreshCw } from 'lucide-react';
import { useIssues, type Issue, type IssueStatus } from '@/hooks/useIssues';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ISSUE_STATUSES, issueCategoryLabel } from '@/lib/issues';
import { formatRelativeTime } from '@/lib/timeUtils';
import { IssueStatusBadge } from './IssueStatusControl';
import { ISSUE_STATUS_LABEL, formatIssueDate, issueHref, issueSender } from './issueDisplay';

export type IssueFilter = IssueStatus | 'all';

export const ISSUE_FILTERS: readonly IssueFilter[] = [...ISSUE_STATUSES, 'all'];

const EMPTY_COPY: Record<IssueFilter, { title: string; detail: string }> = {
  new: { title: 'no new issues', detail: 'nothing is waiting on triage.' },
  triaged: { title: 'no triaged issues', detail: 'an issue lands here once someone has looked at it.' },
  fixed: { title: 'no fixed issues', detail: 'nothing has been marked fixed yet.' },
  wontfix: { title: "no won't fix issues", detail: 'nothing has been set aside.' },
  all: { title: 'no issues yet', detail: 'when someone uses submit issue, it lands here.' },
};

function filterLabel(filter: IssueFilter): string {
  return filter === 'all' ? 'all' : ISSUE_STATUS_LABEL[filter];
}

function StatusFilter({ value, onChange }: { value: IssueFilter; onChange: (filter: IssueFilter) => void }) {
  return (
    <div role="group" aria-label="status" className="flex flex-wrap gap-0.5 rounded-lg border border-border bg-card p-0.5">
      {ISSUE_FILTERS.map((filter) => (
        <Button
          key={filter}
          variant="ghost"
          size="sm"
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
          className="h-7 px-2.5 text-xs sm:px-3"
        >
          {filterLabel(filter)}
        </Button>
      ))}
    </div>
  );
}

// one grid, two shapes. a phone: number, title and age on the first line, the
// badge and the sender under the title. md up: one row, the badge in its own column.
// cells are placed by line: a col-span utility would reset the col-start beside it
function IssueRow({ issue }: { issue: Issue }) {
  const created = issue.createdAt ? Date.parse(issue.createdAt) : NaN;
  const sender = issueSender(issue);
  return (
    <li>
      <Link
        href={issueHref(issue)}
        className="grid grid-cols-[2.75rem_auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-3 py-3 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 sm:px-4 md:grid-cols-[3.5rem_minmax(0,1fr)_6.5rem_5rem] md:gap-x-4"
      >
        <span
          className="col-[1] row-[1] font-mono text-xs tabular-nums text-muted-foreground md:row-[1/3]"
          title={issue.number === null ? issue.id : undefined}
        >
          {issue.number === null ? '—' : `#${issue.number}`}
        </span>
        <span className="col-[2/4] row-[1] truncate text-sm font-medium text-foreground md:col-[2]">
          {issue.title || 'untitled'}
        </span>
        <span className="col-[2] row-[2] md:col-[3] md:row-[1/3]">
          <IssueStatusBadge status={issue.status} />
        </span>
        <span className="col-[3/5] row-[2] truncate text-xs text-muted-foreground md:col-[2]">
          {issueCategoryLabel(issue.category)}
          <span aria-hidden="true"> · </span>
          <span className={issue.from ? undefined : 'font-mono'}>{sender}</span>
        </span>
        <span className="col-[4] row-[1] text-right text-xs tabular-nums text-muted-foreground md:row-[1/3]">
          {Number.isNaN(created) ? (
            '—'
          ) : (
            <time dateTime={issue.createdAt ?? undefined} title={formatIssueDate(issue.createdAt as string)}>
              {formatRelativeTime(created / 1000)}
            </time>
          )}
        </span>
      </Link>
    </li>
  );
}

function SkeletonRows() {
  return (
    <ul aria-hidden="true" className="divide-y divide-border">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex items-center gap-4 px-3 py-3.5 sm:px-4">
          <span className="h-3 w-8 rounded bg-muted motion-safe:animate-pulse" />
          <span className="flex-1 space-y-2">
            <span className="block h-3.5 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
            <span className="block h-3 w-1/3 rounded bg-muted motion-safe:animate-pulse" />
          </span>
          <span className="h-3 w-10 rounded bg-muted motion-safe:animate-pulse" />
        </li>
      ))}
    </ul>
  );
}

/** One filter's issues. Keyed on the filter, so a switch never shows the last filter's rows. */
function IssueResults({ filter }: { filter: IssueFilter }) {
  const { issues, loading, loadingMore, error, hasMore, loadMore, refresh } = useIssues({
    status: filter === 'all' ? undefined : filter,
  });
  const empty = EMPTY_COPY[filter];

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border bg-card" aria-busy={loading}>
        {loading ? (
          <>
            <span className="sr-only">loading issues</span>
            <SkeletonRows />
          </>
        ) : error && issues.length === 0 ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <p className="text-sm text-danger">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              try again
            </Button>
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <Inbox className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">{empty.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{empty.detail}</p>
          </div>
        ) : (
          <ul aria-label={`${filterLabel(filter)} issues`} className="divide-y divide-border">
            {issues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </ul>
        )}
      </div>

      {!loading && issues.length > 0 && (error || hasMore) && (
        <div className="mt-4 flex flex-col items-center gap-2">
          {error && (
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

/** The superadmin's list of issues, one status at a time, newest first. */
export function IssueList({
  filter,
  onFilterChange,
}: {
  filter: IssueFilter;
  onFilterChange: (filter: IssueFilter) => void;
}) {
  // refresh remounts the results, which reads the first page again
  const [reloads, setReloads] = useState(0);

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="mx-auto max-w-screen-2xl">
        <AdminPageHeader
          className="mb-4 md:mb-6"
          title="issues"
          description="what users sent with submit issue, newest first"
          actions={
            <IconButton label="refresh issues" variant="outline" onClick={() => setReloads((n) => n + 1)}>
              <RefreshCw />
            </IconButton>
          }
          toolbar={<StatusFilter value={filter} onChange={onFilterChange} />}
        />
        <IssueResults key={`${filter}:${reloads}`} filter={filter} />
      </div>
    </div>
  );
}
