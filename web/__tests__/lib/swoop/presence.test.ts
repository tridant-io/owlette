/**
 * @jest-environment jsdom
 */

import { attach, NO_PRESENCE, swoopPresence } from '@/lib/swoop/presence';
import type { SwoopSession } from '@/lib/swoop/features';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const ROSTER = [
  { id: 'viewer-a', name: 'uid_operator', ctl: true },
  { id: 'viewer-b', name: 'uid_watcher', ctl: false },
  { id: 'viewer-me', name: 'uid_me', ctl: true },
];

const roster = (viewers = ROSTER) => JSON.stringify({ t: 'roster', viewers, tsUs: 1_700_000 });

const vpos = (viewer: string, x: number, y: number, tsUs = 1_700_000) =>
  JSON.stringify({ t: 'vpos', viewer, x, y, tsUs });

interface Harness {
  session: SwoopSession;
  control(data: unknown): void;
  cursor(data: unknown): void;
  detach(): void;
}

function harness(): Harness {
  const handlers = new Map<string, (data: unknown) => void>();
  const session = {
    viewerId: 'viewer-me',
    onChannelMessage: (label: string, incoming: (data: unknown) => void) => {
      handlers.set(label, incoming);
      return () => {
        handlers.delete(label);
      };
    },
  } as unknown as SwoopSession;

  const detach = attach(session);
  return {
    session,
    control: (data) => handlers.get('swoop-control')?.(data),
    cursor: (data) => handlers.get('swoop-cursor')?.(data),
    detach,
  };
}

// ---------------------------------------------------------------------------

describe('swoop presence', () => {
  it('has nobody until the first roster lands', () => {
    const h = harness();
    expect(swoopPresence(h.session)?.get()).toBe(NO_PRESENCE);
    h.detach();
  });

  it('takes the roster and the control flags from the host', () => {
    const h = harness();
    h.control(roster());
    expect(swoopPresence(h.session)?.get().viewers).toEqual(ROSTER);
    h.detach();
  });

  it('replaces the roster whole, so a departure leaves no ghost', () => {
    const h = harness();
    h.control(roster());
    h.control(roster([ROSTER[0], ROSTER[2]]));
    expect(swoopPresence(h.session)?.get().viewers.map((v) => v.id)).toEqual([
      'viewer-a',
      'viewer-me',
    ]);
    h.detach();
  });

  it('draws another controller cursor but never its own', () => {
    const h = harness();
    h.control(roster());
    h.cursor(vpos('viewer-a', 0.25, 0.5));
    h.cursor(vpos('viewer-me', 0.9, 0.9));
    expect(swoopPresence(h.session)?.get().cursors).toEqual([
      { viewer: 'viewer-a', x: 0.25, y: 0.5, tsUs: 1_700_000 },
    ]);
    h.detach();
  });

  it('keeps one cursor per viewer, in id order', () => {
    const h = harness();
    h.control(roster());
    h.cursor(vpos('viewer-b', 0.1, 0.1));
    h.cursor(vpos('viewer-a', 0.2, 0.2));
    h.cursor(vpos('viewer-b', 0.3, 0.3, 1_700_001));
    expect(swoopPresence(h.session)?.get().cursors).toEqual([
      { viewer: 'viewer-a', x: 0.2, y: 0.2, tsUs: 1_700_000 },
      { viewer: 'viewer-b', x: 0.3, y: 0.3, tsUs: 1_700_001 },
    ]);
    h.detach();
  });

  it('drops the cursor of a viewer the next roster no longer names', () => {
    const h = harness();
    h.control(roster());
    h.cursor(vpos('viewer-a', 0.25, 0.5));
    h.control(roster([ROSTER[1], ROSTER[2]]));
    expect(swoopPresence(h.session)?.get().cursors).toEqual([]);
    h.detach();
  });

  /** the two channels are independent, so a position can outrun the roster. */
  it('ignores a cursor for somebody the roster has not named', () => {
    const h = harness();
    h.cursor(vpos('viewer-a', 0.25, 0.5));
    expect(swoopPresence(h.session)?.get().cursors).toEqual([]);
    h.control(roster());
    h.cursor(vpos('viewer-a', 0.25, 0.5));
    expect(swoopPresence(h.session)?.get().cursors).toHaveLength(1);
    h.detach();
  });

  it('is total: nothing on either channel throws or half-applies', () => {
    const h = harness();
    h.control(roster());
    const before = swoopPresence(h.session)?.get();
    for (const junk of [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ t: 'hello-host', displays: [] }),
      JSON.stringify({ t: 'roster' }),
      JSON.stringify({ t: 'roster', viewers: [{ id: 'x', name: 'x' }] }),
      JSON.stringify({ t: 'roster', viewers: [null] }),
      new Uint8Array([1, 2, 3]),
    ]) {
      expect(() => h.control(junk)).not.toThrow();
    }
    for (const junk of [
      'not json',
      JSON.stringify({ t: 'cpos', x: 0.5, y: 0.5, visible: true, tsUs: 1 }),
      JSON.stringify({ t: 'vpos', viewer: 'viewer-a' }),
      JSON.stringify({ t: 'vpos', viewer: 'viewer-a', x: Number.NaN, y: 0.5, tsUs: 1 }),
      JSON.stringify({ t: 'vpos', viewer: 42, x: 0.5, y: 0.5, tsUs: 1 }),
    ]) {
      expect(() => h.cursor(junk)).not.toThrow();
    }
    // a malformed roster never lands half of itself.
    expect(swoopPresence(h.session)?.get()).toBe(before);
    h.detach();
  });

  it('notifies subscribers and stops on detach', () => {
    const h = harness();
    let notified = 0;
    const off = swoopPresence(h.session)?.subscribe(() => {
      notified += 1;
    });
    h.control(roster());
    expect(notified).toBe(1);
    off?.();
    h.control(roster([ROSTER[0]]));
    expect(notified).toBe(1);
    h.detach();
    expect(swoopPresence(h.session)).toBeNull();
  });
});
