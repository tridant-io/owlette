/**
 * `owlette user list | get | promote | demote | assign-sites | remove-sites | delete`.
 *
 * Drives the public `/api/users` routes.
 *
 * Every mutation carries an auto-generated `Idempotency-Key`, so a network retry
 * replays the cached response instead of re-running the cascade.
 *
 * Two 409 codes get bespoke stderr handling as the common operator errors:
 * `last_superadmin` (demote) and `orphan_sites` (delete; pass `--successor`).
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import {
  isJson,
  renderTable,
  unconfirmedMutationFatal,
  usageFatal,
} from '../lib/output';

interface UserListItem {
  uid: string;
  email: string | null;
  role: string;
  sites: string[];
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  createdAt: string | null;
  deletedAt: number | null;
}

type UserDetail = UserListItem;

interface ListResponse {
  users?: UserListItem[];
  nextPageToken?: string;
  detail?: string;
  code?: string;
}

const PROMOTE_ROLES = new Set(['admin', 'superadmin']);

export function registerUserCommands(program: Command): void {
  const user =
    (program.commands.find((c) => c.name() === 'user') as Command | undefined) ??
    program.command('user').description('platform user management (superadmin)');

  // Overwrite any earlier description so help text is registration-order safe.
  user.description('platform user management (superadmin)');

  // Drop earlier sub-command registrations so a re-register doesn't double-list.
  for (const verb of [
    'list',
    'get',
    'promote',
    'demote',
    'assign-sites',
    'remove-sites',
    'delete',
  ] as const) {
    const existing = user.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = user.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  // list

  user
    .command('list')
    .description('list platform users (superadmin)')
    .option('--role <role>', 'filter by role: member | admin | superadmin')
    .option('--site <siteId>', 'filter to users assigned to this site')
    .option('--include-deleted', 'include soft-deleted users (default: false)')
    .option('--limit <n>', 'page size (1-100, default 20)')
    .option('--cursor <token>', 'opaque page_token from a previous response')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const params = new URLSearchParams();
      if (opts.role) params.set('role', String(opts.role));
      if (opts.site) params.set('site', String(opts.site));
      if (opts.includeDeleted) params.set('includeDeleted', 'true');
      if (opts.limit !== undefined) {
        const n = Number(opts.limit);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100) {
          usageFatal('--limit must be an integer between 1 and 100');
          return;
        }
        params.set('page_size', String(n));
      }
      if (opts.cursor) params.set('page_token', String(opts.cursor));

      const url = params.toString()
        ? `${apiUrl}/api/users?${params.toString()}`
        : `${apiUrl}/api/users`;

      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as ListResponse;
      if (!res.ok) {
        fatal(
          `GET /api/users failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      const users = data.users ?? [];

      if (json) {
        process.stdout.write(
          JSON.stringify({ users, nextPageToken: data.nextPageToken ?? '' }, null, 2) + '\n',
        );
        return;
      }

      if (users.length === 0) {
        process.stdout.write('(no users)\n');
        return;
      }

      const rows = users.map((u) => [
        u.uid,
        u.email ?? '',
        u.role,
        String(u.sites.length),
        u.deletedAt ? new Date(u.deletedAt).toISOString().slice(0, 10) : '',
        u.createdAt ? u.createdAt.slice(0, 10) : '',
      ]);
      process.stdout.write(
        renderTable(
          ['uid', 'email', 'role', 'sites', 'deleted', 'created'],
          rows,
        ),
      );
      if (data.nextPageToken) {
        process.stdout.write(`\nnext page: --cursor ${data.nextPageToken}\n`);
      }
    });

  // get

  user
    .command('get <uid>')
    .description('print the detail record for one platform user (superadmin)')
    .action(async (uid: string, _opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(`${apiUrl}/api/users/${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as UserDetail & {
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/users/${uid} failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatUserDetail(data));
    });

  // promote

  user
    .command('promote <uid>')
    .description('promote a user to admin or superadmin (superadmin)')
    .requiredOption('--role <role>', 'target role: admin | superadmin')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (uid: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!PROMOTE_ROLES.has(opts.role)) {
        usageFatal(`--role must be one of: ${[...PROMOTE_ROLES].join(', ')}`);
        return;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-user-promote-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${apiUrl}/api/users/${encodeURIComponent(uid)}/promote`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({ role: opts.role }),
          },
        );
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/users/${uid}/promote`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        uid?: string;
        role?: string;
        previousRole?: string;
        changed?: boolean;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        fatal(
          `POST /api/users/${uid}/promote failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        data.changed
          ? `owlette: ${uid} promoted ${data.previousRole ?? '?'} → ${data.role ?? opts.role}\n`
          : `owlette: ${uid} already ${data.role ?? opts.role} (no change)\n`,
      );
    });

  // demote

  user
    .command('demote <uid>')
    .description('demote a user back to member (superadmin)')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (uid: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-user-demote-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${apiUrl}/api/users/${encodeURIComponent(uid)}/demote`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({}),
          },
        );
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/users/${uid}/demote`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        uid?: string;
        role?: string;
        previousRole?: string;
        changed?: boolean;
        detail?: string;
        code?: string;
        minSuperadmins?: number;
        currentActiveCount?: number;
      };

      if (!res.ok) {
        if (res.status === 409 && data.code === 'last_superadmin') {
          fatal(
            `cannot demote ${uid}: last_superadmin (only ${data.currentActiveCount ?? '?'} active superadmin(s) remain; floor is ${data.minSuperadmins ?? 1}). promote another user first.`,
          );
          return;
        }
        fatal(
          `POST /api/users/${uid}/demote failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        data.changed
          ? `owlette: ${uid} demoted ${data.previousRole ?? '?'} → ${data.role ?? 'member'}\n`
          : `owlette: ${uid} already member (no change)\n`,
      );
    });

  // assign-sites

  user
    .command('assign-sites <uid>')
    .description('grant a user access to one or more sites (superadmin)')
    .requiredOption('--sites <csv>', 'comma-separated list of site ids to assign')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (uid: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const siteIds = parseCsv(opts.sites);
      if (siteIds.length === 0) {
        usageFatal('--sites must contain at least one site id');
        return;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-user-assign-sites-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${apiUrl}/api/users/${encodeURIComponent(uid)}/assign-sites`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({ siteIds }),
          },
        );
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/users/${uid}/assign-sites`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        uid?: string;
        assignedSiteIds?: string[];
        detail?: string;
        code?: string;
        unknownSites?: string[];
      };

      if (!res.ok) {
        if (res.status === 400 && data.code === 'unknown_site') {
          fatal(
            `POST /api/users/${uid}/assign-sites failed (400, unknown_site): unknown site(s): ${(data.unknownSites ?? []).join(', ')}`,
          );
          return;
        }
        fatal(
          `POST /api/users/${uid}/assign-sites failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      const assigned = data.assignedSiteIds ?? siteIds;
      process.stdout.write(
        `owlette: ${uid} granted access to ${assigned.length} site(s): ${assigned.join(', ')}\n`,
      );
    });

  // remove-sites

  user
    .command('remove-sites <uid>')
    .description("revoke a user's access to one or more sites (superadmin)")
    .requiredOption('--sites <csv>', 'comma-separated list of site ids to remove')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (uid: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const siteIds = parseCsv(opts.sites);
      if (siteIds.length === 0) {
        usageFatal('--sites must contain at least one site id');
        return;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-user-remove-sites-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${apiUrl}/api/users/${encodeURIComponent(uid)}/remove-sites`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({ siteIds }),
          },
        );
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/users/${uid}/remove-sites`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        uid?: string;
        removedSiteIds?: string[];
        cancelledCommandCount?: number;
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        fatal(
          `POST /api/users/${uid}/remove-sites failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      const removed = data.removedSiteIds ?? siteIds;
      const cancelled = data.cancelledCommandCount ?? 0;
      process.stdout.write(
        `owlette: ${uid} revoked from ${removed.length} site(s): ${removed.join(', ')}` +
          (cancelled > 0 ? ` (cancelled ${cancelled} pending command(s))` : '') +
          '\n',
      );
    });

  // delete

  user
    .command('delete <uid>')
    .description('soft-delete a platform user (superadmin)')
    .option('--successor <uid>', 'transfer owned sites to this user (admin or superadmin)')
    .option('--yes', 'skip the interactive confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (uid: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          usageFatal(
            'stdin is not a tty and --yes was not supplied; refusing to delete silently',
          );
          return;
        }
        const ok = await promptYesNo(
          `soft-delete user ${uid}? this revokes their api keys and cancels pending commands. [y/N] `,
        );
        if (!ok) {
          process.stdout.write('delete cancelled\n');
          return;
        }
      }

      const params = new URLSearchParams();
      if (opts.successor) params.set('successorUid', String(opts.successor));
      const url = params.toString()
        ? `${apiUrl}/api/users/${encodeURIComponent(uid)}?${params.toString()}`
        : `${apiUrl}/api/users/${encodeURIComponent(uid)}`;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-user-delete-${randomUUID()}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({}),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `DELETE /api/users/${uid}`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        uid?: string;
        alreadyDeleted?: boolean;
        deletedAt?: number;
        transferredSites?: string[];
        revokedKeyIds?: string[];
        detail?: string;
        code?: string;
        ownedSites?: string[];
        successorUid?: string;
        reason?: string;
      };

      if (!res.ok) {
        if (res.status === 409 && data.code === 'orphan_sites') {
          const owned = data.ownedSites ?? [];
          fatal(
            `cannot delete ${uid}: orphan_sites — user owns ${owned.length} site(s): ${owned.join(', ')}. re-run with --successor <uid> to transfer ownership.`,
          );
          return;
        }
        if (res.status === 400 && data.code === 'successor_invalid') {
          fatal(
            `cannot delete ${uid}: successor_invalid (${data.reason ?? 'unknown reason'}). pick a different --successor.`,
          );
          return;
        }
        fatal(
          `DELETE /api/users/${uid} failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      if (data.alreadyDeleted) {
        process.stdout.write(`owlette: user ${uid} was already deleted\n`);
        return;
      }
      const transferred = data.transferredSites ?? [];
      const revoked = data.revokedKeyIds ?? [];
      const lines: string[] = [`owlette: user ${uid} soft-deleted`];
      if (transferred.length > 0) {
        lines.push(
          `  transferred ${transferred.length} site(s) to ${opts.successor}: ${transferred.join(', ')}`,
        );
      }
      if (revoked.length > 0) {
        lines.push(`  revoked ${revoked.length} api key(s)`);
      }
      process.stdout.write(lines.join('\n') + '\n');
    });
}

// formatters

function formatUserDetail(u: UserDetail): string {
  const out: string[] = [];
  out.push(`uid          ${u.uid}`);
  out.push(`email        ${u.email ?? '(none)'}`);
  out.push(`role         ${u.role}`);
  out.push(`displayName  ${u.displayName ?? '(none)'}`);
  out.push(`firstName    ${u.firstName ?? '(none)'}`);
  out.push(`lastName     ${u.lastName ?? '(none)'}`);
  out.push(`createdAt    ${u.createdAt ?? '(unknown)'}`);
  out.push(`deletedAt    ${u.deletedAt ? new Date(u.deletedAt).toISOString() : '(active)'}`);
  out.push(`sites (${u.sites.length})`);
  if (u.sites.length === 0) {
    out.push('  (none)');
  } else {
    for (const s of u.sites) out.push(`  - ${s}`);
  }
  return out.join('\n') + '\n';
}

// util

function parseCsv(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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

async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}

/** Export for unit tests. */
export const _internals = { formatUserDetail, parseCsv };
