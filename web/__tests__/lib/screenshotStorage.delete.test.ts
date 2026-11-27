/** @jest-environment node */

/**
 * deleteMachineScreenshots / deleteSiteScreenshots: what leaving a site deletes.
 * the images under the folder and the history records both go, each whatever
 * the other does, and an id that would widen the folder deletes nothing. both
 * throw; deleteScreenshotsBestEffort, the one leaving a site calls, only logs.
 */

const deletedPrefixes: string[] = [];
const recursiveDeletes: string[] = [];
let imageDeleteFailure: Error | null = null;
let listedMachines: string[] = [];

const mockLoggerError = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...a: unknown[]) => mockLoggerError(...a), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => {
    throw new Error('the tests pass a db');
  },
  getAdminStorage: () => ({
    bucket: (name: string) => ({
      name,
      deleteFiles: async ({ prefix }: { prefix: string }) => {
        if (imageDeleteFailure) throw imageDeleteFailure;
        deletedPrefixes.push(prefix);
      },
    }),
  }),
}));

import {
  deleteMachineScreenshots,
  deleteScreenshotsBestEffort,
  deleteSiteScreenshots,
} from '@/lib/screenshotStorage.server';

function ref(path: string) {
  return {
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(path: string) {
  return {
    path,
    doc: (id: string) => ref(`${path}/${id}`),
    listDocuments: async () => listedMachines.map((id) => ref(`${path}/${id}`)),
  };
}

const db = {
  collection: (name: string) => collectionRef(name),
  recursiveDelete: async (target: { path: string }) => {
    recursiveDeletes.push(target.path);
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => {
  deletedPrefixes.length = 0;
  recursiveDeletes.length = 0;
  imageDeleteFailure = null;
  listedMachines = [];
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'bucket.example';
});

describe('deleteMachineScreenshots', () => {
  it("deletes the images in the machine's folder and its history records", async () => {
    await deleteMachineScreenshots('site-a', 'm1', db);

    expect(deletedPrefixes).toEqual(['screenshots/site-a/m1/']);
    expect(recursiveDeletes).toEqual(['sites/site-a/machines/m1/screenshots']);
  });

  it('deletes the records when the images cannot be, then says so', async () => {
    imageDeleteFailure = new Error('storage unavailable');

    await expect(deleteMachineScreenshots('site-a', 'm1', db)).rejects.toThrow('storage unavailable');

    expect(recursiveDeletes).toEqual(['sites/site-a/machines/m1/screenshots']);
  });

  it.each([
    ['an empty site id', '', 'm1'],
    ['an empty machine id', 'site-a', ''],
    ['a site id with a slash', 'site-a/m2', 'm1'],
    ['a machine id with a slash', 'site-a', 'm1/x'],
    ['a dot segment', 'site-a', '..'],
  ])('refuses %s and deletes nothing', async (_label, siteId, machineId) => {
    await expect(deleteMachineScreenshots(siteId, machineId, db)).rejects.toThrow('without a slash');

    expect(deletedPrefixes).toEqual([]);
    expect(recursiveDeletes).toEqual([]);
  });
});

describe('deleteSiteScreenshots', () => {
  it("deletes the images in the site's folder and every listed machine's records", async () => {
    listedMachines = ['m1', 'gone-machine'];

    await deleteSiteScreenshots('site-a', db);

    expect(deletedPrefixes).toEqual(['screenshots/site-a/']);
    expect(recursiveDeletes).toEqual([
      'sites/site-a/machines/m1/screenshots',
      'sites/site-a/machines/gone-machine/screenshots',
    ]);
  });

  it('refuses an empty site id and deletes nothing', async () => {
    listedMachines = ['m1'];

    await expect(deleteSiteScreenshots('', db)).rejects.toThrow('without a slash');

    expect(deletedPrefixes).toEqual([]);
    expect(recursiveDeletes).toEqual([]);
  });
});

describe('deleteScreenshotsBestEffort', () => {
  it("deletes a machine's screenshots, or the site's with no machine", async () => {
    listedMachines = ['m1'];

    await deleteScreenshotsBestEffort('site-a', 'm2', 'removeMachine', db);
    await deleteScreenshotsBestEffort('site-b', null, 'deleteSite', db);

    expect(deletedPrefixes).toEqual(['screenshots/site-a/m2/', 'screenshots/site-b/']);
    expect(recursiveDeletes).toEqual(['sites/site-a/machines/m2/screenshots', 'sites/site-b/machines/m1/screenshots']);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('logs a failure as an error, with the site and machine, and never throws', async () => {
    imageDeleteFailure = new Error('storage unavailable');

    await expect(deleteScreenshotsBestEffort('site-a', 'm1', 'moveConfirm', db)).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      'moveConfirm: screenshot delete failed (non-fatal)',
      expect.objectContaining({ context: 'moveConfirm', data: expect.objectContaining({ siteId: 'site-a', machineId: 'm1', err: 'storage unavailable' }) }),
    );
  });
});
