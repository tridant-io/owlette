/**
 * HTTP-shape tests for `owlette deploy {create,list,get,retry,cancel,uninstall,delete}` — the
 * CLASSIC installer-deploy noun, not `owlette roost deploy` (see deploy-http.test.ts).
 *
 * Drives src/commands/deploy.ts with a per-test `global.fetch` stub; asserts url, method, headers
 * (Bearer + auto Idempotency-Key on mutations), body shape and response parsing.
 */

import { Command } from 'commander';
import { registerDeployCommands } from '../../src/commands/deploy';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerDeployCommands(program);
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
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  process.exitCode = 0;
  jest.restoreAllMocks();
});

/* create */

describe('owlette deploy create', () => {
  it('POSTs /api/sites/:siteId/deployments with the right body + auto Idempotency-Key', async () => {
    const calls = installFetchStub(
      {
        deploymentId: 'deploy-1',
        siteId: 'site-1',
        status: 'in_progress',
        targets: [{ machineId: 'm-1', status: 'pending' }],
      },
      201,
    );
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'deploy',
        'create',
        '--site',
        'site-1',
        '--name',
        'rollout-may',
        '--installer-url',
        'https://cdn.example/Owlette-Installer-v2.10.0.exe',
        '--installer-name',
        'Owlette-Installer-v2.10.0.exe',
        '--silent-flags',
        '/S',
        '--machines',
        'm-1,m-2',
        '--verify-path',
        'C:/ProgramData/Owlette',
        '--close-processes',
        'TouchDesigner.exe, chrome.exe',
        '--suppress-projects',
        'show-a, C:/Shows/show-b',
        '--parallel',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/deployments');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toMatch(/^cli-deploy-create-/);
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      name: 'rollout-may',
      installer_name: 'Owlette-Installer-v2.10.0.exe',
      installer_url: 'https://cdn.example/Owlette-Installer-v2.10.0.exe',
      silent_flags: '/S',
      machines: ['m-1', 'm-2'],
      verify_path: 'C:/ProgramData/Owlette',
      close_processes: ['TouchDesigner.exe', 'chrome.exe'],
      suppress_projects: ['show-a', 'C:/Shows/show-b'],
      parallel_install: true,
    });
  });

  it('respects an explicit --idempotency-key', async () => {
    const calls = installFetchStub(
      {
        deploymentId: 'deploy-2',
        siteId: 'site-1',
        status: 'in_progress',
        targets: [],
      },
      201,
    );
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'deploy',
        'create',
        '--site',
        'site-1',
        '--name',
        'r',
        '--installer-url',
        'https://cdn/x.exe',
        '--installer-name',
        'x.exe',
        '--silent-flags',
        '/S',
        '--machines',
        'm-1',
        '--idempotency-key',
        'caller-pinned-key',
      ],
      { from: 'user' },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('caller-pinned-key');
  });

  it('surfaces 413 over_quota with the quota numbers + a hint', async () => {
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    installFetchStub(
      {
        code: 'over_quota',
        detail: 'too many targets',
        quota: { max_targets: 100, requested: 250 },
      },
      413,
    );
    const program = buildProgram();
    await program.parseAsync(
      [
        'deploy',
        'create',
        '--site',
        'site-1',
        '--name',
        'r',
        '--installer-url',
        'https://cdn/x.exe',
        '--installer-name',
        'x.exe',
        '--silent-flags',
        '/S',
        '--machines',
        'm-1',
      ],
      { from: 'user' },
    );
    const out = stderr.join('');
    expect(out).toContain('over_quota');
    expect(out).toContain('max_targets=100');
    expect(out).toContain('requested=250');
    expect(out).toContain('hint:');
    expect(process.exitCode).toBe(1);
  });

  it('rejects an empty --machines list before hitting the network', async () => {
    const calls = installFetchStub({}, 200);
    const program = buildProgram();
    await program.parseAsync(
      [
        'deploy',
        'create',
        '--site',
        'site-1',
        '--name',
        'r',
        '--installer-url',
        'https://cdn/x.exe',
        '--installer-name',
        'x.exe',
        '--silent-flags',
        '/S',
        '--machines',
        ', , ,',
      ],
      { from: 'user' },
    );
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });

  it('surfaces the idempotency key and retry command on unconfirmed failure', async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      throw new Error('request timed out after 30000ms');
    });
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    const program = buildProgram();
    await program.parseAsync(
      [
        'deploy',
        'create',
        '--site',
        'site-1',
        '--name',
        'r',
        '--installer-url',
        'https://cdn/x.exe',
        '--installer-name',
        'x.exe',
        '--silent-flags',
        '/S',
        '--machines',
        'm-1',
      ],
      { from: 'user' },
    );
    const out = stderr.join('');
    expect(out).toContain('did not return a confirmed response');
    expect(out).toContain('Idempotency-Key: cli-deploy-create-');
    expect(out).toContain('re-run your original command with `--idempotency-key cli-deploy-create-');
    expect(out).not.toContain('owlette deploy create');
    expect(process.exitCode).toBe(1);
  });
});

/* list */

describe('owlette deploy list', () => {
  it('GETs /api/sites/:siteId/deployments with no query when no flags given', async () => {
    const calls = installFetchStub({ items: [], next_page_token: '' });
    const program = buildProgram();
    await program.parseAsync(['--json', 'deploy', 'list', '--site', 'site-1'], { from: 'user' });
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/deployments');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('passes --limit and --cursor through as page_size + page_token', async () => {
    const calls = installFetchStub({ items: [], next_page_token: '' });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'deploy', 'list', '--site', 'site-1', '--limit', '50', '--cursor', 'deploy-x'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/sites/site-1/deployments?page_size=50&page_token=deploy-x',
    );
  });

  it('emits the raw server response in --json mode', async () => {
    const stdout: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stdout.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    installFetchStub({
      items: [
        {
          id: 'deploy-1',
          name: 'd1',
          status: 'completed',
          targets: [],
          installer_name: 'x.exe',
          installer_url: 'https://cdn/x.exe',
          silent_flags: '/S',
          verify_path: null,
          sha256_checksum: null,
          parallel_install: false,
          createdAt: '2026-01-01T00:00:00Z',
          completedAt: null,
          updatedAt: null,
        },
      ],
      next_page_token: 'deploy-2',
    });
    const program = buildProgram();
    await program.parseAsync(['--json', 'deploy', 'list', '--site', 'site-1'], { from: 'user' });
    const parsed = JSON.parse(stdout.join('')) as { items: unknown[]; next_page_token: string };
    expect(parsed.items).toHaveLength(1);
    expect(parsed.next_page_token).toBe('deploy-2');
  });
});

/* get */

describe('owlette deploy get', () => {
  it('GETs /api/sites/:siteId/deployments/:id with Bearer auth', async () => {
    const calls = installFetchStub({
      id: 'deploy-1',
      siteId: 'site-1',
      name: 'd1',
      status: 'completed',
      targets: [{ machineId: 'm-1', status: 'completed' }],
      installer_name: 'x.exe',
      installer_url: 'https://cdn/x.exe',
      silent_flags: '/S',
      verify_path: null,
      sha256_checksum: null,
      parallel_install: false,
      createdAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      updatedAt: null,
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'deploy', 'get', 'deploy-1', '--site', 'site-1'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/deployments/deploy-1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('surfaces a 404 with code on stderr', async () => {
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    installFetchStub(
      { detail: 'deployment deploy-x not found on site site-1' },
      404,
    );
    const program = buildProgram();
    await program.parseAsync(['deploy', 'get', 'deploy-x', '--site', 'site-1'], { from: 'user' });
    const out = stderr.join('');
    expect(out).toContain('failed (404');
    expect(out).toContain('not found');
    expect(process.exitCode).toBe(1);
  });
});

/* retry */

describe('owlette deploy retry', () => {
  it('POSTs /api/sites/:siteId/deployments/:id/retry with auto idempotency key', async () => {
    const calls = installFetchStub({
      deploymentId: 'deploy-1',
      siteId: 'site-1',
      status: 'in_progress',
      retried: 2,
      machine_ids: ['m-1', 'm-2'],
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'deploy', 'retry', 'deploy-1', '--site', 'site-1'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/deployments/deploy-1/retry');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-deploy-retry-/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });
});

/* active-hours override on create and retry */

describe.each([
  [
    'create',
    [
      'deploy', 'create', '--site', 'site-1', '--name', 'r',
      '--installer-url', 'https://cdn/x.exe', '--installer-name', 'x.exe',
      '--silent-flags', '/S', '--machines', 'm-1',
    ],
  ],
  ['retry', ['deploy', 'retry', 'deploy-1', '--site', 'site-1']],
])('owlette deploy %s --override-active-hours', (_verb, args) => {
  it('sends --reason, trimmed, as active_hours_override', async () => {
    const calls = installFetchStub({
      deploymentId: 'deploy-1',
      siteId: 'site-1',
      status: 'in_progress',
      targets: [],
    });
    await buildProgram().parseAsync(
      [...args, '--override-active-hours', '--reason', '  venue closed today  '],
      { from: 'user' },
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.active_hours_override).toEqual({ reason: 'venue closed today' });
    expect(process.exitCode).toBe(0);
  });

  it.each([
    [['--override-active-hours']],
    [['--override-active-hours', '--reason', '   ']],
    [['--reason', 'venue closed today']],
  ])('refuses %j before any http', async (flags) => {
    const calls = installFetchStub({});
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    await buildProgram().parseAsync([...args, ...flags], { from: 'user' });
    expect(calls).toHaveLength(0);
    expect(stderr.join('')).toContain('--override-active-hours');
    expect(process.exitCode).toBe(2);
  });
});

/* cancel */

describe('owlette deploy cancel', () => {
  it('POSTs /api/sites/:siteId/deployments/:id/cancel when --yes is supplied', async () => {
    const calls = installFetchStub({
      deploymentId: 'deploy-1',
      siteId: 'site-1',
      status: 'cancelled',
      cancelled: 1,
      machine_ids: ['m-1'],
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'deploy', 'cancel', 'deploy-1', '--site', 'site-1', '--yes'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/deployments/deploy-1/cancel');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-deploy-cancel-/);
  });
});

/* uninstall */

describe('owlette deploy uninstall', () => {
  it('POSTs /api/sites/:siteId/deployments/:id/uninstall when --yes is supplied', async () => {
    const calls = installFetchStub({
      deploymentId: 'deploy-1',
      siteId: 'site-1',
      status: 'uninstalling',
      queued: 3,
      machine_ids: ['m-1', 'm-2', 'm-3'],
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'deploy', 'uninstall', 'deploy-1', '--site', 'site-1', '--yes'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/sites/site-1/deployments/deploy-1/uninstall',
    );
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-deploy-uninstall-/);
  });

  it('surfaces 403 scope_insufficient with an admin-scope hint', async () => {
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    installFetchStub(
      { code: 'scope_insufficient', detail: 'requires site=site-1:admin' },
      403,
    );
    const program = buildProgram();
    await program.parseAsync(
      ['deploy', 'uninstall', 'deploy-1', '--site', 'site-1', '--yes'],
      { from: 'user' },
    );
    const out = stderr.join('');
    expect(out).toContain('scope_insufficient');
    expect(out).toContain('site=site-1:admin');
    expect(out).toContain('hint:');
    expect(process.exitCode).toBe(1);
  });

  it('refuses to run silently without --yes when stdin is not a tty', async () => {
    const calls = installFetchStub({}, 200);
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      const program = buildProgram();
      await program.parseAsync(['deploy', 'uninstall', 'deploy-1', '--site', 'site-1'], {
        from: 'user',
      });
      expect(calls).toHaveLength(0);
      expect(process.exitCode).toBe(2);
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY);
    }
  });
});

/* delete */

describe('owlette deploy delete', () => {
  it('DELETEs /api/sites/:siteId/deployments/:id when --yes is supplied', async () => {
    const calls = installFetchStub({
      deploymentId: 'deploy-1',
      siteId: 'site-1',
      deleted: true,
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'deploy', 'delete', 'deploy-1', '--site', 'site-1', '--yes'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/deployments/deploy-1');
    expect(calls[0]!.init.method).toBe('DELETE');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-deploy-delete-/);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });

  it('refuses to run silently without --yes when stdin is not a tty', async () => {
    const calls = installFetchStub({}, 200);
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      const program = buildProgram();
      await program.parseAsync(['deploy', 'delete', 'deploy-1', '--site', 'site-1'], {
        from: 'user',
      });
      expect(calls).toHaveLength(0);
      expect(process.exitCode).toBe(2);
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY);
    }
  });
});
