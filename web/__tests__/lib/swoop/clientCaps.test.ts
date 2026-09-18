/**
 * @jest-environment jsdom
 */

import { probeClientCaps } from '@/lib/swoop/clientCaps';
import { PLAYOUT_DELAY_URI } from '@/lib/swoop/protocol';

const CHROME_MIMES = ['video/VP8', 'video/rtx', 'video/VP9', 'video/H264', 'video/AV1', 'video/H265'];
const EDGE_MIMES = CHROME_MIMES.filter((mime) => mime !== 'video/H265');

interface Stubs {
  mimeTypes?: string[] | null;
  headerExtensions?: string[];
  decodingInfo?: (config: MediaDecodingConfiguration) => Promise<MediaCapabilitiesDecodingInfo>;
  isConfigSupported?: jest.Mock;
}

function stubBrowser({ mimeTypes = CHROME_MIMES, headerExtensions = [PLAYOUT_DELAY_URI], decodingInfo, isConfigSupported }: Stubs) {
  if (mimeTypes !== null) {
    Object.defineProperty(globalThis, 'RTCRtpReceiver', {
      configurable: true,
      value: {
        getCapabilities: () => ({
          codecs: mimeTypes.map((mimeType) => ({ mimeType, clockRate: 90000 })),
          headerExtensions: headerExtensions.map((uri) => ({ uri })),
        }),
      },
    });
  }

  Object.defineProperty(navigator, 'mediaCapabilities', {
    configurable: true,
    value: {
      decodingInfo:
        decodingInfo ??
        (async ({ video }: MediaDecodingConfiguration) => {
          const hardware = /H264|H265/.test(video?.contentType ?? '');
          return { supported: true, smooth: hardware, powerEfficient: hardware } as MediaCapabilitiesDecodingInfo;
        }),
    },
  });

  Object.defineProperty(globalThis, 'VideoDecoder', {
    configurable: true,
    value: { isConfigSupported: isConfigSupported ?? jest.fn(async () => ({ supported: true })) },
  });
}

afterEach(() => {
  for (const key of ['RTCRtpReceiver', 'VideoDecoder']) {
    Reflect.deleteProperty(globalThis, key);
  }
  Reflect.deleteProperty(navigator, 'mediaCapabilities');
});

describe('probeClientCaps', () => {
  it('offers hevc above the h264 floor when the webrtc receiver reports hardware hevc', async () => {
    stubBrowser({});
    const caps = await probeClientCaps();

    expect(caps.codecs).toEqual(['hevc', 'h264']);
    expect(caps.hardware).toEqual(['hevc', 'h264']);
  });

  it('degrades to h264 when the receiver does not list h265 — edge, even though webcodecs says yes', async () => {
    const isConfigSupported = jest.fn(async () => ({ supported: true }));
    stubBrowser({ mimeTypes: EDGE_MIMES, isConfigSupported });

    const caps = await probeClientCaps();

    expect(caps.codecs).toEqual(['h264']);
    expect(caps.webCodecsHevc).toBe(true);
    expect(isConfigSupported).toHaveBeenCalledTimes(1);
  });

  it('never offers hevc the receiver cannot decode in hardware', async () => {
    stubBrowser({
      decodingInfo: async ({ video }: MediaDecodingConfiguration) => {
        const isHevc = /H265/.test(video?.contentType ?? '');
        return {
          supported: true,
          smooth: !isHevc,
          powerEfficient: !isHevc,
        } as MediaCapabilitiesDecodingInfo;
      },
    });

    const caps = await probeClientCaps();

    expect(caps.codecs).toEqual(['h264']);
    expect(caps.hardware).toEqual(['h264']);
  });

  it('treats a throwing isConfigSupported as unsupported, not a rejection', async () => {
    stubBrowser({
      isConfigSupported: jest.fn(async () => {
        throw new TypeError('Unsupported configuration');
      }),
    });

    await expect(probeClientCaps()).resolves.toMatchObject({ webCodecsHevc: false });
  });

  it('reports whether the receiver offers the playout-delay extension', async () => {
    stubBrowser({ headerExtensions: [] });
    await expect(probeClientCaps()).resolves.toMatchObject({ playoutDelay: false });

    stubBrowser({});
    await expect(probeClientCaps()).resolves.toMatchObject({ playoutDelay: true });
  });

  it('keeps the h264 floor on an engine that exposes no receiver capabilities', async () => {
    stubBrowser({ mimeTypes: null });

    const caps = await probeClientCaps();

    expect(caps.codecs).toEqual(['h264']);
    expect(caps.hardware).toEqual([]);
    expect(caps.playoutDelay).toBe(false);
  });
});
