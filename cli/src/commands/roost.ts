/**
 * `owlette roost list | get | diff | versions` over GET /api/roosts[/{id}
 * [/versions[/{versionRef}/diff]]].
 *
 * Plain-ascii tables by default, structured JSON under the program-level
 * `--json`. list + versions walk cursor pagination until exhausted (or `--limit`
 * hits zero), unless `--page-size N` caps a single page.
 */

import { Command } from 'commander';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { humanBytes, isJson, renderTable, truncate, usageFatal } from '../lib/output';

interface RoostListItem {
  roostId: string;
  siteId: string;
  name: string;
  targets: string[];
  currentVersionId: string | null;
  previousVersionId: string | null;
  versionCounter?: number;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
}

interface RoostDetail {
  roostId: string;
  siteId: string;
  name: string;
  targets: string[];
  extractPath: string | null;
  schemaVersion: number;
  currentVersionId: string | null;
  previousVersionId: string | null;
  versionCounter?: number;
  versionUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  currentVersion: VersionSummary | null;
  previousVersion: VersionSummary | null;
}

interface VersionSummary {
  versionId: string;
  versionNumber: number | null;
  description: string | null;
  versionUrl: string | null;
  createdAt: string | null;
  createdBy: string | null;
  totalSize: number;
  totalFiles: number;
  parentVersionId: string | null;
}

interface DiffResponse {
  versionId: string;
  fromVersion?: string;
  toVersion?: string;
  against: string;
  roostId: string;
  siteId: string;
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    hasChanges: boolean;
    netBytesDelta: number;
  };
  added: Array<{ path: string; size: number; reason: 'added'; chunks: number }>;
  removed: Array<{ path: string; size: number; reason: 'removed'; chunks: number }>;
  modified: Array<{
    path: string;
    fromSize: number;
    toSize: number;
    reason: 'modified';
    fromChunks: number;
    toChunks: number;
  }>;
}

interface VersionListItem {
  versionId: string;
  versionNumber: number | null;
  description: string | null;
  versionUrl: string | null;
  createdAt: string | null;
  createdBy: string | null;
  totalSize: number;
  totalFiles: number;
  parentVersionId: string | null;
}

export function registerRoostInspectCommands(program: Command): void {
  const roost =
    (program.commands.find((c) => c.name() === 'roost') as Command | undefined) ??
    program.command('roost').description('manage roosts + versions');

  // list

  roost
    .command('list')
    .description('list roosts on a site (auto-paginates)')
    .requiredOption('--site <siteId>', 'site id to list roosts for')
    .option('--page-size <n>', 'server-side page size (default 20, max 100)', '20')
    .option('--limit <n>', 'stop after fetching this many roosts in total')
    .option('--include-deleted', 'include tombstoned roosts in the result')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const pageSize = clampInt(opts.pageSize, 1, 100, 20);
      const limit = opts.limit ? clampInt(opts.limit, 1, Number.MAX_SAFE_INTEGER, NaN) : NaN;
      const collected: RoostListItem[] = [];
      let cursor = '';

      for (;;) {
        const qs = new URLSearchParams({
          siteId: opts.site,
          limit: String(pageSize),
        });
        if (cursor) qs.set('cursor', cursor);
        if (opts.includeDeleted) qs.set('includeDeleted', 'true');

        const res = await fetchWithTimeout(`${apiUrl}/api/roosts?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json().catch(() => ({}))) as {
          roosts?: RoostListItem[];
          nextPageToken?: string;
          detail?: string;
        };
        if (!res.ok) {
          fatal(`GET /api/roosts failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
          return;
        }
        for (const r of data.roosts ?? []) {
          collected.push(r);
          if (Number.isFinite(limit) && collected.length >= limit) break;
        }
        cursor = data.nextPageToken ?? '';
        if (!cursor) break;
        if (Number.isFinite(limit) && collected.length >= limit) break;
      }

      if (json) {
        process.stdout.write(JSON.stringify({ roosts: collected }, null, 2) + '\n');
        return;
      }

      if (collected.length === 0) {
        process.stdout.write('(no roosts)\n');
        return;
      }

      const rows = collected.map((r) => [
        r.roostId,
        r.name,
        r.currentVersionId ?? '(none)',
        String(r.targets.length),
        r.deletedAt ? 'tombstoned' : 'active',
        r.updatedAt ?? '',
      ]);
      process.stdout.write(renderTable(['id', 'name', 'current', 'targets', 'status', 'updated'], rows));
    });

  // get

  roost
    .command('get <roostId>')
    .description('print the detail record for one roost')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .action(async (roostId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const qs = new URLSearchParams({ siteId: opts.site });
      const res = await fetchWithTimeout(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as RoostDetail & { detail?: string };
      if (!res.ok) {
        fatal(`GET /api/roosts/${roostId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatRoostDetail(data));
    });

  // diff

  roost
    .command('diff <roostId>')
    .description('diff two versions on a roost')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .requiredOption('--against <versionRef>', '"from" version ref to diff against (id, #N, vN, "current", "previous", "first")')
    .option(
      '--version <versionRef>',
      '"to" version ref (default: current version of the roost)',
    )
    .action(async (roostId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      // "to" ref: explicit flag, else the current version.
      let toRef = opts.version as string | undefined;
      if (!toRef) {
        const qs = new URLSearchParams({ siteId: opts.site });
        const res = await fetchWithTimeout(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}?${qs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json().catch(() => ({}))) as RoostDetail & { detail?: string };
        if (!res.ok) {
          fatal(
            `GET /api/roosts/${roostId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
          );
          return;
        }
        toRef = data.currentVersionId ?? undefined;
        if (!toRef) {
          usageFatal('roost has no currentVersionId; pass --version <versionRef> explicitly');
          return;
        }
      }

      const qs = new URLSearchParams({ siteId: opts.site, against: opts.against });
      const res = await fetchWithTimeout(
        `${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(
          toRef,
        )}/diff?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as DiffResponse & { detail?: string };
      if (!res.ok) {
        fatal(`GET /diff failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatDiff(data));
    });

  // versions

  roost
    .command('versions <roostId>')
    .description('list all versions published on a roost (auto-paginates)')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .option('--page-size <n>', 'server-side page size (default 20, max 100)', '20')
    .option('--limit <n>', 'stop after fetching this many versions in total')
    .action(async (roostId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const pageSize = clampInt(opts.pageSize, 1, 100, 20);
      const limit = opts.limit ? clampInt(opts.limit, 1, Number.MAX_SAFE_INTEGER, NaN) : NaN;
      const collected: VersionListItem[] = [];
      let cursor = '';

      for (;;) {
        const qs = new URLSearchParams({
          siteId: opts.site,
          limit: String(pageSize),
        });
        if (cursor) qs.set('cursor', cursor);

        const res = await fetchWithTimeout(
          `${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/versions?${qs}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = (await res.json().catch(() => ({}))) as {
          versions?: VersionListItem[];
          nextCursor?: string | null;
          detail?: string;
        };
        if (!res.ok) {
          fatal(
            `GET /api/roosts/${roostId}/versions failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
          );
          return;
        }
        for (const v of data.versions ?? []) {
          collected.push(v);
          if (Number.isFinite(limit) && collected.length >= limit) break;
        }
        cursor = data.nextCursor ?? '';
        if (!cursor) break;
        if (Number.isFinite(limit) && collected.length >= limit) break;
      }

      if (json) {
        process.stdout.write(JSON.stringify({ versions: collected }, null, 2) + '\n');
        return;
      }

      if (collected.length === 0) {
        process.stdout.write('(no versions)\n');
        return;
      }

      const rows = collected.map((v) => [
        v.versionNumber !== null ? `#${v.versionNumber}` : '',
        v.versionId,
        v.description ?? '',
        v.createdAt ?? '',
      ]);
      process.stdout.write(renderTable(['#', 'versionId', 'description', 'createdAt'], rows));
    });
}

// formatters

function formatRoostDetail(r: RoostDetail): string {
  const out: string[] = [];
  out.push(`id         ${r.roostId}`);
  out.push(`name       ${r.name}`);
  out.push(`site       ${r.siteId}`);
  if (r.extractPath) out.push(`extractPath ${r.extractPath}`);
  out.push(`targets    ${r.targets.length === 0 ? '(none)' : r.targets.join(', ')}`);
  out.push(`current    ${r.currentVersionId ?? '(none)'}`);
  out.push(`previous   ${r.previousVersionId ?? '(none)'}`);
  out.push(`createdAt  ${r.createdAt ?? '(unknown)'}`);
  out.push(`updatedAt  ${r.updatedAt ?? '(unknown)'}`);
  if (r.deletedAt) out.push(`deletedAt  ${r.deletedAt} (tombstoned)`);
  if (r.currentVersion) {
    out.push('');
    out.push(`current version:`);
    if (r.currentVersion.versionNumber !== null) {
      out.push(`  number     #${r.currentVersion.versionNumber}`);
    }
    out.push(`  id         ${r.currentVersion.versionId}`);
    if (r.currentVersion.description) {
      out.push(`  summary    ${r.currentVersion.description}`);
    }
    out.push(`  files      ${r.currentVersion.totalFiles}`);
    out.push(`  bytes      ${humanBytes(r.currentVersion.totalSize)}`);
    if (r.currentVersion.createdBy) out.push(`  createdBy  ${r.currentVersion.createdBy}`);
    if (r.currentVersion.createdAt) out.push(`  createdAt  ${r.currentVersion.createdAt}`);
  }
  return out.join('\n') + '\n';
}

function formatDiff(d: DiffResponse): string {
  const out: string[] = [];
  const toLabel = d.toVersion ?? d.versionId;
  out.push(
    `diff ${truncate(d.against, 12)} → ${truncate(toLabel, 12)} (roost ${d.roostId})`,
  );
  out.push(
    `  summary: +${d.summary.added} -${d.summary.removed} ~${d.summary.changed} ` +
      `=${d.summary.unchanged} (${d.summary.netBytesDelta >= 0 ? '+' : ''}${humanBytes(
        d.summary.netBytesDelta,
      )})`,
  );
  out.push('');

  for (const f of d.added) {
    out.push(`  + ${f.path}   ${humanBytes(f.size)}`);
  }
  for (const f of d.removed) {
    out.push(`  - ${f.path}   ${humanBytes(f.size)}`);
  }
  for (const f of d.modified) {
    const delta = f.toSize - f.fromSize;
    const sign = delta >= 0 ? '+' : '';
    out.push(`  ~ ${f.path}   ${humanBytes(f.fromSize)} → ${humanBytes(f.toSize)} (${sign}${humanBytes(delta)})`);
  }

  if (!d.summary.hasChanges) {
    out.push('  (no changes — versions are functionally identical)');
  }

  return out.join('\n') + '\n';
}

// util

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

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** Export for unit tests. re-exports the shared helpers for backcompat. */
export const _internals = {
  formatRoostDetail,
  formatDiff,
  renderTable,
  humanBytes,
  truncate,
};
