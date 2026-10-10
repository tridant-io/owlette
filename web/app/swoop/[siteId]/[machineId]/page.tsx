'use client';

/**
 * `/swoop/{siteId}/{machineId}` — one live remote session, full window.
 *
 * the page is deliberately a wiring diagram and nothing else: `useSwoopSession`
 * owns every moving part, and every control a later wave adds is already
 * mounted here as its own component, taking the session off the hook. that is
 * the point — no task after this one should need to edit this file or the hook
 * to add a toolbar button, a menu or an overlay.
 *
 * the step-up dialog's props are frozen at this shape. `onProof` takes the body
 * `parseMfaProof` accepts and the hook forwards it verbatim into the
 * session-create request; the page never inspects, stores or logs a proof.
 */

import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines } from '@/hooks/useFirestore';
import {
  applyBarPosition,
  currentBarPosition,
  setPictureAspect,
  subscribeBarPosition,
  type SwoopBarPosition,
} from '@/lib/swoop/barPosition';
import { isViewerApp } from '@/lib/swoop/viewerApp';
import { closeViewerWindow, isSessionWindow } from '@/lib/swoop/viewerWindow';
import { useSwoopSession } from '@/hooks/useSwoopSession';
import { SwoopStage } from '@/components/swoop/SwoopStage';
import { SwoopToolbar } from '@/components/swoop/SwoopToolbar';
import { SwoopStatsOverlay } from '@/components/swoop/SwoopStatsOverlay';
import { SwoopStepUpDialog } from '@/components/swoop/SwoopStepUpDialog';
import { SwoopQualityMenu } from '@/components/swoop/SwoopQualityMenu';
import { SwoopDisplayPicker } from '@/components/swoop/SwoopDisplayPicker';
import { SwoopSpecialKeys } from '@/components/swoop/SwoopSpecialKeys';
import { SwoopAudioToggle } from '@/components/swoop/SwoopAudioToggle';
import { SwoopPresence } from '@/components/swoop/SwoopPresence';
import { SwoopCursor } from '@/components/swoop/SwoopCursor';
import { SwoopBarPositionMenu } from '@/components/swoop/SwoopBarPositionMenu';

const barOnTop = (): SwoopBarPosition => 'top';

/** long enough to read "session ended" before owlette swoop's window moves on. */
const ENDED_RETURN_MS = 800;

export default function SwoopPage({
  params,
}: {
  params: Promise<{ siteId: string; machineId: string }>;
}) {
  const { siteId, machineId } = use(params);
  const { state, error, refusal, stats, session, videoRef, stageRef, stepUp, end, reconnect, retryIn, noPath } =
    useSwoopSession(siteId, machineId);
  const { isSiteAdmin } = useAuth();
  // the keyboard follows the machine's system. no hook reads one machine
  // document, so this takes it off the site's list; an agent that reports no
  // system is a windows one.
  const { machines } = useMachines(siteId);
  const osFamily = machines.find((machine) => machine.machineId === machineId)?.osFamily ?? 'windows';
  // the overlay covers the picture, so it is off until asked for — and the
  // toolbar is out of reach once fullscreen holds, so the choice is made here.
  const [statsOpen, setStatsOpen] = useState(false);
  // escape twice on the stage lands the keyboard on the bar's first button.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const leaveStage = useCallback(() => {
    toolbarRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, []);
  // the menus' and tooltips' side; the layout follows `data-swoop-bar`.
  const position = useSyncExternalStore(subscribeBarPosition, currentBarPosition, barOnTop);
  // auto sums with the window and the picture, so both are watched
  useEffect(() => {
    window.addEventListener('resize', applyBarPosition);
    return () => window.removeEventListener('resize', applyBarPosition);
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onResize = () => setPictureAspect(video.videoWidth, video.videoHeight);
    video.addEventListener('resize', onResize);
    return () => video.removeEventListener('resize', onResize);
  }, [videoRef]);
  // a disconnected session (not one counting down to a reconnect) gives
  // fullscreen back, in a browser and in the app alike: the bar and the way on
  // are out of reach while it holds. this runs before the return below, so a
  // window never closes or moves on in fullscreen.
  const disconnected = (state === 'ended' || state === 'error') && retryIn === null;
  useEffect(() => {
    if (!disconnected || !document.fullscreenElement) return;
    document.exitPointerLock?.();
    void document.exitFullscreen().catch(() => undefined);
  }, [disconnected]);
  // in owlette swoop a session that is over gives its window back: the main
  // window returns to the picker, a session's own window closes (through the
  // app's close handshake). one counting down to a reconnect is not over, and a
  // refusal or failure keeps its notice and the way back.
  const router = useRouter();
  // only a session that ran is over: a refusal that arrives before any picture
  // (the same machine, swoop off, a cancelled step-up) also lands in `ended`, and
  // its notice must stay up with the way back (owner ruling).
  const ran = useRef(false);
  useEffect(() => {
    if (state === 'connected') ran.current = true;
  }, [state]);
  const over = disconnected && state === 'ended';
  useEffect(() => {
    if (!over || !ran.current || !isViewerApp()) return;
    const timer = setTimeout(() => {
      if (isSessionWindow()) closeViewerWindow();
      else router.replace('/swoop');
    }, ENDED_RETURN_MS);
    return () => clearTimeout(timer);
  }, [over, router]);

  return (
    <main className="flex h-full w-full flex-col md:bar-left:flex-row md:bar-right:flex-row-reverse">
      <SwoopToolbar
        ref={toolbarRef}
        machineId={machineId}
        session={session}
        state={state}
        error={error}
        stats={stats}
        retryIn={retryIn}
        onEnd={end}
        onReconnect={reconnect}
        statsOpen={statsOpen}
        onToggleStats={() => setStatsOpen((open) => !open)}
        position={position}
      >
        <SwoopDisplayPicker session={session} />
        <SwoopQualityMenu session={session} />
        <SwoopAudioToggle session={session} />
        <SwoopSpecialKeys session={session} osFamily={osFamily} />
        <SwoopBarPositionMenu position={position} />
      </SwoopToolbar>

      <div className="min-h-0 min-w-0 flex-1">
        <SwoopStage
          session={session}
          state={state}
          error={error}
          retryIn={retryIn}
          refusal={refusal}
          settingsHref={isSiteAdmin(siteId) ? `/dashboard?settings=${encodeURIComponent(siteId)}` : null}
          noPath={noPath}
          stall={stats.stall.recovery}
          stageRef={stageRef}
          videoRef={videoRef}
          onLeave={leaveStage}
        >
          <SwoopCursor session={session} />
          <SwoopPresence session={session} />
          <SwoopStatsOverlay session={session} stats={stats} open={statsOpen} />
        </SwoopStage>
      </div>

      <SwoopStepUpDialog
        open={stepUp.required}
        enrolled={stepUp.enrolled}
        onProof={stepUp.submitProof}
        onCancel={stepUp.cancel}
      />
    </main>
  );
}
