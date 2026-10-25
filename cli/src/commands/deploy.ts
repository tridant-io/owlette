/**
 * `owlette deploy create|list|get|retry|cancel|uninstall|delete` — classic
 * agent-installer deploys over /api/sites/{siteId}/deployments.
 *
 * NOT `owlette roost deploy`, which is the content-addressed atomic deploy
 * (roost-deploy.ts).
 *
 * Mutations auto-generate an `Idempotency-Key` so a retry after a network blip
 * replays the cached response instead of double-issuing commands;
 * `--idempotency-key` pins one.
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config';
import { activeHoursOverrideFrom, addActiveHoursOverrideOptions } from '../lib/activeHoursOverride';
import { fetchWithTimeout } from '../lib/http';
import {
  isJson,
  renderTable,
  unconfirmedMutationFatal,
  usageFatal,
} from '../lib/output';

interface DeploymentTarget {
  machineId: string;
  status: string;
  error?: string | null;
}

interface DeploymentListItem {
  id: string;
  name: string;
  installer_name: string;
  installer_url: string;
  silent_flags: string;
  verify_path: string | null;
  sha256_checksum: string | null;
  parallel_install: boolean;
  targets: DeploymentTarget[];
  status: string;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

interface DeploymentDetail extends DeploymentListItem {
  siteId: string;
}

export function registerDeployCommands(program: Command): void {
  const deploy =
    (program.commands.find((c) => c.name() === 'deploy') as Command | undefined) ??
    program
      .command('deploy')
      .description(
        'classic installer deploys — see `owlette roost deploy` for content-addressed deploys',
      );

  // Re-set regardless of registration order: the help text must disambiguate
  // `owlette deploy` from `owlette roost deploy`.
  deploy.description(
    'classic installer deploys — see `owlette roost deploy` for content-addressed deploys',
  );

  // Drop any stub verbs left from earlier file-load ordering.
  for (const verb of ['create', 'list', 'get', 'retry', 'cancel', 'uninstall', 'delete'] as const) {
    const existing = deploy.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = deploy.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  const create = deploy
    .command('create')
    .description('create a new classic-installer deployment')
    .requiredOption('--site <siteId>', 'site id that owns the deployment')
    .requiredOption('--name <name>', 'human-readable deployment name')
    .requiredOption('--installer-url <url>', 'https url of the installer binary')
    .requiredOption('--installer-name <name>', 'installer file name (e.g. Owlette-Installer-v2.10.0.exe)')
    .requiredOption('--silent-flags <flags>', 'silent-install flags passed to the exe (e.g. /S)')
    .requiredOption('--machines <csv>', 'comma-separated machine ids')
    .option('--verify-path <path>', 'path that must exist after install to mark success')
    .option('--sha256 <hex>', '64-char sha256 digest of the installer for verification')
    .option('--close-processes <csv>', 'comma-separated process exe names agents should close first')
    .option('--suppress-projects <csv>', 'comma-separated project names/paths agents should suppress first')
    .option('--parallel', 'run install on all targets concurrently (default: serial)');
  addActiveHoursOverrideOptions(create, "install inside the machines' active hours anyway")
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const machines = parseCsv(opts.machines);
      if (machines.length === 0) {
        usageFatal('--machines must contain at least one non-empty id');
        return;
      }
      const closeProcesses = parseCsv(opts.closeProcesses);
      if (opts.closeProcesses !== undefined && closeProcesses.length === 0) {
        usageFatal('--close-processes must contain at least one non-empty value when supplied');
        return;
      }
      const suppressProjects = parseCsv(opts.suppressProjects);
      if (opts.suppressProjects !== undefined && suppressProjects.length === 0) {
        usageFatal('--suppress-projects must contain at least one non-empty value when supplied');
        return;
      }
      const override = activeHoursOverrideFrom(opts);
      if (!override.ok) return;

      const body: Record<string, unknown> = {
        name: opts.name,
        installer_name: opts.installerName,
        installer_url: opts.installerUrl,
        silent_flags: opts.silentFlags,
        machines,
      };
      if (opts.verifyPath) body.verify_path = opts.verifyPath;
      if (opts.sha256) body.sha256_checksum = opts.sha256;
      if (closeProcesses.length > 0) body.close_processes = closeProcesses;
      if (suppressProjects.length > 0) body.suppress_projects = suppressProjects;
      if (opts.parallel) body.parallel_install = true;
      if (override.override) body.active_hours_override = override.override;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-deploy-create-${randomUUID()}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      };

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/deployments`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/deployments`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        deploymentId?: string;
        siteId?: string;
        status?: string;
        targets?: DeploymentTarget[];
        detail?: string;
        code?: string;
        quota?: { max_targets?: number; requested?: number };
      };

      if (!res.ok) {
        if (res.status === 413 && data.code === 'over_quota') {
          const q = data.quota ?? {};
          fatal(
            `POST /api/sites/${opts.site}/deployments failed (413, over_quota): ${data.detail ?? 'too many targets'}` +
              (q.max_targets !== undefined && q.requested !== undefined
                ? `\n  quota: max_targets=${q.max_targets}, requested=${q.requested}` +
                  `\n  hint:  raise sites/${opts.site}.deployQuota or shrink --machines`
                : ''),
          );
          return;
        }
        fatal(
          `POST /api/sites/${opts.site}/deployments failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: deployment ${data.deploymentId} created on ${data.siteId} — status ${data.status}, ${(data.targets ?? []).length} target(s)\n`,
      );
    });

  deploy
    .command('list')
    .description('list classic-installer deployments on a site')
    .requiredOption('--site <siteId>', 'site id to list deployments for')
    .option('--limit <n>', 'page size (1..100, default 25)')
    .option('--cursor <token>', 'opaque page_token returned by a previous list call')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const qs = new URLSearchParams();
      if (opts.limit !== undefined) {
        const n = Number(opts.limit);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          usageFatal('--limit must be a positive integer');
          return;
        }
        qs.set('page_size', String(n));
      }
      if (opts.cursor) qs.set('page_token', String(opts.cursor));

      const url =
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/deployments` +
        (qs.toString() ? `?${qs.toString()}` : '');
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        items?: DeploymentListItem[];
        next_page_token?: string;
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/deployments failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      const items = data.items ?? [];
      if (items.length === 0) {
        process.stdout.write('(no deployments)\n');
        return;
      }

      const rows = items.map((d) => [
        d.id,
        d.name,
        d.status,
        String(d.targets.length),
        d.installer_name,
        d.createdAt ?? '',
      ]);
      process.stdout.write(
        renderTable(['id', 'name', 'status', 'targets', 'installer', 'createdAt'], rows),
      );
      if (data.next_page_token) {
        process.stdout.write(`\nnext page: --cursor ${data.next_page_token}\n`);
      }
    });

  deploy
    .command('get <deploymentId>')
    .description('print one classic-installer deployment incl. per-target status')
    .requiredOption('--site <siteId>', 'site id that owns the deployment')
    .action(async (deploymentId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/deployments/${encodeURIComponent(deploymentId)}`;
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as DeploymentDetail & {
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/deployments/${deploymentId} failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatDeploymentDetail(data));
    });

  const retry = deploy
    .command('retry <deploymentId>')
    .description('re-issue a deployment to targets that previously failed')
    .requiredOption('--site <siteId>', 'site id that owns the deployment');
  // a retry needs its own override; the original deployment's does not carry over.
  addActiveHoursOverrideOptions(retry, "install inside the machines' active hours anyway")
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (deploymentId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const override = activeHoursOverrideFrom(opts);
      if (!override.ok) return;
      const body = override.override ? { active_hours_override: override.override } : {};

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-deploy-retry-${randomUUID()}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      };

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/deployments/${encodeURIComponent(deploymentId)}/retry`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/deployments/${deploymentId}/retry`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        deploymentId?: string;
        siteId?: string;
        status?: string;
        retried?: number;
        machine_ids?: string[];
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        fatal(
          `POST /api/sites/${opts.site}/deployments/${deploymentId}/retry failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: retried ${data.retried ?? 0} target(s) on ${deploymentId} — status ${data.status}\n`,
      );
    });

  deploy
    .command('cancel <deploymentId>')
    .description('cancel queued targets on a deployment (in-flight installers are left alone)')
    .requiredOption('--site <siteId>', 'site id that owns the deployment')
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (deploymentId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes && process.stdin.isTTY) {
        const ok = await promptYesNo(
          `cancel queued targets on ${deploymentId}? running installers will not be interrupted. [y/N] `,
        );
        if (!ok) {
          process.stdout.write('cancel aborted\n');
          return;
        }
      } else if (!opts.yes && !process.stdin.isTTY) {
        usageFatal('stdin is not a tty and --yes was not supplied; refusing to cancel silently');
        return;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-deploy-cancel-${randomUUID()}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      };

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/deployments/${encodeURIComponent(deploymentId)}/cancel`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/deployments/${deploymentId}/cancel`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        deploymentId?: string;
        siteId?: string;
        status?: string;
        cancelled?: number;
        machine_ids?: string[];
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        fatal(
          `POST /api/sites/${opts.site}/deployments/${deploymentId}/cancel failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: cancelled ${data.cancelled ?? 0} target(s) on ${deploymentId} — status ${data.status}\n`,
      );
    });

  deploy
    .command('uninstall <deploymentId>')
    .description('queue uninstall on every target machine (requires site=<id>:admin scope)')
    .requiredOption('--site <siteId>', 'site id that owns the deployment')
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (deploymentId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes && process.stdin.isTTY) {
        const ok = await promptYesNo(
          `uninstall ${deploymentId} from every target machine? this is permanent. [y/N] `,
        );
        if (!ok) {
          process.stdout.write('uninstall aborted\n');
          return;
        }
      } else if (!opts.yes && !process.stdin.isTTY) {
        usageFatal('stdin is not a tty and --yes was not supplied; refusing to uninstall silently');
        return;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-deploy-uninstall-${randomUUID()}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      };

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/deployments/${encodeURIComponent(deploymentId)}/uninstall`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/deployments/${deploymentId}/uninstall`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        deploymentId?: string;
        siteId?: string;
        status?: string;
        queued?: number;
        machine_ids?: string[];
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        if (res.status === 403 && data.code === 'scope_insufficient') {
          fatal(
            `POST /api/sites/${opts.site}/deployments/${deploymentId}/uninstall failed (403, scope_insufficient): ${data.detail ?? 'admin scope required'}` +
              `\n  hint: uninstall requires site=${opts.site}:admin scope (write is not enough)`,
          );
          return;
        }
        fatal(
          `POST /api/sites/${opts.site}/deployments/${deploymentId}/uninstall failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: queued uninstall on ${data.queued ?? 0} target(s) for ${deploymentId} — status ${data.status}\n`,
      );
    });

  deploy
    .command('delete <deploymentId>')
    .description('delete a terminal deployment record (does not uninstall software)')
    .requiredOption('--site <siteId>', 'site id that owns the deployment')
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (deploymentId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes && process.stdin.isTTY) {
        const ok = await promptYesNo(
          `delete deployment record ${deploymentId}? this does not uninstall software. [y/N] `,
        );
        if (!ok) {
          process.stdout.write('delete aborted\n');
          return;
        }
      } else if (!opts.yes && !process.stdin.isTTY) {
        usageFatal('stdin is not a tty and --yes was not supplied; refusing to delete silently');
        return;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-deploy-delete-${randomUUID()}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      };

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/deployments/${encodeURIComponent(deploymentId)}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'DELETE',
          headers,
          body: JSON.stringify({}),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `DELETE /api/sites/${opts.site}/deployments/${deploymentId}`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        deploymentId?: string;
        siteId?: string;
        deleted?: boolean;
        detail?: string;
        code?: string;
      };

      if (!res.ok) {
        fatal(
          `DELETE /api/sites/${opts.site}/deployments/${deploymentId} failed (${res.status}, ${data.code ?? 'unknown'}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(
        `owlette: deployment ${data.deploymentId ?? deploymentId} deleted on ${data.siteId ?? opts.site}\n`,
      );
    });
}

function formatDeploymentDetail(d: DeploymentDetail): string {
  const out: string[] = [];
  out.push(`id              ${d.id}`);
  out.push(`siteId          ${d.siteId}`);
  out.push(`name            ${d.name}`);
  out.push(`status          ${d.status}`);
  out.push(`installer name  ${d.installer_name}`);
  out.push(`installer url   ${d.installer_url}`);
  out.push(`silent flags    ${d.silent_flags}`);
  out.push(`verify path     ${d.verify_path ?? '(none)'}`);
  out.push(`sha256          ${d.sha256_checksum ?? '(none)'}`);
  out.push(`parallel        ${d.parallel_install ? 'yes' : 'no'}`);
  out.push(`createdAt       ${d.createdAt ?? '(unknown)'}`);
  out.push(`completedAt     ${d.completedAt ?? '(pending)'}`);
  out.push('');
  out.push(`targets (${d.targets.length})`);
  if (d.targets.length === 0) {
    out.push('  (none)');
  } else {
    const rows = d.targets.map((t) => [t.machineId, t.status, t.error ?? '']);
    out.push(renderTable(['machineId', 'status', 'error'], rows).trimEnd());
  }
  return out.join('\n') + '\n';
}

function parseCsv(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
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

function fatal(msg: string): void {
  process.stderr.write(`owlette: ${msg}\n`);
  process.exitCode = 1;
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

/** Exported for tests. */
export const _internals = { formatDeploymentDetail };
