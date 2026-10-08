/** @jest-environment node */

/**
 * tridantRelease.server — the installer versions kept in step with tridant
 * id's release log: what a promote imports, what a rollback or delete yanks,
 * what is stored on the version doc, and that nothing here ever throws.
 */

jest.mock('firebase-admin/firestore', () => ({ FieldValue: { delete: () => '__delete__' } }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const docs: Record<string, Record<string, unknown>> = {};
let latest: string | null = null;
const updates: Array<{ version: string; patch: Record<string, unknown> }> = [];
let failReads = false;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name !== 'installer_metadata') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (id: string) => ({
          get: async () => {
            if (failReads) throw new Error('firestore down');
            return { data: () => (id === 'latest' && latest ? { version: latest } : undefined) };
          },
          collection: () => ({
            get: async () => ({
              docs: Object.entries(docs).map(([version, data]) => ({
                id: version,
                data: () => data,
                ref: {
                  update: async (patch: Record<string, unknown>) => {
                    updates.push({ version, patch });
                  },
                },
              })),
            }),
          }),
        }),
      };
    },
  }),
}));

import logger from '@/lib/logger';
import { syncInstallerRelease, tridantReleaseState } from '@/lib/tridantRelease.server';

const HOST = 'https://download-staging.tridant.io/owlette';
const fetchMock = jest.fn();
const ENV_KEYS = ['TRIDANT_API_URL', 'TRIDANT_RELEASE_KEY', 'ROOST_ENV'];
const saved: Record<string, string | undefined> = {};

function file(version: string, ext: string, onHost = true) {
  const name = `Owlette-Installer-v${version}.${ext}`;
  return {
    download_url: onHost ? `${HOST}/${name}` : `https://storage.googleapis.com/b/${name}`,
    checksum_sha256: ext.repeat(30).slice(0, 64),
    file_size: 1000,
    file_name: name,
    uploaded_at: 1,
  };
}

function seed(version: string, extra: Record<string, unknown> = {}) {
  docs[version] = {
    version,
    uploaded_at: 1791072000000,
    release_notes: '## [x] notes',
    files: { windows_x64: file(version, 'exe'), macos_arm64: file(version, 'pkg') },
    ...extra,
  };
}

function respond(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}

function importAnswer(...versions: string[]) {
  return respond(200, { releases: versions.map((v) => ({ id: `rel_${v}`, version: v })) });
}

function stored(version: string) {
  return updates.filter((u) => u.version === version).at(-1)?.patch.tridant as Record<string, unknown> | undefined;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io/';
  process.env.TRIDANT_RELEASE_KEY = 'rk_test';
  process.env.ROOST_ENV = 'dev';
  for (const k of Object.keys(docs)) delete docs[k];
  updates.length = 0;
  latest = null;
  failReads = false;
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('syncInstallerRelease', () => {
  it('does nothing until both the url and the key are set', async () => {
    delete process.env.TRIDANT_RELEASE_KEY;
    seed('4.1.7');
    latest = '4.1.7';

    await expect(syncInstallerRelease('4.1.7')).resolves.toEqual({ status: 'not_configured', error: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('imports the promoted version with every file on the download host and stores the release id', async () => {
    seed('4.1.7', {
      files: {
        windows_x64: file('4.1.7', 'exe'),
        macos_arm64: file('4.1.7', 'pkg'),
        linux_x64: file('4.1.7', 'deb', false),
      },
    });
    latest = '4.1.7';
    fetchMock.mockResolvedValue(importAnswer('4.1.6', '4.1.7'));

    await expect(syncInstallerRelease('4.1.7')).resolves.toEqual({ status: 'registered', error: null });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-staging.tridant.io/v1/admin/products/prd_owlette_core/releases/import');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer rk_test');
    const body = JSON.parse(init.body);
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]).toMatchObject({
      version: '4.1.7',
      channel: 'stable',
      published_at: 1791072000000,
      notes_md: '## [x] notes',
    });
    // the linux file is still on firebase storage, which tridant id would refuse
    expect(body.releases[0].artifacts).toEqual([
      {
        kind: 'app', os: 'win', arch: 'x64', filename: 'Owlette-Installer-v4.1.7.exe',
        size_bytes: 1000, sha256: file('4.1.7', 'exe').checksum_sha256, download_url: `${HOST}/Owlette-Installer-v4.1.7.exe`,
      },
      {
        kind: 'app', os: 'mac', arch: 'arm64', filename: 'Owlette-Installer-v4.1.7.pkg',
        size_bytes: 1000, sha256: file('4.1.7', 'pkg').checksum_sha256, download_url: `${HOST}/Owlette-Installer-v4.1.7.pkg`,
      },
    ]);
    expect(stored('4.1.7')).toMatchObject({ status: 'registered', release_id: 'rel_4.1.7', yanked: false, error: null });
  });

  it('skips a version with no file on the download host, without calling tridant id', async () => {
    seed('4.1.6', { files: { windows_x64: file('4.1.6', 'exe', false) } });
    latest = '4.1.6';

    await expect(syncInstallerRelease('4.1.6')).resolves.toEqual({ status: 'skipped', error: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('stores a refusal with its status and error code, and resolves rather than throws', async () => {
    seed('4.1.7');
    latest = '4.1.7';
    fetchMock.mockResolvedValue(respond(400, { error: 'download_url_not_allowed', url: 'x' }));

    await expect(syncInstallerRelease('4.1.7')).resolves.toEqual({
      status: 'failed',
      error: '400 download_url_not_allowed',
    });
    expect(stored('4.1.7')).toMatchObject({ status: 'failed', release_id: null, error: '400 download_url_not_allowed' });
  });

  it('counts an import answer without this version id as a failure, so it can be retried', async () => {
    seed('4.1.7');
    latest = '4.1.7';
    fetchMock.mockResolvedValue(importAnswer('4.1.6'));

    const result = await syncInstallerRelease('4.1.7');

    expect(result.status).toBe('failed');
    expect(stored('4.1.7')).toMatchObject({ status: 'failed', error: 'the import response has no id for this version' });
  });

  it('a promote past an earlier rollback lists the versions in between again', async () => {
    seed('4.1.0', { tridant: { status: 'registered', release_id: 'rel_4.1.0', yanked: false } });
    seed('4.2.0', { tridant: { status: 'yanked', release_id: 'rel_4.2.0', yanked: true } });
    seed('4.3.0', { tridant: { status: 'yanked', release_id: 'rel_4.3.0', yanked: true } });
    seed('4.2.5', { deletedAt: 9, tridant: { status: 'yanked', release_id: 'rel_4.2.5', yanked: true } });
    latest = '4.3.0';
    fetchMock.mockImplementation(async (url: string, init: { method: string }) =>
      init.method === 'POST' ? importAnswer('4.1.0', '4.2.0', '4.2.5', '4.3.0') : respond(200, {}),
    );

    await expect(syncInstallerRelease('4.3.0')).resolves.toEqual({ status: 'registered', error: null });

    expect(stored('4.3.0')).toMatchObject({ status: 'registered', yanked: false });
    expect(stored('4.2.0')).toMatchObject({ status: 'registered', yanked: false, release_id: 'rel_4.2.0' });
    // already listed, or deleted and yanked: nothing to change
    expect(stored('4.1.0')).toBeUndefined();
    expect(stored('4.2.5')).toBeUndefined();
    const calls = fetchMock.mock.calls.map(([url, init]) => `${init.method} ${url}`);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(2);
    expect(calls).toContain('PATCH https://api-staging.tridant.io/v1/admin/releases/rel_4.2.0');
  });

  it('on a rollback, yanks every registered release above the new latest', async () => {
    seed('4.1.6', { tridant: { status: 'registered', release_id: 'rel_4.1.6', yanked: false } });
    seed('4.1.7', { tridant: { status: 'registered', release_id: 'rel_4.1.7', yanked: false } });
    seed('4.1.8');
    latest = '4.1.6';
    fetchMock
      .mockResolvedValueOnce(importAnswer('4.1.6', '4.1.7'))
      .mockResolvedValueOnce(respond(200, { id: 'rel_4.1.7', yanked: true }));

    await expect(syncInstallerRelease('4.1.6')).resolves.toEqual({ status: 'registered', error: null });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [yankUrl, yankInit] = fetchMock.mock.calls[1];
    expect(yankUrl).toBe('https://api-staging.tridant.io/v1/admin/releases/rel_4.1.7');
    expect(yankInit.method).toBe('PATCH');
    expect(JSON.parse(yankInit.body)).toEqual({ yanked: true, yanked_reason: 'latest rolled back to 4.1.6' });
    expect(stored('4.1.7')).toMatchObject({ status: 'yanked', yanked: true, release_id: 'rel_4.1.7' });
    // 4.1.8 was never registered, so nothing is sent for it
    expect(stored('4.1.8')).toBeUndefined();
  });

  it('un-yanks a restored version after importing it', async () => {
    seed('4.1.7', { tridant: { status: 'yanked', release_id: 'rel_4.1.7', yanked: true } });
    latest = '4.1.7';
    fetchMock
      .mockResolvedValueOnce(importAnswer('4.1.7'))
      .mockResolvedValueOnce(respond(200, { id: 'rel_4.1.7', yanked: false }));

    await expect(syncInstallerRelease('4.1.7')).resolves.toEqual({ status: 'registered', error: null });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ yanked: false });
    expect(stored('4.1.7')).toMatchObject({ status: 'registered', yanked: false });
  });

  it('yanks a deleted version, and records a failed yank so it can be retried', async () => {
    seed('4.1.5', { deletedAt: 5, tridant: { status: 'registered', release_id: 'rel_4.1.5', yanked: false } });
    latest = '4.1.7';
    fetchMock.mockResolvedValueOnce(respond(503, {}));

    await expect(syncInstallerRelease('4.1.5')).resolves.toEqual({ status: 'failed', error: '503 unreachable' });
    expect(stored('4.1.5')).toMatchObject({ status: 'failed', yanked: false, release_id: 'rel_4.1.5' });

    fetchMock.mockResolvedValueOnce(respond(200, {}));
    docs['4.1.5'].tridant = stored('4.1.5');
    await expect(syncInstallerRelease('4.1.5')).resolves.toEqual({ status: 'yanked', error: null });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ yanked: true, yanked_reason: 'deleted in owlette' });
  });

  it('clears a stale failure on a deleted version that was never registered', async () => {
    seed('4.1.5', { deletedAt: 5, tridant: { status: 'failed', release_id: null, error: 'unreachable' } });
    latest = '4.1.7';

    await expect(syncInstallerRelease('4.1.5')).resolves.toEqual({ status: 'skipped', error: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates).toEqual([{ version: '4.1.5', patch: { tridant: '__delete__' } }]);
  });

  it('resolves to failed when firestore throws', async () => {
    seed('4.1.7');
    latest = '4.1.7';
    failReads = true;

    await expect(syncInstallerRelease('4.1.7')).resolves.toEqual({
      status: 'failed',
      error: 'the sync failed before tridant id answered',
    });
    expect(logger.error).toHaveBeenCalledWith(
      '[tridant] release sync failed',
      expect.objectContaining({ data: { version: '4.1.7', error: 'firestore down' } }),
    );
  });
});

describe('tridantReleaseState', () => {
  it('reads a stored state and treats an unknown status as failed', () => {
    expect(tridantReleaseState(undefined)).toBeNull();
    expect(tridantReleaseState({ status: 'odd', release_id: 7 })).toEqual({
      status: 'failed', release_id: null, yanked: false, error: null, at: 0,
    });
  });
});
