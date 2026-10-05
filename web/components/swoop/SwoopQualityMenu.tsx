'use client';

/**
 * the quality ceiling — bandwidth, resolution, frame rate and codec preference.
 * one row per axis, showing what is chosen, with its options in a submenu: all
 * four lists at once ran to twenty rows and hid what was set.
 *
 * a preset is a ceiling, not a setting: the host's governor still adapts below
 * it, so the menu never promises a rate the session will actually hold. that is
 * why the footer says so out loud and why nothing here reports a live number —
 * the stats overlay owns what is actually happening.
 *
 * **three of the four axes go out on §5's `quality`, and the fourth cannot.**
 * the wire message is `{ preset, maxBitrateKbps, maxFps }` and the host's
 * `signal::messages` is `deny_unknown_fields`, so the two numbers carry their
 * own axes and `preset` carries the resolution cap — the only one without a
 * field. `agent/swoop/src/session/quality.rs` reads exactly that.
 *
 * codec preference is not a control message at all. the host picks the codec by
 * reading the browser's **offer** (`session::pick_codec`), so the preference is
 * applied to the transceiver and takes effect at the next negotiation, which is
 * why its submenu says "on reconnect" rather than pretending to switch mid-session.
 * the options come from `probeClientCaps`, never from a webcodecs probe: spike
 * 2.12 measured edge exposing no `video/H265` to `RTCRtpReceiver` on the same
 * box where it decodes hevc happily through webcodecs, and offering hevc there
 * would negotiate a stream it cannot show.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { probeClientCaps } from '@/lib/swoop/clientCaps';
import { encodeControlMessage, type SwoopCodec } from '@/lib/swoop/protocol';
import type { SwoopSession } from '@/lib/swoop/features';
import { useBarMenuPlacement } from '@/components/swoop/barMenuPlacement';

/** kbps, because that is the unit the wire uses. `0` means "unstated". */
const BANDWIDTH: { value: number; label: string }[] = [
  { value: 0, label: 'auto' },
  { value: 5_000, label: '5 mbps' },
  { value: 10_000, label: '10 mbps' },
  { value: 20_000, label: '20 mbps' },
  { value: 30_000, label: '30 mbps' },
  { value: 50_000, label: '50 mbps' },
  { value: 80_000, label: '80 mbps' },
  { value: 100_000, label: '100 mbps' },
];

/** the `preset` tokens `ResolutionCap::parse` knows. `native` caps nothing. */
const RESOLUTION = ['native', '1440p', '1080p', '720p'] as const;

const FRAME_RATE = [60, 30];

type CodecPreference = 'auto' | SwoopCodec;

interface Ceiling {
  /** kbps on the wire; `0` is "unstated" and the host takes its own default. */
  bandwidth: number;
  resolution: string;
  fps: number;
  codec: CodecPreference;
}

const DEFAULTS: Ceiling = { bandwidth: 0, resolution: 'native', fps: 60, codec: 'auto' };

/** av1 is in the protocol's codec union but no host encodes it yet (plan.md
 *  d5), so it is here for the mapping and never reaches the menu — the options
 *  come from what the receiver advertises, not from this table. */
const MIME: Record<SwoopCodec, string> = {
  hevc: 'video/h265',
  h264: 'video/h264',
  av1: 'video/av1',
};

/**
 * put the preferred codec first on the video transceiver, or hand back the
 * browser's own order for `auto`. a no-op on a browser without the api — the
 * host answers with whatever the offer actually carries either way.
 */
function applyCodecPreference(session: SwoopSession, preference: CodecPreference): void {
  if (typeof RTCRtpReceiver === 'undefined') return;
  const transceiver = session.peer.connection
    .getTransceivers()
    .find((candidate) => candidate.receiver.track?.kind === 'video');
  if (typeof transceiver?.setCodecPreferences !== 'function') return;
  try {
    const all = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
    if (preference === 'auto') {
      transceiver.setCodecPreferences([]);
      return;
    }
    const wanted = MIME[preference];
    const preferred = all.filter((codec) => codec.mimeType.toLowerCase() === wanted);
    // never narrow the offer to one codec: a preference that removed the rest
    // would turn a host with no hevc encoder into a session with no video.
    if (preferred.length > 0) {
      transceiver.setCodecPreferences([...preferred, ...all.filter((codec) => !preferred.includes(codec))]);
    }
  } catch {
    // an invalid preference list throws rather than degrading; the browser's
    // own order is a fine answer and the session keeps running.
  }
}

/** one axis: its name, what is chosen, and the options a level down. */
function Axis({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          {label}
          <span className="text-xs text-muted-foreground">{value}</span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent>{children}</DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

export interface SwoopQualityMenuProps {
  session: SwoopSession | null;
}

export function SwoopQualityMenu({ session }: SwoopQualityMenuProps) {
  const menuPlacement = useBarMenuPlacement();
  const [ceiling, setCeiling] = useState<Ceiling>(DEFAULTS);
  const [owner, setOwner] = useState(session);
  const [offerable, setOfferable] = useState<SwoopCodec[]>([]);

  // a new session starts at the host's own default, so the menu does too rather
  // than showing a ceiling the host was never told about. adjusted in render
  // rather than in an effect, which would render the stale ceiling first.
  if (owner !== session) {
    setOwner(session);
    setCeiling(DEFAULTS);
  }

  useEffect(() => {
    let live = true;
    void probeClientCaps().then((caps) => {
      if (live) setOfferable(caps.codecs);
    });
    return () => {
      live = false;
    };
  }, []);

  const update = (next: Partial<Ceiling>) => {
    const merged = { ...ceiling, ...next };
    setCeiling(merged);
    if (!session) return;
    if (next.codec !== undefined) {
      applyCodecPreference(session, merged.codec);
      return;
    }
    session.send(
      'swoop-control',
      encodeControlMessage({
        t: 'quality',
        preset: merged.resolution,
        maxBitrateKbps: merged.bandwidth,
        maxFps: merged.fps,
      }),
    );
  };

  const live = session !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" disabled={!live} aria-label="quality ceiling">
          <SlidersHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent {...menuPlacement} align="end" className="w-56">
        <Axis
          label="bandwidth"
          value={BANDWIDTH.find((option) => option.value === ceiling.bandwidth)?.label ?? 'auto'}
        >
          <DropdownMenuRadioGroup
            value={String(ceiling.bandwidth)}
            onValueChange={(value) => update({ bandwidth: Number(value) })}
          >
            {BANDWIDTH.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={String(option.value)}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </Axis>

        <Axis label="resolution" value={ceiling.resolution}>
          <DropdownMenuRadioGroup
            value={ceiling.resolution}
            onValueChange={(value) => update({ resolution: value })}
          >
            {RESOLUTION.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {option}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </Axis>

        <Axis label="frame rate" value={`${ceiling.fps} fps`}>
          <DropdownMenuRadioGroup
            value={String(ceiling.fps)}
            onValueChange={(value) => update({ fps: Number(value) })}
          >
            {FRAME_RATE.map((option) => (
              <DropdownMenuRadioItem key={option} value={String(option)}>
                {option} fps
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </Axis>

        <Axis label="codec" value={ceiling.codec}>
          <DropdownMenuRadioGroup
            value={ceiling.codec}
            onValueChange={(value) => update({ codec: value as CodecPreference })}
          >
            <DropdownMenuRadioItem value="auto">auto</DropdownMenuRadioItem>
            {offerable.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {option}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-xs text-muted-foreground">takes effect on reconnect.</p>
        </Axis>

        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          bandwidth, resolution and frame rate are upper limits: the machine lowers them when the connection needs it.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
