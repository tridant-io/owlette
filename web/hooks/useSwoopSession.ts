'use client';

/**
 * one swoop session, from the session-create POST to the last teardown.
 *
 * this hook is the page's only moving part, and it is deliberately the only
 * place that knows the order the wave-3 client pieces go together:
 *
 *   identity (dtls certificate) → session-create → signaling → peer →
 *   receiver + presenter → features
 *
 * the parts that are easy to get wrong, all of them measured or decided
 * upstream rather than derived here:
 *
 * - **the certificate comes first.** a viewer token carries the browser's dtls
 *   fingerprint, so the api needs it in the create body — before any peer
 *   traffic and before any offer.
 * - **`video/receiver.ts` owns the `<video>` element**, the single
 *   `requestVideoFrameCallback` chain and `jitterBufferTarget`. this hook hands
 *   it the element and never touches any of the three. in chrome
 *   `jitterBufferTarget` is a *minimum*, not a target: a non-zero value only
 *   raises the playout floor, and 250 would have tripled the 31 ms the lan row
 *   measured.
 * - **the viewer token reaches the host as the first frame on
 *   `swoop-control`**, because the `offer` message has no field for it.
 *   `peer.ts` does that through `leaseToken`; §10's renewal is the same path,
 *   so `mintViewerToken` below is the one place a token is produced.
 * - **a refused websocket upgrade is invisible here.** it arrives as close 1006
 *   with nothing in it, so "the room was full" and "the room is not the one you
 *   were given" are indistinguishable. every failure message below says what
 *   happened, never why it guesses it happened.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  SWOOP_FEATURES,
  swoopFeedback,
  type SwoopDetach,
  type SwoopLease,
  type SwoopSession,
} from '@/lib/swoop/features';
import type { SwoopFeedbackDiagnostics } from '@/lib/swoop/feedback';
import { SwoopLeaseRefused } from '@/lib/swoop/lease';
import { createSwoopIdentity, createSwoopPeer, type SwoopPeer } from '@/lib/swoop/peer';
import { backoffDelayMs, isTransientEnd } from '@/lib/swoop/backoff';
import { controlRefusedForCapability } from '@/lib/swoop/intent';
import { probeClientCaps } from '@/lib/swoop/clientCaps';
import {
  base64UrlDecode,
  encodeControlMessage,
  type SignalingMessage,
  type SwoopChannel,
} from '@/lib/swoop/protocol';
import {
  createSwoopSignaling,
  type SwoopSignalFatal,
  type SwoopSignaling,
  type SwoopSignalStatus,
} from '@/lib/swoop/signaling';
import {
  createPresenter,
  type PresenterStats,
  type SwoopPresenter,
} from '@/lib/swoop/video/presenter';
import {
  SwoopReceiver,
  type FrameObservation,
  type SwoopReceiverDiagnostics,
} from '@/lib/swoop/video/receiver';
import type { SwoopStepUpProof } from '@/lib/swoop/stepUp';

/** how far the page has got. `ended` and `error` are both terminal. */
/** the reconnect ladder: 2 s, 4 s, … 30 s between sessions, reset after one held for `RETRY_RESET_MS`. */
const RETRY_LADDER = { baseMs: 2000, capMs: 30000 };
const RETRY_RESET_MS = 30000;

export type SwoopSessionState =
  | 'idle'
  | 'authorizing'
  | 'connecting'
  | 'connected'
  | 'ended'
  | 'error';

export interface SwoopStats {
  signal: SwoopSignalStatus;
  presenter: PresenterStats;
  receiver: SwoopReceiverDiagnostics;
  /**
   * the most recently presented frame with its host stamps — the overlay's
   * per-stage breakdown, sampled on this hook's timer rather than re-rendering
   * the page sixty times a second.
   */
  frame: FrameObservation | null;
  /** the feedback loop's numbers, including the measured app-level rtt. */
  feedback: SwoopFeedbackDiagnostics | null;
  /** when the lease currently held lapses; 0 before one exists. */
  leaseExpiresAt: number;
}

export interface SwoopStepUpControls {
  required: boolean;
  /** false when the account holds no second factor — it cannot take control. */
  enrolled: boolean;
  submitProof: (proof: SwoopStepUpProof) => Promise<void>;
  cancel: () => void;
}

export interface UseSwoopSession {
  state: SwoopSessionState;
  error: string | null;
  stats: SwoopStats;
  /**
   * the live session, once the peer is up. this is what every toolbar, menu and
   * overlay a later wave adds talks to, so none of them needs the page or this
   * hook changed to reach the control channel.
   */
  session: SwoopSession | null;
  /**
   * the element the receiver attaches the track to. gate g1 chose the rtp media
   * track, so this is a `<video>` — not the canvas arm A would have drawn into.
   */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** the surface input capture binds to; it wraps the video. */
  stageRef: RefObject<HTMLDivElement | null>;
  stepUp: SwoopStepUpControls;
  /** end the session and stop the streamer. */
  end: () => void;
  /** a fresh session to the same machine, from the ended or failed state. */
  reconnect: () => void;
  /**
   * seconds until the next automatic reconnect, or null when none is due: a
   * session that ended for a reason that was not a decision is started
   * again on a ladder, and the operator can reconnect now instead.
   */
  retryIn: number | null;
}

interface SessionGrant {
  sid: string;
  viewerId: string;
  ctl: boolean;
  viewerJwt: string;
  k: string;
  iceServers: RTCIceServer[];
  signalUrl: string;
  /** the LEASE expiry, not the 60 s life of the jwt beside it. */
  expiresAt: number;
  /**
   * a control session's continuity token: presented on this tab's next mint
   * in place of a passkey. kept in memory only, so closing the tab forgets it.
   */
  continuity?: string;
}

const EMPTY_STATS: SwoopStats = {
  signal: 'idle',
  presenter: {
    width: 0,
    height: 0,
    presentedFrames: 0,
    gaps: 0,
    duplicates: 0,
    displayPhaseMs: null,
  },
  receiver: {
    framesObserved: 0,
    metaRecords: 0,
    metaDropped: {},
    idrRequests: 0,
    awaitingIrap: false,
    unjoinableFrames: 0,
    unmatchedHostRecordsDropped: 0,
    unmatchedClientFramesDropped: 0,
    jitterBufferTargetApplied: null,
    requestVideoFrameCallback: false,
  },
  frame: null,
  feedback: null,
  leaseExpiresAt: 0,
};

/** how often the overlay's numbers are resampled. */
const STATS_INTERVAL_MS = 1000;

/**
 * the letterboxed picture inside the element, in client coordinates.
 *
 * `object-contain` scales the frame to fit and centres what is left over, so
 * the content box is the element box shrunk by the smaller of the two axis
 * ratios. the css in `SwoopStage` and this function are one decision: change
 * the fit or the position there and this is wrong.
 *
 * the size comes from the presenter, which already tracks `videoWidth` /
 * `videoHeight` off the element's own `resize` event — a third listener on the
 * same element would only be a second copy of the same number. before metadata
 * lands both are 0 and the element box is genuinely all anyone knows; it
 * self-corrects on the first frame.
 */
function contentRect(video: HTMLVideoElement, width: number, height: number): DOMRect {
  const box = video.getBoundingClientRect();
  if (width <= 0 || height <= 0) return box;
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale;
  const h = height * scale;
  return new DOMRect(box.x + (box.width - w) / 2, box.y + (box.height - h) / 2, w, h);
}

/** the server's own sentence, when it sent one. */
async function problemDetail(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
  return body.detail || body.error || fallback;
}


export function useSwoopSession(
  siteId: string,
  machineId: string,
  options?: { control?: boolean },
): UseSwoopSession {
  const control = options?.control ?? true;
  const { mfaFactors } = useAuth();
  const enrolled = mfaFactors.totp || mfaFactors.passkeys > 0;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const [state, setState] = useState<SwoopSessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SwoopStats>(EMPTY_STATS);
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const [session, setSession] = useState<SwoopSession | null>(null);
  // bumping this is what re-runs the sequence after a step-up ceremony.
  const [attempt, setAttempt] = useState(0);
  // the automatic reconnect: when it is due, and which rung of the ladder it
  // is on. the rung resets once a session has held for `RETRY_RESET_MS`.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const retryIn = retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // the proof is held in a ref, never in state: state lands in a devtools
  // snapshot and a live second-factor proof has no business being there.
  const proofRef = useRef<SwoopStepUpProof | null>(null);
  const continuityRef = useRef<string | null>(null);
  const endRef = useRef<(reason: string) => void>(() => {});
  const stoppedRef = useRef(false);

  const submitProof = useCallback(async (proof: SwoopStepUpProof) => {
    proofRef.current = proof;
    setStepUpRequired(false);
    // exactly one retry, never a loop: a second `step_up_required` re-opens the
    // dialog through the same path and the operator decides again.
    setAttempt((n) => n + 1);
  }, []);

  const cancel = useCallback(() => {
    stoppedRef.current = true;
    setStepUpRequired(false);
    setState('ended');
  }, []);

  /**
   * a fresh session to the same machine from the ended or failed state. the
   * effect below keys on `attempt`, so bumping it tears the old run down and
   * starts a new one; the step-up proof is not reused (a new session is a new
   * ceremony if the window has closed).
   */
  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setRetryAt(null);
  }, []);

  const reconnect = useCallback(() => {
    clearRetry();
    stoppedRef.current = false;
    proofRef.current = null;
    setError(null);
    setStepUpRequired(false);
    setState('connecting');
    setAttempt((n) => n + 1);
  }, [clearRetry]);

  /**
   * the end of a session that was not a decision — a lost path, a host that
   * went away, a room that closed — is the start of the next one, after a
   * delay that grows with each attempt. an operator who ended it, an admin
   * who killed it, and an api that refused it are decisions, and stop here.
   */
  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current || retryTimerRef.current !== null) return;
    retryAttemptRef.current += 1;
    const delay = backoffDelayMs(retryAttemptRef.current, RETRY_LADDER);
    setNow(Date.now());
    setRetryAt(Date.now() + delay);
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      setRetryAt(null);
      reconnect();
    }, delay);
  }, [reconnect]);

  const end = useCallback(() => {
    clearRetry();
    // a deliberate end: the next session from this tab asks again.
    continuityRef.current = null;
    endRef.current('closed');
  }, [clearRetry]);

  // the countdown the page shows, once a second.
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  // a session that held for a while starts the next ladder from the bottom.
  useEffect(() => {
    if (state !== 'connected') return;
    const timer = setTimeout(() => {
      retryAttemptRef.current = 0;
    }, RETRY_RESET_MS);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => clearRetry, [clearRetry]);

  useEffect(() => {
    if (!siteId || !machineId) return;
    if (stoppedRef.current) return;

    let disposed = false;
    let signaling: SwoopSignaling | null = null;
    let peer: SwoopPeer | null = null;
    let receiver: SwoopReceiver | null = null;
    let presenter: SwoopPresenter | null = null;
    let statsTimer: ReturnType<typeof setInterval> | null = null;
    let grant: SessionGrant | null = null;
    let leaseExpiresAt = 0;
    // the create route already minted one, good for 60 s. spend it on the first
    // dial rather than asking the lease route for a second.
    let pendingJwt: string | null = null;

    const detachers: SwoopDetach[] = [];
    // the overlay's per-stage numbers come off one frame, resampled on the
    // stats timer; holding the newest here is cheaper than a second subscriber.
    let latestFrame: FrameObservation | null = null;
    const frameHandlers = new Set<(observation: FrameObservation) => void>();
    const channelHandlers = new Map<SwoopChannel, Set<(data: unknown) => void>>();

    // `transient` is the difference between a path that may come back and a
    // decision: the first schedules the next session, the second waits for
    // the operator.
    const fail = (message: string, transient: boolean) => {
      if (disposed) return;
      setError(message);
      setState('error');
      if (transient) scheduleReconnect();
    };

    const sendOnChannel = (label: SwoopChannel, data: string): boolean => {
      const channel = peer?.channel(label);
      if (!channel || channel.readyState !== 'open') return false;
      channel.send(data);
      return true;
    };

    const teardown = (reason: string) => {
      if (disposed) return;
      disposed = true;
      if (statsTimer !== null) clearInterval(statsTimer);
      setSession(null);
      for (const detach of detachers.reverse()) {
        try {
          detach();
        } catch {
          // one feature failing to unwind must not stop the rest unwinding.
        }
      }
      presenter?.detach();
      receiver?.stop();
      peer?.close();
      signaling?.close(1000, reason);
      if (grant) {
        // best effort: the record ends server-side and the streamer is stopped
        // over two independent paths, so a lost beacon costs the user nothing.
        void fetch(
          `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/swoop/sessions/${encodeURIComponent(grant.sid)}`,
          {
            method: 'DELETE',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endReason: 'closed' }),
          },
        ).catch(() => undefined);
      }
    };

    endRef.current = (reason: string) => {
      const transient = isTransientEnd(reason);
      stoppedRef.current = !transient;
      teardown(reason);
      setState('ended');
      if (transient) scheduleReconnect();
    };

    const renewLease = async (fp: string): Promise<SwoopLease> => {
      if (!grant) throw new Error('swoop: no session to renew');
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/swoop/sessions/${encodeURIComponent(grant.sid)}/lease`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewerId: grant.viewerId, fp }),
        },
      );
      if (!res.ok) {
        const detail = await problemDetail(res, 'the session lease could not be renewed.');
        // 401/403 is the authorisation going away — what the lease exists to
        // catch. everything else is a failure the renewer may retry.
        if (res.status === 401 || res.status === 403) {
          throw new SwoopLeaseRefused(res.status, detail);
        }
        throw new Error(detail);
      }
      const body = (await res.json()) as { data: SwoopLease };
      leaseExpiresAt = body.data.expiresAt;
      return body.data;
    };

    /**
     * one viewer jwt, for whoever asks next. the signaling socket mints one per
     * dial and the peer mints one for the lease it presents on `swoop-control`;
     * both come through here, so the lease route has a single caller.
     */
    const mintViewerToken = async (fp: string): Promise<string> => {
      const spent = pendingJwt;
      if (spent) {
        pendingJwt = null;
        return spent;
      }
      return (await renewLease(fp)).viewerJwt;
    };

    const createSession = async (fp: string, wantControl = control): Promise<SessionGrant | null> => {
      const clientCaps = await probeClientCaps();
      // a proof only ever belongs to the run the ceremony asked for; the first
      // attempt cannot have one.
      const proof = attempt > 0 ? proofRef.current : null;
      proofRef.current = null;
      // no proof in hand: the last control session's continuity stands in,
      // and the server decides whether it still counts.
      const continuity = proof || !wantControl ? null : continuityRef.current;

      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/swoop/sessions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // the proof crosses exactly as the ceremony produced it.
          body: JSON.stringify({
            control: wantControl,
            fp,
            clientCaps,
            ...(proof ? { mfaProof: proof } : {}),
            ...(continuity ? { continuity } : {}),
          }),
        },
      );
      if (!res.ok) {
        // one read of the body: `problemDetail` consumes it, and every branch
        // below wants both the code and the sentence.
        const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string; error?: string };
        const code = typeof problem.code === 'string' ? problem.code : null;
        const detail = problem.detail || problem.error || 'this swoop session could not be started.';
        // a member holds the view capability only: the control ask is refused
        // before swoop's own gate, and the watch ask is the one to make. once,
        // and only for that refusal.
        if (wantControl && controlRefusedForCapability(res.status, code, detail)) {
          return createSession(fp, false);
        }
        if (res.status === 401 && code === 'step_up_required') {
          if (!disposed) {
            setStepUpRequired(true);
            setState('authorizing');
          }
          return null;
        }
        // a 5xx or a 429 is the api having a bad moment; a 4xx is its answer.
        fail(detail, res.status >= 500 || res.status === 429);
        return null;
      }
      const body = (await res.json()) as { data: SessionGrant };
      // a fresh token per session; a watch grant carries none and clears it.
      continuityRef.current = body.data.continuity ?? null;
      return body.data;
    };

    const run = async () => {
      const video = videoRef.current;
      const stage = stageRef.current;
      if (!video || !stage) return;

      setState('authorizing');
      setError(null);

      const identity = await createSwoopIdentity();
      if (disposed) return;

      grant = await createSession(identity.fingerprint);
      if (!grant || disposed) return;

      pendingJwt = grant.viewerJwt;
      leaseExpiresAt = grant.expiresAt;

      const viewerKey = base64UrlDecode(grant.k);
      if (!viewerKey) {
        fail('the session key the server sent could not be read.', false);
        return;
      }

      setState('connecting');

      receiver = new SwoopReceiver({
        video,
        onFrame: (observation) => {
          latestFrame = observation;
          presenter?.observe(observation);
          for (const handler of frameHandlers) handler(observation);
        },
        onIdrRequest: () => {
          sendOnChannel('swoop-control', encodeControlMessage({ t: 'idr' }));
        },
      });
      presenter = createPresenter(video);

      const signalingOptions = {
        roomUrl: grant.signalUrl,
        mintToken: () => mintViewerToken(identity.fingerprint),
        onMessage: (message: SignalingMessage) => {
          void peer?.handleSignal(message);
        },
        onStatus: (signal: SwoopSignalStatus) => {
          if (!disposed) setStats((prev) => ({ ...prev, signal }));
        },
        onFatal: (code: SwoopSignalFatal) => {
          if (code === 'version_mismatch') {
            fail('this machine runs a swoop version this page cannot talk to.', false);
          } else {
            fail('this session is no longer authorised.', false);
          }
        },
      };

      try {
        signaling = createSwoopSignaling(signalingOptions);
      } catch {
        // the room url is the deployment's own configuration, not anything the
        // operator typed, so a url the constructor refuses is a server fault
        // they cannot retry their way out of — say so, and never echo the url
        // or the protocol back at them.
        fail('swoop is misconfigured on this deployment: the signalling address is not a secure websocket address. an administrator has to fix it.', false);
        return;
      }

      peer = createSwoopPeer({
        identity,
        sid: grant.sid,
        viewerId: grant.viewerId,
        viewerKey,
        iceServers: grant.iceServers,
        send: (message) => signaling?.send(message),
        refreshToken: () => signaling?.refresh() ?? Promise.resolve(),
        leaseToken: () => mintViewerToken(identity.fingerprint),
        onTrack: (stream, rtpReceiver) => {
          // two tracks arrive now, and only one of them is a picture: audio is
          // its own m-line and `lib/swoop/audio.ts` takes it off the connection
          // itself. handed to the receiver it would point the `<video>` at a
          // stream with no frames in it.
          if (rtpReceiver.track.kind !== 'video') return;
          // `attachTrack` reads exactly these two fields off the track event,
          // and the peer has already split them apart for us.
          receiver?.attachTrack({
            streams: [stream],
            receiver: rtpReceiver,
          } as unknown as RTCTrackEvent);
          void receiver?.start().then(() => {
            if (!disposed) setState('connected');
          });
        },
        onChannelOpen: (label, channel) => {
          if (label === 'swoop-meta') channel.binaryType = 'arraybuffer';
          channel.onmessage = (event) => {
            if (label === 'swoop-meta') receiver?.handleMeta(event.data);
            const handlers = channelHandlers.get(label);
            if (handlers) for (const handler of handlers) handler(event.data);
          };
        },
        onError: (code) => {
          if (code === 'host_mac_mismatch' || code === 'host_fingerprint_missing') {
            fail('this machine could not prove it is the one you asked for; the session was refused.', false);
          } else if (code === 'playout_delay_not_negotiated') {
            fail('this machine did not agree the low-latency terms swoop requires.', false);
          } else {
            fail('the connection to this machine failed.', true);
          }
        },
        onClosed: (reason) => {
          if (disposed) return;
          if (reason === 'kill') {
            continuityRef.current = null;
            setError('this session was ended from elsewhere.');
            setState('ended');
          } else if (reason !== 'closed') {
            // the host went away without a decision: a service restart, a
            // streamer that exited. the next session finds it back.
            setState('ended');
            scheduleReconnect();
          }
        },
      });

      await signaling.connect();
      if (disposed) return;
      await peer.start();
      if (disposed) return;

      const live: SwoopSession = {
        siteId,
        machineId,
        sid: grant.sid,
        viewerId: grant.viewerId,
        ctl: grant.ctl,
        fingerprint: identity.fingerprint,
        video,
        stage,
        contentRect: () => {
          const size = presenter?.stats();
          return contentRect(video, size?.width ?? 0, size?.height ?? 0);
        },
        peer,
        presenter,
        send: sendOnChannel,
        onChannelMessage: (label, handler) => {
          const handlers = channelHandlers.get(label) ?? new Set<(data: unknown) => void>();
          handlers.add(handler);
          channelHandlers.set(label, handlers);
          return () => {
            handlers.delete(handler);
          };
        },
        onFrame: (handler) => {
          frameHandlers.add(handler);
          return () => {
            frameHandlers.delete(handler);
          };
        },
        renewLease: () => renewLease(identity.fingerprint),
        leaseExpiresAt: () => leaseExpiresAt,
        end: (reason) => endRef.current(reason),
      };

      for (const feature of SWOOP_FEATURES) detachers.push(feature.attach(live));
      setSession(live);

      statsTimer = setInterval(() => {
        if (disposed) return;
        setStats((prev) => ({
          signal: prev.signal,
          presenter: presenter?.stats() ?? prev.presenter,
          receiver: receiver?.diagnostics() ?? prev.receiver,
          frame: latestFrame,
          feedback: swoopFeedback(live)?.diagnostics() ?? null,
          leaseExpiresAt,
        }));
      }, STATS_INTERVAL_MS);
    };

    void run().catch((err: unknown) => {
      fail(err instanceof Error ? err.message : 'this swoop session could not be started.', true);
    });

    return () => teardown('unmounted');
  }, [siteId, machineId, control, attempt, scheduleReconnect]);

  const stepUp = useMemo<SwoopStepUpControls>(
    () => ({ required: stepUpRequired, enrolled, submitProof, cancel }),
    [stepUpRequired, enrolled, submitProof, cancel],
  );

  return { state, error, stats, session, videoRef, stageRef, stepUp, end, reconnect, retryIn };
}
