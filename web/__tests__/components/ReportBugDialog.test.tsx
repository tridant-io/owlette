/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ReportBugDialog — category and description, no title, plus screenshots and
 * videos uploaded before the issue is filed. The success toast names the issue
 * number POST /api/bug-report returns.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

// radix select drives its trigger with pointer capture and scrolls the active item into view
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

const MB = 1024 * 1024;
const fetchMock = jest.fn();
const createObjectURL = jest.fn();
const revokeObjectURL = jest.fn();
let putStatus: number | 'network' = 200;
const puts: { url: string; type: string; body: File }[] = [];

class FakeXhr {
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  private url = '';
  private type = '';
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    if (name === 'Content-Type') this.type = value;
  }
  send(body: File) {
    puts.push({ url: this.url, type: this.type, body });
    setTimeout(() => {
      if (putStatus === 'network') return this.onerror?.();
      this.status = putStatus;
      this.onload?.();
    }, 0);
  }
}

let urlCount = 0;
beforeEach(() => {
  jest.clearAllMocks();
  puts.length = 0;
  putStatus = 200;
  urlCount = 0;
  global.fetch = fetchMock as unknown as typeof fetch;
  global.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  createObjectURL.mockImplementation(() => `blob:preview-${++urlCount}`);
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

function file(name: string, type: string, size = 2 * MB): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

function respond(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body });
}

/** Signs one url per file asked for, then files the issue as #7. */
function respondWithUploads() {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url === '/api/issue-attachments/upload-url') {
      const { files } = JSON.parse(String(init.body)) as { files: unknown[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: files.map((_, i) => ({ key: `issues/web/u/${i}`, uploadUrl: `https://r2.test/${i}` })),
          expiresIn: 1800,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, id: 'abc', number: 7 }) };
  });
}

function renderDialog() {
  const onOpenChange = jest.fn();
  render(<ReportBugDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange, user: userEvent.setup() };
}

async function describeIssue(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('description'), 'the thing stopped');
}

function pick(files: File[]) {
  fireEvent.change(screen.getByTestId('report-attachment-input'), { target: { files } });
}

function bugReportBody() {
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/bug-report');
  return call ? JSON.parse(String(call[1].body)) : undefined;
}

async function submit() {
  const { onOpenChange, user } = renderDialog();
  await describeIssue(user);
  await user.click(screen.getByRole('button', { name: 'submit' }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
}

describe('ReportBugDialog fields', () => {
  it('has no title field, and the category runs full width', () => {
    renderDialog();
    expect(screen.queryByLabelText('title')).toBeNull();
    expect(screen.getByRole('combobox')).toHaveClass('w-full');
  });

  it('files category and description with no title and no files', async () => {
    respond({ success: true, id: 'abc', number: 42 });
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = bugReportBody();
    expect(body).toMatchObject({ category: 'bug', description: 'the thing stopped' });
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('files');
  });
});

describe('ReportBugDialog success toast', () => {
  it('names the issue number when the response carries one', async () => {
    respond({ success: true, id: 'abc', number: 42 });
    await submit();
    expect(fetchMock).toHaveBeenCalledWith('/api/bug-report', expect.objectContaining({ method: 'POST' }));
    expect(toast.success).toHaveBeenCalledWith('issue #42 submitted — thank you!');
  });

  it.each([
    ['no number', { success: true, id: 'abc' }],
    ['a null number', { success: true, id: 'abc', number: null }],
    ['a non-integer number', { success: true, id: 'abc', number: '42' }],
  ])('falls back to the plain toast for %s', async (_label, body) => {
    respond(body);
    await submit();
    expect(toast.success).toHaveBeenCalledWith('issue submitted — thank you!');
  });

  it('falls back when the body is not json', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('not json'); } });
    await submit();
    expect(toast.success).toHaveBeenCalledWith('issue submitted — thank you!');
  });
});

describe('ReportBugDialog attachments', () => {
  it('uploads each file with its exact type, then files the issue with the keys', async () => {
    respondWithUploads();
    const { onOpenChange, user } = renderDialog();
    const shot = file('shot.png', 'image/png', 1 * MB);
    const clip = file('clip.mov', 'video/quicktime', 3 * MB);
    pick([shot, clip]);
    expect(screen.getByAltText('screenshot 1')).toHaveAttribute('src', 'blob:preview-1');
    expect(screen.getByTitle('clip.mov')).toHaveTextContent('3.0 MB');
    expect(screen.getByTestId('report-attachment-limit')).toHaveTextContent('4.0 of 100 MB used');

    await describeIssue(user);
    await user.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/issue-attachments/upload-url')!;
    expect(JSON.parse(String(init.body))).toEqual({
      files: [
        { size: 1 * MB, contentType: 'image/png' },
        { size: 3 * MB, contentType: 'video/quicktime' },
      ],
    });
    expect(puts).toEqual([
      { url: 'https://r2.test/0', type: 'image/png', body: shot },
      { url: 'https://r2.test/1', type: 'video/quicktime', body: clip },
    ]);
    expect(bugReportBody()).toMatchObject({ files: ['issues/web/u/0', 'issues/web/u/1'] });
    expect(toast.success).toHaveBeenCalledWith('issue #7 submitted — thank you!');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it.each([
    ['a non-2xx PUT', 403 as const],
    ['a network or cors failure', 'network' as const],
  ])('keeps the dialog and the files on %s, and files nothing', async (_label, status) => {
    respondWithUploads();
    putStatus = status;
    const { onOpenChange, user } = renderDialog();
    pick([file('shot.png', 'image/png')]);
    await describeIssue(user);
    await user.click(screen.getByRole('button', { name: 'submit' }));

    expect(await screen.findByTestId('report-error')).toHaveTextContent(
      'could not upload the attachments — try again',
    );
    expect(bugReportBody()).toBeUndefined();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('report-screenshot')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'submit' })).toBeEnabled();
  });

  it('refuses what the desktop app refuses, with its words', () => {
    renderDialog();
    pick([
      file('anim.gif', 'image/gif'),
      file('huge.png', 'image/png', 8 * MB + 1),
      file('long.mp4', 'video/mp4', 99 * MB),
      file('one-more.webm', 'video/webm', 2 * MB),
    ]);
    const notice = screen.getByTestId('report-attachment-notice');
    expect(within(notice).getByText('anim.gif: only png, jpeg or webp images')).toBeInTheDocument();
    expect(within(notice).getByText('huge.png: images must be 8 MB or smaller')).toBeInTheDocument();
    expect(within(notice).getByText('one-more.webm: attachments must total 100 MB or less')).toBeInTheDocument();
    expect(screen.getAllByTestId('report-video')).toHaveLength(1);
    expect(screen.queryByTestId('report-screenshot')).toBeNull();
  });

  it('holds screenshots to 10', () => {
    renderDialog();
    pick(Array.from({ length: 11 }, (_, i) => file(`s${i}.png`, 'image/png', 1000)));
    expect(screen.getAllByTestId('report-screenshot')).toHaveLength(10);
    expect(screen.getByTestId('report-attachment-notice')).toHaveTextContent('up to 10 screenshots per issue');
  });

  it('adds a pasted image, but leaves a paste carrying text to the text box', () => {
    renderDialog();
    const image = file('image.png', 'image/png', 1000);
    const imageItem = { kind: 'file', type: 'image/png', getAsFile: () => image };
    const textItem = { kind: 'string', type: 'text/plain', getAsFile: () => null };

    fireEvent.paste(screen.getByLabelText('description'), { clipboardData: { items: [textItem, imageItem] } });
    expect(screen.queryByTestId('report-screenshot')).toBeNull();

    fireEvent.paste(screen.getByLabelText('description'), { clipboardData: { items: [imageItem] } });
    expect(screen.getAllByTestId('report-screenshot')).toHaveLength(1);
  });

  it('removing a file revokes its preview and gives back its room', async () => {
    const { user } = renderDialog();
    pick([file('shot.png', 'image/png', 2 * MB), file('clip.mp4', 'video/mp4', 5 * MB)]);
    expect(screen.getByTestId('report-attachment-limit')).toHaveTextContent('7.0 of 100 MB used');

    await user.click(screen.getByRole('button', { name: 'remove screenshot' }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(screen.getByTestId('report-attachment-limit')).toHaveTextContent('5.0 of 100 MB used');

    await user.click(screen.getByRole('button', { name: 'remove clip.mp4' }));
    expect(screen.getByTestId('report-attachment-limit')).toHaveTextContent('up to 100 MB, or paste an image');
  });
});

describe('ReportBugDialog closing', () => {
  async function draft() {
    const onOpenChange = jest.fn();
    const view = render(<ReportBugDialog open onOpenChange={onOpenChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'i just need to vent' }));
    await describeIssue(user);
    pick([file('shot.png', 'image/png', 1000)]);
    const reopen = () => {
      view.rerender(<ReportBugDialog open={false} onOpenChange={onOpenChange} />);
      view.rerender(<ReportBugDialog open onOpenChange={onOpenChange} />);
    };
    return { onOpenChange, user, reopen };
  }

  it('cancel keeps the draft, and reopening shows it', async () => {
    const { onOpenChange, user, reopen } = await draft();
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    reopen();
    expect(screen.getByLabelText('description')).toHaveValue('the thing stopped');
    expect(screen.getByRole('combobox')).toHaveTextContent('i just need to vent');
    expect(screen.getByAltText('screenshot 1')).toHaveAttribute('src', 'blob:preview-1');
  });

  it('escape clears the draft and revokes its previews', async () => {
    const { onOpenChange, user, reopen } = await draft();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');

    reopen();
    expect(screen.getByLabelText('description')).toHaveValue('');
    expect(screen.getByRole('combobox')).toHaveTextContent('something broke');
    expect(screen.queryByTestId('report-screenshot')).toBeNull();
  });

  it('unmounting revokes the previews it still holds', async () => {
    const view = render(<ReportBugDialog open onOpenChange={jest.fn()} />);
    pick([file('shot.png', 'image/png', 1000)]);
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });
});
