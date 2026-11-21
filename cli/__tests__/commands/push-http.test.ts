import { Command } from 'commander';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _internals as pushInternals, registerPushCommand } from '../../src/commands/push';
import { _resetConfigCache } from '../../src/config';
import { buildVersion, versionIdForVersion } from '../../src/lib/versionBuilder';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function publishInput() {
  return {
    apiUrl: 'https://dev.test',
    token: 'owk_live_testtoken',
    siteId: 'site-1',
    roostId: 'rst_new',
    version: buildVersion([]),
  };
}

let originalFetch: typeof global.fetch;

beforeAll(() => {
  originalFetch = global.fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

afterEach(() => {
  process.exitCode = 0;
  jest.restoreAllMocks();
});

describe('push publishWithRetry', () => {
  it('publishes a first version when the roost head read returns 404', async () => {
    const calls: FetchCall[] = [];
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url === 'https://dev.test/api/roosts/rst_new?siteId=site-1') {
          return jsonResponse(404, { detail: 'roost not found' });
        }
        if (url === 'https://dev.test/api/roosts/rst_new/versions') {
          const body = JSON.parse(String(init.body));
          expect(body.expectedCurrentVersionId).toBeNull();
          return jsonResponse(201, {
            versionId: 'vrs_first',
            versionNumber: 1,
            currentVersionId: 'vrs_first',
            previousVersionId: null,
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    const result = await pushInternals.publishWithRetry(publishInput());

    expect(result.versionId).toBe('vrs_first');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['null head', { currentVersionId: null }],
    ['absent head', {}],
  ])(
    'sends expect-empty when the roost head read returns 200 with %s',
    async (_case, headBody) => {
      const calls: FetchCall[] = [];
      (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
        async (url: string, init: RequestInit = {}) => {
          calls.push({ url, init });
          if (url === 'https://dev.test/api/roosts/rst_new?siteId=site-1') {
            return jsonResponse(200, headBody);
          }
          if (url === 'https://dev.test/api/roosts/rst_new/versions') {
            const body = JSON.parse(String(init.body));
            expect(body.expectedCurrentVersionId).toBeNull();
            return jsonResponse(201, {
              versionId: 'vrs_empty',
              versionNumber: 1,
              currentVersionId: 'vrs_empty',
              previousVersionId: null,
            });
          }
          throw new Error(`unexpected fetch ${url}`);
        },
      );

      const result = await pushInternals.publishWithRetry(publishInput());

      expect(result.versionId).toBe('vrs_empty');
      expect(calls).toHaveLength(2);
    },
  );

  it('publishes when a write-only key gets 403 reading the roost head', async () => {
    const calls: FetchCall[] = [];
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url === 'https://dev.test/api/roosts/rst_new?siteId=site-1') {
          return jsonResponse(403, { detail: 'missing roost:read' });
        }
        if (url === 'https://dev.test/api/roosts/rst_new/versions') {
          const body = JSON.parse(String(init.body));
          expect(body.expectedCurrentVersionId).toBeUndefined();
          return jsonResponse(201, {
            versionId: 'vrs_write_only',
            versionNumber: 2,
            currentVersionId: 'vrs_write_only',
            previousVersionId: 'vrs_first',
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    const result = await pushInternals.publishWithRetry(publishInput());

    expect(result.versionId).toBe('vrs_write_only');
    expect(calls).toHaveLength(2);
  });

  it('omits expectedCurrentVersionId when the roost head read is unknown', async () => {
    const calls: FetchCall[] = [];
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url === 'https://dev.test/api/roosts/rst_new?siteId=site-1') {
          return jsonResponse(500, { detail: 'temporary failure' });
        }
        if (url === 'https://dev.test/api/roosts/rst_new/versions') {
          const body = JSON.parse(String(init.body));
          expect(body.expectedCurrentVersionId).toBeUndefined();
          return jsonResponse(201, {
            versionId: 'vrs_unknown_head',
            versionNumber: 2,
            currentVersionId: 'vrs_unknown_head',
            previousVersionId: 'vrs_first',
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    const result = await pushInternals.publishWithRetry(publishInput());

    expect(result.versionId).toBe('vrs_unknown_head');
    expect(calls).toHaveLength(2);
  });

  it('does not retry non-stale 412 publish errors such as missing chunks', async () => {
    const calls: FetchCall[] = [];
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url === 'https://dev.test/api/roosts/rst_new?siteId=site-1') {
          return jsonResponse(200, { currentVersionId: 'abc123' });
        }
        if (url === 'https://dev.test/api/roosts/rst_new/versions') {
          return jsonResponse(412, {
            detail: '2 referenced chunk(s) are not present in R2.',
            missingChunks: ['hash-a', 'hash-b'],
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    await expect(pushInternals.publishWithRetry(publishInput())).rejects.toThrow(
      /missingChunks/,
    );

    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => call.url.endsWith('/versions'))).toHaveLength(1);
  });

  it('aborts a stale 412 when the current head cannot be determined', async () => {
    const calls: FetchCall[] = [];
    let headReads = 0;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url === 'https://dev.test/api/roosts/rst_new?siteId=site-1') {
          headReads += 1;
          if (headReads === 1) {
            return jsonResponse(200, { currentVersionId: 'vrs_old' });
          }
          return jsonResponse(500, { detail: 'head read unavailable' });
        }
        if (url === 'https://dev.test/api/roosts/rst_new/versions') {
          const body = JSON.parse(String(init.body));
          expect(body.expectedCurrentVersionId).toBe('vrs_old');
          return jsonResponse(412, {
            code: 'version_stale',
            detail: 'expectedCurrentVersionId did not match; re-read + retry.',
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    await expect(pushInternals.publishWithRetry(publishInput())).rejects.toThrow(
      /current head could not be determined/,
    );

    expect(calls.filter((call) => call.url.endsWith('/versions'))).toHaveLength(1);
  });

  it('converges on a stale 412 retry using a fresh idempotency key per attempt', async () => {
    const calls: FetchCall[] = [];
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url === 'https://dev.test/api/roosts/rst_new?siteId=site-1') {
          return jsonResponse(200, { currentVersionId: 'vrs_old' });
        }
        if (url === 'https://dev.test/api/roosts/rst_new/versions') {
          const body = JSON.parse(String(init.body));
          const headers = init.headers as Record<string, string>;
          const publishCalls = calls.filter((call) =>
            call.url.endsWith('/versions'),
          );
          if (publishCalls.length === 1) {
            expect(headers['Idempotency-Key']).toBe('push-key');
            expect(body.expectedCurrentVersionId).toBe('vrs_old');
            return jsonResponse(412, {
              code: 'version_stale',
              detail:
                'expectedCurrentVersionId did not match the current head (vrs_new). re-read + retry.',
            });
          }
          expect(headers['Idempotency-Key']).toBe('push-key-1');
          expect(body.expectedCurrentVersionId).toBe('vrs_new');
          return jsonResponse(201, {
            versionId: 'vrs_published',
            versionNumber: 3,
            currentVersionId: 'vrs_published',
            previousVersionId: 'vrs_new',
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    const result = await pushInternals.publishWithRetry({
      ...publishInput(),
      idempotencyKey: 'push-key',
    });

    expect(result.versionId).toBe('vrs_published');
    expect(calls.filter((call) => call.url.endsWith('/versions'))).toHaveLength(2);
  });

  it('surfaces the failed attempt key so a manual retry can replay the publish response', async () => {
    const calls: FetchCall[] = [];
    const stderr: string[] = [];
    let committed = false;
    let replayed = false;
    let cachedRawBody: string | null = null;
    let cachedBodyHash: string | null = null;
    const firstInput = {
      ...publishInput(),
      dir: './dist',
      idempotencyKey: 'manual-retry-key',
      idempotencyKeyWasProvided: false,
    };
    const deterministicVersionId = versionIdForVersion(firstInput.version);
    const cachedResponse = {
      versionId: deterministicVersionId,
      versionNumber: 2,
      currentVersionId: deterministicVersionId,
      previousVersionId: 'vrs_base',
    };
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url === 'https://dev.test/api/roosts/rst_new?siteId=site-1') {
          return committed
            ? jsonResponse(200, {
                currentVersionId: deterministicVersionId,
                previousVersionId: 'vrs_base',
              })
            : jsonResponse(200, {
                currentVersionId: 'vrs_base',
                previousVersionId: 'vrs_older',
              });
        }
        if (url === 'https://dev.test/api/roosts/rst_new/versions') {
          const headers = init.headers as Record<string, string>;
          const rawBody = String(init.body);
          const bodyHash = createHash('sha256').update(rawBody).digest('hex');
          expect(headers['Idempotency-Key']).toBe('manual-retry-key');
          if (!committed) {
            cachedRawBody = rawBody;
            cachedBodyHash = bodyHash;
            committed = true;
            throw new Error('socket closed after commit');
          }
          expect(rawBody).toBe(cachedRawBody);
          expect(bodyHash).toBe(cachedBodyHash);
          replayed = true;
          return jsonResponse(201, cachedResponse);
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    await expect(pushInternals.publishWithRetry(firstInput)).rejects.toThrow(
      /unconfirmed publish failure handled/,
    );

    const err = stderr.join('');
    expect(err).toContain('Idempotency-Key: manual-retry-key');
    expect(err).toContain(
      're-run your original command with `--idempotency-key manual-retry-key` appended',
    );
    expect(err).not.toContain('owlette roost push ./dist');

    process.exitCode = 0;
    const result = await pushInternals.publishWithRetry({
      ...firstInput,
      dir: './dist',
      idempotencyKey: 'manual-retry-key',
      idempotencyKeyWasProvided: true,
    });

    expect(replayed).toBe(true);
    expect(result.versionId).toBe(deterministicVersionId);
    expect(calls.filter((call) => call.url.endsWith('/versions'))).toHaveLength(2);
  });
});

describe('push version identity', () => {
  // the real module object, so any host or platform lookup during a push sees the spies
  const nodeOs = jest.requireActual<typeof import('os')>('os');

  beforeEach(() => {
    _resetConfigCache();
    process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
    process.env.OWLETTE_API_URL = 'https://dev.test';
    process.env.OWLETTE_PROFILE = 'default';
  });

  afterEach(() => {
    delete process.env.OWLETTE_TOKEN;
    delete process.env.OWLETTE_API_URL;
    delete process.env.OWLETTE_PROFILE;
  });

  async function pushFrom(
    dir: string,
    host: string,
    osName: NodeJS.Platform,
  ): Promise<ReturnType<typeof buildVersion>> {
    jest.spyOn(nodeOs, 'hostname').mockReturnValue(host);
    jest.spyOn(nodeOs, 'platform').mockReturnValue(osName);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let published: ReturnType<typeof buildVersion> | undefined;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        if (url === 'https://dev.test/api/chunks/check') {
          return jsonResponse(200, { missing: [] });
        }
        if (url === 'https://dev.test/api/roosts/rst_ci?siteId=site-1') {
          return jsonResponse(404, { detail: 'roost not found' });
        }
        if (url === 'https://dev.test/api/roosts/rst_ci/versions') {
          published = JSON.parse(String(init.body)).version;
          return jsonResponse(201, {
            versionId: 'vrs_ci',
            versionNumber: 1,
            currentVersionId: 'vrs_ci',
            previousVersionId: null,
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    const program = new Command()
      .name('owlette')
      .exitOverride()
      .option('--profile <name>')
      .option('--json');
    registerPushCommand(program);
    await program.parseAsync(
      ['--json', 'roost', 'push', dir, '--to', 'rst_ci', '--site', 'site-1'],
      { from: 'user' },
    );
    jest.restoreAllMocks();
    if (!published) throw new Error('push published nothing');
    return published;
  }

  it('publishes the same files under one id from any host, os or cli release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owlette-cli-push-'));
    writeFileSync(join(dir, 'main.toe'), 'same bytes on every runner');

    const fromRunnerA = await pushFrom(dir, 'ci-runner-a', 'linux');
    const fromRunnerB = await pushFrom(dir, 'ci-runner-b', 'win32');

    expect(versionIdForVersion(fromRunnerB)).toBe(versionIdForVersion(fromRunnerA));
    // the server hashes all of `config`, so the cli's own release must stay out of it too
    expect(fromRunnerA.config).toEqual({});
  });
});
