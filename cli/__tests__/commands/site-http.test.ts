/**
 * HTTP-shape tests for `owlette site list | get`.
 *
 * Intercepts global.fetch, builds an in-process commander program, and
 * asserts the request URL/method/headers/body match the contract.
 */

import { Command } from 'commander';
import { registerSiteCommands } from '../../src/commands/site';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerSiteCommands(program);
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
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  jest.restoreAllMocks();
});

describe('owlette site list', () => {
  it('GETs /api/sites with Bearer auth', async () => {
    const calls = installFetchStub({ sites: [] });
    const program = buildProgram();

    await program.parseAsync(['--json', 'site', 'list'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites');
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('emits {sites: [...]} envelope in --json mode', async () => {
    const sites = [
      { id: 'site-1', name: 'alpha', plan: 'pro', timezone: 'utc', owner: null, createdAt: null },
      { id: 'site-2', name: 'beta', plan: null, timezone: null, owner: null, createdAt: null },
    ];
    installFetchStub({ sites });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'site', 'list'], { from: 'user' });

    const out = writes.join('');
    const parsed = JSON.parse(out) as { sites: typeof sites };
    expect(parsed.sites).toEqual(sites);
  });

  it('renders an ascii table in default mode', async () => {
    installFetchStub({
      sites: [
        { id: 'site-1', name: 'alpha', plan: 'pro', timezone: 'utc', owner: null, createdAt: null },
      ],
    });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['site', 'list'], { from: 'user' });

    const out = writes.join('');
    expect(out).toContain('id');
    expect(out).toContain('site-1');
    expect(out).toContain('alpha');
  });
});

describe('owlette site get', () => {
  it('GETs /api/sites/:siteId with Bearer auth', async () => {
    const calls = installFetchStub({
      id: 'site-1',
      name: 'alpha',
      plan: 'pro',
      timezone: 'utc',
      owner: null,
      createdAt: null,
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'site', 'get', 'site-1'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('round-trips the raw detail in --json mode', async () => {
    const detail = {
      id: 'site-1',
      name: 'alpha',
      plan: 'pro',
      timezone: 'utc',
      owner: 'u_1',
      createdAt: '2026-01-01T00:00:00Z',
    };
    installFetchStub(detail);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'site', 'get', 'site-1'], { from: 'user' });

    const out = writes.join('');
    expect(JSON.parse(out)).toEqual(detail);
  });
});

// ---------------------------------------------------------------------------
// membership — per-site roles + ownership transfer
// ---------------------------------------------------------------------------

describe('owlette site members', () => {
  it('GETs the members collection', async () => {
    const calls = installFetchStub({ members: [] });
    const program = buildProgram();

    await program.parseAsync(['site', 'members', 'site-1'], { from: 'user' });

    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/members');
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
  });
});

describe('owlette site add-member', () => {
  it('POSTs uid + role with an auto Idempotency-Key', async () => {
    const calls = installFetchStub({ uid: 'u-1', roleHonored: true, globalRole: 'admin' });
    const program = buildProgram();

    await program.parseAsync(
      ['site', 'add-member', 'site-1', '--uid', 'u-1', '--role', 'admin'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/members');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ uid: 'u-1', role: 'admin' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-add-member-/);
  });

  it('POSTs email instead of uid when --email is used', async () => {
    const calls = installFetchStub({ uid: 'u-1', roleHonored: true });
    const program = buildProgram();

    await program.parseAsync(
      ['site', 'add-member', 'site-1', '--email', 'alice@example.com'],
      { from: 'user' },
    );

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      email: 'alice@example.com',
      role: 'member',
    });
  });

  it('refuses both --uid and --email without calling the API', async () => {
    const calls = installFetchStub({});
    const program = buildProgram();

    await program.parseAsync(
      ['site', 'add-member', 'site-1', '--uid', 'u-1', '--email', 'a@b.c'],
      { from: 'user' },
    );

    // Validated client-side, mirroring the API's own 400 — no round trip spent.
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it.each(['admin', 'member'])(
    'says an existing member keeps their role and points at set-role (--role %s)',
    async (role) => {
      // roleHonored false means nothing was written: the target was already a member.
      installFetchStub({ uid: 'u-1', roleHonored: false, globalRole: 'member' });
      const writes: string[] = [];
      (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
        writes.push(chunk);
        return true;
      });
      const program = buildProgram();

      await program.parseAsync(
        ['site', 'add-member', 'site-1', '--uid', 'u-1', '--role', role],
        { from: 'user' },
      );

      const out = writes.join('');
      // silence here would read as unqualified success; scripts grep for these two
      expect(out).toContain('WARNING');
      expect(out).toContain('NOT honored');
      expect(out).toContain('already a member');
      expect(out).toContain('owlette site set-role');
      expect(out).not.toContain('added to');
      expect(out).not.toContain('user promote');
    },
  );
});

describe('owlette site set-role', () => {
  it('PATCHes the member with the new per-site role', async () => {
    const calls = installFetchStub({ siteId: 'site-1', uid: 'u-1', role: 'admin' });
    const program = buildProgram();

    await program.parseAsync(['site', 'set-role', 'site-1', 'u-1', 'admin'], { from: 'user' });

    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/members/u-1');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ role: 'admin' });
  });

  it('refuses role=owner locally and points at transfer-ownership', async () => {
    const calls = installFetchStub({});
    const writes: string[] = [];
    const errs: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((c: string) => {
      writes.push(c);
      return true;
    });
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string) => {
      errs.push(c);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['site', 'set-role', 'site-1', 'u-1', 'owner'], { from: 'user' });

    expect(calls).toHaveLength(0);
    expect(errs.join('')).toContain('transfer-ownership');
  });
});

describe('owlette site remove-member', () => {
  it('DELETEs the member and passes a talon successor when given', async () => {
    const calls = installFetchStub({ wasMember: true, talonCount: 0, reassignedTalonIds: [] });
    const program = buildProgram();

    await program.parseAsync(
      ['site', 'remove-member', 'site-1', 'u-1', '--talon-successor', 'u-2'],
      { from: 'user' },
    );

    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/sites/site-1/members/u-1?talonSuccessorUid=u-2',
    );
  });

  it('WARNS about talons left orphaned by the removal', async () => {
    // The talons survive, but their author can no longer reach the site, so they
    // start failing silently — worth saying out loud.
    installFetchStub({ wasMember: true, talonCount: 3, reassignedTalonIds: [] });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((c: string) => {
      writes.push(c);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['site', 'remove-member', 'site-1', 'u-1'], { from: 'user' });

    const out = writes.join('');
    expect(out).toContain('WARNING');
    expect(out).toContain('3 talon(s)');
  });
});

describe('owlette site transfer-ownership', () => {
  it('POSTs successorUid to the site-level transfer endpoint', async () => {
    const calls = installFetchStub({
      siteId: 'site-1',
      previousOwnerUid: 'u-old',
      newOwnerUid: 'u-new',
    });
    const program = buildProgram();

    await program.parseAsync(['site', 'transfer-ownership', 'site-1', 'u-new'], {
      from: 'user',
    });

    // Deliberately NOT under /members: ownership belongs to the site.
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/transfer-ownership');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ successorUid: 'u-new' });
  });

  it('surfaces a 403 not_owner refusal', async () => {
    installFetchStub({ detail: 'transferring a site is the owner\'s decision' }, 403);
    const errs: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string) => {
      errs.push(c);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['site', 'transfer-ownership', 'site-1', 'u-new'], {
      from: 'user',
    });

    expect(errs.join('')).toContain('403');
    expect(process.exitCode).toBe(1);
  });
});
