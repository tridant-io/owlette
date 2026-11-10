'use client';

/**
 * quality and display — the three ceilings (bandwidth, resolution, frame rate),
 * codec preference, and how this browser draws the picture (size and smooth
 * scaling). one row per axis, showing what is chosen, with its options in a
 * submenu: every list at once ran to twenty rows and hid what was set.
 *
 * a ceiling is not a setting: the streamer's governor still adapts below it, so
 * the menu never promises a rate the session will actually hold. that is why
 * the footer says so out loud and why nothing here reports a live number — the
 * stats overlay owns what is actually happening.
 *
 * **the three ceilings go out on §5's `quality`.** the wire message is
 * `{ preset, maxBitrateKbps, maxFps }` and the streamer's `signal::messages` is
 * `deny_unknown_fields`, so the two numbers carry their own axes and `preset`
 * carries the resolution cap — the only one without a field.
 * `agent/swoop/src/session/quality.rs` reads exactly that.
 *
 * codec preference is not a control message at all. the streamer picks the
 * codec once, from the browser's first **offer** (`session::pick_codec`), so a
 * choice is stored for this tab and machine (`lib/swoop/codecStore.ts`) and
 * applied by a new session, which the menu starts in place of this one. it is
 * per machine rather than per session, unlike the ceilings: a picture that froze
 * on a dead hevc decoder writes `h264` there too, and the row shows it.
 * the options come from `probeClientCaps`, never from a webcodecs probe: spike
 * 2.12 measured edge exposing no `video/H265` to `RTCRtpReceiver` on the same
 * box where it decodes hevc happily through webcodecs, and offering hevc there
 * would negotiate a stream it cannot show.
 *
 * size (fit or sharp) and smooth scaling describe this screen, not the machine
 * or the session (dev/active/swoop-clarity/plan.md, C13): they are this
 * browser's, kept by `lib/swoop/viewStore.ts`, never sent, and kept across
 * sessions. smooth scaling is the off switch for the canvas path; where it
 * cannot draw (no webgl2, no rvfc, a software renderer) it is greyed out.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
import { readCodecChoice, writeCodecChoice, type SwoopCodecChoice } from '@/lib/swoop/codecStore';
import { encodeControlMessage, type SwoopCodec } from '@/lib/swoop/protocol';
import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopSize } from '@/lib/swoop/view';
import { readSize, readSmooth, setSize, setSmooth, subscribeView } from '@/lib/swoop/viewStore';
import { smoothCanDraw } from '@/hooks/useSwoopView';
import { useBarMenuPlacement } from '@/components/swoop/barMenuPlacement';
import { BarTooltip } from '@/components/swoop/BarTooltip';

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

interface Ceiling {
  /** kbps on the wire; `0` is "unstated" and the streamer takes its own default. */
  bandwidth: number;
  resolution: string;
  fps: number;
}

const DEFAULTS: Ceiling = { bandwidth: 0, resolution: 'native', fps: 60 };

const SIZE: SwoopSize[] = ['fit', 'sharp'];

const subscribeNever = (): (() => void) => () => {};
const onServer = (): boolean => false;
const fitOnServer = (): SwoopSize => 'fit';

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
  const [codec, setCodec] = useState<SwoopCodecChoice>(() =>
    session ? readCodecChoice(session.siteId, session.machineId) : 'auto',
  );
  const [owner, setOwner] = useState(session);
  const [offerable, setOfferable] = useState<SwoopCodec[]>([]);
  const size = useSyncExternalStore(subscribeView, readSize, fitOnServer);
  const smooth = useSyncExternalStore(subscribeView, readSmooth, onServer);
  const canDraw = useSyncExternalStore(subscribeNever, smoothCanDraw, onServer);

  // a new session starts at the streamer's own default, so the menu does too
  // rather than showing a ceiling the streamer was never told about; the codec
  // is the one that session offered. adjusted in render rather than in an
  // effect, which would render the stale values first.
  if (owner !== session) {
    setOwner(session);
    setCeiling(DEFAULTS);
    setCodec(session ? readCodecChoice(session.siteId, session.machineId) : 'auto');
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

  // `auto` also clears the h.264 a frozen hevc picture fell back to.
  const chooseCodec = (choice: SwoopCodecChoice) => {
    if (!session || choice === codec) return;
    writeCodecChoice(session.siteId, session.machineId, choice);
    setCodec(choice);
    session.restart();
  };

  const live = session !== null;

  return (
    <DropdownMenu>
      <BarTooltip label="quality">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" disabled={!live} aria-label="quality and display">
            <SlidersHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </BarTooltip>
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

        <Axis label="codec" value={codec}>
          <DropdownMenuRadioGroup value={codec} onValueChange={(value) => chooseCodec(value as SwoopCodecChoice)}>
            <DropdownMenuRadioItem value="auto">auto</DropdownMenuRadioItem>
            {offerable.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {option}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-xs text-muted-foreground">reconnects to apply.</p>
        </Axis>

        <DropdownMenuSeparator />
        <Axis label="size" value={size}>
          <DropdownMenuRadioGroup value={size} onValueChange={(value) => setSize(value as SwoopSize)}>
            {SIZE.map((option) => (
              <DropdownMenuRadioItem key={option} value={option}>
                {option}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </Axis>
        <DropdownMenuCheckboxItem checked={smooth} disabled={!canDraw} onCheckedChange={setSmooth}>
          smooth scaling
        </DropdownMenuCheckboxItem>
        {!canDraw && <p className="pr-2 pb-1.5 pl-11 text-xs text-muted-foreground">not available in this browser</p>}

        <DropdownMenuSeparator />
        <div className="space-y-1 px-2 py-1.5 text-xs text-muted-foreground">
          <p>bandwidth, resolution and frame rate are upper limits: the machine lowers them when the connection needs it.</p>
          <p>size and smooth scaling only change how the picture is drawn on this computer.</p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
