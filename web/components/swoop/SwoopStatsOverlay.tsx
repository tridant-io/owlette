'use client';

/**
 * the per-stage latency breakdown — capture, encode, send, arrive, decode,
 * present — plus the app-level rtt `feedback.ts` measures, and the path
 * profile with the cap that path carries.
 *
 * every number here already arrives through `FrameObservation`, resampled once
 * a second by `useSwoopSession`. this component must never arm a second
 * `requestVideoFrameCallback` chain on the video element to get its own, which
 * would double-count every presented frame.
 *
 * **the two clocks only meet in the `send → arrive` row.** the host stamps are
 * microseconds on the streamer's clock and the client stamps are
 * `performance.now()` milliseconds on ours, so crossing between them needs the
 * offset the ping/pong exchange measures — and before the first pong lands
 * there is no honest number to show, so that row and the total read as unknown
 * rather than as zero. every other row subtracts two stamps from one clock and
 * needs no offset at all.
 */

import { Fragment, useEffect, useState } from 'react';
import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopStats } from '@/hooks/useSwoopSession';
import type { FrameObservation } from '@/lib/swoop/video/receiver';
import type { SwoopCodec } from '@/lib/swoop/protocol';

export interface SwoopStatsOverlayProps {
  session: SwoopSession | null;
  stats: SwoopStats;
  /** the toolbar's toggle; the overlay is off by default. */
  open: boolean;
}

interface Row {
  label: string;
  ms: number | null;
}

const show = (ms: number | null): string => (ms === null ? '—' : `${ms.toFixed(1)} ms`);

/** the codec the picture is arriving in, from the frame's own meta record. */
const CODEC_LABEL: Record<SwoopCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };

export type SwoopPathProfile = 'direct' | 'relay-udp' | 'relay-tls';

/**
 * the read-out of `agent/swoop/src/transport/budget.rs`. the host classifies
 * the path from its own selected pair and is the only thing that enforces a
 * cap — this side re-derives the same answer from `getStats()` so the overlay
 * can say what is in force without a new field on a frozen wire type. the
 * numbers and the strings are that module's; keep the two in step.
 *
 * the fragment size is not shown: it comes from the relay path mtu spike 6.8
 * has not measured yet, and a placeholder here would read as a measurement.
 */
const PATH_BUDGETS: Record<SwoopPathProfile, { label: string; cap: string; reason: string }> = {
  direct: {
    label: 'direct',
    cap: '50 mbps / 60 fps',
    reason: 'peer to peer — no relay cap',
  },
  'relay-udp': {
    label: 'relayed (udp)',
    cap: '25 mbps / 60 fps',
    reason: 'relay shapes above ~50 mbps and ~5 kpps',
  },
  'relay-tls': {
    label: 'relayed (tls)',
    cap: '6 mbps / 30 fps',
    reason: 'tcp head-of-line blocking — fec off',
  },
};

/**
 * the selected candidate pair's local candidate, as the two fields the rust
 * classifier reads. an unknown token is the looser answer on both axes, for
 * the reason `budget.rs` gives: a session wrongly shown as degraded looks like
 * a bad network and reports nothing.
 */
export function classifyPath(report: RTCStatsReport): SwoopPathProfile | null {
  let local: { candidateType?: string; relayProtocol?: string } | undefined;
  report.forEach((entry) => {
    const stat = entry as { type?: string; state?: string; nominated?: boolean; localCandidateId?: string };
    if (stat.type !== 'candidate-pair' || stat.state !== 'succeeded' || stat.nominated === false) return;
    if (!stat.localCandidateId) return;
    local = report.get(stat.localCandidateId) as typeof local;
  });
  if (!local?.candidateType) return null;
  if (local.candidateType !== 'relay') return 'direct';
  const protocol = local.relayProtocol;
  return protocol === 'tcp' || protocol === 'tls' || protocol === 'ssltcp' ? 'relay-tls' : 'relay-udp';
}

/** how often the path is re-read. a forced-relay session has to show inside 2 s. */
const PATH_POLL_MS = 1000;

/**
 * the read carries the session it came from, so a second session's overlay
 * cannot show the first one's path for a poll — that is state the effect would
 * otherwise have to clear synchronously, which is a cascading render.
 */
function usePathProfile(session: SwoopSession | null, open: boolean): SwoopPathProfile | null {
  const [read, setRead] = useState<{ of: SwoopSession; profile: SwoopPathProfile | null } | null>(
    null,
  );

  useEffect(() => {
    if (!session || !open) return;
    let live = true;
    const poll = async () => {
      let report: RTCStatsReport;
      try {
        report = await session.peer.connection.getStats();
      } catch {
        // a closing peer: keep the last answer rather than flapping to unknown.
        return;
      }
      if (live) setRead({ of: session, profile: classifyPath(report) });
    };
    void poll();
    const timer = setInterval(() => void poll(), PATH_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session, open]);

  return read && read.of === session ? read.profile : null;
}

/**
 * the six stages, each the interval between two consecutive stamps. the last
 * one is the compositor's own phase (`expectedDisplayTime - presentationTime`),
 * which is the closest the user agent lets us get to photons.
 */
function stageRows(frame: FrameObservation | null, offsetUs: number | null): Row[] {
  if (!frame) {
    return [
      { label: 'capture → encode', ms: null },
      { label: 'encode → send', ms: null },
      { label: 'send → arrive', ms: null },
      { label: 'decode', ms: null },
      { label: 'wait for paint', ms: null },
      { label: 'paint → display', ms: null },
    ];
  }
  const { arrivalMs, decodeMs, presentedMs, expectedDisplayMs } = frame;
  return [
    { label: 'capture → encode', ms: (frame.tEncodeUs - frame.tCaptureUs) / 1000 },
    { label: 'encode → send', ms: (frame.tSendUs - frame.tEncodeUs) / 1000 },
    {
      label: 'send → arrive',
      ms:
        arrivalMs === null || offsetUs === null
          ? null
          : (arrivalMs * 1000 + offsetUs - frame.tSendUs) / 1000,
    },
    // the decoder's own time, as the ua reports it.
    { label: 'decode', ms: decodeMs },
    {
      // a decoded frame waits for the next paint: on a 60 hz display this
      // swings between 0 and one refresh (16.7 ms), and that is not decode.
      label: 'wait for paint',
      ms: arrivalMs === null || decodeMs === null ? null : presentedMs - (arrivalMs + decodeMs),
    },
    // the painted frame reaches the glass one refresh later.
    { label: 'paint → display', ms: expectedDisplayMs - presentedMs },
  ];
}

export function SwoopStatsOverlay({ session, stats, open }: SwoopStatsOverlayProps) {
  const path = usePathProfile(session, open);
  if (!open) return null;

  const budget = path ? PATH_BUDGETS[path] : null;
  const { frame, feedback, presenter } = stats;
  const offsetUs = feedback?.clockOffsetUs ?? null;
  const rows = stageRows(frame, offsetUs);
  const total =
    frame && offsetUs !== null
      ? (frame.expectedDisplayMs * 1000 + offsetUs - frame.tCaptureUs) / 1000
      : null;
  const ms = (us: number | null | undefined): number | null =>
    us === null || us === undefined ? null : us / 1000;

  return (
    <aside
      aria-label="latency breakdown"
      className="pointer-events-none absolute right-3 top-3 w-72 rounded-md border border-border bg-card/90 p-3 text-xs text-muted-foreground shadow-sm"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 whitespace-nowrap [&>dd]:tabular-nums">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd className="text-right font-mono text-foreground">{show(row.ms)}</dd>
          </Fragment>
        ))}
        <dt className="mt-1 border-t border-border pt-1">capture → display</dt>
        <dd className="mt-1 border-t border-border pt-1 text-right font-mono text-foreground">
          {show(total)}
        </dd>
        <dt>app rtt</dt>
        <dd className="text-right font-mono text-foreground">{show(ms(feedback?.rttUs))}</dd>
        <dt>delay rise</dt>
        <dd className="text-right font-mono text-foreground">{show(ms(feedback?.delayRiseUs))}</dd>
        <dt>resolution</dt>
        <dd className="text-right font-mono text-foreground">
          {presenter.width > 0 ? `${presenter.width}×${presenter.height}` : '—'}
        </dd>
        <dt>codec</dt>
        <dd className="text-right font-mono text-foreground">{frame ? CODEC_LABEL[frame.codec] : '—'}</dd>
        <dt>gaps / duplicates</dt>
        <dd className="text-right font-mono text-foreground">
          {presenter.gaps} / {presenter.duplicates}
        </dd>
        <dt className="mt-1 border-t border-border pt-1">path</dt>
        <dd className="mt-1 border-t border-border pt-1 text-right font-mono text-foreground">
          {budget ? budget.label : '—'}
        </dd>
        <dt>cap</dt>
        <dd className="text-right font-mono text-foreground">{budget ? budget.cap : '—'}</dd>
      </dl>
      {budget ? <p className="mt-1 leading-snug">{budget.reason}</p> : null}
    </aside>
  );
}
