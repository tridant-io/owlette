/**
 * @jest-environment node
 *
 * PUT /api/issue-attachments/e2e-put — the e2e stand-in for R2: gone outside
 * OWLETTE_E2E, takes only a web issue file key, refuses a body whose size or
 * type differs from the presigned one like R2's signed headers do, and records
 * what it took for `headIssueLogs`. Firestore is an in-memory map.
 */

import { NextRequest } from 'next/server';

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

import { PUT } from '@/app/api/issue-attachments/e2e-put/route';
import { headIssueLogs, presignIssueLogsUpload, webIssueFileKey } from '@/lib/issueLogsStorage.server';

const saved = process.env.OWLETTE_E2E;

beforeEach(() => {
  process.env.OWLETTE_E2E = '1';
  mockE2EFiles.clear();
});

afterAll(() => {
  if (saved === undefined) delete process.env.OWLETTE_E2E;
  else process.env.OWLETTE_E2E = saved;
});

function put(url: string, body: Uint8Array, contentType: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: body as unknown as BodyInit,
  });
}

it('takes the presigned upload and records its size for the HEAD', async () => {
  const key = webIssueFileKey('uid-1', 'png');
  const url = await presignIssueLogsUpload(key, 5, 'image/png');
  const res = await PUT(put(url, new Uint8Array(5), 'image/png'));
  expect(res.status).toBe(200);
  expect(await headIssueLogs(key)).toEqual({ size: 5 });
});

it('does not exist outside OWLETTE_E2E', async () => {
  const key = webIssueFileKey('uid-1', 'png');
  const url = await presignIssueLogsUpload(key, 5, 'image/png');
  delete process.env.OWLETTE_E2E;
  const res = await PUT(put(url, new Uint8Array(5), 'image/png'));
  expect(res.status).toBe(404);
  expect(mockE2EFiles.size).toBe(0);
});

it.each([
  ['an agent zip key', 'issues/site-1/m/0b6f2c1e-5a4d-4e8f-9c3b-1d2e3f4a5b6c.zip'],
  ['a non-uuid name', 'issues/web/uid-1/shot.png'],
  ['no key', ''],
])('refuses %s', async (_label, key) => {
  const url = `/api/issue-attachments/e2e-put?${new URLSearchParams({ key, size: '5', contentType: 'image/png' })}`;
  const res = await PUT(put(url, new Uint8Array(5), 'image/png'));
  expect(res.status).toBe(400);
  expect(mockE2EFiles.size).toBe(0);
});

it('refuses a content type other than the presigned one', async () => {
  const url = await presignIssueLogsUpload(webIssueFileKey('uid-1', 'png'), 5, 'image/png');
  expect((await PUT(put(url, new Uint8Array(5), 'image/webp'))).status).toBe(403);
  expect(mockE2EFiles.size).toBe(0);
});

it("refuses a presigned type that is not the key's own", async () => {
  const url = await presignIssueLogsUpload(webIssueFileKey('uid-1', 'png'), 5, 'video/mp4');
  expect((await PUT(put(url, new Uint8Array(5), 'video/mp4'))).status).toBe(403);
});

it.each([[4], [6], [0]])('refuses a %i-byte body presigned for 5', async (n) => {
  const url = await presignIssueLogsUpload(webIssueFileKey('uid-1', 'mp4'), 5, 'video/mp4');
  expect((await PUT(put(url, new Uint8Array(n), 'video/mp4'))).status).toBe(403);
  expect(mockE2EFiles.size).toBe(0);
});
