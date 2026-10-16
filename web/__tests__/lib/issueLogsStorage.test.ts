/** @jest-environment node */

/**
 * issueLogsStorage.server — the keys an agent zip and a browser's issue files
 * land under, what their presigned uploads sign (the real sdk presigner, no
 * network), and the OWLETTE_E2E stub that stands in for R2 in the playwright
 * suite.
 */

const mockE2EFiles = new Map<string, Record<string, unknown>>();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        set: async (data: Record<string, unknown>) => void mockE2EFiles.set(`${name}/${id}`, data),
        get: async () => {
          const data = mockE2EFiles.get(`${name}/${id}`);
          return { exists: !!data, get: (field: string) => data?.[field] };
        },
      }),
    }),
  }),
}));

import {
  headIssueLogs,
  ISSUE_FILES_E2E_SINK,
  ISSUE_LOGS_E2E_SIZE,
  ISSUE_LOGS_MAX_BYTES,
  webIssueFileExt,
  issueLogsKey,
  presignIssueLogsDownload,
  presignIssueLogsUpload,
  recordIssueFileE2E,
  webIssueFileKey,
} from '@/lib/issueLogsStorage.server';
import { ISSUE_FILE_TYPES, type IssueFileExt } from '@/lib/issues';

const UUID = '0b6f2c1e-5a4d-4e8f-9c3b-1d2e3f4a5b6c';

const ENV_KEYS = [
  'R2_S3_ENDPOINT',
  'ISSUE_LOGS_R2_ACCESS_KEY_ID',
  'ISSUE_LOGS_R2_SECRET_ACCESS_KEY',
  'ROOST_ENV',
  'OWLETTE_E2E',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.R2_S3_ENDPOINT = 'https://acct.r2.cloudflarestorage.com';
  process.env.ISSUE_LOGS_R2_ACCESS_KEY_ID = 'key-id';
  process.env.ISSUE_LOGS_R2_SECRET_ACCESS_KEY = 'key-secret';
  process.env.ROOST_ENV = 'dev';
  delete process.env.OWLETTE_E2E;
  mockE2EFiles.clear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('ISSUE_LOGS_MAX_BYTES', () => {
  it("is 150 MiB, room for the agent's largest zip", () => {
    expect(ISSUE_LOGS_MAX_BYTES).toBe(150 * 1024 * 1024);
    expect(ISSUE_LOGS_MAX_BYTES).toBeGreaterThanOrEqual(150_000_000);
  });
});

describe('issueLogsKey', () => {
  it('is issues/{siteId}/{machineId}/{uuid}.zip, fresh each call', () => {
    const key = issueLogsKey('site-1', 'MACHINE-A');
    expect(key).toMatch(/^issues\/site-1\/MACHINE-A\/[0-9a-f-]{36}\.zip$/);
    expect(issueLogsKey('site-1', 'MACHINE-A')).not.toBe(key);
  });

  it('refuses a segment that would escape its prefix', () => {
    expect(() => issueLogsKey('site-1/../other', 'm')).toThrow('invalid siteId');
    expect(() => issueLogsKey('site-1', '..')).toThrow('invalid machineId');
    expect(() => issueLogsKey('', 'm')).toThrow('invalid siteId');
  });
});

describe('webIssueFileKey', () => {
  it('is issues/web/{uid}/{uuid}.{ext}, fresh each call', () => {
    const key = webIssueFileKey('uid-1', 'png');
    expect(key).toMatch(/^issues\/web\/uid-1\/[0-9a-f-]{36}\.png$/);
    expect(webIssueFileKey('uid-1', 'png')).not.toBe(key);
  });

  it('refuses a uid that would escape its prefix', () => {
    expect(() => webIssueFileKey('a/../b', 'png')).toThrow('invalid uid');
    expect(() => webIssueFileKey('..', 'mp4')).toThrow('invalid uid');
    expect(() => webIssueFileKey('', 'mp4')).toThrow('invalid uid');
  });
});

describe('webIssueFileExt', () => {
  it.each(Object.keys(ISSUE_FILE_TYPES) as IssueFileExt[])('accepts a minted .%s key for its own uid', (ext) => {
    expect(webIssueFileExt(webIssueFileKey('uid-1', ext), 'uid-1')).toBe(ext);
  });

  it("refuses another user's key", () => {
    expect(webIssueFileExt(webIssueFileKey('uid-1', 'png'), 'uid-2')).toBeNull();
  });

  it.each([
    ['an agent zip', `issues/web/uid-1/${UUID}.zip`],
    ['an unknown extension', `issues/web/uid-1/${UUID}.gif`],
    ['an upper-case extension', `issues/web/uid-1/${UUID}.PNG`],
    ['a non-uuid name', 'issues/web/uid-1/screenshot.png'],
    ['an upper-case uuid', `issues/web/uid-1/${UUID.toUpperCase()}.png`],
    ['an extra segment', `issues/web/uid-1/x/${UUID}.png`],
    ['a missing prefix', `web/uid-1/${UUID}.png`],
    ['a trailing suffix', `issues/web/uid-1/${UUID}.png.zip`],
    ['a site key', `issues/site-1/uid-1/${UUID}.png`],
  ])('refuses %s', (_label, key) => {
    expect(webIssueFileExt(key, 'uid-1')).toBeNull();
  });

  it.each([['..'], ['.'], ['a\\b'], ['']])('refuses the unsafe uid %p even when the key carries it', (uid) => {
    expect(webIssueFileExt(`issues/web/${uid}/${UUID}.png`, uid)).toBeNull();
  });
});

describe('presignIssueLogsUpload', () => {
  it('signs content-length and content-type into a 30 minute PUT on the env bucket', async () => {
    const key = 'issues/site-1/m/abc.zip';
    const url = new URL(await presignIssueLogsUpload(key, 4096));
    expect(url.pathname).toBe(`/owlette-dev-issue-logs/${key}`);
    const signed = url.searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
    expect(signed).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('1800');
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
  });

  describe('at a fixed signing time', () => {
    beforeEach(() => jest.useFakeTimers({ now: Date.parse('2026-10-16T12:00:00Z') }));
    afterEach(() => jest.useRealTimers());

    const signature = async (contentType?: string) =>
      new URL(await presignIssueLogsUpload(`issues/web/uid-1/${UUID}.png`, 4096, contentType)).searchParams.get(
        'X-Amz-Signature',
      );

    it('signs the content type it is given, defaulting to the zip type', async () => {
      expect(await signature('image/png')).toBe(await signature('image/png'));
      expect(await signature('image/png')).not.toBe(await signature());
      expect(await signature('application/zip')).toBe(await signature());
    });
  });
});

describe('presignIssueLogsDownload', () => {
  it('asks R2 to serve the zip as an attachment under a header-safe name', async () => {
    const url = new URL(await presignIssueLogsDownload('issues/s/m/abc.zip', 'logs "A" 1.zip'));
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="logs__A__1.zip"');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  });
});

describe('OWLETTE_E2E stub', () => {
  beforeEach(() => {
    process.env.OWLETTE_E2E = '1';
    delete process.env.ISSUE_LOGS_R2_ACCESS_KEY_ID;
    delete process.env.ISSUE_LOGS_R2_SECRET_ACCESS_KEY;
  });

  it('mints upload and download urls without R2 credentials', async () => {
    const key = 'issues/s/m/abc.zip';
    expect(await presignIssueLogsUpload(key, 10)).toContain(`/${key}?op=put`);
    expect(await presignIssueLogsDownload(key, 'logs.zip')).toContain(`/${key}?op=get`);
  });

  it('reports every agent issues/ key as uploaded, and nothing else', async () => {
    expect(await headIssueLogs('issues/s/m/abc.zip')).toEqual({ size: ISSUE_LOGS_E2E_SIZE });
    expect(await headIssueLogs('other/abc.zip')).toBeNull();
  });

  it('points a web issue file upload at the same-origin sink, with what R2 would sign', async () => {
    const key = `issues/web/uid-1/${UUID}.mp4`;
    const url = new URL(await presignIssueLogsUpload(key, 2048, 'video/mp4'), 'http://localhost');
    expect(url.pathname).toBe(ISSUE_FILES_E2E_SINK);
    expect(Object.fromEntries(url.searchParams)).toEqual({ key, size: '2048', contentType: 'video/mp4' });
  });

  it('reports a web issue file only once the sink recorded it, at its real size', async () => {
    const key = `issues/web/uid-1/${UUID}.png`;
    expect(await headIssueLogs(key)).toBeNull();
    await recordIssueFileE2E(key, 77);
    expect(await headIssueLogs(key)).toEqual({ size: 77 });
  });

  it('refuses to record outside OWLETTE_E2E', async () => {
    delete process.env.OWLETTE_E2E;
    await expect(recordIssueFileE2E(`issues/web/uid-1/${UUID}.png`, 1)).rejects.toThrow('only under OWLETTE_E2E');
  });
});
