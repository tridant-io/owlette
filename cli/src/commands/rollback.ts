/**
 * `owlette rollback <roostId>`: load the roost, resolve the target version
 * (`--to <versionRef>` — numeric, `#3`/`v3`, `vrs_*`, or an alias — else
 * `previousVersionId`), print the diff against current, confirm, then POST
 * /rollback. The mutation sends the version id the diff resolved, so an
 * idempotent retry replays the same body. Confirmation requires a tty; piping
 * without `--yes` is refused rather than rolling back silently.
 *
 * Exit codes: 0 success or declined prompt, 1 api failure,
 * 2 usage / auth / no target / non-tty without --yes.
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import { usageFatal } from '../lib/output';
import { _internals as roostInternals } from './roost';

interface RoostDetail {
  roostId: string;
  siteId: string;
  name: string;
  currentVersionId: string | null;
  previousVersionId: string | null;
  deletedAt: string | null;
  detail?: string;
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

interface RollbackResponse {
  currentVersionId: string;
  previousVersionId: string | null;
  detail?: string;
}

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback <roostId>')
    .description('roll a roost back to a previous version (prints diff, confirms)')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .option(
      '--to <versionRef>',
      'explicit target version (id, #N, vN, "current", "previous", "first"); default: previousVersionId',
    )
    .option('--yes', 'skip the confirmation prompt (required when stdin is not a tty)')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (roostId: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token } = loadConfig({ profile: globals.profile });
      if (!token) {
        process.stderr.write(
          'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
        );
        process.exitCode = 2;
        return;
      }

      const json = globals.json === true;
      const siteId: string = opts.site;

      const roost = await fetchRoost(apiUrl, token, roostId, siteId);
      if (!roost) {
        process.exitCode = 1;
        return;
      }
      if (roost.deletedAt) {
        fatal(`roost ${roostId} is tombstoned — cannot roll back`);
        return;
      }
      if (!roost.currentVersionId) {
        usageFatal(`roost ${roostId} has no currentVersionId — nothing to roll back from`);
        return;
      }

      // `--to` is forwarded verbatim so the server resolver handles every ref form
      const targetRef: string | null =
        (typeof opts.to === 'string' && opts.to.length > 0 ? opts.to : null) ??
        roost.previousVersionId;
      if (!targetRef) {
        usageFatal(
          'no rollback target: the roost has no previousVersionId. pass --to <versionRef> explicitly.',
        );
        return;
      }

      // the diff endpoint runs the same resolver, so the raw ref goes straight through
      const diff = await fetchDiff(
        apiUrl,
        token,
        roostId,
        siteId,
        /* to   = */ targetRef,
        /* from = */ roost.currentVersionId,
      );
      if (!diff) {
        process.exitCode = 1;
        return;
      }

      // both refs resolved to the same version: nothing to flip
      if (diff.toVersion && diff.fromVersion && diff.toVersion === diff.fromVersion) {
        usageFatal(
          `target version resolves to ${diff.toVersion}, which is already the current version. pass --to <versionRef> to a different version.`,
        );
        return;
      }
      const resolvedTargetVersionId = diff.toVersion ?? diff.versionId;

      if (!json) {
        process.stdout.write(
          `about to roll back roost '${roost.name}' (${roostId})\n` +
            `  current  ${roost.currentVersionId}\n` +
            `  target   ${targetRef}\n\n`,
        );
        process.stdout.write(roostInternals.formatDiff(diff));
      }

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          usageFatal(
            'stdin is not a tty and --yes was not supplied; refusing to roll back silently.',
          );
          return;
        }
        const ok = await promptYesNo('proceed with rollback? [y/N] ');
        if (!ok) {
          if (json) {
            process.stdout.write(
              JSON.stringify({ action: 'cancelled', roost, target: targetRef, diff }, null, 2) + '\n',
            );
          } else {
            process.stdout.write('rollback cancelled\n');
          }
          return;
        }
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-rollback-${randomUUID()}`;
      let result: RollbackResponse | null;
      try {
        result = await performRollback(
          apiUrl,
          token,
          roostId,
          siteId,
          resolvedTargetVersionId,
          idempotencyKey,
        );
      } catch (err) {
        unconfirmedRollbackFatal({
          operation: `POST /api/roosts/${roostId}/rollback`,
          idempotencyKey,
          targetVersionId: resolvedTargetVersionId,
          cause: err,
        });
        return;
      }
      if (!result) {
        process.exitCode = 1;
        return;
      }

      if (json) {
        process.stdout.write(
          JSON.stringify({ action: 'rolled_back', roost, target: targetRef, diff, result }, null, 2) + '\n',
        );
      } else {
        process.stdout.write(
          `owlette: rolled back\n` +
            `  current   ${result.currentVersionId}\n` +
            `  previous  ${result.previousVersionId ?? '(none)'}\n`,
        );
      }
    });
}

async function fetchRoost(
  apiUrl: string,
  token: string,
  roostId: string,
  siteId: string,
): Promise<RoostDetail | null> {
  const qs = new URLSearchParams({ siteId });
  const res = await fetchWithTimeout(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => ({}))) as RoostDetail;
  if (!res.ok) {
    fatal(
      `GET /api/roosts/${roostId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
    );
    return null;
  }
  return data;
}

async function fetchDiff(
  apiUrl: string,
  token: string,
  roostId: string,
  siteId: string,
  to: string,
  from: string,
): Promise<DiffResponse | null> {
  const qs = new URLSearchParams({ siteId, against: from });
  const res = await fetchWithTimeout(
    `${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(to)}/diff?${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = (await res.json().catch(() => ({}))) as DiffResponse & { detail?: string };
  if (!res.ok) {
    fatal(`GET /diff failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`);
    return null;
  }
  return data;
}

async function performRollback(
  apiUrl: string,
  token: string,
  roostId: string,
  siteId: string,
  targetVersion: string,
  idempotencyKey: string,
): Promise<RollbackResponse | null> {
  const res = await fetchWithTimeout(`${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/rollback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ siteId, targetVersion }),
  });
  const data = (await res.json().catch(() => ({}))) as RollbackResponse & { detail?: string };
  if (!res.ok) {
    fatal(
      `POST /api/roosts/${roostId}/rollback failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
    );
    return null;
  }
  return data;
}

/** Defaults to "no" on empty input per [y/N] — return must never roll back. */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function fatal(msg: string, exitCode = 1): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = exitCode;
}

function unconfirmedRollbackFatal(input: {
  operation: string;
  idempotencyKey: string;
  targetVersionId: string;
  cause: unknown;
}): void {
  const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
  process.stderr.write(
    `owlette: ${input.operation} did not return a confirmed response: ${detail}\n` +
      `  The request may or may not have completed.\n` +
      `  Idempotency-Key: ${input.idempotencyKey}\n` +
      `  To retry safely, re-run your original command with \`--to ${input.targetVersionId} --idempotency-key ${input.idempotencyKey}\` appended.\n`,
  );
  process.exitCode = 1;
}

/** Exported for unit tests: promptYesNo reads process.stdin. */
export const _internals = {
  promptYesNo,
};
