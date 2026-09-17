/**
 * Stub-command coverage. `machine live-view` is the CLI's last deferred stub
 * (out of MVP until remote desktop ships as swoop); every other verb is
 * now a real http handler covered by its own `*-http.test.ts`.
 *
 * Asserts exit code 3, human-mode stderr carrying the dashboard url +
 * future-plan path + verb name, and the `--json` envelope
 * `{ ok, stub, noun, reason, dashboard_url, future_plan }` — snake_case per
 * docs/cli/overview.md#json-envelope-schema.
 *
 * `process.exit` is mocked to throw a sentinel so the synchronous exit(3) in
 * `stubExit` is observable without killing the jest worker.
 */

import { Command } from 'commander';
import { registerMachineCommands } from '../../src/commands/machine';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerMachineCommands(program);
  return program;
}

interface StubFixture {
  noun: string;
  verb: string;
  /** argv after the global flags + before any per-mode --json prefix. */
  argv: string[];
  dashboardPath: string;
  /** Substring that the future-plan field must contain. */
  futurePlanSubstr: string;
}

const FIXTURES: StubFixture[] = [
  {
    noun: 'machine',
    verb: 'live-view',
    argv: ['machine', 'live-view', 'm-1', '--site', 'site-1'],
    dashboardPath: '/dashboard',
    futurePlanSubstr: 'public-api deferred: swoop',
  },
];

const API_URL = 'https://dev.test';

class StubExitError extends Error {
  constructor(public code: number) {
    super(`__stub_exit_${code}__`);
  }
}

function installExitSpy(): jest.SpyInstance {
  return jest
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      throw new StubExitError(code ?? 0);
    }) as never);
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
  process.env.OWLETTE_API_URL = API_URL;
  process.env.OWLETTE_PROFILE = 'default';
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  jest.restoreAllMocks();
});

describe.each(FIXTURES)('owlette $noun $verb (stub)', (fix) => {
  it('exits 3 and surfaces the dashboard + future plan on stderr in human mode', async () => {
    const exitSpy = installExitSpy();
    const stderr: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    const program = buildProgram();

    let caught: unknown;
    try {
      await program.parseAsync(fix.argv, { from: 'user' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StubExitError);
    expect((caught as StubExitError).code).toBe(3);
    expect(exitSpy).toHaveBeenCalledWith(3);

    const err = stderr.join('');
    expect(err).toContain(`\`${fix.noun} ${fix.verb}\``);
    expect(err).toContain(`${API_URL}${fix.dashboardPath}`);
    expect(err).toContain(fix.futurePlanSubstr);
    expect(err).toContain('is a stub');
  });

  it('emits the canonical {ok:false, stub:true, ...} envelope on stdout in --json mode', async () => {
    const exitSpy = installExitSpy();
    const stdout: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    const program = buildProgram();

    let caught: unknown;
    try {
      await program.parseAsync(['--json', ...fix.argv], { from: 'user' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StubExitError);
    expect((caught as StubExitError).code).toBe(3);
    expect(exitSpy).toHaveBeenCalledWith(3);

    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.stub).toBe(true);
    expect(parsed.noun).toBe(fix.noun);
    expect(parsed.dashboard_url).toBe(`${API_URL}${fix.dashboardPath}`);
    expect(typeof parsed.future_plan).toBe('string');
    expect(parsed.future_plan as string).toContain(fix.futurePlanSubstr);
    expect(typeof parsed.reason).toBe('string');
    // snake_case is load-bearing per command-surface.md; guard the flip to camelCase
    expect(parsed.dashboardUrl).toBeUndefined();
    expect(parsed.futurePlan).toBeUndefined();
  });
});

describe('stubExit envelope contract', () => {
  it('JSON envelope keys are exactly {ok, stub, noun, reason, dashboard_url, future_plan}', async () => {
    installExitSpy();
    const stdout: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    const program = buildProgram();

    try {
      await program.parseAsync(
        ['--json', 'machine', 'live-view', 'm-1', '--site', 'site-1'],
        { from: 'user' },
      );
    } catch {
      /* sentinel */
    }

    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['dashboard_url', 'future_plan', 'noun', 'ok', 'reason', 'stub'].sort(),
    );
  });
});
