/** @jest-environment node */

import type { InstallerPlatform } from '@/lib/installerPlatform';

const mockDocs = new Map<string, Record<string, unknown>>();
let mockReads = 0;
let mockFailure: Error | 'hang' | null = null;

function mockDocRef(path: string): unknown {
  return {
    get: () => {
      mockReads += 1;
      if (mockFailure === 'hang') return new Promise(() => {});
      if (mockFailure) return Promise.reject(mockFailure);
      const data = mockDocs.get(path);
      return Promise.resolve({ exists: data !== undefined, data: () => data });
    },
    collection: (name: string) => mockCollectionRef(`${path}/${name}`),
  };
}

function mockCollectionRef(path: string) {
  return { doc: (id: string) => mockDocRef(`${path}/${id}`) };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: (name: string) => mockCollectionRef(name) }),
}));

const EVERY: InstallerPlatform[] = ['windows_x64', 'macos_arm64', 'linux_x64'];

function seedRelease(version: string, record: Record<string, unknown>) {
  mockDocs.set('installer_metadata/latest', { version, ...record });
  mockDocs.set(`installer_metadata/data/versions/${version}`, { version, ...record });
}

// a fresh module each time: the platform list is cached at module level
async function landing() {
  jest.resetModules();
  return (await import('@/lib/latestInstaller.server')).landingDownloadPlatforms;
}

beforeEach(() => {
  mockDocs.clear();
  mockReads = 0;
  mockFailure = null;
  delete process.env.OWLETTE_E2E;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('landingDownloadPlatforms', () => {
  it('offers only windows for a release with only the flat windows fields', async () => {
    seedRelease('3.3.7', { download_url: 'https://example.test/owlette.exe' });

    await expect((await landing())()).resolves.toEqual(['windows_x64']);
  });

  it('offers every platform a three-file release has, in menu order', async () => {
    seedRelease('4.1.19', {
      download_url: 'https://example.test/owlette.exe',
      files: {
        linux_x64: { download_url: 'https://example.test/owlette.deb' },
        windows_x64: { download_url: 'https://example.test/owlette.exe' },
        macos_arm64: { download_url: 'https://example.test/owlette.pkg' },
      },
    });

    await expect((await landing())()).resolves.toEqual(EVERY);
  });

  it('offers none when there is no release, or its version is deleted', async () => {
    await expect((await landing())()).resolves.toEqual([]);

    seedRelease('3.3.7', { download_url: 'https://example.test/owlette.exe', deletedAt: 1 });
    await expect((await landing())()).resolves.toEqual([]);
  });

  it('answers a second view within a minute without reading the catalog', async () => {
    seedRelease('3.3.7', { download_url: 'https://example.test/owlette.exe' });
    const landingDownloadPlatforms = await landing();

    await landingDownloadPlatforms();
    const readsAfterFirst = mockReads;
    await expect(landingDownloadPlatforms()).resolves.toEqual(['windows_x64']);

    expect(readsAfterFirst).toBe(2);
    expect(mockReads).toBe(2);
  });

  it('reads the catalog on every view under e2e, which seeds it directly', async () => {
    process.env.OWLETTE_E2E = '1';
    seedRelease('3.3.7', { download_url: 'https://example.test/owlette.exe' });
    const landingDownloadPlatforms = await landing();

    await landingDownloadPlatforms();
    await landingDownloadPlatforms();

    expect(mockReads).toBe(4);
  });

  it('offers every platform when the lookup fails, and keeps no answer from it', async () => {
    const landingDownloadPlatforms = await landing();
    mockFailure = new Error('firestore unavailable');
    await expect(landingDownloadPlatforms()).resolves.toEqual(EVERY);

    mockFailure = null;
    seedRelease('3.3.7', { download_url: 'https://example.test/owlette.exe' });
    await expect(landingDownloadPlatforms()).resolves.toEqual(['windows_x64']);
  });

  it('stops waiting after two seconds and offers every platform', async () => {
    const landingDownloadPlatforms = await landing();
    jest.useFakeTimers();
    mockFailure = 'hang';
    const pending = landingDownloadPlatforms();

    jest.advanceTimersByTime(2_000);

    await expect(pending).resolves.toEqual(EVERY);
  });
});
