// task 1.1's signaling golden vectors against the send-rights table of
// PROTOCOL.md section 2. the wire round-trip of the same vectors is in
// signal.test.ts; this file pins the table itself.

import { describe, expect, it } from 'vitest';

import { classifyClientMessage, fansToAgentSide, LIMITS, type Role } from '../src/messages';
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
    expect(LIMITS.messagesPerWindow).toBe(120);
    expect(LIMITS.viewersPerRoom).toBe(4);
    expect(LIMITS.ringsPerWindow).toBe(10);
    expect(LIMITS.ringWindowMs).toBe(60000);
    // serializeAttachment()'s documented hard limit.
    expect(LIMITS.attachmentBytes).toBe(16384);
  });
});
