'use client';

/**
 * the per-stage latency breakdown — capture, encode, send, arrive, decode,
 * present — plus the app-level rtt `feedback.ts` measures. task 7.6 adds the
 * path profile.
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

import { Fragment } from 'react';
import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopStats } from '@/hooks/useSwoopSession';
import type { FrameObservation } from '@/lib/swoop/video/receiver';

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
      { label: 'arrive → decode', ms: null },
      { label: 'decode → present', ms: null },
      { label: 'present → display', ms: null },
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
    { label: 'arrive → decode', ms: decodeMs },
    {
      label: 'decode → present',
      ms: arrivalMs === null || decodeMs === null ? null : presentedMs - (arrivalMs + decodeMs),
    },
    { label: 'present → display', ms: expectedDisplayMs - presentedMs },
  ];
}

export function SwoopStatsOverlay({ stats, open }: SwoopStatsOverlayProps) {
  if (!open) return null;

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
      className="pointer-events-none absolute right-3 top-3 w-60 rounded-md border border-border bg-card/90 p-3 text-xs text-muted-foreground shadow-sm"
    >
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
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
        <dt>gaps / duplicates</dt>
        <dd className="text-right font-mono text-foreground">
          {presenter.gaps} / {presenter.duplicates}
        </dd>
      </dl>
    </aside>
  );
}
