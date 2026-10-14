/** @jest-environment node */

/**
 * issueLogsStorage.server — the key an attached zip lands under, what its
 * presigned upload signs (the real sdk presigner, no network), and the
 * OWLETTE_E2E stub that stands in for R2 in the playwright suite.
 */

import {
  headIssueLogs,
  ISSUE_LOGS_E2E_SIZE,
  issueLogsKey,
  presignIssueLogsDownload,
  presignIssueLogsUpload,
} from '@/lib/issueLogsStorage.server';

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
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
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

describe('presignIssueLogsUpload', () => {
  it('signs content-length and content-type into a 15 minute PUT on the env bucket', async () => {
    const key = 'issues/site-1/m/abc.zip';
    const url = new URL(await presignIssueLogsUpload(key, 4096));
    expect(url.pathname).toBe(`/owlette-dev-issue-logs/${key}`);
    const signed = url.searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [];
    expect(signed).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
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

  it('reports every issues/ key as uploaded, and nothing else', async () => {
    expect(await headIssueLogs('issues/s/m/abc.zip')).toEqual({ size: ISSUE_LOGS_E2E_SIZE });
    expect(await headIssueLogs('other/abc.zip')).toBeNull();
  });
});
