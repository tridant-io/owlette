/**
 * the picture's box, written onto the `<video>`.
 *
 * `layoutPicture` (`lib/swoop/view.ts`) decides where the picture sits in its
 * area and at what size, on whole device pixels; this writes that box straight
 * onto the video's style, not through react state, as touch.ts writes its
 * transform. so the element's own box is the picture's, and `contentRect()`,
 * input, touch and the overlays all read that one box (plan C1).
 *
 * laid out again whenever anything it reads can change: the area's size (its
 * exact device size where the browser reports one), the window, fullscreen, the
 * frame's size, the screen's dpr, the bar moving the area without resizing it,
 * and this browser's size and smooth scaling settings.
 */

import { useEffect, type RefObject } from 'react';
import { subscribeBarPosition } from '@/lib/swoop/barPosition';
import { layoutPicture } from '@/lib/swoop/view';
import { readSize, readSmooth, subscribeView } from '@/lib/swoop/viewStore';
import { smoothAvailable } from '@/lib/swoop/video/smooth';

/**
 * whether smooth scaling can draw in this browser. the emulator build is the
 * e2e's, whose ci runner has no gpu, so only it takes a software renderer; a
 * production bundle inlines false.
 */
export const smoothCanDraw = (): boolean =>
  smoothAvailable({ allowSoftware: process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR === 'true' });

/** whether smooth scaling draws here: this viewer has it on, and it can draw. */
export const smoothActive = (): boolean => readSmooth() && smoothCanDraw();

export function useSwoopView({
  videoRef,
  areaRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  areaRef: RefObject<HTMLDivElement | null>;
}): void {
  useEffect(() => {
    const video = videoRef.current;
    const area = areaRef.current;
    if (!video || !area) return;
    // the area's exact device size, from the last observation that gave one
    let devicePixels: { width: number; height: number } | null = null;

    const layout = (): void => {
      const rect = area.getBoundingClientRect();
      const { box } = layoutPicture({
        area: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        dpr: window.devicePixelRatio || 1,
        devicePixels,
        frame: { width: video.videoWidth, height: video.videoHeight },
        size: readSize(),
        wholeFractions: smoothActive(),
      });
      const { style } = video;
      style.left = `${box.left}px`;
      style.top = `${box.top}px`;
      style.width = `${box.width}px`;
      style.height = `${box.height}px`;
    };

    const resizes =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            const exact = entries.at(-1)?.devicePixelContentBoxSize?.[0];
            devicePixels = exact ? { width: exact.inlineSize, height: exact.blockSize } : null;
            layout();
          })
        : null;
    try {
      resizes?.observe(area, { box: 'device-pixel-content-box' });
    } catch {
      // safari has no device-pixel-content-box: the content box, and the area's size times dpr
      resizes?.observe(area);
    }

    // a dpr change is the current resolution's query ceasing to match, so each change watches for the next
    let resolution: MediaQueryList | null = null;
    function watchDpr(): void {
      resolution?.removeEventListener('change', onDpr);
      resolution =
        typeof window.matchMedia === 'function'
          ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
          : null;
      resolution?.addEventListener('change', onDpr);
    }
    function onDpr(): void {
      watchDpr();
      layout();
    }
    watchDpr();

    window.addEventListener('resize', layout);
    document.addEventListener('fullscreenchange', layout);
    video.addEventListener('resize', layout);
    const offBar = subscribeBarPosition(layout);
    const offView = subscribeView(layout);
    layout();

    return () => {
      offView();
      offBar();
      video.removeEventListener('resize', layout);
      document.removeEventListener('fullscreenchange', layout);
      window.removeEventListener('resize', layout);
      resolution?.removeEventListener('change', onDpr);
      resizes?.disconnect();
    };
  }, [videoRef, areaRef]);
}
