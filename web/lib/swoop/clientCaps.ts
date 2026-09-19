/**
 * what this browser can actually receive — the client half of the codec choice
 * in PROTOCOL.md section 3 (codec = client ladder ∩ host encoders).
 *
 * gate G1 chose the rtp-media-track path, so the decoder that matters is the
 * **webrtc** one. the ladder is built from `RTCRtpReceiver.getCapabilities` and
 * `mediaCapabilities.decodingInfo({type:'webrtc'})`; `VideoDecoder` describes a
 * different decoder and must not stand in for it (spike 2.12 rule 1).
 *
 * the measurement that makes that non-negotiable: edge 153 exposes no
 * `video/H265` to webrtc and reports `supported: false` for it, on the same box,
 * gpu and driver where it decodes hevc happily through webcodecs and
 * `type: 'file'`. a webcodecs probe would call edge an hevc client and be wrong.
 * **arm b on edge is h.264**, and firefox is the structurally degraded client
 * (no rVFC to measure with, and it may offer neither hevc nor hardware h.264).
 * both are expected, not bugs.
 */

import { PLAYOUT_DELAY_URI, type SwoopCodec } from '@/lib/swoop/protocol';

/** annex-b, no `description` (PROTOCOL.md section 4). level comes from the bitstream, not the encoder config. */
const H264_CONTENT_TYPE = 'video/H264;codecs=avc1.64002A';
const HEVC_CONTENT_TYPE = 'video/H265;codecs=hev1.1.6.L123.B0';
const HEVC_WEBCODECS_STRING = 'hev1.1.6.L123.B0';

/** the probe frame: 1080p60 at the top of the bitrate ladder, so `smooth`/`powerEfficient` answer for our worst case. */
const PROBE_VIDEO = { width: 1920, height: 1080, bitrate: 8_000_000, framerate: 60 } as const;

export interface ClientCaps {
  /** the ladder, best first. always ends at h264 — the host has nothing below it to offer. */
  codecs: SwoopCodec[];
  /** codecs the receiver reports a hardware path for (`powerEfficient`). */
  hardware: SwoopCodec[];
  /** the playout-delay header extension PROTOCOL.md section 3 requires. */
  playoutDelay: boolean;
  /** diagnostic only. true on edge, which still gets h.264 — see the note above. */
  webCodecsHevc: boolean;
}

function receiverCapabilities(): RTCRtpCapabilities | null {
  if (typeof RTCRtpReceiver === 'undefined') return null;
  try {
    return RTCRtpReceiver.getCapabilities('video');
  } catch {
    return null;
  }
}

async function webrtcDecodingInfo(contentType: string): Promise<MediaCapabilitiesDecodingInfo | null> {
  const capabilities = navigator.mediaCapabilities as MediaCapabilities | undefined;
  if (!capabilities) return null;
  try {
    return await capabilities.decodingInfo({ type: 'webrtc', video: { contentType, ...PROBE_VIDEO } });
  } catch {
    return null;
  }
}

async function webCodecsHevc(): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined') return false;
  try {
    const support = await VideoDecoder.isConfigSupported({
      codec: HEVC_WEBCODECS_STRING,
      hardwareAcceleration: 'prefer-hardware',
    });
    return support.supported === true;
  } catch {
    // chromium has thrown here instead of resolving `{supported: false}`.
    return false;
  }
}

export async function probeClientCaps(): Promise<ClientCaps> {
  const receiver = receiverCapabilities();
  const mimeTypes = new Set((receiver?.codecs ?? []).map((codec) => codec.mimeType.toLowerCase()));
  const playoutDelay = (receiver?.headerExtensions ?? []).some((extension) => extension.uri === PLAYOUT_DELAY_URI);

  const codecs: SwoopCodec[] = [];
  const hardware: SwoopCodec[] = [];

  // hevc has no software decoder anywhere we measured: a viewer that negotiates
  // it without a hardware path gets a black stream, not a slow one. so it is
  // offered only when the receiver itself says hardware, never on a guess.
  const hevc = mimeTypes.has('video/h265') ? await webrtcDecodingInfo(HEVC_CONTENT_TYPE) : null;
  if (hevc?.supported && hevc.powerEfficient) {
    codecs.push('hevc');
    hardware.push('hevc');
  }

  const h264 = mimeTypes.has('video/h264') ? await webrtcDecodingInfo(H264_CONTENT_TYPE) : null;
  if (h264?.powerEfficient) hardware.push('h264');
  codecs.push('h264');

  return { codecs, hardware, playoutDelay, webCodecsHevc: await webCodecsHevc() };
}
