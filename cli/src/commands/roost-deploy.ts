/**
 * `owlette roost deploy <roostId>`.
 *
 * Drives POST /api/roosts/{id}/deploy with body:
 *   {
 *     siteId,
 *     versionId?,      // defaults to the roost's currentVersionId server-side
 *     machines?,       // comma-separated list; overrides the roost's targets[]
 *     scheduleAt?,     // iso8601
 *     dryRun?,
 *   }
 *
 * dry-run returns the server-computed plan (canary/fleet split, resolved
 * extractRoot + versionUrl) and writes nothing. A real deploy creates the
 * rollout doc and queues `sync_pull` for the canary wave; a future
 * `scheduleAt` stores a `scheduled` rollout for the sweeper.
 *
 * Sends `Idempotency-Key`: the server caches the 201 for 24h, so a retry after
 * a network timeout replays the original plan instead of starting a second
 * rollout.
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import {
  unconfirmedMutationFatal,
  usageFatal,
} from '../lib/output';

interface DeployResponse {
  rolloutId: string;
  versionId: string;
  siteId: string;
  roostId: string;
  stage: 'canary' | 'scheduled' | string;
  canary: string[];
  fleet: string[];
  extractRoot: string;
  versionUrl: string;
  dryRun?: boolean;
  alreadyRunning?: boolean;
  scheduled?: { at: string; warning: string };
  detail?: string;
}

export function registerRoostDeployCommand(program: Command): void {
  const roost =
    (program.commands.find((c) => c.name() === 'roost') as Command | undefined) ??
    program.command('roost').description('manage roosts + versions');

  roost
    .command('deploy <roostId>')
    .description('trigger a targeted fan-out (canary → fleet)')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .option(
      '--version <versionId>',
      "version to deploy (default: the roost's currentVersionId)",
    )
    .option('--machines <ids>', 'comma-separated machine ids (overrides roost.targets)')
    .option('--dry-run', 'compute + print the rollout plan without writing')
    .option('--at <iso8601>', 'schedule the rollout for a future timestamp')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted on retries)',
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
      const body: Record<string, unknown> = { siteId: opts.site };

      if (opts.version) body.versionId = opts.version;

      if (opts.machines) {
        const machines = String(opts.machines)
          .split(',')
          .map((m: string) => m.trim())
          .filter(Boolean);
        if (machines.length === 0) {
          usageFatal('--machines must contain at least one non-empty id when provided');
          return;
        }
        body.machines = machines;
      }

      if (opts.at) {
        const parsed = Date.parse(opts.at);
        if (Number.isNaN(parsed)) {
          usageFatal(`--at '${opts.at}' is not a valid iso8601 timestamp`);
          return;
        }
        body.scheduleAt = new Date(parsed).toISOString();
      }

      if (opts.dryRun) body.dryRun = true;

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : opts.dryRun
          ? null
          : `cli-deploy-${randomUUID()}`;
      if (opts.idempotencyKey) {
        headers['Idempotency-Key'] = idempotencyKey!;
      } else if (idempotencyKey) {
        // Auto-key real deploys so a retry cannot create a second rollout. Dry
        // runs mutate nothing, so there is nothing to cache.
        headers['Idempotency-Key'] = idempotencyKey;
      }

      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${apiUrl}/api/roosts/${encodeURIComponent(roostId)}/deploy`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          },
        );
      } catch (err) {
        if (idempotencyKey && !opts.dryRun) {
          unconfirmedMutationFatal({
            operation: `POST /api/roosts/${roostId}/deploy`,
            idempotencyKey,
            cause: err,
          });
        } else {
          fatal(`POST /api/roosts/${roostId}/deploy failed: ${(err as Error).message}`);
        }
        return;
      }
      const data = (await res.json().catch(() => ({}))) as DeployResponse;

      if (!res.ok) {
        fatal(
          `POST /api/roosts/${roostId}/deploy failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatDeployResult(data, roostId));
    });
}

// formatter

function formatDeployResult(r: DeployResponse, roostId: string): string {
  const lines: string[] = [];
  const label = r.dryRun
    ? 'dry-run plan'
    : r.alreadyRunning
      ? 'rollout already in flight'
      : r.stage === 'scheduled'
        ? 'scheduled'
        : 'rollout started';

  lines.push(`owlette: ${label} for ${roostId}`);
  lines.push(`  version       ${r.versionId}`);
  lines.push(`  stage         ${r.stage}`);
  lines.push(`  extract root  ${r.extractRoot}`);
  lines.push(`  version url   ${r.versionUrl}`);
  if (r.scheduled) {
    lines.push(`  scheduled at  ${r.scheduled.at}`);
    lines.push(`  warning       ${r.scheduled.warning}`);
  }
  lines.push('');
  lines.push(`  canary (${r.canary.length})`);
  if (r.canary.length === 0) {
    lines.push('    (none)');
  } else {
    for (const m of r.canary) lines.push(`    - ${m}`);
  }
  lines.push(`  fleet (${r.fleet.length})`);
  if (r.fleet.length === 0) {
    lines.push('    (none)');
  } else {
    for (const m of r.fleet) lines.push(`    - ${m}`);
  }
  return lines.join('\n') + '\n';
}

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
}

/** Exported for tests. */
export const _internals = { formatDeployResult };
