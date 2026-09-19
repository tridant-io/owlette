/**
 * @jest-environment jsdom
 */

import { attach, swoopDisplays } from '@/lib/swoop/displays';
import type { SwoopSession } from '@/lib/swoop/features';
import { encodeControlMessage, type ControlChannelMessage } from '@/lib/swoop/protocol';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** the 0.8 box: a 1080p primary and a rotated 4k panel, advertised as the
 *  un-rotated texture the browser is actually handed. */
const ROSTER = [
  { index: 0, width: 1920, height: 1080, primary: true },
  { index: 1, width: 3840, height: 2160, primary: false },
];

const helloHost = (
  displays: typeof ROSTER,
): Extract<ControlChannelMessage, { t: 'hello-host' }> => ({
  t: 'hello-host',
  codec: 'h264',
  width: 1920,
  height: 1080,
  displays,
  streamerEpoch: 1,
  protocolVersion: 1,
});

interface Harness {
  session: SwoopSession;
  sent: string[];
  /** false once the data channel is treated as closed. */
  open: { value: boolean };
  deliver(frame: ControlChannelMessage): void;
  detach(): void;
}

function harness(options: { ctl?: boolean } = {}): Harness {
  const sent: string[] = [];
  const open = { value: true };
  let handler: ((data: unknown) => void) | null = null;

  const session = {
    ctl: options.ctl ?? true,
    send: (label: string, data: string) => {
      if (!open.value) return false;
      if (label === 'swoop-control') sent.push(data);
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
    session,
    sent,
    open,
    deliver: (frame) => handler?.(encodeControlMessage(frame)),
    detach,
  };
}

// ---------------------------------------------------------------------------

describe('swoop display selection', () => {
  it('has no roster until hello-host lands', () => {
    const h = harness();
    expect(swoopDisplays(h.session)?.get()).toEqual({ displays: [], selected: null });
    h.detach();
  });

  it('takes the roster from hello-host and starts on the primary', () => {
    const h = harness();
    h.deliver(helloHost(ROSTER));
    // the primary is what the host opens at startup, not a guess.
    expect(swoopDisplays(h.session)?.get()).toEqual({ displays: ROSTER, selected: 0 });
    h.detach();
  });

  it('ignores control traffic that is not a roster', () => {
    const h = harness();
    h.deliver(helloHost(ROSTER));
    h.deliver({ t: 'lease-ok', expiresAt: 1 });
    h.deliver({ t: 'idr' });
    expect(swoopDisplays(h.session)?.get().displays).toEqual(ROSTER);
    h.detach();
  });

  it('sends a display switch and notifies subscribers', () => {
    const h = harness();
    const seen: number[] = [];
    const store = swoopDisplays(h.session);
    const off = store?.subscribe(() => seen.push(store.get().selected ?? -1));
    h.deliver(helloHost(ROSTER));

    expect(store?.select(1)).toBe(true);
    expect(h.sent).toEqual([JSON.stringify({ t: 'display', index: 1 })]);
    expect(store?.get().selected).toBe(1);
    expect(seen).toEqual([0, 1]);
    off?.();
    h.detach();
  });

  it('refuses a display that is not in the roster', () => {
    const h = harness();
    h.deliver(helloHost(ROSTER));
    expect(swoopDisplays(h.session)?.select(7)).toBe(false);
    expect(h.sent).toEqual([]);
    h.detach();
  });

  // the host is the enforcement point and denies a gated control message from a
  // viewer without ctl; not sending it keeps the audit trail free of attempts
  // the ui made on the user's behalf.
  it('sends nothing at all for a view-only viewer', () => {
    const h = harness({ ctl: false });
    h.deliver(helloHost(ROSTER));
    expect(swoopDisplays(h.session)?.select(1)).toBe(false);
    expect(h.sent).toEqual([]);
    h.detach();
  });

  it('does not move the selection when the channel refused the switch', () => {
    const h = harness();
    h.deliver(helloHost(ROSTER));
    h.open.value = false;
    expect(swoopDisplays(h.session)?.select(1)).toBe(false);
    expect(swoopDisplays(h.session)?.get().selected).toBe(0);
    h.detach();
  });

  it('forgets the store on detach', () => {
    const h = harness();
    h.deliver(helloHost(ROSTER));
    h.detach();
    expect(swoopDisplays(h.session)).toBeNull();
  });
});
