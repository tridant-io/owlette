/**
 * intentionally empty.
 *
 * this file is the webcodecs half of plan.md D3's seam: a `VideoDecoder` fed
 * access units off a data channel. gate **g1 closed on 2026-09-18 on arm B**
 * (spike `0.2-video-path-bakeoff.md` §14) — the picture arrives on an rtp media
 * track and the `<video>` element decodes it, so nothing in the shipping path
 * decodes video in javascript and there is no decoder to configure, no
 * `EncodedVideoChunk` to submit and no `decodeQueueSize` to push back on.
 *
 * the arm that would have lived here measured 20.15 ms p50 and **1067 ms p95**
 * on a real lan, against arm B's 31.17 / 32.18: `sctp-proto`'s `RTO_MIN` is
 * 1000 ms and a real link has the loss loopback did not.
 *
 * the file is kept, empty, because the seam is what makes the wave 9
 * second-video-path track cheap if arm A is ever revisited with a working sctp
 * rto and a pacer. writing the decoder now would be shipping machinery nothing
 * calls. `receiver.ts` does not import it.
 */

export {};
