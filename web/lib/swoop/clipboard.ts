/**
 * browser half of clipboard sync.
 *
 * clipboard traffic rides `swoop-control`, not a channel of its own: the
 * transport caps buffering at 128 KiB across all channels, so five channels is
 * one pacing budget. only a viewer whose verified jwt carries `ctl` may push to
 * the host, and the host is what enforces that — `session.ctl` here only stops
 * a watcher generating denials nobody can act on.
 *
 * four things about this file are not obvious:
 *
 * 1. **the clip comes from the `paste` event the real keystroke fires.** a
 *    capture-phase keydown on the window takes ctrl+v away from `input.ts`,
 *    which calls `preventDefault()` on every key it forwards, but leaves its
 *    default alone. that default is the browser's own paste, and it fires
 *    `paste` on the stage with the clipboard in hand and no permission to ask
 *    for. `navigator.clipboard.read()` does ask, its prompt is easy to miss and
 *    unseen in fullscreen, and a refusal is final: the build that read the
 *    clipboard itself never carried a paste to the host (owner, 2026-09-28).
 *    the keystroke is re-dispatched to the stage once the clip has gone. the
 *    host must have the clip before it has the ctrl+v, or it pastes what was
 *    there before.
 * 2. **every key is held while a paste is in flight, not just the v.** a keyup
 *    that overtook its keydown would leave the host holding a key down, and a
 *    large image takes seconds to send.
 * 3. **a browser that fires no `paste` still gets its keystroke through**,
 *    `PASTE_WAIT_MS` later and without a clip. the event is the keystroke's own
 *    default action, dispatched straight after it, so the wait is only ever
 *    served in full when it is not coming.
 * 4. **a transfer is paced by the channel's own buffer.** an image may be 15
 *    MiB, about 20 once encoded, and sent at once it would overrun chrome's
 *    16 MiB send buffer and hold the lease and keyframe requests that share
 *    `swoop-control` behind it. so chunks wait while more than 1 MiB is queued,
 *    and the held paste keystroke waits until the whole clip has left.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';
import {
  CLIPBOARD_MAX_CHUNK_BYTES,
  CLIPBOARD_MAX_IMAGE_BYTES,
  CLIPBOARD_MAX_TEXT_BYTES,
  decodeControlMessage,
  encodeControlMessage,
} from '@/lib/swoop/protocol';

/** how long a paste keystroke waits for the browser's `paste` before going without a clip. */
const PASTE_WAIT_MS = 300;

/** how much of a transfer may sit in the channel's buffer before the next chunk waits. */
const SEND_HIGH_WATER_BYTES = 1024 * 1024;
/** where it goes on: the buffer drained this far. */
const SEND_LOW_WATER_BYTES = 256 * 1024;
/**
 * a buffer that does not drain in this long belongs to a path too slow or too
 * dead to carry the rest, and the transfer is given up.
 */
const DRAIN_TIMEOUT_MS = 30_000;

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
  /** the last clip the host was sent, and the last it sent: what it holds already. */
  let lastPushed: ClipPayload | null = null;
  let lastReceived: ClipPayload | null = null;
  let waiting = false;
  /** a paste keystroke is held for the `paste` its default fires; this ends the wait. */
  let pasteWait: number | null = null;
  let held: KeyboardEvent[] = [];
  /** keys this module re-dispatched, so its own listener lets them past. */
  const replayed = new WeakSet<KeyboardEvent>();

  // ----------------------------------------------------------- viewer → host

  // true once the channel's buffer is down to `level`; false when the channel
  // closed or the buffer would not drain in time.
  const drainedTo = (channel: RTCDataChannel, level: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (channel.bufferedAmount <= level) {
        resolve(true);
        return;
      }
      const settle = (ok: boolean): void => {
        view.clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        resolve(ok);
      };
      // an event the browser queued under an earlier threshold can land after
      // this one is set, so the buffer is read rather than the event trusted.
      const onLow = (): void => {
        if (channel.bufferedAmount <= level) settle(true);
      };
      const onClose = (): void => settle(false);
      const timer = view.setTimeout(() => settle(false), DRAIN_TIMEOUT_MS);
      channel.bufferedAmountLowThreshold = level;
      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onClose);
    });

  const transfer = async (payload: ClipPayload): Promise<void> => {
    if (payload.bytes.length === 0 || payload.bytes.length > capFor(payload.fmt)) return;
    const channel = session.peer.channel('swoop-control');
    if (!channel) return;
    seq += 1;
    const id = seq;
    const chunks = Math.max(1, Math.ceil(payload.bytes.length / CLIPBOARD_MAX_CHUNK_BYTES));
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      if (detached) return;
      // paced by the channel's own buffer: a 4k screenshot handed over at once
      // sits whole in it, past chrome's 16 MiB limit, and the lease and keyframe
      // requests that share the channel wait behind it.
      if (channel.bufferedAmount > SEND_HIGH_WATER_BYTES && !(await drainedTo(channel, SEND_LOW_WATER_BYTES))) {
        return;
      }
      const start = chunk * CLIPBOARD_MAX_CHUNK_BYTES;
      session.send(
        'swoop-control',
        encodeControlMessage({
          t: 'clip',
          dir: 'to-host',
          fmt: payload.fmt,
          seq: id,
          chunk,
          chunks,
          totalBytes: payload.bytes.length,
          data: toBase64(payload.bytes.subarray(start, start + CLIPBOARD_MAX_CHUNK_BYTES)),
        }),
      );
    }
    lastPushed = payload;
    // the keystroke that pastes this rides another channel, so the clip leaves
    // this side entirely before the keystroke is let go.
    await drainedTo(channel, 0);
  };

  // one transfer at a time: interleaved, two are two corrupt pastes; queued,
  // the later clipboard still lands last. one that throws must not take every
  // later paste down with it.
  let sending: Promise<void> = Promise.resolve();
  const sendPayload = (payload: ClipPayload): Promise<void> => {
    sending = sending.then(() => transfer(payload)).catch(() => undefined);
    return sending;
  };

  const same = (a: ClipPayload | null, b: ClipPayload): boolean =>
    a !== null &&
    a.fmt === b.fmt &&
    a.bytes.length === b.bytes.length &&
    a.bytes.every((byte, at) => byte === b.bytes[at]);

  // a clip the host holds already is not pushed again. a mac whose pasteboard
  // owlette may not read never sends its copies here, so pushing this side's
  // stale clipboard before every paste would paste over the copy just made
  // there; the keystroke alone pastes what the host has.
  const hostHas = (clip: ClipPayload): boolean => same(lastPushed, clip) || same(lastReceived, clip);

  // the clipboard as the browser hands it to a paste, read inside the event,
  // which is the only place it can be read without asking. an image is
  // preferred, as the host prefers one.
  const payloadFrom = (data: DataTransfer | null): Promise<ClipPayload | null> => {
    if (!data) return Promise.resolve(null);
    const image = Array.from(data.items).find((item) => item.type === 'image/png')?.getAsFile();
    if (image) {
      return image.arrayBuffer().then(
        (buffer): ClipPayload => ({ fmt: 'png', bytes: new Uint8Array(buffer) }),
        () => null,
      );
    }
    const text = data.getData('text/plain');
    return Promise.resolve(text ? { fmt: 'text', bytes: new TextEncoder().encode(text) } : null);
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
      // a paste is in flight: everything queues, so the host sees the same
      // order the user typed.
      event.preventDefault();
      event.stopPropagation();
      held.push(event);
      return;
    }
    if (event.type !== 'keydown' || !isPasteKey(event)) return;

    // kept from `input.ts` but not prevented: its default is the browser's
    // paste, and the `paste` that fires is where the clip comes from.
    event.stopPropagation();
    held.push(event);
    waiting = true;
    pasteWait = view.setTimeout(() => settlePaste(null), PASTE_WAIT_MS);
  };

  // the paste keystroke's wait is over: its clip, if any, goes first and the
  // held keys follow it.
  const settlePaste = (payload: Promise<ClipPayload | null> | null): void => {
    if (pasteWait === null) return;
    view.clearTimeout(pasteWait);
    pasteWait = null;
    void (payload ?? Promise.resolve(null))
      .then((clip) => (clip && !hostHas(clip) ? sendPayload(clip) : undefined))
      .then(() => {
        waiting = false;
        forwardHeld();
      });
  };

  const onCopyOrCut = (event: ClipboardEvent): void => {
    // the machine's clipboard is the one that matters on this surface: let the
    // host's own copy come back as a to-viewer clip instead of letting the
    // browser overwrite the local clipboard with the page's empty selection.
    event.preventDefault();
  };

  const onPaste = (event: ClipboardEvent): void => {
    if (detached || !session.ctl) return;
    event.preventDefault();
    const payload = payloadFrom(event.clipboardData);
    if (pasteWait !== null) {
      settlePaste(payload);
      return;
    }
    // a paste with no keystroke held for it, such as the browser's own edit menu.
    void payload.then((clip) => {
      if (clip && !detached && !hostHas(clip)) void sendPayload(clip);
    });
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
    const received: ClipPayload = { fmt: transfer.fmt, bytes: whole };
    lastReceived = received;
    applyOrHold(received);
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
    if (pasteWait !== null) view.clearTimeout(pasteWait);
    pasteWait = null;
    held = [];
    inbound = null;
    pendingWrite = null;
  };
}
