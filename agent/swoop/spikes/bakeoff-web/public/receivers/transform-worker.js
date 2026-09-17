// **Arm C's worker.** A receive-side `RTCRtpScriptTransform` runs in a worker
// by specification, so this is where arm C's encoded frames first become
// visible to the page.
//
// It does exactly two things and deliberately nothing else:
//
// 1. Reads `RTCEncodedVideoFrame`s off the transformer's `readable` and posts
//    them to the page, transferring the backing buffer so nothing is copied.
// 2. Stamps each one with an **absolute** timestamp
//    (`performance.timeOrigin + performance.now()`). A worker's
//    `performance.now()` counts from the worker's own time origin, not the
//    document's, so posting a bare `now()` would be a second unreconciled
//    clock in a harness whose whole point is that there is only one
//    (spike 0.1 §2.5). The page converts it back with its own `timeOrigin`,
//    and the conversion is exact: both origins are the same Unix epoch.
//
// It never calls `controller.enqueue()`. Arm C's entire premise is that the
// page decodes and presents the frames itself, so a frame written back to the
// pipeline would be decoded twice and presented once, by the element this arm
// exists to bypass.
//
// The decode is *not* done here, even though a worker with an OffscreenCanvas
// is the shape `research/02-browser-client.md` §2.4 recommends for the product.
// Arms A and C must decode and present identically or the bake-off measures two
// things at once (see `webcodecs.js`), and arm A has no worker. The cost of the
// choice is one `postMessage` hop, which the page measures per frame and reports
// as its own row rather than leaving inside arm C's total.

self.onrtctransform = (event) => {
  const t = event.transformer;
  const reader = t.readable.getReader();
  self.postMessage({
    type: 'attached',
    atMs: performance.timeOrigin + performance.now(),
    shape: {
      hasReadable: !!t.readable,
      hasWritable: !!t.writable,
      options: t.options ? JSON.stringify(t.options) : null,
      keys: Object.getOwnPropertyNames(Object.getPrototypeOf(t)).join(','),
    },
  });

  const pump = async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) {
        self.postMessage({ type: 'ended' });
        return;
      }
      const metadata = frame.getMetadata();
      self.postMessage(
        {
          type: 'frame',
          // The RTP timestamp: arm C's join key against the host's stamps on
          // the `swoop-meta` channel, exactly as arm B joins on
          // `requestVideoFrameCallback`'s `rtpTimestamp`.
          rtp: (metadata.rtpTimestamp ?? frame.timestamp) >>> 0,
          frameType: frame.type,
          data: frame.data,
          byteLength: frame.data.byteLength,
          atMs: performance.timeOrigin + performance.now(),
        },
        [frame.data],
      );
    }
  };

  pump().catch((err) => {
    self.postMessage({ type: 'error', message: String(err?.stack ?? err) });
  });
};
