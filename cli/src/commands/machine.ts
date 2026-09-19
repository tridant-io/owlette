/**
 * `owlette machine list | get | deployments | reboot | shutdown | screenshot | live-view`.
 *
 * Drives:
 *   GET  /api/sites/{siteId}/machines[/{machineId}[/deployments]]
 *   POST /api/sites/{siteId}/machines/{machineId}/commands  (reboot/shutdown/screenshot)
 *   GET  /api/sites/{siteId}/machines/{machineId}/commands/{commandId}  (screenshot poll)
 *
 * Reads render a plain-ascii table / key-value detail, or JSON with `--json`.
 * Mutations hit the wave-2A allowlisted commands endpoint with an auto-generated
 * `Idempotency-Key`. Screenshot is queue → poll → download the signed-url bytes
 * to `--output <path>` (default `screenshot-<machineId>-<timestamp>.png`).
 *
 * `live-view` is the only remaining c-tier `stubExit()` shim — remote desktop
 * ships as swoop, so the stub points at `owlette swoop`.
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import * as path from 'path';
import { loadConfig } from '../config';
import { fetchWithTimeout } from '../lib/http';
import {
  isJson,
  renderTable,
  unconfirmedMutationFatal,
  usageFatal,
} from '../lib/output';
import { stubExit } from '../lib/stubExit';

interface RoostSummary {
  roostId: string;
  name: string;
  currentVersionId: string | null;
  versionCounter: number;
}

interface MachineListItem {
  id: string;
  name: string;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  os: string | null;
  currentRoosts: RoostSummary[];
}

interface MachineMetrics {
  cpu?: number;
  memory?: number;
  disk?: number;
  uptime?: number;
  [key: string]: unknown;
}

interface MachineProcess {
  name?: string;
  status?: string;
  pid?: number | null;
  [key: string]: unknown;
}

interface MachineDetail {
  id: string;
  siteId: string;
  name: string;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  os: string | null;
  hostname: string | null;
  metrics: MachineMetrics | null;
  processes: MachineProcess[];
}

interface MachineDeployment {
  roostId: string;
  name: string;
  currentVersionId: string | null;
  previousVersionId: string | null;
  versionCounter: number;
  extractPath: string | null;
  reportedVersionId: string | null;
  reportedStatus: string | null;
  reportedAt: string | null;
}

interface MachineDeploymentsResponse {
  siteId: string;
  machineId: string;
  deployments: MachineDeployment[];
}

const SCREENSHOT_POLL_INTERVAL_MS = 1500;
const SCREENSHOT_POLL_MAX_ATTEMPTS = 40; // 60s wall-clock at 1.5s interval

interface CommandStatusEnvelope {
  commandId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: {
    screenshot_url?: string;
    screenshot_path?: string;
    expires_at?: number | string;
    [key: string]: unknown;
  };
  error?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface CommandQueueEnvelope {
  commandId: string;
  status: string;
}

interface ProblemEnvelope {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
}

interface OkEnvelope<T> {
  ok?: boolean;
  data?: T;
}

export function registerMachineCommands(program: Command): void {
  const machine =
    (program.commands.find((c) => c.name() === 'machine') as Command | undefined) ??
    program.command('machine').description('list + inspect machines + remote control');

  // Overwrite any earlier stub description so help text stays canonical.
  machine.description('list + inspect machines + remote control');

  // Drop stubs left by earlier file-load ordering, mutation verbs included.
  for (const verb of [
    'list',
    'get',
    'deployments',
    'reboot',
    'shutdown',
    'screenshot',
    'live-view',
  ] as const) {
    const existing = machine.commands.find((c) => c.name() === verb);
    if (existing) {
      const list = machine.commands as Command[];
      const idx = list.indexOf(existing);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  machine
    .command('list')
    .description('list machines on a site with online + last-heartbeat')
    .requiredOption('--site <siteId>', 'site id to list machines for')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as {
        machines?: MachineListItem[];
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/machines failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      const machines = data.machines ?? [];

      if (json) {
        process.stdout.write(JSON.stringify({ machines }, null, 2) + '\n');
        return;
      }

      if (machines.length === 0) {
        process.stdout.write('(no machines)\n');
        return;
      }

      const rows = machines.map((m) => [
        m.id,
        m.name,
        m.online ? 'yes' : 'no',
        m.lastHeartbeat ?? '',
        m.agentVersion ?? '',
        formatRoostSummary(m.currentRoosts),
      ]);
      process.stdout.write(
        renderTable(
          ['id', 'name', 'online', 'last-heartbeat', 'agent', 'roosts'],
          rows,
        ),
      );
    });

  machine
    .command('get <machineId>')
    .description('print the detail record for one machine (metrics + processes)')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action(async (machineId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(machineId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as MachineDetail & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/machines/${machineId} failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatMachineDetail(data));
    });

  machine
    .command('deployments <machineId>')
    .description('per-roost deployment state for one machine (intended vs reported)')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action(async (machineId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const res = await fetchWithTimeout(
        `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(machineId)}/deployments`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json().catch(() => ({}))) as MachineDeploymentsResponse & {
        detail?: string;
      };
      if (!res.ok) {
        fatal(
          `GET /api/sites/${opts.site}/machines/${machineId}/deployments failed (${res.status}): ${data.detail ?? JSON.stringify(data)}`,
        );
        return;
      }

      if (json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      const deployments = data.deployments ?? [];
      if (deployments.length === 0) {
        process.stdout.write('(no roosts target this machine)\n');
        return;
      }

      const rows = deployments.map((d) => [
        d.roostId,
        d.name,
        d.currentVersionId ?? '(none)',
        d.reportedVersionId ?? '(none)',
        d.reportedStatus ?? '(unknown)',
        d.reportedAt ?? '',
      ]);
      process.stdout.write(
        renderTable(
          ['roostId', 'name', 'intended', 'reported', 'status', 'reportedAt'],
          rows,
        ),
      );
    });

  registerSimpleCommandVerb(machine, {
    verb: 'reboot',
    description: 'queue a reboot command on the machine',
    commandType: 'reboot_machine',
  });

  registerSimpleCommandVerb(machine, {
    verb: 'shutdown',
    description: 'queue a shutdown command on the machine',
    commandType: 'shutdown_machine',
  });

  machine
    .command('screenshot <machineId>')
    .description('capture a screenshot from the machine and download it locally')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .option(
      '--monitor <monitor>',
      'non-negative integer monitor index (0 captures all monitors)',
    )
    .option('--output <path>', 'path to write the png (default: screenshot-<machineId>-<ts>.png in cwd)')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (machineId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const params: Record<string, unknown> = {};
      if (opts.monitor !== undefined) {
        const monitor = parseMonitorOpt(String(opts.monitor));
        if (typeof monitor === 'string' && monitor.startsWith('error:')) {
          return usageFatal(monitor.slice('error:'.length));
        }
        params.monitor = monitor;
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-machine-screenshot-${randomUUID()}`;
      const queueUrl = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(machineId)}/commands`;
      let queueRes: Response;
      try {
        queueRes = await fetchWithTimeout(queueUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ type: 'capture_screenshot', params }),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/machines/${machineId}/commands`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const queueData = (await queueRes.json().catch(() => ({}))) as
        OkEnvelope<CommandQueueEnvelope> & ProblemEnvelope;
      if (!queueRes.ok) {
        return fatalProblem(
          `POST /api/sites/${opts.site}/machines/${machineId}/commands`,
          queueRes.status,
          queueData,
          'screenshot',
        );
      }

      const commandId = queueData.data?.commandId;
      if (!commandId) {
        return fatal('server returned ok but no commandId — cannot poll for screenshot');
      }

      // Poll status. A dot per attempt in human mode; --json stays silent.
      const pollUrl = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(machineId)}/commands/${encodeURIComponent(commandId)}`;
      let final: CommandStatusEnvelope | null = null;
      for (let attempt = 0; attempt < SCREENSHOT_POLL_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await sleep(SCREENSHOT_POLL_INTERVAL_MS);
        }
        if (!json) process.stdout.write('.');
        const pollRes = await fetchWithTimeout(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
        const pollData = (await pollRes.json().catch(() => ({}))) as
          OkEnvelope<CommandStatusEnvelope> & ProblemEnvelope;
        if (!pollRes.ok) {
          if (!json) process.stdout.write('\n');
          return fatalProblem(`GET ${pollUrl}`, pollRes.status, pollData, 'screenshot');
        }
        const status = pollData.data?.status;
        if (status === 'completed' || status === 'failed') {
          final = pollData.data ?? null;
          break;
        }
      }
      if (!json) process.stdout.write('\n');

      if (!final) {
        return fatal(
          `screenshot timed out after ${SCREENSHOT_POLL_MAX_ATTEMPTS * SCREENSHOT_POLL_INTERVAL_MS / 1000}s — the command is still pending. check the dashboard or retry the screenshot command later`,
        );
      }

      if (final.status === 'failed') {
        return fatal(`screenshot capture failed on the agent: ${final.error ?? '(no error detail)'}`);
      }

      const signedUrl = final.result?.screenshot_url;
      if (!signedUrl) {
        return fatal('command completed but the server did not return a screenshot_url — try the dashboard');
      }

      const outputPath = opts.output
        ? String(opts.output)
        : path.join(process.cwd(), defaultScreenshotFilename(machineId));

      const downloadRes = await fetch(signedUrl);
      if (!downloadRes.ok) {
        return fatal(`failed to download screenshot bytes from signed url (${downloadRes.status})`);
      }
      const bytes = Buffer.from(await downloadRes.arrayBuffer());
      await writeFile(outputPath, bytes);

      if (json) {
        process.stdout.write(
          JSON.stringify(
            { commandId, screenshotPath: outputPath, sizeBytes: bytes.length },
            null,
            2,
          ) + '\n',
        );
        return;
      }
      process.stdout.write(
        `owlette: screenshot saved to ${outputPath} (${bytes.length} bytes)\n`,
      );
    });

  machine
    .command('live-view <machineId>')
    .description('open a live thumbnail/video stream from the machine (stub)')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .action((_machineId: string, _opts, cmd) => {
      const { apiUrl } = loadConfig({ profile: cmd.optsWithGlobals().profile });
      stubExit({
        noun: 'machine',
        verb: 'live-view',
        reason: 'remote desktop ships as swoop — run `owlette swoop <machineId> --site <siteId>`',
        dashboardUrl: `${apiUrl}/dashboard`,
        futurePlan: 'public-api deferred: swoop',
        cmd,
      });
    });
}

function registerSimpleCommandVerb(
  machine: Command,
  cfg: { verb: 'reboot' | 'shutdown'; description: string; commandType: string },
): void {
  machine
    .command(`${cfg.verb} <machineId>`)
    .description(cfg.description)
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .option(
      '--delay-seconds <n>',
      'delay before the agent fires the command (default: 0)',
    )
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (machineId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const params: Record<string, unknown> = {};
      if (opts.delaySeconds !== undefined) {
        const n = Number(opts.delaySeconds);
        if (!Number.isFinite(n) || n < 0) {
          return usageFatal('--delay-seconds must be a non-negative number');
        }
        params.delay_seconds = Math.floor(n);
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-machine-${cfg.verb}-${randomUUID()}`;
      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(machineId)}/commands`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ type: cfg.commandType, params }),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/machines/${machineId}/commands`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as
        OkEnvelope<CommandQueueEnvelope> & ProblemEnvelope;
      if (!res.ok) {
        return fatalProblem(
          `POST /api/sites/${opts.site}/machines/${machineId}/commands`,
          res.status,
          data,
        );
      }

      if (json) {
        process.stdout.write(JSON.stringify(data.data ?? {}, null, 2) + '\n');
        return;
      }

      const commandId = data.data?.commandId ?? '(unknown)';
      process.stdout.write(
        `owlette: ${cfg.verb} queued for machine ${machineId} (commandId=${commandId})\n`,
      );
    });
}

function formatRoostSummary(roosts: readonly RoostSummary[] | undefined): string {
  if (!roosts || roosts.length === 0) return '(none)';
  if (roosts.length === 1) {
    const r = roosts[0]!;
    return `${r.name} → ${r.currentVersionId ?? '(none)'}`;
  }
  return `${roosts.length} roosts`;
}

function formatMachineDetail(m: MachineDetail): string {
  const out: string[] = [];
  out.push(`id             ${m.id}`);
  out.push(`name           ${m.name}`);
  out.push(`site           ${m.siteId}`);
  out.push(`online         ${m.online ? 'yes' : 'no'}`);
  out.push(`last-heartbeat ${m.lastHeartbeat ?? '(never)'}`);
  out.push(`agent          ${m.agentVersion ?? '(unknown)'}`);
  out.push(`os             ${m.os ?? '(unknown)'}`);
  out.push(`hostname       ${m.hostname ?? '(unknown)'}`);

  if (m.metrics && Object.keys(m.metrics).length > 0) {
    out.push('');
    out.push('metrics:');
    for (const [k, v] of Object.entries(m.metrics)) {
      out.push(`  ${k.padEnd(12)} ${formatMetricValue(v)}`);
    }
  }

  const procs = Array.isArray(m.processes) ? m.processes : [];
  if (procs.length > 0) {
    out.push('');
    out.push(`processes (${procs.length}):`);
    for (const p of procs) {
      const name = typeof p.name === 'string' ? p.name : '(unnamed)';
      const status = typeof p.status === 'string' ? p.status : '(unknown)';
      const pid = p.pid !== null && p.pid !== undefined ? `pid ${p.pid}` : 'no pid';
      out.push(`  ${name.padEnd(28)} ${status.padEnd(12)} ${pid}`);
    }
  }

  return out.join('\n') + '\n';
}

function formatMetricValue(v: unknown): string {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return JSON.stringify(v);
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

/**
 * Render an RFC-7807 problem+json error: pulls `code` + `detail` and adds a hint
 * for the stable codes we surface.
 */
function fatalProblem(
  operation: string,
  status: number,
  env: ProblemEnvelope,
  context?: 'screenshot',
): void {
  const code = env.code ?? '(no code)';
  const detail = env.detail ?? JSON.stringify(env);
  const hint = hintForCode(code, context);
  const suffix = hint ? `\n  hint: ${hint}` : '';
  process.stderr.write(
    `owlette: ${operation} failed (${status}, code=${code}): ${detail}${suffix}\n`,
  );
  process.exitCode = 1;
}

function hintForCode(code: string, context?: 'screenshot'): string | null {
  switch (code) {
    case 'machine_offline':
      return 'machine appears offline; check the dashboard heartbeat';
    case 'unsupported_command_type':
      return 'supported types: reboot_machine, shutdown_machine, capture_screenshot';
    case 'scope_insufficient':
      if (context === 'screenshot') {
        return 'screenshot requires both machine=<id>:write and machine=<id>:read scopes';
      }
      return 'your key is missing the required scope: machine=<id>:write';
    default:
      return null;
  }
}

/**
 * Parse `--monitor` as a non-negative integer — the agent treats 0 as the
 * all-monitors virtual display and its command contract has no named monitors.
 * Returns `error:<message>` so the caller can surface it via `fatal()`.
 */
function parseMonitorOpt(raw: string): string | number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return `error:--monitor must be a non-negative integer (0 captures all monitors; named monitors are not supported)`;
  }
  return n;
}

/** Default screenshot filename — `screenshot-<machineId>-<iso-ts>.png`. */
function defaultScreenshotFilename(machineId: string): string {
  // Replace ':' with '-' so the filename is valid on Windows.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // Strip any path-illegal chars from machineId for safety.
  const safe = machineId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `screenshot-${safe}-${ts}.png`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Export for unit tests. */
export const _internals = {
  formatMachineDetail,
  formatRoostSummary,
  formatMetricValue,
  renderTable,
  parseMonitorOpt,
  defaultScreenshotFilename,
  hintForCode,
  SCREENSHOT_POLL_INTERVAL_MS,
  SCREENSHOT_POLL_MAX_ATTEMPTS,
};
