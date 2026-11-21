/**
 * @jest-environment jsdom
 *
 * issueUploads — the dashboard's attachment limits match the desktop app's, and the
 * upload stops on any failure so the issue is never filed with part of its files.
 */

import { admitIssueFiles, ISSUE_UPLOAD_FAILED, uploadIssueFiles } from '@/lib/issueUploads';

const MB = 1024 * 1024;

function file(name: string, type: string, size = 10): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

const png = (size?: number) => file('shot.png', 'image/png', size);
const mp4 = (size?: number) => file('clip.mp4', 'video/mp4', size);
const source = (f: File) => ({ file: f, label: f.name });

describe('admitIssueFiles', () => {
  it('admits the six types, in order', () => {
    const files = [
      png(),
      file('a.jpg', 'image/jpeg'),
      file('a.webp', 'image/webp'),
      mp4(),
      file('a.mov', 'video/quicktime'),
      file('a.webm', 'video/webm'),
    ];
    expect(admitIssueFiles([], files.map(source))).toEqual({ admitted: files, refused: [] });
  });

  it('refuses any other type, named and worded by its family', () => {
    const files = [file('anim.gif', 'image/gif'), file('old.avi', 'video/x-msvideo'), file('notes.txt', 'text/plain')];
    expect(admitIssueFiles([], files.map(source))).toEqual({
      admitted: [],
      refused: [
        'anim.gif: only png, jpeg or webp images',
        'old.avi: only mp4, mov or webm videos',
        'notes.txt: only png, jpeg or webp images, or mp4, mov or webm videos',
      ],
    });
  });

  it('refuses an image over 8 MB, but not a video', () => {
    const big = file('big.png', 'image/png', 8 * MB + 1);
    const ok = file('ok.png', 'image/png', 8 * MB);
    const clip = mp4(9 * MB);
    const { admitted, refused } = admitIssueFiles([], [source(big), source(ok), source(clip)]);
    expect(admitted).toEqual([ok, clip]);
    expect(refused).toEqual(['big.png: images must be 8 MB or smaller']);
  });

  it('holds screenshots to 10, counting the ones already held', () => {
    const held = Array.from({ length: 9 }, () => png());
    const { admitted, refused } = admitIssueFiles(held, [source(png()), source(png()), source(png())]);
    expect(admitted).toHaveLength(1);
    expect(refused).toEqual(['up to 10 screenshots per issue']);
  });

  it('holds videos to 20', () => {
    const held = Array.from({ length: 20 }, () => mp4());
    expect(admitIssueFiles(held, [source(mp4())]).refused).toEqual(['up to 20 videos per issue']);
  });

  it('holds the total to 100 MB', () => {
    const held = [mp4(95 * MB)];
    const fits = mp4(5 * MB);
    const over = file('over.mp4', 'video/mp4', 1);
    const { admitted, refused } = admitIssueFiles(held, [source(fits), source(over)]);
    expect(admitted).toEqual([fits]);
    expect(refused).toEqual(['over.mp4: attachments must total 100 MB or less']);
  });
});

type Sent = { method: string; url: string; headers: Record<string, string>; body: unknown };

function installXhr(status: (url: string) => number | 'network') {
  const sent: Sent[] = [];
  class FakeXhr {
    upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    status = 0;
    private req: Sent = { method: '', url: '', headers: {}, body: null };
    open(method: string, url: string) {
      this.req = { method, url, headers: {}, body: null };
    }
    setRequestHeader(name: string, value: string) {
      this.req.headers[name] = value;
    }
    send(body: File) {
      this.req.body = body;
      sent.push(this.req);
      const outcome = status(this.req.url);
      setTimeout(() => {
        if (outcome === 'network') return this.onerror?.();
        this.upload.onprogress?.({ loaded: body.size / 2 });
        this.status = outcome;
        this.onload?.();
      }, 0);
    }
  }
  global.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  return sent;
}

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});

function signedFor(count: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      files: Array.from({ length: count }, (_, i) => ({ key: `issues/web/u/${i}.png`, uploadUrl: `https://r2/${i}` })),
      expiresIn: 1800,
    }),
  };
}

describe('uploadIssueFiles', () => {
  it('asks for urls with each size and type, PUTs each with its exact type, and returns the keys', async () => {
    const sent = installXhr(() => 200);
    fetchMock.mockResolvedValue(signedFor(2));
    const files = [png(100), mp4(300)];
    const progress: number[] = [];

    const keys = await uploadIssueFiles(files, (p) => progress.push(p));

    expect(keys).toEqual(['issues/web/u/0.png', 'issues/web/u/1.png']);
    expect(fetchMock).toHaveBeenCalledWith('/api/issue-attachments/upload-url', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      files: [
        { size: 100, contentType: 'image/png' },
        { size: 300, contentType: 'video/mp4' },
      ],
    });
    expect(sent.map((s) => [s.method, s.url, s.headers['Content-Type'], s.body])).toEqual([
      ['PUT', 'https://r2/0', 'image/png', files[0]],
      ['PUT', 'https://r2/1', 'video/mp4', files[1]],
    ]);
    expect(progress).toEqual([0, 12, 25, 62, 100]);
  });

  it.each([
    ['a non-2xx PUT', 403 as const],
    ['a network or cors failure', 'network' as const],
  ])('throws on %s', async (_label, outcome) => {
    installXhr((url) => (url.endsWith('/1') ? outcome : 200));
    fetchMock.mockResolvedValue(signedFor(2));
    await expect(uploadIssueFiles([png(), png()], () => {})).rejects.toThrow(ISSUE_UPLOAD_FAILED);
  });

  it('shows the refusal a 400 carries', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'attachments must total 100 MB or less' }),
    });
    await expect(uploadIssueFiles([png()], () => {})).rejects.toThrow('attachments must total 100 MB or less');
  });

  it('falls back to the plain failure on any other status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ detail: 'Too many requests.' }) });
    await expect(uploadIssueFiles([png()], () => {})).rejects.toThrow(ISSUE_UPLOAD_FAILED);
  });

  it('throws when the urls do not match the files', async () => {
    installXhr(() => 200);
    fetchMock.mockResolvedValue(signedFor(1));
    await expect(uploadIssueFiles([png(), png()], () => {})).rejects.toThrow(ISSUE_UPLOAD_FAILED);
  });
});
