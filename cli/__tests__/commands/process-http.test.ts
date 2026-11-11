/**
 * HTTP-shape tests for `owlette process …` — every verb of the scoped process
 * api. Beyond url + method, these assert:
 *   - mutations send `Idempotency-Key: cli-process-<verb>-<uuid>`
 *   - --json round-trips the server `data` field byte-identical
 *   - `duplicate_process_name` 409 / `scope_insufficient` 403 surface their
 *     stable code + hint
 *   - `schedule` validates --mode and --blocks json (scheduled mode needs
 *     non-empty blocks) and forwards the parsed blocks as-is
 *   - `delete` honors `--yes` and refuses without it on a non-tty
 */

import { Command } from 'commander';
import { registerProcessCommands } from '../../src/commands/process';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerProcessCommands(program);
  return program;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchStub(payload: unknown, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as Response;
    },
  );
  return calls;
}

let originalFetch: typeof global.fetch;
beforeAll(() => {
  originalFetch = global.fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  _resetConfigCache();
  process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
  process.env.OWLETTE_API_URL = 'https://dev.test';
  process.env.OWLETTE_PROFILE = 'default';
  process.exitCode = 0;
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // `process delete` without --yes on a non-tty must bail; the --yes path has
  // its own test.
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  process.exitCode = 0;
  jest.restoreAllMocks();
});

const URL_PREFIX = 'https://dev.test/api/sites/site-1/machines/m-1/processes';

describe('owlette process list', () => {
  it('GETs the processes list with Bearer auth', async () => {
    const calls = installFetchStub({ ok: true, data: { processes: [], nextPageToken: null } });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'process', 'list', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_PREFIX);
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('emits the unwrapped data envelope in --json mode', async () => {
    const data = {
      processes: [
        {
          processId: 'proc_abc',
          name: 'td',
          launch_mode: 'always',
          status: 'running',
          pid: 1234,
        },
      ],
      nextPageToken: null,
    };
    installFetchStub({ ok: true, data });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'process', 'list', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(JSON.parse(writes.join(''))).toEqual(data);
  });
});

describe('owlette process get', () => {
  it('GETs /processes/:processId and renders detail (human mode)', async () => {
    const calls = installFetchStub({
      ok: true,
      data: {
        processId: 'proc_abc',
        name: 'td',
        exe_path: 'C:/td.exe',
        cwd: 'C:/work',
        priority: 'Normal',
        visibility: 'Show',
        launch_mode: 'always',
        autolaunch: true,
        status: 'running',
        pid: 1234,
        responsive: true,
        schedule: null,
        schedules: null,
        last_updated: '2026-04-25T12:00:00Z',
      },
    });
    const program = buildProgram();

    await program.parseAsync(
      ['process', 'get', 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc`);
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
  });
});

describe('owlette process create', () => {
  it('POSTs body {name,exe_path,...} with idempotency key', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_new' } }, 201);
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'process',
        'create',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--name',
        'td',
        '--exe',
        'C:/td.exe',
        '--cwd',
        'C:/work',
        '--launch-mode',
        'always',
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(URL_PREFIX);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-process-create-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      name: 'td',
      exe_path: 'C:/td.exe',
      cwd: 'C:/work',
      launch_mode: 'always',
    });
  });

  it('surfaces the duplicate_process_name 409 with the canonical hint', async () => {
    installFetchStub(
      {
        type: 'about:blank',
        title: 'duplicate_process_name',
        status: 409,
        code: 'duplicate_process_name',
        detail: 'Process named `td` already exists on m-1',
      },
      409,
    );
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'create',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--name',
        'td',
        '--exe',
        'C:/td.exe',
      ],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('code=duplicate_process_name');
    expect(errOut).toContain('process names must be unique per machine');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects --launch-mode that is not in the allowlist before issuing http', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'x' } });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'create',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--name',
        'td',
        '--exe',
        'C:/td.exe',
        '--launch-mode',
        'banana',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });
});

describe('owlette process update', () => {
  it('PATCHes only fields the user passed (live-update of name + visibility)', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_abc' } });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'process',
        'update',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--name',
        'td-renamed',
        '--visibility',
        'minimized',
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc`);
    expect(calls[0]!.init.method).toBe('PATCH');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-process-update-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ name: 'td-renamed', visibility: 'minimized' });
  });

  it('refuses an empty patch (no fields → exit 1, no http)', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_abc' } });
    const program = buildProgram();

    await program.parseAsync(
      ['process', 'update', 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });
});

describe.each(['create', 'update'])('owlette process %s --help', (verb) => {
  it('lists the priority and visibility values the agent matches, case and all', () => {
    const proc = buildProgram().commands.find((c) => c.name() === 'process')!;
    const help = proc.commands.find((c) => c.name() === verb)!.helpInformation();

    expect(help).toContain('Low|Normal|High|Realtime');
    expect(help).toContain('Normal|Hidden');
  });
});

describe('owlette process delete', () => {
  it('DELETEs and prints the alreadyDeleted=true no-op message', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { processId: 'proc_abc', alreadyDeleted: true },
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'delete',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--yes',
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc`);
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('refuses to run without --yes when stdin is not a tty', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_abc', alreadyDeleted: false } });
    // jest's stdin is not a tty, so the cli must bail before fetching.
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    const program = buildProgram();

    await program.parseAsync(
      ['process', 'delete', 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });
});

describe.each([
  ['kill', 'kill_process'],
  ['restart', 'restart_process'],
  ['start', 'start_process'],
  ['stop', 'stop_process'],
] as const)('owlette process %s', (verb, _commandType) => {
  it(`POSTs /processes/:processId/${verb} with idempotency key`, async () => {
    const calls = installFetchStub(
      { ok: true, data: { commandId: 'cmd-123', status: 'pending' } },
      202,
    );
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'process', verb, 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc/${verb}`);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(new RegExp(`^cli-process-${verb}-`));
  });

  it(`auto-generates a unique idempotency key per ${verb} request (replay safety)`, async () => {
    const calls = installFetchStub(
      { ok: true, data: { commandId: 'cmd-123', status: 'pending' } },
      202,
    );
    const program1 = buildProgram();
    const program2 = buildProgram();

    await program1.parseAsync(
      ['--json', 'process', verb, 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );
    await program2.parseAsync(
      ['--json', 'process', verb, 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    const k1 = (calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']!;
    const k2 = (calls[1]!.init.headers as Record<string, string>)['Idempotency-Key']!;
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(new RegExp(`^cli-process-${verb}-`));
    expect(k2).toMatch(new RegExp(`^cli-process-${verb}-`));
  });

  it(`surfaces the idempotency key and append-only retry guidance when ${verb} is unconfirmed`, async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      throw new Error('socket hang up');
    });
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        verb,
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--idempotency-key',
        'pinned-process-key',
      ],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('did not return a confirmed response');
    expect(errOut).toContain('Idempotency-Key: pinned-process-key');
    expect(errOut).toContain(
      're-run your original command with `--idempotency-key pinned-process-key` appended',
    );
    expect(errOut).not.toContain(`owlette process ${verb} proc_abc`);
    expect(process.exitCode).toBe(1);
  });
});

describe('owlette process schedule', () => {
  it('POSTs /schedule with mode + parsed blocks (mode=scheduled)', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { processId: 'proc_abc', mode: 'scheduled' },
    });
    const program = buildProgram();
    const blocks = [
      { days: ['mon', 'tue'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ];

    await program.parseAsync(
      [
        '--json',
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'scheduled',
        '--blocks',
        JSON.stringify(blocks),
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc/schedule`);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-process-schedule-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ mode: 'scheduled', blocks });
  });

  it('lets mode=always omit --blocks (live-update with no schedule body)', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { processId: 'proc_abc', mode: 'always' },
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'always',
      ],
      { from: 'user' },
    );

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ mode: 'always' });
  });

  it('rejects mode=scheduled without --blocks before issuing http', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_abc', mode: 'scheduled' } });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'scheduled',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });

  it('rejects an invalid --mode value before issuing http', async () => {
    const calls = installFetchStub({ ok: true, data: {} });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'banana',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });

  it('rejects --blocks that is not valid json before issuing http', async () => {
    const calls = installFetchStub({ ok: true, data: {} });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'scheduled',
        '--blocks',
        'not-json',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });
});

describe('scope_insufficient surfacing', () => {
  it('renders the missing-scope hint when the server returns 403/scope_insufficient', async () => {
    installFetchStub(
      {
        type: 'about:blank',
        title: 'scope_insufficient',
        status: 403,
        code: 'scope_insufficient',
        detail: 'API key is missing machine=m-1:write scope',
      },
      403,
    );
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['process', 'kill', 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('code=scope_insufficient');
    expect(errOut).toContain('your key is missing the required scope: machine=<id>:write');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
