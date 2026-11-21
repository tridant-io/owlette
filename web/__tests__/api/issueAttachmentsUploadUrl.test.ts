/**
 * @jest-environment node
 *
 * POST /api/issue-attachments/upload-url — a signed-in user gets one signed PUT
 * per screenshot or video, under their own prefix, held to the desktop app's
 * limits, with the budget per user. Storage runs on its OWLETTE_E2E stub.
 */

import { createMockRequest } from './helpers/utils';
import { ApiAuthError } from '@/lib/apiAuth.server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({ getAdminAuth: jest.fn(), getAdminDb: jest.fn() }));

const mockRequireSession = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

const mockPresign = jest.fn();
jest.mock('@/lib/issueLogsStorage.server', () => {
  const actual = jest.requireActual('@/lib/issueLogsStorage.server');
  return {
    ...actual,
    presignIssueLogsUpload: (...args: [string, number, string?]) => {
      mockPresign(...args);
      return actual.presignIssueLogsUpload(...args);
    },
  };
});

const limiterCalls = new Map<string, number>();
jest.mock('@/lib/rateLimit', () => ({
  ...jest.requireActual('@/lib/rateLimit'),
  checkRateLimit: async (_limiter: unknown, key: string) => {
    const n = (limiterCalls.get(key) ?? 0) + 1;
    limiterCalls.set(key, n);
    const reset = Date.now() + 60_000;
    return n <= 20
      ? { success: true, limit: 20, remaining: 20 - n, reset }
      : { success: false, limit: 20, remaining: 0, reset, retryAfter: 60 };
  },
}));

import { POST } from '@/app/api/issue-attachments/upload-url/route';
import {
  ISSUE_ATTACHMENT_MAX_BYTES,
  ISSUE_MAX_SCREENSHOTS,
  ISSUE_MAX_VIDEOS,
  ISSUE_SCREENSHOT_MAX_BYTES,
} from '@/lib/issues';

const UID = 'user-1';
const png = (size = 1000) => ({ size, contentType: 'image/png' });
const mp4 = (size = 1000) => ({ size, contentType: 'video/mp4' });

function call(body: Record<string, unknown> | undefined) {
  return POST(
    createMockRequest('http://localhost/api/issue-attachments/upload-url', { method: 'POST', body }),
  );
}

async function detail(res: Response): Promise<string> {
  return ((await res.json()) as { detail: string }).detail;
}

const savedE2E = process.env.OWLETTE_E2E;

beforeEach(() => {
  process.env.OWLETTE_E2E = '1';
  limiterCalls.clear();
  mockPresign.mockReset();
  mockRequireSession.mockReset();
  mockRequireSession.mockResolvedValue(UID);
});

afterAll(() => {
  if (savedE2E === undefined) delete process.env.OWLETTE_E2E;
  else process.env.OWLETTE_E2E = savedE2E;
});

describe('POST issue-attachments/upload-url', () => {
  it('401s without a session', async () => {
    mockRequireSession.mockRejectedValue(new ApiAuthError(401, 'Unauthorized: No valid session'));
    const res = await call({ files: [png()] });
    expect(res.status).toBe(401);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('signs a mixed batch in request order, one key per file under the user prefix', async () => {
    const types = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'];
    const exts = ['png', 'jpg', 'webp', 'mp4', 'mov', 'webm'];
    const res = await call({ files: types.map((contentType, i) => ({ size: 100 + i, contentType })) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { key: string; uploadUrl: string }[]; expiresIn: number };
    expect(body.expiresIn).toBe(1800);
    expect(body.files).toHaveLength(6);
    body.files.forEach(({ key, uploadUrl }, i) => {
      expect(key).toMatch(new RegExp(`^issues/web/${UID}/[0-9a-f-]{36}\\.${exts[i]}$`));
      expect(uploadUrl).toContain(encodeURIComponent(key));
    });
    expect(new Set(body.files.map((f) => f.key)).size).toBe(6);
    expect(res.headers.get('RateLimit-Remaining')).toBe('19');
  });

  it('signs each url with its file size and content type', async () => {
    const res = await call({ files: [png(321), mp4(654)] });
    expect(res.status).toBe(200);
    const { files } = (await res.json()) as { files: { key: string }[] };
    expect(mockPresign.mock.calls).toEqual([
      [files[0].key, 321, 'image/png'],
      [files[1].key, 654, 'video/mp4'],
    ]);
  });

  it.each([
    ['no files key', {}],
    ['an empty list', { files: [] }],
    ['a non-list', { files: 'a.png' }],
    ['too many entries', { files: Array.from({ length: ISSUE_MAX_SCREENSHOTS + ISSUE_MAX_VIDEOS + 1 }, () => mp4()) }],
  ])('400s %s', async (_label, body) => {
    expect((await call(body)).status).toBe(400);
  });

  it.each([
    ['zero', 0],
    ['a fraction', 10.5],
    ['a string', '100'],
    ['missing', undefined],
  ])('400s a size that is %s', async (_label, size) => {
    expect((await call({ files: [{ size, contentType: 'image/png' }] })).status).toBe(400);
  });

  it.each([
    ['image/gif', 'only png, jpeg or webp images'],
    ['video/x-msvideo', 'only mp4, mov or webm videos'],
    ['application/zip', 'only png, jpeg or webp images, or mp4, mov or webm videos'],
    ['text/plain', 'only png, jpeg or webp images, or mp4, mov or webm videos'],
    [undefined, 'only png, jpeg or webp images, or mp4, mov or webm videos'],
  ])('400s content type %s, worded by its family', async (contentType, refusal) => {
    const res = await call({ files: [{ size: 100, contentType }] });
    expect(res.status).toBe(400);
    expect(await detail(res)).toBe(refusal);
  });

  it('400s an image over 8 MB and takes one at exactly 8 MB', async () => {
    const over = await call({ files: [png(ISSUE_SCREENSHOT_MAX_BYTES + 1)] });
    expect(over.status).toBe(400);
    expect(await detail(over)).toBe('images must be 8 MB or smaller');
    expect((await call({ files: [png(ISSUE_SCREENSHOT_MAX_BYTES)] })).status).toBe(200);
  });

  it('takes a video larger than the image cap', async () => {
    expect((await call({ files: [mp4(ISSUE_SCREENSHOT_MAX_BYTES + 1)] })).status).toBe(200);
  });

  it(`400s more than ${ISSUE_MAX_SCREENSHOTS} screenshots`, async () => {
    const res = await call({ files: Array.from({ length: ISSUE_MAX_SCREENSHOTS + 1 }, () => png()) });
    expect(res.status).toBe(400);
    expect(await detail(res)).toBe('up to 10 screenshots per issue');
  });

  it(`400s more than ${ISSUE_MAX_VIDEOS} videos`, async () => {
    const res = await call({ files: Array.from({ length: ISSUE_MAX_VIDEOS + 1 }, () => mp4()) });
    expect(res.status).toBe(400);
    expect(await detail(res)).toBe('up to 20 videos per issue');
  });

  it('400s a batch over 100 MB in total and takes exactly 100 MB', async () => {
    const half = ISSUE_ATTACHMENT_MAX_BYTES / 2;
    const over = await call({ files: [mp4(half), mp4(half + 1)] });
    expect(over.status).toBe(400);
    expect(await detail(over)).toBe('attachments must total 100 MB or less');
    expect((await call({ files: [mp4(half), mp4(half)] })).status).toBe(200);
  });

  it('signs nothing for a batch it refuses', async () => {
    await call({ files: [png(), { size: 1, contentType: 'text/plain' }] });
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('429s the twenty-first call in the window, keyed on the user', async () => {
    for (let i = 0; i < 20; i++) expect((await call({ files: [png()] })).status).toBe(200);
    const limited = await call({ files: [png()] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(Array.from(limiterCalls.keys())).toEqual([`web_issue_upload:${UID}`]);
  });
});
