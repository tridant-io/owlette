'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, Download, Film, ImageIcon, SearchX } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useIssue, type Issue } from '@/hooks/useIssues';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { issueAttachmentsSummary, issueCategoryLabel, issueSourceLabel, plural } from '@/lib/issues';
import { formatFileSize } from '@/lib/storageUtils';
import { formatRelativeTime } from '@/lib/timeUtils';
import { cn } from '@/lib/utils';
import { IssueStatusBadge, IssueStatusControl } from './IssueStatusControl';
import { formatIssueDate, formatIssueDay } from './issueDisplay';

// the route's problem detail for a missing issue
const NOT_FOUND = 'issue not found';
const DAY_MS = 24 * 60 * 60 * 1000;
// a system info line the agent writes: "  cpu percent: 12.5"
const SYSTEM_INFO_LINE = /^([^:]{1,48}):\s*(.*)$/;

type TimeFormat = '12h' | '24h';

function relative(iso: string): string {
  return formatRelativeTime(Date.parse(iso) / 1000);
}

/** the `key: value` rows of the agent's system info, or null when it is not all rows */
function parseSystemInfo(systemInfo: string): [string, string][] | null {
  const lines = systemInfo.split('\n').map((line) => line.trim()).filter(Boolean);
  const rows: [string, string][] = [];
  for (const line of lines) {
    const match = SYSTEM_INFO_LINE.exec(line);
    if (!match) return null;
    rows.push([match[1].trim(), match[2]]);
  }
  return rows.length ? rows : null;
}

/** "logs, 3 screenshots and 1 video" */
function attachedSummary(attachments: Issue['attachments']): string {
  return issueAttachmentsSummary(attachments) || 'a zip';
}

// "1 screenshot was", "a zip was", but "logs were" and "2 screenshots and 1 video were"
function deletedVerb({ logs, screenshots, videos }: Issue['attachments']): string {
  return !logs && screenshots + videos <= 1 ? 'was' : 'were';
}

function expiresIn(iso: string): string {
  // ceil: a fresh 30-day upload reads "expires in 30 days", not 29
  const days = Math.ceil((Date.parse(iso) - Date.now()) / DAY_MS);
  if (days < 1) return 'expires today';
  return `expires in ${plural(days, 'day')}`;
}

function Panel({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('rounded-xl border border-border bg-card p-4 sm:p-5', className)}>
      <h2 id={id} className="mb-3 text-sm font-semibold text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 border-b border-border py-2 first:pt-0 last:border-0 last:pb-0">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 flex-1 text-foreground wrap-anywhere', mono && 'font-mono text-xs leading-5')}>
        {children || <span className="text-muted-foreground">—</span>}
      </dd>
    </div>
  );
}

function Facts({ issue, timeFormat }: { issue: Issue; timeFormat: TimeFormat }) {
  return (
    <Panel id="issue-details-heading" title="details">
      <dl className="text-sm">
        <Fact label="from">{issue.from}</Fact>
        <Fact label="host" mono>{issue.host}</Fact>
        <Fact label="site" mono>{issue.siteId}</Fact>
        <Fact label="machine" mono>{issue.machineId}</Fact>
        <Fact label="app version" mono>{issue.appVersion}</Fact>
        <Fact label="source">{issue.source && issueSourceLabel(issue.source)}</Fact>
        <Fact label="created">
          {issue.createdAt && (
            <time dateTime={issue.createdAt}>
              {formatIssueDate(issue.createdAt, timeFormat)}
              <span className="text-muted-foreground"> · {relative(issue.createdAt)}</span>
            </time>
          )}
        </Fact>
      </dl>
    </Panel>
  );
}

/** a dashboard issue's files, each with its own download; numbered within its kind */
function FileList({ files, base }: { files: Issue['attachments']['files']; base: string }) {
  const seen = { screenshot: 0, video: 0 };
  return (
    <ul className="mt-3 border-t border-border">
      {files.map((file) => {
        const label = `${file.kind} ${++seen[file.kind]}`;
        const Icon = file.kind === 'video' ? Film : ImageIcon;
        return (
          <li key={file.index} className="flex items-center gap-3 border-b border-border py-2 last:border-0 last:pb-0">
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">{label}</p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {file.ext} · {formatFileSize(file.size)}
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <a href={`${base}/files/${file.index}`} aria-label={`download ${label}`}>
                <Download />
                download
              </a>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function Attachments({ issue, timeFormat }: { issue: Issue; timeFormat: TimeFormat }) {
  const { attachments } = issue;
  const { notes } = issue.description;
  const expired = !attachments.available && attachments.expiresAt !== null;
  const base = `/api/admin/issues/${encodeURIComponent(String(issue.number ?? issue.id))}`;

  return (
    <Panel id="issue-attachments-heading" title="attachments">
      {attachments.available ? (
        <>
          <p className="text-sm text-foreground">{attachedSummary(attachments)}</p>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
            {attachments.size !== null && `${formatFileSize(attachments.size)} · `}
            {attachments.expiresAt && (
              <span title={formatIssueDate(attachments.expiresAt, timeFormat)}>{expiresIn(attachments.expiresAt)}</span>
            )}
          </p>
          {attachments.files.length > 0 ? (
            <FileList files={attachments.files} base={base} />
          ) : (
            <Button asChild variant="outline" size="sm" className="mt-3 w-full">
              <a href={`${base}/logs`}>
                <Download />
                download attachments
              </a>
            </Button>
          )}
        </>
      ) : expired ? (
        <>
          <p className="text-sm text-foreground">attachments expired</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {attachedSummary(attachments)} {deletedVerb(attachments)} deleted on {formatIssueDay(attachments.expiresAt as string)}.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">nothing attached</p>
      )}

      {notes.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-medium text-muted-foreground">notes from the app</h3>
          <ul className="mt-1.5 space-y-1 text-xs text-foreground">
            {notes.map((note, i) => (
              <li key={i} className="wrap-anywhere">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function SystemInfo({ systemInfo }: { systemInfo: string }) {
  const rows = parseSystemInfo(systemInfo);
  return (
    <Panel id="issue-system-heading" title="system info">
      {rows ? (
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([key, value], i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <th
                  scope="row"
                  className="w-28 py-1.5 pr-3 text-left align-top font-normal text-muted-foreground sm:w-40"
                >
                  {key}
                </th>
                <td className="py-1.5 font-mono text-foreground wrap-anywhere">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground wrap-anywhere">
          {systemInfo}
        </pre>
      )}
    </Panel>
  );
}

function LogTail({ logTail }: { logTail: string }) {
  const [open, setOpen] = useState(false);
  const lines = logTail.replace(/\n+$/, '').split('\n').length;
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section aria-labelledby="issue-log-heading" className="overflow-hidden rounded-xl border border-border bg-card">
        <h2 id="issue-log-heading">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-auto w-full justify-between rounded-none px-4 py-3 sm:px-5">
              <span className="flex items-baseline gap-2">
                <span className="text-sm font-semibold">log tail</span>
                <span className="text-xs font-normal text-muted-foreground">{plural(lines, 'line')}</span>
              </span>
              <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
            </Button>
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent>
          {/* opens at the end: the newest lines are where the trouble is */}
          <pre
            ref={(el) => {
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="max-h-[32rem] overflow-auto border-t border-border bg-card-sunken px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground wrap-anywhere sm:px-5"
          >
            {logTail}
          </pre>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2.5 mb-3">
      <Link href="/admin/issues">
        <ArrowLeft />
        issues
      </Link>
    </Button>
  );
}

function DetailSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      <div className="h-4 w-32 rounded bg-muted motion-safe:animate-pulse" />
      <div className="h-8 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
      <div className="h-40 rounded-xl bg-muted motion-safe:animate-pulse" />
    </div>
  );
}

/** One issue, everything it holds, and where a superadmin sets its status. */
export function IssueDetail({ idOrNumber }: { idOrNumber: string }) {
  const { issue, loading, error, refresh, setStatus } = useIssue(idOrNumber);
  const { userPreferences } = useAuth();
  const timeFormat: TimeFormat = userPreferences?.timeFormat ?? '12h';

  let body: ReactNode;
  if (issue) {
    const { text, systemInfo, logTail } = issue.description;
    body = (
      <>
        <header className="mb-4 md:mb-6">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-mono tabular-nums text-muted-foreground wrap-anywhere">
              {issue.number === null ? issue.id : `#${issue.number}`}
            </span>
            <IssueStatusBadge status={issue.status} />
            <span className="text-muted-foreground">{issueCategoryLabel(issue.category)}</span>
          </div>
          <h1 className="mt-2 text-2xl font-bold text-foreground wrap-anywhere md:text-3xl">
            {issue.title || 'untitled'}
          </h1>
        </header>

        {/* one column on a phone: the words, then triage, then the machine's detail.
            lg: the reading column on the left, triage and the facts on the right */}
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
            <Panel id="issue-text-heading" title="description" className="order-1">
              {text ? (
                <p className="max-w-[75ch] text-sm leading-relaxed whitespace-pre-wrap text-foreground wrap-anywhere">
                  {text}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">no description</p>
              )}
            </Panel>
            {(systemInfo || logTail) && (
              <div className="order-3 flex min-w-0 flex-col gap-4 lg:gap-6">
                {systemInfo && <SystemInfo systemInfo={systemInfo} />}
                {logTail && <LogTail logTail={logTail} />}
              </div>
            )}
          </div>
          <aside className="order-2 flex min-w-0 flex-col gap-4">
            <IssueStatusControl
              key={`${issue.id}:${issue.statusUpdatedAt ?? ''}`}
              issue={issue}
              onSave={setStatus}
            />
            <Facts issue={issue} timeFormat={timeFormat} />
            <Attachments issue={issue} timeFormat={timeFormat} />
          </aside>
        </div>
      </>
    );
  } else if (loading) {
    body = (
      <>
        <span className="sr-only">loading issue</span>
        <DetailSkeleton />
      </>
    );
  } else if (error === NOT_FOUND) {
    body = (
      <div className="flex flex-col items-center rounded-xl border border-border bg-card px-4 py-12 text-center">
        <SearchX className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-foreground">issue not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          nothing on this environment answers to <span className="font-mono">{idOrNumber}</span>.
        </p>
      </div>
    );
  } else {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-danger-border bg-danger-surface px-4 py-12 text-center">
        <h1 className="text-lg font-semibold text-foreground">could not load the issue</h1>
        <p className="text-sm text-danger">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          try again
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="mx-auto max-w-screen-2xl">
        <BackLink />
        {body}
      </div>
    </div>
  );
}
