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

interface Harness {
  stage: HTMLElement;
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

function harness(options: { ctl?: boolean } = {}): Harness {
  const stage = document.createElement('div');
  stage.tabIndex = 0;
  document.body.appendChild(stage);

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
    send: (label: string, data: string) => {
      if (label === 'swoop-control') {
        sent.push(data);
        order.push('clip');
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

const attached = (options?: { ctl?: boolean }): Harness => {
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
