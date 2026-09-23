'use client';

/**
 * who else is in this session, who holds control, and where their pointers are.
 *
 * the roster is the host's: `ctl` on a line is the host's own verdict from that
 * viewer's verified jwt, so this is a read-out and not a control — there is no
 * "take control" button here because there is no such message in the protocol.
 *
 * **the local cursor stays a css cursor.** this component draws every pointer
 * but ours; drawing ours too puts a second arrow a few pixels from the real one
 * on every move, which reads as lag that is not there.
 *
 * the overlay is a child of the stage, and a pointer's position is normalised
 * over the PICTURE — the letterboxed content area, not the element — so the
 * arithmetic here is the same one `session.contentRect()` exists for on the
 * input side, including its `size - 1` convention. measuring is a layout read,
 * so it happens in an effect after a commit and not in render: the position
 * changes 60 times a second and the box changes when the window does.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { MousePointer2, Eye } from 'lucide-react';
import { NO_PRESENCE, swoopPresence } from '@/lib/swoop/presence';
import type { SwoopSession } from '@/lib/swoop/features';

export interface SwoopPresenceProps {
  session: SwoopSession | null;
}

const subscribeNever = (): (() => void) => () => {};
const noPresence = () => NO_PRESENCE;

/** the picture's box, in the stage's own coordinates. */
interface PictureBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * one of the theme's chart tokens per viewer, picked from the id so a viewer
 * keeps its colour for as long as it is here and every browser in the session
 * draws it the same. never a literal colour — these are the tokens that have a
 * dark-mode value.
 */
const CURSOR_TINTS = ['text-chart-1', 'text-chart-2', 'text-chart-3', 'text-chart-4', 'text-chart-5'];

export function tintOf(viewerId: string): string {
  let hash = 0;
  for (let i = 0; i < viewerId.length; i += 1) hash = (hash * 31 + viewerId.charCodeAt(i)) >>> 0;
  return CURSOR_TINTS[hash % CURSOR_TINTS.length];
}

function measure(session: SwoopSession): PictureBox {
  const picture = session.contentRect();
  const stage = session.stage.getBoundingClientRect();
  return {
    left: picture.left - stage.left,
    top: picture.top - stage.top,
    width: picture.width,
    height: picture.height,
  };
}

const sameBox = (a: PictureBox | null, b: PictureBox): boolean =>
  a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

/**
 * re-measured on a window resize, on entering or leaving fullscreen, and on the
 * `<video>` element's own `resize` — the last one is the display switch, which
 * changes the picture's aspect ratio inside an element whose box never moved
 * and so fires nothing else. re-measuring per cursor message instead would be a
 * layout read sixty times a second for a box that changes when the window does.
 */
function usePictureBox(session: SwoopSession | null): PictureBox | null {
  const [box, setBox] = useState<PictureBox | null>(null);

  useEffect(() => {
    // no session means nothing is rendered at all, so the last box measured is
    // never read again — and the next session re-measures before it is.
    if (!session) return;
    const sync = () => {
      const next = measure(session);
      setBox((held) => (sameBox(held, next) ? held : next));
    };
    sync();
    window.addEventListener('resize', sync);
    document.addEventListener('fullscreenchange', sync);
    session.video.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('resize', sync);
      document.removeEventListener('fullscreenchange', sync);
      session.video.removeEventListener('resize', sync);
    };
  }, [session]);

  return box;
}

export function SwoopPresence({ session }: SwoopPresenceProps) {
  const store = swoopPresence(session);
  const state = useSyncExternalStore(
    store?.subscribe ?? subscribeNever,
    store?.get ?? noPresence,
    // the server has no session and no channel, so it renders nothing and
    // hydration fills it in once the first roster lands.
    noPresence,
  );
  const box = usePictureBox(session);

  // alone in the session, which is the usual case: nothing to say about who
  // else is here, and no pointer but the real one.
  if (state.viewers.length < 2) return null;

  return (
    <>
      <ul
        aria-label="viewers"
        className="pointer-events-none absolute left-3 top-3 space-y-1 rounded-md border border-border bg-card/90 p-2 text-xs text-muted-foreground shadow-sm"
      >
        {state.viewers.map((viewer) => (
          <li key={viewer.id} className="flex items-center gap-1.5">
            {viewer.ctl ? (
              <MousePointer2
                aria-hidden
                className={`size-3 ${viewer.id === session?.viewerId ? 'text-foreground' : tintOf(viewer.id)}`}
              />
            ) : (
              <Eye aria-hidden className="size-3" />
            )}
            <span className={viewer.id === session?.viewerId ? 'text-foreground' : undefined}>
              {viewer.name}
              {viewer.id === session?.viewerId && ' (you)'}
            </span>
            {!viewer.ctl && <span>· view only</span>}
          </li>
        ))}
      </ul>

      {box &&
        state.cursors.map((cursor) => (
          <div
            key={cursor.viewer}
            aria-hidden
            className={`pointer-events-none absolute flex items-start gap-0.5 ${tintOf(cursor.viewer)}`}
            style={{
              left: box.left + cursor.x * Math.max(box.width - 1, 0),
              top: box.top + cursor.y * Math.max(box.height - 1, 0),
            }}
          >
            <MousePointer2 className="size-4 fill-current" />
            <span className="rounded-sm bg-card/90 px-1 text-[10px] leading-4">
              {state.viewers.find((viewer) => viewer.id === cursor.viewer)?.name ?? cursor.viewer}
            </span>
          </div>
        ))}
    </>
  );
}
