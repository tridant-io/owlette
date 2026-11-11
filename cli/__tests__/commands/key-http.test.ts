/**
 * `owlette key list` table rendering.
 */

import { Command } from 'commander';
import { registerKeyCommand } from '../../src/commands/key';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerKeyCommand(program);
  return program;
}

function installFetchStub(payload: unknown): void {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => payload,
      }) as Response,
  );
}

let originalFetch: typeof global.fetch;
beforeAll(() => {
  originalFetch = global.fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

let stdout: string[];
beforeEach(() => {
  _resetConfigCache();
  process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
  process.env.OWLETTE_API_URL = 'https://dev.test';
  process.env.OWLETTE_PROFILE = 'default';
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  process.exitCode = 0;
  jest.restoreAllMocks();
});

describe('owlette key list', () => {
  it('renders the raw firestore timestamps the account route returns', async () => {
    installFetchStub({
      success: true,
      keys: [
        {
          id: 'k_1',
          name: 'ci',
          keyPrefix: 'owk_live_abcdef',
          scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
          createdAt: { _seconds: 1793750400, _nanoseconds: 0 },
          lastUsedAt: null,
          expiresAt: 1801526400000,
        },
      ],
    });

    await buildProgram().parseAsync(['key', 'list'], { from: 'user' });

    const out = stdout.join('');
    expect(out).toContain('2026-11-04');
    expect(out).toContain('2027-02-02');
  });

  it('prints a dash for a value that is not a date', async () => {
    installFetchStub({
      success: true,
      keys: [
        {
          id: 'k_2',
          name: 'odd',
          keyPrefix: 'owk_live_ghijkl',
          scopes: null,
          createdAt: { _methodName: 'serverTimestamp' },
          lastUsedAt: 'not a date',
          expiresAt: null,
        },
      ],
    });

    await buildProgram().parseAsync(['key', 'list'], { from: 'user' });

    const row = stdout.join('').split('\n').find((line) => line.startsWith('k_2'));
    expect(row).toBeDefined();
    expect(row!.match(/—/g)).toHaveLength(3);
  });
});
