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

import { use, useState } from 'react';
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

export default function SwoopPage({
  params,
}: {
  params: Promise<{ siteId: string; machineId: string }>;
}) {
  const { siteId, machineId } = use(params);
  const { state, error, stats, session, videoRef, stageRef, stepUp, end, reconnect } = useSwoopSession(
    siteId,
    machineId,
  );
  // the overlay covers the picture, so it is off until asked for — and the
  // toolbar is out of reach once fullscreen holds, so the choice is made here.
  const [statsOpen, setStatsOpen] = useState(false);

  return (
    <main className="flex h-full w-full flex-col">
      <SwoopToolbar
        machineId={machineId}
        session={session}
        state={state}
        error={error}
        onEnd={end}
        onReconnect={reconnect}
        statsOpen={statsOpen}
        onToggleStats={() => setStatsOpen((open) => !open)}
      >
        <SwoopDisplayPicker session={session} />
        <SwoopQualityMenu session={session} />
        <SwoopAudioToggle session={session} />
        <SwoopSpecialKeys session={session} />
      </SwoopToolbar>

      <div className="min-h-0 flex-1">
        <SwoopStage session={session} state={state} stageRef={stageRef} videoRef={videoRef}>
          <SwoopPresence session={session} />
          <SwoopStatsOverlay session={session} stats={stats} open={statsOpen} />
        </SwoopStage>
      </div>

      {error && (
        <p role="alert" className="px-4 py-2 text-center text-sm text-destructive">
          {error}
        </p>
      )}

      <SwoopStepUpDialog
        open={stepUp.required}
        enrolled={stepUp.enrolled}
        onProof={stepUp.submitProof}
        onCancel={stepUp.cancel}
      />
    </main>
  );
}
