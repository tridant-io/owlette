/**
 * `owlette process …` — process lifecycle on machines, over the scoped process
 * API: /api/sites/{siteId}/machines/{machineId}/processes[/{processId}] plus
 * /kill, /restart, /start, /stop and /schedule.
 *
 * `--site` and `--machine` are required on every verb. Mutations auto-generate an
 * `Idempotency-Key`, which the server caches the response against for 24h.
 * Control verbs and `schedule` return 202 with a `commandId` the cli prints so
 * callers can poll the command-state endpoint.
 *
 * Responses are `{ ok: true, data }`; errors are RFC-7807 problem+json with
 * stable `code` strings (`duplicate_process_name`, `process_not_found`, …).
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

interface ProcessSummary {
  processId: string;
  name: string;
  exe_path: string;
  cwd: string;
  priority: string;
  visibility: string;
  launch_mode: string;
  autolaunch: boolean;
  status: string;
  pid: number | null;
  responsive: boolean;
  schedule: unknown;
  schedules: unknown;
  last_updated: string | number | null;
}

interface ProcessListResponse {
  processes: ProcessSummary[];
  nextPageToken: string | null;
}

interface CommandQueueResponse {
  commandId: string;
  status: string;
}

interface ScheduleResponse {
  processId: string;
  mode: string;
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

const VALID_SCHEDULE_MODES = ['off', 'always', 'scheduled'] as const;
type ScheduleMode = (typeof VALID_SCHEDULE_MODES)[number];

export function registerProcessCommands(program: Command): void {
  const proc = program.command('process').description('process lifecycle on machines');

  // list

  proc
    .command('list')
    .description('list managed processes on a machine')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--machine <machineId>', 'machine id whose processes to list')
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(opts.machine)}/processes`;
      const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = (await res.json().catch(() => ({}))) as
        OkEnvelope<ProcessListResponse> & ProblemEnvelope;
      if (!res.ok) {
        return fatalProblem(`GET /api/sites/${opts.site}/machines/${opts.machine}/processes`, res.status, data);
      }

      const payload = data.data ?? { processes: [], nextPageToken: null };

      if (json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        return;
      }

      const procs = payload.processes ?? [];
      if (procs.length === 0) {
        process.stdout.write('(no processes)\n');
        return;
      }

      const rows = procs.map((p) => [
        p.processId,
        p.name,
        p.launch_mode ?? 'off',
        p.status ?? 'unknown',
        p.pid !== null && p.pid !== undefined ? String(p.pid) : '',
      ]);
      process.stdout.write(
        renderTable(['processId', 'name', 'launch_mode', 'status', 'pid'], rows),
      );
    });

  // get

  proc
    .command('get <processId>')
    .description('print the detail record for one managed process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .action(async (processId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(opts.machine)}/processes/${encodeURIComponent(processId)}`;
      const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = (await res.json().catch(() => ({}))) as
        OkEnvelope<ProcessSummary> & ProblemEnvelope;
      if (!res.ok) {
        return fatalProblem(
          `GET /api/sites/${opts.site}/machines/${opts.machine}/processes/${processId}`,
          res.status,
          data,
        );
      }

      const p = data.data;
      if (!p) {
        return fatal('server returned ok but no process detail');
      }

      if (json) {
        process.stdout.write(JSON.stringify(p, null, 2) + '\n');
        return;
      }

      process.stdout.write(formatProcessDetail(p));
    });

  // create

  proc
    .command('create')
    .description('register a new managed process on a machine')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--machine <machineId>', 'machine id to create the process on')
    .requiredOption('--name <name>', 'human-readable name for the process')
    .requiredOption('--exe <path>', 'absolute path to the executable')
    .option('--cwd <path>', 'working directory for the process')
    .option('--priority <priority>', 'process priority (Low|Normal|High|Realtime)')
    .option('--visibility <visibility>', 'window visibility (Normal|Hidden)')
    .option('--launch-mode <mode>', 'launch mode (off|always|scheduled)')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (opts.launchMode && !VALID_SCHEDULE_MODES.includes(opts.launchMode as ScheduleMode)) {
        return usageFatal(`--launch-mode must be one of ${VALID_SCHEDULE_MODES.join(', ')}`);
      }

      const body: Record<string, unknown> = {
        name: opts.name,
        exe_path: opts.exe,
      };
      if (opts.cwd !== undefined) body.cwd = opts.cwd;
      if (opts.priority !== undefined) body.priority = opts.priority;
      if (opts.visibility !== undefined) body.visibility = opts.visibility;
      if (opts.launchMode !== undefined) body.launch_mode = opts.launchMode;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-process-create-${randomUUID()}`;
      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(opts.machine)}/processes`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/machines/${opts.machine}/processes`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as
        OkEnvelope<{ processId: string }> & ProblemEnvelope;
      if (!res.ok) {
        return fatalProblem(
          `POST /api/sites/${opts.site}/machines/${opts.machine}/processes`,
          res.status,
          data,
        );
      }

      if (json) {
        process.stdout.write(JSON.stringify(data.data ?? {}, null, 2) + '\n');
        return;
      }

      const processId = data.data?.processId ?? '(unknown)';
      process.stdout.write(`owlette: process ${opts.name} created (processId=${processId})\n`);
    });

  // update

  proc
    .command('update <processId>')
    .description('update fields on an existing managed process (partial)')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .option('--name <name>', 'human-readable name for the process')
    .option('--exe <path>', 'absolute path to the executable')
    .option('--cwd <path>', 'working directory for the process')
    .option('--priority <priority>', 'process priority (Low|Normal|High|Realtime)')
    .option('--visibility <visibility>', 'window visibility (Normal|Hidden)')
    .option('--launch-mode <mode>', 'launch mode (off|always|scheduled)')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (processId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      // The server rejects `id` / `processId` in the body; commander already
      // filters unknown options. `--launch-mode` is guarded here for early feedback.
      if (opts.launchMode && !VALID_SCHEDULE_MODES.includes(opts.launchMode as ScheduleMode)) {
        return usageFatal(`--launch-mode must be one of ${VALID_SCHEDULE_MODES.join(', ')}`);
      }

      const body: Record<string, unknown> = {};
      if (opts.name !== undefined) body.name = opts.name;
      if (opts.exe !== undefined) body.exe_path = opts.exe;
      if (opts.cwd !== undefined) body.cwd = opts.cwd;
      if (opts.priority !== undefined) body.priority = opts.priority;
      if (opts.visibility !== undefined) body.visibility = opts.visibility;
      if (opts.launchMode !== undefined) body.launch_mode = opts.launchMode;

      if (Object.keys(body).length === 0) {
        return usageFatal('at least one field flag is required (--name, --exe, --cwd, --priority, --visibility, --launch-mode)');
      }

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-process-update-${randomUUID()}`;
      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(opts.machine)}/processes/${encodeURIComponent(processId)}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `PATCH /api/sites/${opts.site}/machines/${opts.machine}/processes/${processId}`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as
        OkEnvelope<{ processId: string }> & ProblemEnvelope;
      if (!res.ok) {
        return fatalProblem(
          `PATCH /api/sites/${opts.site}/machines/${opts.machine}/processes/${processId}`,
          res.status,
          data,
        );
      }

      if (json) {
        process.stdout.write(JSON.stringify(data.data ?? { processId }, null, 2) + '\n');
        return;
      }
      process.stdout.write(`owlette: process ${processId} updated\n`);
    });

  // delete

  proc
    .command('delete <processId>')
    .description('remove a managed process from a machine')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .option('--yes', 'skip the confirmation prompt')
    .action(async (processId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      if (!opts.yes && process.stdin.isTTY) {
        const ok = await promptYesNo(
          `delete process ${processId} from ${opts.machine}? this cannot be undone. [y/N] `,
        );
        if (!ok) {
          process.stdout.write('delete cancelled\n');
          return;
        }
      } else if (!opts.yes && !process.stdin.isTTY) {
        return usageFatal('stdin is not a tty and --yes was not supplied; refusing to delete silently');
      }

      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(opts.machine)}/processes/${encodeURIComponent(processId)}`;
      const res = await fetchWithTimeout(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as
        OkEnvelope<{ processId: string; alreadyDeleted: boolean }> & ProblemEnvelope;
      if (!res.ok) {
        return fatalProblem(
          `DELETE /api/sites/${opts.site}/machines/${opts.machine}/processes/${processId}`,
          res.status,
          data,
        );
      }

      if (json) {
        process.stdout.write(JSON.stringify(data.data ?? { processId, alreadyDeleted: false }, null, 2) + '\n');
        return;
      }

      const alreadyDeleted = data.data?.alreadyDeleted === true;
      process.stdout.write(
        alreadyDeleted
          ? `owlette: process ${processId} was already deleted (no-op)\n`
          : `owlette: process ${processId} deleted\n`,
      );
    });

  // kill / restart / start / stop (control verbs)

  registerControlVerb(proc, 'kill', 'forcibly terminate a running managed process');
  registerControlVerb(proc, 'restart', 'restart a managed process (graceful stop, then start)');
  registerControlVerb(proc, 'start', 'start a managed process');
  registerControlVerb(proc, 'stop', 'gracefully stop a managed process');

  // schedule

  proc
    .command('schedule <processId>')
    .description('configure run-mode + schedule blocks for a managed process')
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .requiredOption('--mode <mode>', 'run mode (off|always|scheduled)')
    .option(
      '--blocks <json>',
      'schedule blocks as inline json (required when --mode=scheduled)',
    )
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (processId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const mode = opts.mode;
      if (!VALID_SCHEDULE_MODES.includes(mode as ScheduleMode)) {
        return usageFatal(`--mode must be one of ${VALID_SCHEDULE_MODES.join(', ')}`);
      }

      let blocks: unknown = undefined;
      if (opts.blocks !== undefined) {
        try {
          blocks = JSON.parse(String(opts.blocks));
        } catch (err) {
          return usageFatal(
            `--blocks must be valid json: ${(err as Error).message}`,
          );
        }
        if (!Array.isArray(blocks)) {
          return usageFatal('--blocks must be a json array of schedule blocks');
        }
      }

      if (mode === 'scheduled' && (!Array.isArray(blocks) || blocks.length === 0)) {
        return usageFatal('--blocks is required and must be a non-empty json array when --mode=scheduled');
      }

      const body: Record<string, unknown> = { mode };
      if (blocks !== undefined) body.blocks = blocks;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-process-schedule-${randomUUID()}`;
      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(opts.machine)}/processes/${encodeURIComponent(processId)}/schedule`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/machines/${opts.machine}/processes/${processId}/schedule`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as
        OkEnvelope<ScheduleResponse> & ProblemEnvelope;
      if (!res.ok) {
        return fatalProblem(
          `POST /api/sites/${opts.site}/machines/${opts.machine}/processes/${processId}/schedule`,
          res.status,
          data,
        );
      }

      if (json) {
        process.stdout.write(JSON.stringify(data.data ?? { processId, mode }, null, 2) + '\n');
        return;
      }
      process.stdout.write(`owlette: process ${processId} schedule set to '${mode}'\n`);
    });
}

/* control-verb helper — kill / restart / start / stop share the shape */

function registerControlVerb(
  proc: Command,
  verb: 'kill' | 'restart' | 'start' | 'stop',
  description: string,
): void {
  proc
    .command(`${verb} <processId>`)
    .description(description)
    .requiredOption('--site <siteId>', 'site id that owns the machine')
    .requiredOption('--machine <machineId>', 'machine id that owns the process')
    .option(
      '--idempotency-key <key>',
      'optional Idempotency-Key header (auto-generated if omitted)',
    )
    .action(async (processId: string, opts, cmd) => {
      const { apiUrl, token, json } = resolveAuth(cmd);
      if (!token) return;

      const idempotencyKey = opts.idempotencyKey
        ? String(opts.idempotencyKey)
        : `cli-process-${verb}-${randomUUID()}`;
      const url = `${apiUrl}/api/sites/${encodeURIComponent(opts.site)}/machines/${encodeURIComponent(opts.machine)}/processes/${encodeURIComponent(processId)}/${verb}`;
      let res: Response;
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          // No body, but the server reads `request.text()` for idempotency key
          // hashing — sending an empty string keeps that consistent.
          body: '',
        });
      } catch (err) {
        unconfirmedMutationFatal({
          operation: `POST /api/sites/${opts.site}/machines/${opts.machine}/processes/${processId}/${verb}`,
          idempotencyKey,
          cause: err,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as
        OkEnvelope<CommandQueueResponse> & ProblemEnvelope;
      if (!res.ok) {
        return fatalProblem(
          `POST /api/sites/${opts.site}/machines/${opts.machine}/processes/${processId}/${verb}`,
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
        `owlette: ${verb} queued for process ${processId} (commandId=${commandId})\n`,
      );
    });
}

/* formatters */

function formatProcessDetail(p: ProcessSummary): string {
  const out: string[] = [];
  out.push(`processId    ${p.processId}`);
  out.push(`name         ${p.name}`);
  out.push(`exe          ${p.exe_path || '(none)'}`);
  out.push(`cwd          ${p.cwd || '(none)'}`);
  out.push(`priority     ${p.priority || 'Normal'}`);
  out.push(`visibility   ${p.visibility || 'Show'}`);
  out.push(`launch_mode  ${p.launch_mode || 'off'}`);
  out.push(`autolaunch   ${p.autolaunch ? 'yes' : 'no'}`);
  out.push(`status       ${p.status || 'unknown'}`);
  out.push(`pid          ${p.pid !== null && p.pid !== undefined ? String(p.pid) : '(none)'}`);
  out.push(`responsive   ${p.responsive ? 'yes' : 'no'}`);
  if (p.last_updated !== null && p.last_updated !== undefined) {
    out.push(`last_updated ${String(p.last_updated)}`);
  }
  return out.join('\n') + '\n';
}

/* util */

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

/** Render an RFC-7807 problem: `code` + `detail`, plus a hint for known codes. */
function fatalProblem(operation: string, status: number, env: ProblemEnvelope): void {
  const code = env.code ?? '(no code)';
  const detail = env.detail ?? JSON.stringify(env);
  const hint = hintForCode(code);
  const suffix = hint ? `\n  hint: ${hint}` : '';
  process.stderr.write(
    `owlette: ${operation} failed (${status}, code=${code}): ${detail}${suffix}\n`,
  );
  process.exitCode = 1;
}

function hintForCode(code: string): string | null {
  switch (code) {
    case 'machine_offline':
      return 'machine appears offline; check the dashboard heartbeat';
    case 'duplicate_process_name':
      return 'process names must be unique per machine';
    case 'unsupported_command_type':
      return 'supported types: reboot_machine, shutdown_machine, capture_screenshot';
    case 'scope_insufficient':
      return 'your key is missing the required scope: machine=<id>:write';
    case 'process_not_found':
      return 'no process with that id exists on this machine — check `owlette process list`';
    case 'forbidden_field':
      return '`processId` and `id` are server-managed; do not pass them';
    default:
      return null;
  }
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
export const _internals = { formatProcessDetail, hintForCode };
