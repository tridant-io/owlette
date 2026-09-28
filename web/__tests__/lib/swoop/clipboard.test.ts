/**
 * @jest-environment jsdom
 */

import { TextDecoder, TextEncoder } from 'node:util';

import { attach } from '@/lib/swoop/clipboard';
import type { SwoopSession } from '@/lib/swoop/features';
import {
  encodeControlMessage,
  type ClipboardMessage,
  type ControlChannelMessage,
} from '@/lib/swoop/protocol';

// jsdom ships neither, and clipboard.ts uses both the way every browser has
// them.
Object.assign(globalThis, { TextEncoder, TextDecoder });

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/**
 * the `swoop-control` data channel's send buffer, which a transfer paces itself
 * by. it only fills when the harness asks it to buffer.
 */
class FakeChannel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;

  /** empty the buffer to `to`, firing the event the browser fires on the way down. */
  drain(to = 0): void {
    const was = this.bufferedAmount;
    this.bufferedAmount = to;
    if (was > this.bufferedAmountLowThreshold && to <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
  }
}

interface Harness {
  stage: HTMLElement;
  channel: FakeChannel;
  /** every `swoop-control` payload the feature sent. */
  sent: string[];
  /** what a listener where `input.ts` binds actually saw. */
  forwarded: KeyboardEvent[];
  /** 'clip' and 'key' in the order they happened. */
  order: string[];
  /** one inbound `swoop-control` frame, as the data channel delivers it. */
  deliver(frame: ControlChannelMessage): void;
  detach(): void;
}

function harness(options: { ctl?: boolean; buffering?: boolean } = {}): Harness {
  const stage = document.createElement('div');
  stage.tabIndex = 0;
  document.body.appendChild(stage);

  const channel = new FakeChannel();
  const sent: string[] = [];
  const forwarded: KeyboardEvent[] = [];
  const order: string[] = [];
  let handler: ((data: unknown) => void) | null = null;

  // stands in for the input capture: a bubble-phase listener on the stage,
  // which is exactly where `attachInputCapture` binds.
  const record = (event: KeyboardEvent): void => {
    forwarded.push(event);
    order.push('key');
  };
  stage.addEventListener('keydown', record);
  stage.addEventListener('keyup', record);

  const session = {
    ctl: options.ctl ?? true,
    stage,
    peer: { channel: (label: string) => (label === 'swoop-control' ? channel : null) },
    send: (label: string, data: string) => {
      if (label === 'swoop-control') {
        sent.push(data);
        order.push('clip');
        if (options.buffering) channel.bufferedAmount += data.length;
      }
      return true;
    },
    onChannelMessage: (_label: string, incoming: (data: unknown) => void) => {
      handler = incoming;
      return () => {
        handler = null;
      };
    },
  } as unknown as SwoopSession;

  const detach = attach(session);
  return {
    stage,
    channel,
    sent,
    forwarded,
    order,
    deliver: (frame) => handler?.(encodeControlMessage(frame)),
    detach,
  };
}

function withClipboard(clipboard: Partial<Clipboard>): void {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: clipboard,
    configurable: true,
    writable: true,
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const key = (code: string, type = 'keydown', init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });

const pasteKey = (): KeyboardEvent => key('KeyV', 'keydown', { key: 'v', ctrlKey: true });

const toHost = (data: string): ClipboardMessage => ({
  t: 'clip',
  dir: 'to-viewer',
  fmt: 'text',
  seq: 1,
  chunk: 0,
  chunks: 1,
  totalBytes: new TextEncoder().encode(data).length,
  data: btoa(data),
});

const detaches: Harness[] = [];
afterEach(() => {
  while (detaches.length > 0) detaches.pop()?.detach();
  document.body.innerHTML = '';
});

const attached = (options?: { ctl?: boolean; buffering?: boolean }): Harness => {
  const h = harness(options);
  detaches.push(h);
  return h;
};

// ---------------------------------------------------------------------------
// paste interception
// ---------------------------------------------------------------------------

describe('paste interception', () => {
  it('holds the keystroke until the clipboard read resolves, then sends the clip first', async () => {
    let resolveRead: (text: string) => void = () => {};
    withClipboard({
      readText: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    });
    const h = attached();

    h.stage.dispatchEvent(pasteKey());
    expect(h.forwarded).toHaveLength(0);
    expect(h.sent).toHaveLength(0);

    resolveRead('pasted from the browser');
    await flush();

    expect(h.order).toEqual(['clip', 'key']);
    const clip = JSON.parse(h.sent[0]) as ClipboardMessage;
    expect(clip).toMatchObject({ t: 'clip', dir: 'to-host', fmt: 'text', chunk: 0, chunks: 1 });
    expect(atob(clip.data)).toBe('pasted from the browser');
    expect(h.forwarded.map((event) => event.code)).toEqual(['KeyV']);
  });

  it('holds every key typed while the read is in flight, in order', async () => {
    let resolveRead: (text: string) => void = () => {};
    withClipboard({
      readText: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    });
    const h = attached();

    h.stage.dispatchEvent(pasteKey());
    h.stage.dispatchEvent(key('KeyV', 'keyup', { key: 'v', ctrlKey: true }));
    h.stage.dispatchEvent(key('KeyA'));
    expect(h.forwarded).toHaveLength(0);

    resolveRead('pasted');
    await flush();

    expect(h.forwarded.map((event) => `${event.type}:${event.code}`)).toEqual([
      'keydown:KeyV',
      'keyup:KeyV',
      'keydown:KeyA',
    ]);
  });

  it('forwards the keystroke anyway when the browser refuses the read', async () => {
    withClipboard({
      readText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });
    const h = attached();

    h.stage.dispatchEvent(pasteKey());
    await flush();

    expect(h.sent).toHaveLength(0);
    expect(h.forwarded.map((event) => event.code)).toEqual(['KeyV']);

    // a second paste no longer waits on a read that has already been refused.
    h.stage.dispatchEvent(pasteKey());
    expect(h.forwarded).toHaveLength(2);
  });

  it('leaves a watcher alone entirely', async () => {
    withClipboard({ readText: () => Promise.resolve('never read') });
    const h = attached({ ctl: false });

    h.stage.dispatchEvent(pasteKey());
    await flush();

    expect(h.sent).toHaveLength(0);
    expect(h.forwarded.map((event) => event.code)).toEqual(['KeyV']);
  });

  it('does not intercept an ordinary keystroke', () => {
    withClipboard({ readText: () => Promise.resolve('not this') });
    const h = attached();

    h.stage.dispatchEvent(key('KeyA'));
    expect(h.forwarded.map((event) => event.code)).toEqual(['KeyA']);
    expect(h.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// host → viewer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pacing
// ---------------------------------------------------------------------------

const CHUNK = 16 * 1024;

/** a clipboard whose `read()` holds one png of these bytes. */
function withImage(bytes: Uint8Array): void {
  const blob = { arrayBuffer: () => Promise.resolve(bytes.buffer) } as unknown as Blob;
  withClipboard({
    read: () => Promise.resolve([{ types: ['image/png'], getType: () => Promise.resolve(blob) } as unknown as ClipboardItem]),
  });
}

/** a paste event as the browser's own edit menu fires it. */
function pasteEvent(data: { image?: Uint8Array; text?: string }): Event {
  const items = data.image
    ? [{ type: 'image/png', getAsFile: () => ({ arrayBuffer: () => Promise.resolve(data.image!.buffer) }) }]
    : [];
  return Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
    clipboardData: { items, getData: (type: string) => (type === 'text/plain' ? (data.text ?? '') : '') },
  });
}

describe('pacing', () => {
  it('paces a large image by the channel buffer and lets the paste go only once the clip has left', async () => {
    const image = new Uint8Array(3 * 1024 * 1024).fill(7);
    const total = Math.ceil(image.length / CHUNK);
    withImage(image);
    const h = attached({ buffering: true });

    h.stage.dispatchEvent(pasteKey());
    await flush();

    // it stopped once more than 1 MiB was waiting, keystroke still held.
    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.sent.length).toBeLessThan(total);
    expect(h.channel.bufferedAmount).toBeGreaterThan(1024 * 1024);
    expect(h.forwarded).toHaveLength(0);

    while (h.sent.length < total) {
      h.channel.drain();
      await flush();
    }
    // every chunk is handed over, but the tail is still in the buffer.
    expect(h.forwarded).toHaveLength(0);

    h.channel.drain();
    await flush();
    expect(h.forwarded.map((event) => event.code)).toEqual(['KeyV']);
    expect(h.order.at(-1)).toBe('key');
    expect(JSON.parse(h.sent[0]) as ClipboardMessage).toMatchObject({
      fmt: 'png',
      chunk: 0,
      chunks: total,
      totalBytes: image.length,
    });
  });

  it('holds the paste through a low-buffer event that no longer describes the buffer', async () => {
    withClipboard({ readText: () => Promise.resolve('queued') });
    const h = attached({ buffering: true });

    h.stage.dispatchEvent(pasteKey());
    await flush();
    expect(h.sent).toHaveLength(1);

    // a crossing the browser queued under an earlier threshold, landing late.
    h.channel.dispatchEvent(new Event('bufferedamountlow'));
    await flush();
    expect(h.forwarded).toHaveLength(0);

    h.channel.drain();
    await flush();
    expect(h.forwarded.map((event) => event.code)).toEqual(['KeyV']);
  });

  it('gives up on a clip whose channel never drains, and lets the paste go anyway', async () => {
    jest.useFakeTimers();
    try {
      withImage(new Uint8Array(3 * 1024 * 1024));
      const h = attached({ buffering: true });

      h.stage.dispatchEvent(pasteKey());
      await jest.advanceTimersByTimeAsync(0);
      const sentBefore = h.sent.length;
      expect(h.forwarded).toHaveLength(0);

      await jest.advanceTimersByTimeAsync(30_000);
      expect(h.sent.length).toBe(sentBefore);
      expect(h.forwarded.map((event) => event.code)).toEqual(['KeyV']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends one clip at a time, so a later paste lands after the one still going', async () => {
    const image = new Uint8Array(3 * 1024 * 1024);
    const h = attached({ buffering: true });

    h.stage.dispatchEvent(pasteEvent({ image }));
    await flush();
    h.stage.dispatchEvent(pasteEvent({ text: 'pasted after' }));
    await flush();

    while (h.channel.bufferedAmount > 0) {
      h.channel.drain();
      await flush();
    }
    const sequences = h.sent.map((payload) => (JSON.parse(payload) as ClipboardMessage).seq);
    expect(sequences).toEqual([...Array(Math.ceil(image.length / CHUNK)).fill(1), 2]);
    expect(atob((JSON.parse(h.sent.at(-1)!) as ClipboardMessage).data)).toBe('pasted after');
  });
});

describe('applying the host clipboard', () => {
  it('writes inside the next user activation when the first attempt is refused', async () => {
    const writes: string[] = [];
    let allowed = false;
    withClipboard({
      writeText: (text: string) => {
        if (!allowed) return Promise.reject(new DOMException('denied', 'NotAllowedError'));
        writes.push(text);
        return Promise.resolve();
      },
    });
    const h = attached();

    h.deliver(toHost('copied on the machine'));
    await flush();
    expect(writes).toHaveLength(0);

    // the gesture: the write is issued from the handler itself, which is what
    // keeps it inside the activation window.
    allowed = true;
    h.stage.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(writes).toEqual(['copied on the machine']);

    // and it is not written twice on the next gesture.
    h.stage.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(writes).toEqual(['copied on the machine']);
  });

  it('writes a clip the browser accepts straight away', async () => {
    const writes: string[] = [];
    withClipboard({
      writeText: (text: string) => {
        writes.push(text);
        return Promise.resolve();
      },
    });
    const h = attached();

    h.deliver(toHost('straight through'));
    await flush();
    expect(writes).toEqual(['straight through']);
  });

  it('reassembles a chunked transfer and ignores a chunk that does not fit it', async () => {
    const writes: string[] = [];
    withClipboard({
      writeText: (text: string) => {
        writes.push(text);
        return Promise.resolve();
      },
    });
    const h = attached();

    const whole = 'a longer clipboard, in two chunks';
    const first = whole.slice(0, 10);
    const second = whole.slice(10);
    const frame = (chunk: number, data: string): ClipboardMessage => ({
      t: 'clip',
      dir: 'to-viewer',
      fmt: 'text',
      seq: 4,
      chunk,
      chunks: 2,
      totalBytes: whole.length,
      data: btoa(data),
    });

    h.deliver(frame(0, first));
    await flush();
    expect(writes).toHaveLength(0);
    h.deliver(frame(1, second));
    await flush();
    expect(writes).toEqual([whole]);

    // a tail with no transfer open is dropped rather than written.
    h.deliver(frame(1, second));
    await flush();
    expect(writes).toEqual([whole]);
  });

  it('ignores a to-host clip and anything that is not clipboard traffic', async () => {
    const writes: string[] = [];
    withClipboard({
      writeText: (text: string) => {
        writes.push(text);
        return Promise.resolve();
      },
    });
    const h = attached();

    h.deliver({ ...toHost('our own push'), dir: 'to-host' });
    h.deliver({ t: 'idr' });
    await flush();
    expect(writes).toHaveLength(0);
  });
});
