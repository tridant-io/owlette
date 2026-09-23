/**
 * HTTP-shape tests for `owlette swoop <machineId>`.
 *
 * The contract under test is as much about what the command does NOT do: one
 * read of the machine record, then a url. No session POST, no viewer token.
 */

import { Command } from 'commander';
import { registerSwoopCommand } from '../../src/commands/swoop';
import { _resetConfigCache } from '../../src/config';

const openBrowserMock = jest.fn();
jest.mock('../../src/lib/openBrowser', () => ({
  openBrowser: (url: string) => openBrowserMock(url),
}));

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerSwoopCommand(program);
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

const API_URL = 'https://dev.test';
const MACHINE = {
  id: 'm-1',
  siteId: 'site-1',
  name: 'kiosk-1',
  online: true,
  capabilities: { swoop: 1 },
};

let originalFetch: typeof global.fetch;
let stdout: string[];
let stderr: string[];

beforeAll(() => {
  originalFetch = global.fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  _resetConfigCache();
  openBrowserMock.mockClear();
  process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
  process.env.OWLETTE_API_URL = API_URL;
  process.env.OWLETTE_PROFILE = 'default';
  process.exitCode = undefined;
  stdout = [];
  stderr = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  });
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  });
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  process.exitCode = undefined;
  jest.restoreAllMocks();
});

describe('owlette swoop', () => {
  it('reads the machine once with Bearer auth, then prints and opens the viewer url', async () => {
    const calls = installFetchStub(MACHINE);

    await buildProgram().parseAsync(['swoop', 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_URL}/api/sites/site-1/machines/m-1`);
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer owk_live_testtoken',
    );
    expect(stdout.join('')).toBe(`${API_URL}/swoop/site-1/m-1\n`);
    expect(openBrowserMock).toHaveBeenCalledWith(`${API_URL}/swoop/site-1/m-1`);
    expect(process.exitCode).toBeUndefined();
  });

  it('never posts a session and never asks for a viewer token', async () => {
    const calls = installFetchStub(MACHINE);

    await buildProgram().parseAsync(['swoop', 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(calls.every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
    expect(calls.some((c) => c.url.includes('/swoop/sessions'))).toBe(false);
    expect(stdout.join('') + stderr.join('')).not.toMatch(/viewerJwt|viewerToken/);
  });

  it('--no-open prints the url without opening a browser', async () => {
    installFetchStub(MACHINE);

    await buildProgram().parseAsync(['swoop', 'm-1', '--site', 'site-1', '--no-open'], {
      from: 'user',
    });

    expect(stdout.join('')).toBe(`${API_URL}/swoop/site-1/m-1\n`);
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('--json emits the url envelope on stdout and no notes', async () => {
    installFetchStub(MACHINE);

    await buildProgram().parseAsync(['--json', 'swoop', 'm-1', '--site', 'site-1'], {
      from: 'user',
    });

    expect(JSON.parse(stdout.join(''))).toEqual({
      siteId: 'site-1',
      machineId: 'm-1',
      url: `${API_URL}/swoop/site-1/m-1`,
      opened: true,
    });
    expect(stderr.join('')).toBe('');
  });

  it('refuses a machine whose agent reports no swoop capability', async () => {
    installFetchStub({ ...MACHINE, capabilities: { swoop: 0 } });

    await buildProgram().parseAsync(['swoop', 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('does not report the swoop capability');
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('notes an unreported capability but still hands over the url', async () => {
    installFetchStub({ id: 'm-1', name: 'kiosk-1', online: true });

    await buildProgram().parseAsync(['swoop', 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(process.exitCode).toBeUndefined();
    expect(stderr.join('')).toContain('does not report machine capabilities');
    expect(openBrowserMock).toHaveBeenCalledWith(`${API_URL}/swoop/site-1/m-1`);
  });

  it('surfaces a non-2xx machine read and opens nothing', async () => {
    installFetchStub({ detail: 'machine m-1 not found on site site-1' }, 404);

    await buildProgram().parseAsync(['swoop', 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('failed (404)');
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('exits 2 with no token configured', async () => {
    delete process.env.OWLETTE_TOKEN;
    _resetConfigCache();
    const calls = installFetchStub(MACHINE);

    await buildProgram().parseAsync(['swoop', 'm-1', '--site', 'site-1'], { from: 'user' });

    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
    expect(openBrowserMock).not.toHaveBeenCalled();
  });
});
