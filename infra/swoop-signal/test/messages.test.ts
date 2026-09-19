// task 1.1's signaling golden vectors against the send-rights table of
// PROTOCOL.md section 2. the wire round-trip of the same vectors is in
// signal.test.ts; this file pins the table itself.

import { describe, expect, it } from 'vitest';

import { classifyClientMessage, classifyFrame, fansToAgentSide, LIMITS, type Role } from '../src/messages';
import { readVector, vectorsOfKind } from './vectors';

interface SignalingVector {
  sender: { role: Role | 'server'; id: string };
  message: Record<string, unknown>;
}

describe('golden signaling vectors', () => {
  const vectors = vectorsOfKind('signaling');

  it('covers every signaling vector in the manifest', () => {
    expect(vectors.length).toBe(12);
  });

  for (const entry of vectors) {
    it(`${entry.file} -> ${entry.expect} (${entry.reason})`, () => {
      const vector = readVector<SignalingVector>(entry.file);
      const type = vector.message.type;

      if (vector.sender.role === 'server') {
        // a server-only type is refused from every client role, so no client can
        // forge a ring or a kill over its own socket.
        for (const role of ['viewer', 'host', 'doorbell'] as Role[]) {
          expect(classifyClientMessage(type, role)).toEqual({ ok: false, code: 'forbidden_type' });
        }
        expect(entry.expect).toBe('accept');
        return;
      }

      const verdict = classifyClientMessage(type, vector.sender.role);
      if (entry.expect === 'accept') expect(verdict).toEqual({ ok: true });
      else expect(verdict).toEqual({ ok: false, code: entry.reason });
    });
  }
});

describe('send rights', () => {
  it('lets only a viewer offer and only a host answer', () => {
    expect(classifyClientMessage('offer', 'viewer')).toEqual({ ok: true });
    expect(classifyClientMessage('offer', 'host')).toEqual({ ok: false, code: 'wrong_role' });
    expect(classifyClientMessage('answer', 'host')).toEqual({ ok: true });
    expect(classifyClientMessage('answer', 'viewer')).toEqual({ ok: false, code: 'wrong_role' });
  });

  it('lets a doorbell send nothing at all', () => {
    for (const type of ['offer', 'answer', 'candidate', 'host-ready', 'bye']) {
      expect(classifyClientMessage(type, 'doorbell')).toEqual({ ok: false, code: 'wrong_role' });
    }
  });

  it('refuses an unrecognised type and a non-string type', () => {
    expect(classifyClientMessage('whatever', 'viewer')).toEqual({ ok: false, code: 'unknown_type' });
    expect(classifyClientMessage(undefined, 'viewer')).toEqual({ ok: false, code: 'unknown_type' });
    // a prototype key is not a message type.
    expect(classifyClientMessage('constructor', 'viewer')).toEqual({ ok: false, code: 'unknown_type' });
  });

  it('sends viewer traffic to the agent side and agent traffic to viewers', () => {
    expect(fansToAgentSide('viewer')).toBe(true);
    expect(fansToAgentSide('host')).toBe(false);
    expect(fansToAgentSide('doorbell')).toBe(false);
  });
});

describe('flood limits', () => {
  it('pins the numbers the room enforces', () => {
    expect(LIMITS.messageBytes).toBe(65536);
    expect(LIMITS.messageWindowMs).toBe(10000);
    expect(LIMITS.trickleFramesPerWindow).toBe(600);
    expect(LIMITS.trickleFrameBytes).toBe(4096);
    expect(LIMITS.controlFramesPerWindow).toBe(40);
    expect(LIMITS.viewersPerRoom).toBe(4);
    expect(LIMITS.ringsPerWindow).toBe(10);
    expect(LIMITS.ringWindowMs).toBe(60000);
    // serializeAttachment()'s documented hard limit.
    expect(LIMITS.attachmentBytes).toBe(16384);
  });

  it('keeps the byte ceiling of a full window below the single budget it replaced', () => {
    // the trickle budget is five times the old one in frames, so the guarantee
    // that matters is bytes: a socket that spends both budgets to the last frame
    // still costs the room less than 120 frames of 64 KiB did.
    const worst =
      LIMITS.trickleFramesPerWindow * LIMITS.trickleFrameBytes +
      LIMITS.controlFramesPerWindow * LIMITS.messageBytes;
    expect(worst).toBeLessThan(120 * LIMITS.messageBytes);
  });
});

describe('which budget a frame pays from', () => {
  const candidate = (extra = '') =>
    JSON.stringify({ type: 'candidate', candidate: `candidate:1${extra}`, sdpMid: '0', sdpMLineIndex: 0 });

  it('puts a real trickle candidate on the trickle budget, from either peer', () => {
    for (const role of ['viewer', 'host'] as Role[]) {
      expect(classifyFrame(candidate(), role)).toMatchObject({ ok: true, trickle: true });
    }
  });

  it('leaves every other accepted type on the control budget', () => {
    expect(classifyFrame(JSON.stringify({ type: 'offer', sdp: 'v=0' }), 'viewer')).toMatchObject({
      ok: true,
      trickle: false,
    });
    expect(classifyFrame(JSON.stringify({ type: 'answer', sdp: 'v=0' }), 'host')).toMatchObject({
      ok: true,
      trickle: false,
    });
    expect(classifyFrame(JSON.stringify({ type: 'bye' }), 'viewer')).toMatchObject({ ok: true, trickle: false });
  });

  it('refuses a frame the way section 2 says, and never calls a refusal trickle', () => {
    // a refusal on the trickle budget would let garbage buy 600 frames a window.
    expect(classifyFrame(new ArrayBuffer(4), 'viewer')).toEqual({ ok: false, refusal: 'binary_unsupported' });
    expect(classifyFrame('x'.repeat(LIMITS.messageBytes + 1), 'viewer')).toEqual({
      ok: false,
      refusal: 'message_too_large',
    });
    expect(classifyFrame('{', 'viewer')).toEqual({ ok: false, refusal: 'malformed_message' });
    expect(classifyFrame('[]', 'viewer')).toEqual({ ok: false, refusal: 'malformed_message' });
    expect(classifyFrame('null', 'viewer')).toEqual({ ok: false, refusal: 'malformed_message' });
    expect(classifyFrame(JSON.stringify({ type: 'kill' }), 'viewer')).toEqual({
      ok: false,
      refusal: 'forbidden_type',
    });
    expect(classifyFrame(candidate(), 'doorbell')).toEqual({ ok: false, refusal: 'wrong_role' });
  });

  it('keeps an oversized candidate off the trickle budget while still forwarding it', () => {
    // otherwise the trickle budget would be 600 x 64 KiB rather than 600 x 4 KiB.
    const fat = candidate('x'.repeat(LIMITS.trickleFrameBytes));
    expect(fat.length).toBeGreaterThan(LIMITS.trickleFrameBytes);
    expect(classifyFrame(fat, 'host')).toMatchObject({ ok: true, trickle: false });
  });
});
