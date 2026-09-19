/**
 * browser half of clipboard sync.
 *
 * clipboard traffic rides `swoop-control`, not a channel of its own: the
 * transport caps buffering at 128 KiB across all channels, so five channels is
 * one pacing budget. only a viewer whose verified jwt carries `ctl` may push to
 * the host, and the host is what enforces that — `session.ctl` here only stops
 * a watcher generating denials nobody can act on.
 *
 * three things about this file are not obvious:
 *
 * 1. **the paste keystroke is intercepted, not the `paste` event.** `input.ts`
 *    calls `preventDefault()` on every keydown it forwards, which is what stops
 *    the browser acting on ctrl+v locally — and with it the `paste` event that
 *    would have followed. so the read hangs off a capture-phase keydown on the
 *    window, which runs before the stage's own listeners, and the keystroke is
 *    re-dispatched to the stage **after** the clipboard read settles. the host
 *    must have the clip before it has the ctrl+v, or it pastes what was there
 *    before. the `paste` listener below still exists for the paths that do fire
 *    one, such as the browser's own edit menu.
 * 2. **every key is held while a read is in flight, not just the v.** a keyup
 *    that overtook its keydown would leave the host holding a key down, and a
 *    read that waits on a permission prompt is more than long enough for that.
 * 3. **whether reading the clipboard prompts is unmeasured.** spike 2.12
 *    measured read and write resolving on chrome and edge when permitted, but
 *    automation sets the permission state and so hides the prompt. so nothing
 *    here assumes a silent grant: the read is only ever started from the paste
 *    gesture, it is raced against a timeout so a prompt left open cannot swallow
 *    the keystroke, and a refusal is an ordinary outcome that costs the sync and
 *    nothing else.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';
import {
  CLIPBOARD_MAX_CHUNK_BYTES,
  CLIPBOARD_MAX_IMAGE_BYTES,
  CLIPBOARD_MAX_TEXT_BYTES,
  decodeControlMessage,
  encodeControlMessage,
} from '@/lib/swoop/protocol';

/** how long a paste keystroke waits for the clipboard before going without it. */
const READ_TIMEOUT_MS = 1_500;

type ClipFormat = 'text' | 'png';

interface ClipPayload {
  readonly fmt: ClipFormat;
  readonly bytes: Uint8Array;
}

/** a host→viewer transfer being reassembled. */
interface Inbound {
  seq: number;
  fmt: ClipFormat;
  chunks: number;
  next: number;
  totalBytes: number;
  parts: Uint8Array[];
  size: number;
}

/** §5's `data` is standard base64 with padding, which is what the host decodes. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const capFor = (fmt: ClipFormat): number =>
  fmt === 'text' ? CLIPBOARD_MAX_TEXT_BYTES : CLIPBOARD_MAX_IMAGE_BYTES;

/** ctrl+v, cmd+v and the shift+insert the host's own users still type. */
function isPasteKey(event: KeyboardEvent): boolean {
  if (event.code === 'KeyV') return (event.ctrlKey || event.metaKey) && !event.altKey;
  return event.code === 'Insert' && event.shiftKey;
}

export function attach(session: SwoopSession): SwoopDetach {
  const stage = session.stage;
  const view = stage.ownerDocument.defaultView;
  if (!view) return () => {};

  let detached = false;
  let seq = 0;
  let inbound: Inbound | null = null;
  /** the newest host clipboard the browser has not accepted yet. */
  let pendingWrite: ClipPayload | null = null;
  /** the browser refused a read; later pastes no longer wait on one. */
  let readRefused = false;
  let waiting = false;
  let held: KeyboardEvent[] = [];
  /** keys this module re-dispatched, so its own listener lets them past. */
  const replayed = new WeakSet<KeyboardEvent>();

  // ----------------------------------------------------------- viewer → host

  const sendPayload = (payload: ClipPayload): void => {
    if (payload.bytes.length === 0 || payload.bytes.length > capFor(payload.fmt)) return;
    seq += 1;
    const chunks = Math.max(1, Math.ceil(payload.bytes.length / CLIPBOARD_MAX_CHUNK_BYTES));
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const start = chunk * CLIPBOARD_MAX_CHUNK_BYTES;
      session.send(
        'swoop-control',
        encodeControlMessage({
          t: 'clip',
          dir: 'to-host',
          fmt: payload.fmt,
          seq,
          chunk,
          chunks,
          totalBytes: payload.bytes.length,
          data: toBase64(payload.bytes.subarray(start, start + CLIPBOARD_MAX_CHUNK_BYTES)),
        }),
      );
    }
  };

  const readClipboard = async (): Promise<ClipPayload | null> => {
    const clipboard = view.navigator?.clipboard;
    if (!clipboard) return null;
    // `read()` is the only one that can carry an image. it is tried first and
    // `readText()` is the fallback for the browsers that have only that.
    if (typeof clipboard.read === 'function') {
      try {
        const items = await clipboard.read();
        for (const item of items) {
          if (!item.types.includes('image/png')) continue;
          const blob = await item.getType('image/png');
          return { fmt: 'png', bytes: new Uint8Array(await blob.arrayBuffer()) };
        }
        for (const item of items) {
          if (!item.types.includes('text/plain')) continue;
          const blob = await item.getType('text/plain');
          return { fmt: 'text', bytes: new TextEncoder().encode(await blob.text()) };
        }
        return null;
      } catch {
        // falls through: a browser that refuses `read()` may still allow text.
      }
    }
    try {
      const text = await clipboard.readText();
      return text ? { fmt: 'text', bytes: new TextEncoder().encode(text) } : null;
    } catch {
      // a refusal, a prompt the user dismissed, or an insecure context. the
      // keystroke still goes to the host; only the sync is lost.
      readRefused = true;
      return null;
    }
  };

  const forwardHeld = (): void => {
    const queued = held;
    held = [];
    if (detached) return;
    for (const event of queued) {
      const replay = new KeyboardEvent(event.type, {
        code: event.code,
        key: event.key,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      replayed.add(replay);
      stage.dispatchEvent(replay);
    }
  };

  const onKeyCapture = (event: KeyboardEvent): void => {
    if (detached || replayed.has(event)) return;
    // the host refuses a push from a viewer without `ctl` and reports it, so a
    // watcher does not generate denials the operator cannot act on.
    if (!session.ctl) return;
    if (event.target !== stage && !stage.contains(event.target as Node | null)) return;

    if (waiting) {
      // a read is in flight: everything queues, so the host sees the same
      // order the user typed.
      event.preventDefault();
      event.stopPropagation();
      held.push(event);
      return;
    }
    if (event.type !== 'keydown' || !isPasteKey(event) || readRefused) return;

    event.preventDefault();
    event.stopPropagation();
    held.push(event);
    waiting = true;
    let settled = false;
    const finish = (payload: ClipPayload | null): void => {
      if (settled) return;
      settled = true;
      if (payload) sendPayload(payload);
      waiting = false;
      // the clip is on the wire before the keystroke that pastes it.
      forwardHeld();
    };
    const timer = view.setTimeout(() => finish(null), READ_TIMEOUT_MS);
    void readClipboard().then(
      (payload) => {
        view.clearTimeout(timer);
        finish(payload);
      },
      () => {
        view.clearTimeout(timer);
        finish(null);
      },
    );
  };

  const onCopyOrCut = (event: ClipboardEvent): void => {
    // the machine's clipboard is the one that matters on this surface: let the
    // host's own copy come back as a to-viewer clip instead of letting the
    // browser overwrite the local clipboard with the page's empty selection.
    event.preventDefault();
  };

  const onPaste = (event: ClipboardEvent): void => {
    if (detached || !session.ctl) return;
    const data = event.clipboardData;
    event.preventDefault();
    if (!data) return;
    const image = Array.from(data.items).find((item) => item.type === 'image/png')?.getAsFile();
    if (image) {
      void image.arrayBuffer().then((buffer) => {
        if (!detached) sendPayload({ fmt: 'png', bytes: new Uint8Array(buffer) });
      });
      return;
    }
    const text = data.getData('text/plain');
    if (text) sendPayload({ fmt: 'text', bytes: new TextEncoder().encode(text) });
  };

  // ----------------------------------------------------------- host → viewer

  const applyToClipboard = async (payload: ClipPayload): Promise<boolean> => {
    const clipboard = view.navigator?.clipboard;
    if (!clipboard) return false;
    try {
      if (payload.fmt === 'text') {
        await clipboard.writeText(new TextDecoder().decode(payload.bytes));
        return true;
      }
      if (typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
        return false;
      }
      const blob = new Blob([payload.bytes as BlobPart], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * a write is attempted the moment the clip lands and kept for the next user
   * gesture if the browser refuses it: a document that is not focused, and an
   * image write outside a live user activation, are both refusals rather than
   * errors. the newest clipboard supersedes an older one still waiting.
   */
  const applyOrHold = (payload: ClipPayload): void => {
    pendingWrite = payload;
    void applyToClipboard(payload).then((ok) => {
      if (ok && pendingWrite === payload) pendingWrite = null;
    });
  };

  const onActivation = (): void => {
    if (detached || !pendingWrite) return;
    // called synchronously from the gesture's own handler, which is what keeps
    // the write inside the activation window.
    applyOrHold(pendingWrite);
  };

  const receiveChunk = (data: unknown): void => {
    const decoded = decodeControlMessage(data);
    // a rejection here is ordinary: `swoop-control` carries the control traffic
    // too, and the caps are checked before a chunk is buffered.
    if (!decoded.ok || decoded.value.t !== 'clip') return;
    const clip = decoded.value;
    if (clip.dir !== 'to-viewer') return;

    if (clip.chunk === 0) {
      inbound = {
        seq: clip.seq,
        fmt: clip.fmt,
        chunks: clip.chunks,
        next: 0,
        totalBytes: clip.totalBytes,
        parts: [],
        size: 0,
      };
    }
    const transfer = inbound;
    if (
      !transfer ||
      transfer.seq !== clip.seq ||
      transfer.fmt !== clip.fmt ||
      transfer.chunks !== clip.chunks ||
      transfer.totalBytes !== clip.totalBytes ||
      transfer.next !== clip.chunk
    ) {
      inbound = null;
      return;
    }
    const bytes = fromBase64(clip.data);
    if (!bytes || transfer.size + bytes.length > transfer.totalBytes) {
      inbound = null;
      return;
    }
    transfer.parts.push(bytes);
    transfer.size += bytes.length;
    transfer.next += 1;
    if (transfer.next < transfer.chunks) return;

    inbound = null;
    if (transfer.size !== transfer.totalBytes) return;
    const whole = new Uint8Array(transfer.size);
    let at = 0;
    for (const part of transfer.parts) {
      whole.set(part, at);
      at += part.length;
    }
    applyOrHold({ fmt: transfer.fmt, bytes: whole });
  };

  view.addEventListener('keydown', onKeyCapture, true);
  view.addEventListener('keyup', onKeyCapture, true);
  stage.addEventListener('copy', onCopyOrCut);
  stage.addEventListener('cut', onCopyOrCut);
  stage.addEventListener('paste', onPaste);
  stage.addEventListener('pointerdown', onActivation, true);
  stage.addEventListener('keydown', onActivation, true);
  const offControl = session.onChannelMessage('swoop-control', receiveChunk);

  return () => {
    if (detached) return;
    detached = true;
    offControl();
    view.removeEventListener('keydown', onKeyCapture, true);
    view.removeEventListener('keyup', onKeyCapture, true);
    stage.removeEventListener('copy', onCopyOrCut);
    stage.removeEventListener('cut', onCopyOrCut);
    stage.removeEventListener('paste', onPaste);
    stage.removeEventListener('pointerdown', onActivation, true);
    stage.removeEventListener('keydown', onActivation, true);
    held = [];
    inbound = null;
    pendingWrite = null;
  };
}
