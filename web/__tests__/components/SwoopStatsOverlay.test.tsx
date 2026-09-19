/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the path indicator. the classifier is the half that can be wrong in a way
 * nobody notices — a relayed session shown as direct is a session running
 * above the cloudflare cap — so it is tested against the stats shapes
 * `getStats()` actually produces, including the ones it produces before a pair
 * is selected.
 */

import React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { SwoopStatsOverlay, classifyPath } from '@/components/swoop/SwoopStatsOverlay';
import type { SwoopPathProfile } from '@/components/swoop/SwoopStatsOverlay';
import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopStats } from '@/hooks/useSwoopSession';

const EMPTY_STATS = {
  signal: 'connected',
  presenter: { width: 0, height: 0, gaps: 0, duplicates: 0 },
  receiver: {},
  frame: null,
  feedback: null,
  leaseExpiresAt: 0,
} as unknown as SwoopStats;

/** a `getStats()` report: a map with the `get`/`forEach` the classifier uses. */
function report(entries: Record<string, unknown>): RTCStatsReport {
  return new Map(Object.entries(entries)) as unknown as RTCStatsReport;
}

const selectedPair = (localCandidateId: string) => ({
  type: 'candidate-pair',
  state: 'succeeded',
  nominated: true,
  localCandidateId,
});

function sessionWith(getStats: () => Promise<RTCStatsReport>): SwoopSession {
  return { peer: { connection: { getStats } } } as unknown as SwoopSession;
}

describe('classifyPath', () => {
  const cases: Array<[string, Record<string, unknown>, SwoopPathProfile | null]> = [
    ['nothing selected yet', {}, null],
    [
      'a host pair',
      { p: selectedPair('l'), l: { type: 'local-candidate', candidateType: 'host' } },
      'direct',
    ],
    [
      'a server-reflexive pair',
      { p: selectedPair('l'), l: { type: 'local-candidate', candidateType: 'srflx' } },
      'direct',
    ],
    [
      'a relay pair over udp',
      {
        p: selectedPair('l'),
        l: { type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp' },
      },
      'relay-udp',
    ],
    [
      'a relay pair over tls',
      {
        p: selectedPair('l'),
        l: { type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tls' },
      },
      'relay-tls',
    ],
    [
      'a relay pair over plain tcp is the same degraded path',
      {
        p: selectedPair('l'),
        l: { type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tcp' },
      },
      'relay-tls',
    ],
    [
      'a relay pair whose protocol the stats did not say',
      { p: selectedPair('l'), l: { type: 'local-candidate', candidateType: 'relay' } },
      'relay-udp',
    ],
    [
      'a pair that failed is not the selected one',
      {
        p: { type: 'candidate-pair', state: 'failed', nominated: true, localCandidateId: 'l' },
        l: { type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tls' },
      },
      null,
    ],
  ];

  it.each(cases)('%s', (_name, entries, want) => {
    expect(classifyPath(report(entries))).toBe(want);
  });
});

describe('SwoopStatsOverlay path indicator', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    // unmount before the fake timers go, so the poll cannot fire one more read
    // into a component the test has stopped looking at.
    cleanup();
    jest.useRealTimers();
  });

  /**
   * mount and flush the first `getStats()` read, which is awaited rather than
   * timed. two turns: one for the promise, one for the state it sets.
   */
  const mount = async (session: SwoopSession, open = true) => {
    await act(async () => {
      render(<SwoopStatsOverlay session={session} stats={EMPTY_STATS} open={open} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('names the path, the cap in force and why', async () => {
    const session = sessionWith(async () =>
      report({
        p: selectedPair('l'),
        l: { type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tls' },
      }),
    );
    await mount(session);

    expect(screen.getByText('relayed (tls)')).toBeInTheDocument();
    expect(screen.getByText('6 mbps / 30 fps')).toBeInTheDocument();
    expect(screen.getByText('tcp head-of-line blocking — fec off')).toBeInTheDocument();
  });

  it('shows the relay cap on a relayed udp path', async () => {
    const session = sessionWith(async () =>
      report({
        p: selectedPair('l'),
        l: { type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp' },
      }),
    );
    await mount(session);

    expect(screen.getByText('relayed (udp)')).toBeInTheDocument();
    expect(screen.getByText('25 mbps / 60 fps')).toBeInTheDocument();
  });

  it('reads the path inside one poll of connecting, not only on the next one', async () => {
    const getStats = jest.fn(async () =>
      report({ p: selectedPair('l'), l: { type: 'local-candidate', candidateType: 'host' } }),
    );
    await mount(sessionWith(getStats));

    expect(getStats).toHaveBeenCalledTimes(1);
    expect(screen.getByText('direct')).toBeInTheDocument();
  });

  it('polls, so a promotion off the relay is picked up mid-session', async () => {
    let candidateType = 'relay';
    const session = sessionWith(async () =>
      report({
        p: selectedPair('l'),
        l: { type: 'local-candidate', candidateType, relayProtocol: 'udp' },
      }),
    );
    await mount(session);
    expect(screen.getByText('relayed (udp)')).toBeInTheDocument();

    candidateType = 'srflx';
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('direct')).toBeInTheDocument();
  });

  it('says nothing about the path before a pair is selected', async () => {
    await mount(sessionWith(async () => report({})));

    expect(screen.getByText('path').nextSibling).toHaveTextContent('—');
  });

  it('reads no stats at all while the overlay is closed', async () => {
    const getStats = jest.fn(async () => report({}));
    await mount(sessionWith(getStats), false);

    expect(getStats).not.toHaveBeenCalled();
  });
});
