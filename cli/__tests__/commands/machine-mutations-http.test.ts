/**
 * HTTP-shape tests for `owlette machine reboot | shutdown | screenshot`, driving
 * POST/GET on `/api/sites/:siteId/machines/:machineId/commands[/:commandId]`.
 *
 * Asserts: reboot/shutdown send `{type, params:{delay_seconds?, when?,
 * active_hours_override?}}` with an auto-generated Idempotency-Key, then poll
 * the outcome and print an active-hours refusal plainly; 409 machine_offline
 * surfaces the canonical hint; screenshot is queue → poll → download (the signed `screenshot_url` is
 * fetched and written to `--output` or a default name); and the poll loop bails
 * on `failed` and times out after MAX_ATTEMPTS.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { registerMachineCommands } from '../../src/commands/machine';
import { _resetConfigCache } from '../../src/config';
import { _internals as machineInternals } from '../../src/commands/machine';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerMachineCommands(program);
  return program;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchStub(
  responder: (call: FetchCall, idx: number) => { status: number; payload: unknown; bodyBytes?: Buffer },
): FetchCall[] {
  const calls: FetchCall[] = [];
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    async (url: string, init: RequestInit = {}) => {
      const call: FetchCall = { url, init };
      calls.push(call);
      const idx = calls.length - 1;
      const response = responder(call, idx);
      const status = response.status;
      const payload = response.payload;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        arrayBuffer: async () =>
          response.bodyBytes
            ? response.bodyBytes.buffer.slice(
                response.bodyBytes.byteOffset,
                response.bodyBytes.byteOffset + response.bodyBytes.byteLength,
              )
            : new ArrayBuffer(0),
      } as Response;
    },
  );
  return calls;
}

let originalFetch: typeof global.fetch;
let originalSetTimeout: typeof setTimeout;
beforeAll(() => {
  originalFetch = global.fetch;
  originalSetTimeout = global.setTimeout;
});
afterAll(() => {
  global.fetch = originalFetch;
  global.setTimeout = originalSetTimeout;
});

beforeEach(() => {
  _resetConfigCache();
  process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
  process.env.OWLETTE_API_URL = 'https://dev.test';
  process.env.OWLETTE_PROFILE = 'default';
  process.exitCode = 0;
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // Immediate scheduler, or the timeout case really waits 60s.
  (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
    _ms?: number,
    ...rest: unknown[]
  ) => {
    fn(...rest);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  process.exitCode = 0;
  jest.restoreAllMocks();
});

const MACHINE_URL = 'https://dev.test/api/sites/site-1/machines/m-1';
const COMMANDS_URL = `${MACHINE_URL}/commands`;
const ACTIVE_HOURS_REFUSAL =
  'Error: active_hours: inside active hours 08:00–17:00 (machine time); they end at 17:00';
const GUARDED_MACHINE = { id: 'm-1', osFamily: 'windows', agentVersion: '4.1.21', capabilities: { activeHoursGuard: 1 } };

/** POST queues cmd_abc; the command poll answers `poll`; the machine read answers `machine`. */
function powerStub(
  poll: { status: number; payload: unknown },
  machine: { status: number; payload: unknown } = { status: 200, payload: GUARDED_MACHINE },
): FetchCall[] {
  return installFetchStub((call) => {
    if (call.url === COMMANDS_URL) {
      return { status: 202, payload: { ok: true, data: { commandId: 'cmd_abc', status: 'pending' } } };
    }
    if (call.url === `${COMMANDS_URL}/cmd_abc`) return poll;
    if (call.url === MACHINE_URL) return machine;
    throw new Error(`unexpected fetch url ${call.url}`);
  });
}

function finished(data: Record<string, unknown>): { status: number; payload: unknown } {
  return { status: 200, payload: { ok: true, data: { commandId: 'cmd_abc', ...data } } };
}

function captureStream(stream: NodeJS.WriteStream): string[] {
  const out: string[] = [];
  (stream.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
    out.push(chunk);
    return true;
  });
  return out;
}

describe.each([
  ['reboot', 'reboot_machine'],
  ['shutdown', 'shutdown_machine'],
] as const)('owlette machine %s', (verb, commandType) => {
  it(`POSTs /commands with body {type:'${commandType}', params:{}} and an Idempotency-Key`, async () => {
    const calls = powerStub(finished({ status: 'completed' }));
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'machine', verb, 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(COMMANDS_URL);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(new RegExp(`^cli-machine-${verb}-`));
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ type: commandType, params: {} });
  });

  it('forwards --delay-seconds as params.delay_seconds', async () => {
    const calls = powerStub(finished({ status: 'completed' }));
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'machine',
        verb,
        'm-1',
        '--site',
        'site-1',
        '--delay-seconds',
        '30',
      ],
      { from: 'user' },
    );

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ type: commandType, params: { delay_seconds: 30 } });
  });

  it('surfaces 409 machine_offline with the canonical hint', async () => {
    installFetchStub(() => ({
      status: 409,
      payload: {
        type: 'about:blank',
        title: 'machine offline',
        status: 409,
        code: 'machine_offline',
        detail: 'machine m-1 is currently offline; commands cannot be queued until it reconnects',
      },
    }));
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['machine', verb, 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('code=machine_offline');
    expect(errOut).toContain('machine appears offline; check the dashboard heartbeat');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('sends --override-active-hours --reason as params.active_hours_override', async () => {
    const calls = powerStub(finished({ status: 'completed' }));
    const program = buildProgram();

    await program.parseAsync(
      ['machine', verb, 'm-1', '--site', 'site-1', '--override-active-hours', '--reason', '  hotfix for the show  '],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(COMMANDS_URL);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ type: commandType, params: { active_hours_override: { reason: 'hotfix for the show' } } });
    expect(process.exitCode).toBe(0);
  });

  it.each([
    [['--override-active-hours']],
    [['--override-active-hours', '--reason', '   ']],
    [['--reason', 'hotfix']],
  ])('refuses %j before any http', async (flags) => {
    const calls = powerStub(finished({ status: 'completed' }));
    const stderr = captureStream(process.stderr);
    const program = buildProgram();

    await program.parseAsync(['machine', verb, 'm-1', '--site', 'site-1', ...flags], { from: 'user' });

    expect(calls).toHaveLength(0);
    expect(stderr.join('')).toContain('--override-active-hours');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it('waits for the agent and says it accepted the command', async () => {
    const calls = powerStub(finished({ status: 'completed' }));
    const stdout = captureStream(process.stdout);
    const program = buildProgram();

    await program.parseAsync(['machine', verb, 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(calls.map((c) => c.url)).toEqual([COMMANDS_URL, `${COMMANDS_URL}/cmd_abc`]);
    expect(stdout.join('')).toContain(`owlette: ${verb} accepted by machine m-1 (commandId=cmd_abc)`);
    expect(process.exitCode).toBe(0);
  });

  it("puts the agent's answer on the accepted line", async () => {
    const answer = verb === 'reboot' ? 'Reboot scheduled in 60 seconds' : 'Shutdown scheduled in 60 seconds';
    powerStub(finished({ status: 'completed', result: answer }));
    const stdout = captureStream(process.stdout);
    const program = buildProgram();

    await program.parseAsync(['machine', verb, 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(stdout.join('')).toContain(`owlette: ${verb} accepted by machine m-1 (commandId=cmd_abc): ${answer}\n`);
    expect(process.exitCode).toBe(0);
  });

  it("prints the agent's active-hours refusal plainly and exits 1", async () => {
    powerStub(finished({ status: 'failed', error: ACTIVE_HOURS_REFUSAL }));
    const stderr = captureStream(process.stderr);
    const program = buildProgram();

    await program.parseAsync(['machine', verb, 'm-1', '--site', 'site-1'], { from: 'user' });

    const errOut = stderr.join('');
    expect(errOut).toContain(
      `owlette: ${verb} refused by machine m-1: inside active hours 08:00–17:00 (machine time); they end at 17:00`,
    );
    expect(errOut).not.toContain('Error: active_hours');
    expect(errOut).toContain('--override-active-hours --reason <text>');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('--json prints the refused command and exits 1', async () => {
    powerStub(finished({ status: 'failed', error: ACTIVE_HOURS_REFUSAL }));
    const stdout = captureStream(process.stdout);
    const program = buildProgram();

    await program.parseAsync(['--json', 'machine', verb, 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(JSON.parse(stdout.join(''))).toEqual({
      commandId: 'cmd_abc',
      status: 'failed',
      error: ACTIVE_HOURS_REFUSAL,
    });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('surfaces any other agent failure and exits 1', async () => {
    powerStub(finished({ status: 'failed', error: `Error: ${verb} failed: access denied` }));
    const stderr = captureStream(process.stderr);
    const program = buildProgram();

    await program.parseAsync(['machine', verb, 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(stderr.join('')).toContain(`owlette: ${verb} failed on machine m-1: Error: ${verb} failed: access denied`);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('stays queued (exit 0) when the key cannot read the outcome', async () => {
    powerStub({
      status: 403,
      payload: { status: 403, code: 'scope_insufficient', detail: 'API key is missing machine=m-1:read scope' },
    });
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const program = buildProgram();

    await program.parseAsync(['machine', verb, 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(stdout.join('')).toContain(`owlette: ${verb} queued for machine m-1 (commandId=cmd_abc)`);
    expect(stderr.join('')).toContain('machine=m-1:read');
    expect(process.exitCode).toBe(0);
  });

  it('stays queued (exit 0) when the agent does not report back in time', async () => {
    const calls = powerStub(finished({ status: 'pending' }));
    const stdout = captureStream(process.stdout);
    const program = buildProgram();

    await program.parseAsync(['machine', verb, 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(calls).toHaveLength(1 + machineInternals.COMMAND_POLL_MAX_ATTEMPTS);
    expect(stdout.join('')).toContain(`owlette: ${verb} queued for machine m-1 (commandId=cmd_abc)`);
    expect(process.exitCode).toBe(0);
  });
});

describe('owlette machine reboot --after-active-hours', () => {
  const ARGS = ['machine', 'reboot', 'm-1', '--site', 'site-1', '--after-active-hours'];

  it('checks the machine honours it, then sends params.when', async () => {
    const calls = powerStub(finished({ status: 'completed' }));
    const stdout = captureStream(process.stdout);
    const program = buildProgram();

    await program.parseAsync(ARGS, { from: 'user' });

    expect(calls[0]!.url).toBe(MACHINE_URL);
    expect(calls[1]!.url).toBe(COMMANDS_URL);
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(body).toEqual({ type: 'reboot_machine', params: { when: 'after_active_hours' } });
    expect(stdout.join('')).toContain('when its active hours end, or now if it is outside them');
    expect(process.exitCode).toBe(0);
  });

  it("says when the restart happens once the agent answers with it", async () => {
    powerStub(finished({ status: 'completed', result: 'Reboot deferred until 17:00 (machine time)' }));
    const stdout = captureStream(process.stdout);
    const program = buildProgram();

    await program.parseAsync(ARGS, { from: 'user' });

    const out = stdout.join('');
    expect(out).toContain(
      'owlette: reboot accepted by machine m-1 (commandId=cmd_abc): Reboot deferred until 17:00 (machine time)\n',
    );
    expect(out).not.toContain('or now if it is outside them');
  });

  it.each([
    ['a windows agent without the guard', { id: 'm-1', osFamily: 'windows', capabilities: { keepAwake: 1 } }],
    ['a pre-3.4 agent', { id: 'm-1', osFamily: null, capabilities: null }],
    // no active hours to wait for; the API refuses the held restart there too.
    ['macOS', { id: 'm-1', osFamily: 'macos', capabilities: null }],
    ['linux', { id: 'm-1', osFamily: 'linux', capabilities: { keepAwake: 1 } }],
    // an older agent never clears the capability its newer self wrote
    ['a machine rolled back to 3.3.7', { ...GUARDED_MACHINE, agentVersion: '3.3.7' }],
    ['a capability with no agent version', { ...GUARDED_MACHINE, agentVersion: null }],
  ])('refuses on %s, which cannot hold the restart', async (_label, machine) => {
    const calls = powerStub(finished({ status: 'completed' }), { status: 200, payload: machine });
    const stderr = captureStream(process.stderr);
    const program = buildProgram();

    await program.parseAsync(ARGS, { from: 'user' });

    expect(calls.map((c) => c.url)).toEqual([MACHINE_URL]);
    expect(stderr.join('')).toContain("machine m-1 can't hold a restart for active hours");
    expect(stderr.join('')).toContain('drop the flag to restart now');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('warns and goes ahead when the machine cannot be read', async () => {
    const calls = powerStub(finished({ status: 'completed' }), {
      status: 403,
      payload: { status: 403, code: 'scope_insufficient', detail: 'API key is missing site=site-1:read scope' },
    });
    const stderr = captureStream(process.stderr);
    const program = buildProgram();

    await program.parseAsync(ARGS, { from: 'user' });

    expect(calls[1]!.url).toBe(COMMANDS_URL);
    expect(stderr.join('')).toContain('could not check that machine m-1 honours --after-active-hours');
    // the API is the backstop, so going ahead is safe.
    expect(stderr.join('')).toContain('the API refuses it if the machine cannot hold the restart');
    expect(process.exitCode).toBe(0);
  });

  it('reports the API refusing a held restart the machine cannot hold', async () => {
    installFetchStub((call) => {
      if (call.url === MACHINE_URL) return { status: 403, payload: { status: 403, code: 'scope_insufficient' } };
      if (call.url === COMMANDS_URL) {
        return {
          status: 409,
          payload: {
            status: 409,
            code: 'held_restart_unsupported',
            detail: "this machine's agent can't hold a restart for active hours",
          },
        };
      }
      throw new Error(`unexpected fetch url ${call.url}`);
    });
    const stderr = captureStream(process.stderr);
    const program = buildProgram();

    await program.parseAsync(ARGS, { from: 'user' });

    expect(stderr.join('')).toContain('held_restart_unsupported');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('cannot be combined with --override-active-hours', async () => {
    const calls = powerStub(finished({ status: 'completed' }));
    const program = buildProgram();

    await program.parseAsync([...ARGS, '--override-active-hours', '--reason', 'hotfix'], { from: 'user' });

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it('the refusal hint offers it on reboot', async () => {
    powerStub(finished({ status: 'failed', error: ACTIVE_HOURS_REFUSAL }));
    const stderr = captureStream(process.stderr);
    const program = buildProgram();

    await program.parseAsync(['machine', 'reboot', 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(stderr.join('')).toContain('--after-active-hours');
    process.exitCode = 0;
  });

  it('is not an option on shutdown', async () => {
    const calls = powerStub(finished({ status: 'completed' }));
    const program = buildProgram();

    await expect(
      program.parseAsync(['machine', 'shutdown', 'm-1', '--site', 'site-1', '--after-active-hours'], {
        from: 'user',
      }),
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
    expect(calls).toHaveLength(0);
  });
});

describe('owlette machine screenshot', () => {
  it('queues the command, polls, downloads to --output, prints saved path', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'owlette-screenshot-'));
    const outPath = path.join(tmpDir, 'shot.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const signedUrl = 'https://signed.test/shot.png?token=abc';

    const calls = installFetchStub((call) => {
      // POST queue
      if (call.url === COMMANDS_URL) {
        return {
          status: 202,
          payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
        };
      }
      // GET poll
      if (call.url.endsWith('/commands/cmd_xyz')) {
        return {
          status: 200,
          payload: {
            ok: true,
            data: {
              commandId: 'cmd_xyz',
              status: 'completed',
              result: { screenshot_url: signedUrl },
            },
          },
        };
      }
      // GET signed url → png bytes
      if (call.url === signedUrl) {
        return { status: 200, payload: {}, bodyBytes: pngBytes };
      }
      throw new Error(`unexpected fetch url ${call.url}`);
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'machine',
        'screenshot',
        'm-1',
        '--site',
        'site-1',
        '--monitor',
        '1',
        '--output',
        outPath,
      ],
      { from: 'user' },
    );

    // POST queue, GET poll, GET signed.
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(COMMANDS_URL);
    expect(calls[0]!.init.method).toBe('POST');
    const queueBody = JSON.parse(String(calls[0]!.init.body));
    expect(queueBody).toEqual({
      type: 'capture_screenshot',
      params: { monitor: 1 },
    });
    expect(calls[1]!.url).toBe(`${COMMANDS_URL}/cmd_xyz`);
    expect((calls[1]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(calls[2]!.url).toBe(signedUrl);

    const written = await fsp.readFile(outPath);
    expect(written.equals(pngBytes)).toBe(true);

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses --monitor as integer index when numeric', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'owlette-screenshot-'));
    const outPath = path.join(tmpDir, 'shot.png');
    const pngBytes = Buffer.from([0x89]);
    const signedUrl = 'https://signed.test/x.png';

    const calls = installFetchStub((call) => {
      if (call.url === COMMANDS_URL) {
        return {
          status: 202,
          payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
        };
      }
      if (call.url.endsWith('/commands/cmd_xyz')) {
        return {
          status: 200,
          payload: {
            ok: true,
            data: {
              commandId: 'cmd_xyz',
              status: 'completed',
              result: { screenshot_url: signedUrl },
            },
          },
        };
      }
      if (call.url === signedUrl) {
        return { status: 200, payload: {}, bodyBytes: pngBytes };
      }
      throw new Error(`unexpected fetch url ${call.url}`);
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'machine',
        'screenshot',
        'm-1',
        '--site',
        'site-1',
        '--monitor',
        '2',
        '--output',
        outPath,
      ],
      { from: 'user' },
    );

    const queueBody = JSON.parse(String(calls[0]!.init.body));
    expect(queueBody).toEqual({
      type: 'capture_screenshot',
      params: { monitor: 2 },
    });

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses the default filename in cwd when --output is omitted', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'owlette-screenshot-cwd-'));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const pngBytes = Buffer.from([0x89, 0x50]);
      const signedUrl = 'https://signed.test/default.png';

      installFetchStub((call) => {
        if (call.url === COMMANDS_URL) {
          return {
            status: 202,
            payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
          };
        }
        if (call.url.endsWith('/commands/cmd_xyz')) {
          return {
            status: 200,
            payload: {
              ok: true,
              data: {
                commandId: 'cmd_xyz',
                status: 'completed',
                result: { screenshot_url: signedUrl },
              },
            },
          };
        }
        if (call.url === signedUrl) {
          return { status: 200, payload: {}, bodyBytes: pngBytes };
        }
        throw new Error(`unexpected fetch url ${call.url}`);
      });
      const program = buildProgram();

      await program.parseAsync(
        ['--json', 'machine', 'screenshot', 'm-1', '--site', 'site-1'],
        { from: 'user' },
      );

      // Default filename: `screenshot-<machineId>-<ts>.png`.
      const written = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('screenshot-m-1-') && f.endsWith('.png'));
      expect(written.length).toBe(1);
    } finally {
      process.chdir(originalCwd);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('surfaces a useful error and exits 1 when the agent fails the capture', async () => {
    installFetchStub((call) => {
      if (call.url === COMMANDS_URL) {
        return {
          status: 202,
          payload: { ok: true, data: { commandId: 'cmd_fail', status: 'pending' } },
        };
      }
      return {
        status: 200,
        payload: {
          ok: true,
          data: { commandId: 'cmd_fail', status: 'failed', error: 'no display attached' },
        },
      };
    });
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['machine', 'screenshot', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('screenshot capture failed on the agent');
    expect(errOut).toContain('no display attached');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('surfaces screenshot read+write scope hint on scope_insufficient', async () => {
    installFetchStub(() => ({
      status: 403,
      payload: {
        type: 'about:blank',
        title: 'scope_insufficient',
        status: 403,
        code: 'scope_insufficient',
        detail: 'API key is missing machine=m-1:write scope',
      },
    }));
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['machine', 'screenshot', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('code=scope_insufficient');
    expect(errOut).toContain('screenshot requires both machine=<id>:write and machine=<id>:read scopes');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('times out and exits 1 after MAX_ATTEMPTS poll attempts of pending status', async () => {
    const calls = installFetchStub((call, idx) => {
      if (idx === 0) {
        // POST queue
        return {
          status: 202,
          payload: { ok: true, data: { commandId: 'cmd_slow', status: 'pending' } },
        };
      }
      // Every poll returns pending forever.
      return {
        status: 200,
        payload: { ok: true, data: { commandId: 'cmd_slow', status: 'pending' } },
      };
    });
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['machine', 'screenshot', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    // 1 POST + MAX_ATTEMPTS polls.
    expect(calls.length).toBe(1 + machineInternals.COMMAND_POLL_MAX_ATTEMPTS);
    const errOut = stderr.join('');
    expect(errOut).toContain('screenshot timed out');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects an invalid --monitor value before issuing http', async () => {
    const calls = installFetchStub(() => ({
      status: 202,
      payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
    }));
    const program = buildProgram();

    await program.parseAsync(
      [
        'machine',
        'screenshot',
        'm-1',
        '--site',
        'site-1',
        '--monitor',
        'banana',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });

  it('rejects named --monitor values before issuing http', async () => {
    const calls = installFetchStub(() => ({
      status: 202,
      payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
    }));
    const program = buildProgram();

    await program.parseAsync(
      [
        'machine',
        'screenshot',
        'm-1',
        '--site',
        'site-1',
        '--monitor',
        'primary',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });
});

describe('machine helpers', () => {
  it('parseMonitorOpt accepts non-negative integers and rejects named values', () => {
    expect(String(machineInternals.parseMonitorOpt('all'))).toMatch(/^error:/);
    expect(String(machineInternals.parseMonitorOpt('primary'))).toMatch(/^error:/);
    expect(machineInternals.parseMonitorOpt('0')).toBe(0);
    expect(machineInternals.parseMonitorOpt('3')).toBe(3);
    expect(String(machineInternals.parseMonitorOpt('-1'))).toMatch(/^error:/);
    expect(String(machineInternals.parseMonitorOpt('1.5'))).toMatch(/^error:/);
    expect(String(machineInternals.parseMonitorOpt('hello'))).toMatch(/^error:/);
  });

  it('defaultScreenshotFilename strips path-illegal chars and ends with .png', () => {
    const f = machineInternals.defaultScreenshotFilename('weird:id*');
    expect(f.startsWith('screenshot-weird_id_-')).toBe(true);
    expect(f.endsWith('.png')).toBe(true);
  });
});
