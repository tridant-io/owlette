/**
 * `owlette quota show | history` over
 *   GET /api/sites/{siteId}/quota
 *   GET /api/sites/{siteId}/quota/history?period=<7d|14d|30d|60d|90d>
 *
 * `show` prints a storage progress bar plus recent alarms; `history` prints
 * one ascii row per UTC day. `--json` round-trips the server snapshot verbatim
 * so it stays pipeable into `jq`.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { humanBytes, isJson, renderTable, usageFatal } from '../lib/output';

interface QuotaAlarm {
  id: string;
  threshold: number | null;
  firedAt: string | null;
}

interface QuotaSnapshot {
  siteId: string;
  usedBytes: number;
  pendingBytes: number;
  committedBytes: number;
  limitBytes: number | null;
  fractionUsed: number | null;
  lastAlarmLevel: number;
  lastAlarmAt: string | null;
  lastReconciledAt: string | null;
  alarms: QuotaAlarm[];
}

interface QuotaHistoryBucket {
  date: string;
  storageBytesAvg: number | null;
  classAOps: number;
  classBOps: number;
  egressBytes: number;
}

interface QuotaHistory {
  siteId: string;
  period: string;
  days: number;
  daily: QuotaHistoryBucket[];
}

const VALID_PERIODS = ['7d', '14d', '30d', '60d', '90d'] as const;
type QuotaPeriod = (typeof VALID_PERIODS)[number];

export function registerQuotaCommands(program: Command): void {
  const quota = program
    .command('quota')
    .description('inspect site storage + bandwidth quota');

  quota
    .command('show')
    .description('current storage snapshot for a site, with alarms')
    .requiredOption('--site <siteId>', 'site id to fetch quota for')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/quota`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as QuotaSnapshot & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/quota failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatQuotaSnapshot(data));
    });

  quota
    .command('history')
    .description('daily usage rollup over the requested window')
    .requiredOption('--site <siteId>', 'site id to fetch usage history for')
    .option(
      '--period <window>',
      `time window: ${VALID_PERIODS.join(' | ')}`,
      '30d',
    )
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const period = opts.period as string;
      if (!VALID_PERIODS.includes(period as QuotaPeriod)) {
        usageFatal(`--period must be one of ${VALID_PERIODS.join(', ')} (got '${period}')`);
        return;
      }

      const qs = new URLSearchParams({ period });
      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/quota/history?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as QuotaHistory & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/quota/history failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatQuotaHistory(data));
    });
}

const BAR_WIDTH = 20;

function formatQuotaSnapshot(q: QuotaSnapshot): string {
  const out: string[] = [];
  out.push(`site       ${q.siteId}`);
  out.push('');

  if (q.limitBytes === null) {
    // The API always reports a finite cap, but the field is nullable —
    // print what we know rather than a bar against an unknown limit.
    out.push(`storage: ${humanBytes(q.committedBytes)} used`);
  } else {
    out.push(formatProgressLine('storage', q.committedBytes, q.limitBytes));
  }

  if (q.pendingBytes > 0) {
    out.push(
      `  pending: ${humanBytes(q.pendingBytes)} (in-flight uploads, not yet committed)`,
    );
  }

  if (q.lastReconciledAt) {
    out.push(`  reconciled at ${q.lastReconciledAt}`);
  }

  if (q.alarms.length > 0) {
    out.push('');
    out.push(`alarms (${q.alarms.length}):`);
    for (const a of q.alarms) {
      const pct = a.threshold !== null ? `${Math.round(a.threshold * 100)}%` : '?';
      out.push(`  - ${a.firedAt ?? '(unknown time)'}  threshold ${pct}`);
    }
  } else if (q.lastAlarmLevel > 0) {
    out.push('');
    out.push(`last alarm level: ${Math.round(q.lastAlarmLevel * 100)}% (${q.lastAlarmAt ?? 'unknown time'})`);
  }

  return out.join('\n') + '\n';
}

/**
 * `<label>: <used> / <limit> (NN%) [bar]`. `limit` must be > 0 — callers
 * handle the null/no-entitlement case.
 */
function formatProgressLine(label: string, used: number, limit: number): string {
  const fraction = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const pct = Math.round(fraction * 100);
  const filled = Math.round(fraction * BAR_WIDTH);
  const bar = '#'.repeat(filled) + '.'.repeat(BAR_WIDTH - filled);
  return `${label}: ${humanBytes(used)} / ${humanBytes(limit)} (${pct}%) [${bar}]`;
}

function formatQuotaHistory(h: QuotaHistory): string {
  const out: string[] = [];
  out.push(`site    ${h.siteId}`);
  out.push(`period  ${h.period} (${h.days} day${h.days === 1 ? '' : 's'})`);
  out.push('');

  if (h.daily.length === 0) {
    out.push('(no usage recorded in this window)');
    return out.join('\n') + '\n';
  }

  const rows = h.daily.map((b) => [
    b.date,
    b.storageBytesAvg !== null ? humanBytes(b.storageBytesAvg) : '-',
    String(b.classAOps),
    String(b.classBOps),
    humanBytes(b.egressBytes),
  ]);
  out.push(
    renderTable(['date', 'storage avg', 'class A ops', 'class B ops', 'egress'], rows).trimEnd(),
  );
  return out.join('\n') + '\n';
}

function resolveAuth(cmd: Command): { apiUrl: string; token: string | null; json: boolean } {
  const { apiUrl, token } = loadConfig({ profile: cmd.optsWithGlobals().profile });
  if (!token) {
    process.stderr.write(
      'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
    );
    process.exitCode = 2;
    return { apiUrl, token: null, json: isJson(cmd) };
  }
  return { apiUrl, token, json: isJson(cmd) };
}

function fatal(msg: string, exitCode = 1): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = exitCode;
}

/** Export for unit tests. */
export const _internals = {
  formatQuotaSnapshot,
  formatQuotaHistory,
  formatProgressLine,
};
