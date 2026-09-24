/** @jest-environment node */

import { readFileSync } from 'fs';
import path from 'path';
import { webcrypto } from 'crypto';

// Web Crypto is a browser global; the `node` runner does not expose it by
// default. Polyfill before importing the module under test, exactly as
// __tests__/lib/displayCanonical.test.ts does.
if (!('crypto' in globalThis)) {
  (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto;
}

import {
  BUNDLE_EXIT_CODES,
  SWOOP_PROTOCOL_VERSION,
  advanceFrameSequence,
  base64UrlDecode,
  base64UrlEncode,
  canonicalizeFingerprint,
  checkProtocolVersion,
  checkSendRights,
  computeHostFingerprintMac,
  decodeControlMessage,
  decodeCursorMessage,
  decodeFeedbackMessage,
  decodeFrameHeader,
  decodeInputMessage,
  decodeJwt,
  decodePipeControl,
  decodePipeEvent,
  decodeSignalingMessage,
  deriveViewerKey,
  encodeControlMessage,
  encodeCursorMessage,
  encodeFeedbackMessage,
  encodeFrameHeader,
  encodeInputMessage,
  encodePipeControl,
  encodePipeEvent,
  encodeSignalingMessage,
  extractSdpFingerprint,
  hostFingerprintMacInput,
  validateBundle,
  verifyHostFingerprintMac,
  verifySwoopJwt,
} from '@/lib/swoop/protocol';
import type {
  FrameSequenceState,
  RejectReason,
  SignalHello,
  SwoopJwtKey,
  SwoopResult,
  SwoopRole,
} from '@/lib/swoop/protocol';

// ---------------------------------------------------------------------------
// the shared oracle
// ---------------------------------------------------------------------------

const VECTOR_DIR = path.resolve(__dirname, '../../../../agent/swoop/testdata/protocol');

interface Vector {
  file: string;
  kind: string;
  format: 'json' | 'ndjson' | 'binary';
  expect: 'accept' | 'reject';
  reason: string;
  description: string;
  expected?: Record<string, unknown>;
  state?: { lastFrameId: number | null; haveIrap: boolean };
  exitCode?: number;
}

interface Manifest {
  version: number;
  protocolVersion: number;
  keys: string;
  timeAnchor: number;
  streamerEpoch: number;
  vectors: Vector[];
}

const readVectorFile = (file: string): Buffer => readFileSync(path.join(VECTOR_DIR, file));
const readVectorJson = (file: string): Record<string, unknown> =>
  JSON.parse(readVectorFile(file).toString('utf8'));

const manifest = readVectorJson('index.json') as unknown as Manifest;

const testKeys = readVectorJson(manifest.keys) as unknown as {
  keys: { kid: string; seedAscii: string; publicKey: string }[];
};
const keyByKid = new Map(testKeys.keys.map((k) => [k.kid, k]));

/**
 * every reason the library can produce. the manifest naming a reason that is
 * not here means the spec grew a refusal this module does not implement.
 */
const KNOWN_REASONS: readonly RejectReason[] = [
  'malformed_message',
  'binary_unsupported',
  'message_too_large',
  'unknown_type',
  'forbidden_type',
  'wrong_role',
  'version_mismatch',
  'unknown_kid',
  'alg_not_permitted',
  'bad_signature',
  'iss_mismatch',
  'aud_mismatch',
  'role_mismatch',
  'expired',
  'lifetime_too_long',
  'fp_missing',
  'fp_mismatch',
  'site_mismatch',
  'machine_mismatch',
  'sid_mismatch',
  'jti_replayed',
  'unknown_record',
  'dangling_reference',
  'not_permitted',
  'clipboard_too_large',
  'bundle_invalid',
  'overrides_not_permitted',
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** recursive key sort: "byte-identical" for json means identical content, not
 *  an arbitrary key order the manifest never promised. binary vectors are
 *  compared byte for byte instead. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = sort(o[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const verdict = (result: SwoopResult<unknown>): { expect: 'accept' | 'reject'; reason: string } =>
  result.ok ? { expect: 'accept', reason: 'ok' } : { expect: 'reject', reason: result.reason };

/** ed25519 pkcs#8 wrapper for a raw 32-byte seed: webcrypto imports private
 *  keys as pkcs8 only, and the vectors publish seeds. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

async function signEd25519(seedAscii: string, message: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedAscii, 'ascii')]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message as BufferSource));
}

/** the control and feedback fixtures annotate each message with the direction
 *  it travels. `dir` is a real wire field on `clip` and nowhere else. */
function stripDirection(message: Record<string, unknown>): Record<string, unknown> {
  if (message.t === 'clip') return message;
  const { dir: _dir, ...rest } = message;
  return rest;
}

// ---------------------------------------------------------------------------
// per-kind handlers — an unknown kind throws, it is never skipped
// ---------------------------------------------------------------------------

type Handler = (vector: Vector) => Promise<SwoopResult<unknown>> | SwoopResult<unknown>;

const handleHandshake: Handler = (vector) => {
  const file = readVectorJson(vector.file) as { supported: number; message: Record<string, unknown> };
  const decoded = decodeSignalingMessage(JSON.stringify(file.message));
  if (!decoded.ok) return decoded;
  const hello = decoded.value as SignalHello;
  const checked = checkProtocolVersion(hello, file.supported);
  if (checked.ok) {
    expect(canonical(JSON.parse(encodeSignalingMessage(hello)))).toBe(canonical(file.message));
  }
  return checked;
};

const handleJwt: Handler = async (vector) => {
  const file = readVectorJson(vector.file) as unknown as {
    token: string;
    verifier: {
      aud: 'swoop-host' | 'swoop-signal';
      site: string;
      machine: string;
      sid: string | null;
      anchorNow: number;
      elapsedSeconds: number;
      offerFingerprint: string | null;
      keys: string[];
    };
    claims: Record<string, unknown>;
  };
  const keys: SwoopJwtKey[] = file.verifier.keys.map((kid) => {
    const k = keyByKid.get(kid);
    if (!k) throw new Error(`vector ${vector.file} names key ${kid}, absent from ${manifest.keys}`);
    return { kid: k.kid, alg: 'EdDSA', key: k.publicKey };
  });
  const result = await verifySwoopJwt(file.token, { ...file.verifier, keys });
  if (result.ok) {
    expect(result.value).toEqual(file.claims);
    // the signature half of the round trip: ed25519 is deterministic, so
    // re-signing the vector's own signing input must reproduce it byte for byte.
    const decoded = decodeJwt(file.token);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const seed = keyByKid.get(decoded.value.header.kid);
      expect(seed).toBeDefined();
      const resigned = await signEd25519(seed!.seedAscii, decoded.value.signingInput);
      expect(base64UrlEncode(resigned)).toBe(file.token.split('.')[2]);
    }
  }
  return result;
};

const handleSignaling: Handler = (vector) => {
  const file = readVectorJson(vector.file) as {
    sender: { role: SwoopRole; id: string };
    message: Record<string, unknown>;
  };
  // send rights first: a viewer's `answer` is `wrong_role` whatever its body.
  const rights = checkSendRights(file.sender.role, String(file.message.type));
  if (!rights.ok) return rights;
  const decoded = decodeSignalingMessage(JSON.stringify(file.message));
  if (decoded.ok) {
    expect(canonical(JSON.parse(encodeSignalingMessage(decoded.value)))).toBe(canonical(file.message));
  }
  return decoded;
};

const handleFrameHeader: Handler = (vector) => {
  const bytes = readVectorFile(vector.file);
  const decoded = decodeFrameHeader(new Uint8Array(bytes));
  if (!decoded.ok) return decoded;

  const { reservedFlags, ...wire } = decoded.value;
  expect(reservedFlags).toBe(0); // bits 3-7 are reserved and sent zero
  expect(wire).toEqual(vector.expected);
  expect(Buffer.from(encodeFrameHeader(decoded.value))).toEqual(bytes);

  const state: FrameSequenceState = vector.state
    ? { lastFrameId: vector.state.lastFrameId, haveIrap: vector.state.haveIrap }
    : { lastFrameId: null, haveIrap: false };
  return advanceFrameSequence(state, decoded.value);
};

// the reference build for the bundle vectors. the manifest does not name an
// expected agentVersion, so the accept vector defines it — the rust core has
// to make the same choice, because the crate's own version is not it.
const REFERENCE_AGENT_VERSION = (readVectorJson('bundle/bundle-valid.json').agentVersion as string);

const handleBundle: Handler = (vector) => {
  const text = readVectorFile(vector.file).toString('utf8');
  const result = validateBundle(text, {
    protocolVersion: manifest.protocolVersion,
    agentVersion: REFERENCE_AGENT_VERSION,
    allowOverrides: false,
  });
  if (result.ok) {
    expect(canonical(result.value)).toBe(canonical(JSON.parse(text)));
  } else if (vector.exitCode !== undefined) {
    expect(BUNDLE_EXIT_CODES[result.reason as keyof typeof BUNDLE_EXIT_CODES]).toBe(vector.exitCode);
  }
  return result;
};

function handleNdjson(vector: Vector, decode: (line: string) => SwoopResult<unknown>, encode: (v: never) => string): SwoopResult<unknown> {
  const lines = readVectorFile(vector.file).toString('utf8').split('\n').filter((l) => l.trim() !== '');
  expect(lines.length).toBeGreaterThan(0);
  let last: SwoopResult<unknown> = { ok: true, value: null };
  for (const line of lines) {
    last = decode(line);
    if (!last.ok) return last;
    expect(canonical(JSON.parse(encode(last.value as never)))).toBe(canonical(JSON.parse(line)));
  }
  return last;
}

function handleMessages(
  vector: Vector,
  decode: (raw: unknown, viewer?: { ctl: boolean }) => SwoopResult<unknown>,
  encode: (v: never) => string,
): SwoopResult<unknown> {
  const file = readVectorJson(vector.file) as unknown as {
    channel: string;
    viewer?: { id: string; ctl: boolean };
    messages: Record<string, unknown>[];
  };
  expect(file.messages.length).toBeGreaterThan(0);
  let last: SwoopResult<unknown> = { ok: true, value: null };
  for (const raw of file.messages) {
    const message = stripDirection(raw);
    last = decode(JSON.stringify(message), file.viewer ? { ctl: file.viewer.ctl } : undefined);
    if (!last.ok) return last;
    expect(canonical(JSON.parse(encode(last.value as never)))).toBe(canonical(message));
  }
  return last;
}

const handleCrypto: Handler = async (vector) => {
  const file = readVectorJson(vector.file) as unknown as {
    hkdf: { viewerKey: { ikm: string; salt: string; info: string; length: number; expected: string } };
    hostMac: { key: string; parts: string[]; input: string; expected: string };
  };
  const ikm = base64UrlDecode(file.hkdf.viewerKey.ikm);
  expect(ikm).not.toBeNull();
  const k = await deriveViewerKey(ikm!, file.hkdf.viewerKey.info);
  expect(base64UrlEncode(k)).toBe(file.hkdf.viewerKey.expected);

  const [, , sid, , viewerId, , fingerprint] = file.hostMac.parts;
  const input = hostFingerprintMacInput(sid, viewerId, fingerprint);
  expect(base64UrlEncode(input)).toBe(file.hostMac.input);

  const mac = await computeHostFingerprintMac(k, sid, viewerId, fingerprint);
  expect(base64UrlEncode(mac)).toBe(file.hostMac.expected);
  expect(await verifyHostFingerprintMac(k, sid, viewerId, fingerprint, file.hostMac.expected)).toBe(true);
  return { ok: true, value: null };
};

const HANDLERS: Record<string, Handler> = {
  handshake: handleHandshake,
  jwt: handleJwt,
  signaling: handleSignaling,
  'frame-header': handleFrameHeader,
  bundle: handleBundle,
  'pipe-stdout': (v) => handleNdjson(v, decodePipeEvent, encodePipeEvent),
  'pipe-stdin': (v) => handleNdjson(v, decodePipeControl, encodePipeControl),
  'message-input': (v) => handleMessages(v, decodeInputMessage, encodeInputMessage),
  'message-cursor': (v) => handleMessages(v, (raw) => decodeCursorMessage(raw), encodeCursorMessage),
  'message-clipboard': (v) => handleMessages(v, decodeControlMessage, encodeControlMessage),
  'message-control': (v) => handleMessages(v, decodeControlMessage, encodeControlMessage),
  'message-feedback': (v) => handleMessages(v, (raw) => decodeFeedbackMessage(raw), encodeFeedbackMessage),
  crypto: handleCrypto,
};

// ---------------------------------------------------------------------------
// the manifest walk
// ---------------------------------------------------------------------------

const observed = { accept: 0, reject: 0 };

describe('swoop protocol golden vectors', () => {
  it('the manifest is the one this build speaks', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.protocolVersion).toBe(SWOOP_PROTOCOL_VERSION);
    expect(manifest.vectors.length).toBeGreaterThan(0);
  });

  it('every kind and reason in the manifest is covered by this module', () => {
    for (const vector of manifest.vectors) {
      // a vector nobody runs is worse than no vector: an unrecognised kind is
      // a failure here, never a skip.
      expect(Object.keys(HANDLERS)).toContain(vector.kind);
      if (vector.expect === 'reject') {
        expect(KNOWN_REASONS).toContain(vector.reason as RejectReason);
      } else {
        expect(vector.reason).toBe('ok');
      }
      expect(['json', 'ndjson', 'binary']).toContain(vector.format);
      expect(typeof vector.description).toBe('string');
    }
  });

  for (const vector of manifest.vectors) {
    it(`${vector.file} -> ${vector.expect}/${vector.reason}`, async () => {
      const handler = HANDLERS[vector.kind];
      if (!handler) throw new Error(`unknown vector kind: ${vector.kind}`);
      const result = await handler(vector);
      expect(verdict(result)).toEqual({ expect: vector.expect, reason: vector.reason });
      observed[vector.expect] += 1;
    });
  }

  it('exercised every vector in index.json', () => {
    expect(observed.accept + observed.reject).toBe(manifest.vectors.length);
    expect(observed.accept).toBe(manifest.vectors.filter((v) => v.expect === 'accept').length);
    expect(observed.reject).toBe(manifest.vectors.filter((v) => v.expect === 'reject').length);
  });
});

// ---------------------------------------------------------------------------
// contract details the manifest implies but does not carry as a file
// ---------------------------------------------------------------------------

describe('the answer mac binds the host fingerprint to the sdp', () => {
  it('recomputes signal-answer.json from the crypto vector', async () => {
    const cryptoVector = readVectorJson('crypto/hkdf-and-host-mac.json') as unknown as {
      hkdf: { viewerKey: { ikm: string; info: string } };
      hostMac: { parts: string[] };
    };
    const answer = readVectorJson('signaling/signal-answer.json') as unknown as {
      message: { sdp: string; mac: string; to: string };
    };
    const k = await deriveViewerKey(
      base64UrlDecode(cryptoVector.hkdf.viewerKey.ikm)!,
      cryptoVector.hkdf.viewerKey.info,
    );
    const sdpFingerprint = extractSdpFingerprint(answer.message.sdp);
    expect(sdpFingerprint).toBe(cryptoVector.hostMac.parts[6]);
    const ok = await verifyHostFingerprintMac(
      k,
      cryptoVector.hostMac.parts[2],
      cryptoVector.hostMac.parts[4],
      sdpFingerprint!,
      answer.message.mac,
    );
    expect(ok).toBe(true);
  });

  it('a substituted fingerprint fails the mac', async () => {
    const k = await deriveViewerKey(new Uint8Array(32).fill(0x5a), 'viewer_0000000001');
    const relay = 'sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
    const mac = await computeHostFingerprintMac(k, 'sid_0000000000000001', 'viewer_0000000001', relay);
    const honest = 'sha-256 A0:A1:A2:A3:A4:A5:A6:A7:A8:A9:AA:AB:AC:AD:AE:AF:B0:B1:B2:B3:B4:B5:B6:B7:B8:B9:BA:BB:BC:BD:BE:BF';
    expect(await verifyHostFingerprintMac(k, 'sid_0000000000000001', 'viewer_0000000001', honest, base64UrlEncode(mac))).toBe(false);
  });

  it('canonicalises the hash token and the hex', () => {
    expect(canonicalizeFingerprint('SHA-256 a0:b1:c2:d3')).toBe('sha-256 A0:B1:C2:D3');
    expect(canonicalizeFingerprint('not a fingerprint')).toBeNull();
  });
});

describe('the expiry check runs against the anchor, not the wall clock', () => {
  const expired = readVectorJson('jwt/jwt-viewer-expired.json') as unknown as {
    token: string;
    verifier: {
      aud: 'swoop-host';
      site: string;
      machine: string;
      sid: string;
      anchorNow: number;
      elapsedSeconds: number;
      offerFingerprint: string;
      keys: string[];
    };
  };
  const keys = (kids: string[]): SwoopJwtKey[] =>
    kids.map((kid) => ({ kid, alg: 'EdDSA', key: keyByKid.get(kid)!.publicKey }));

  it('the same token passes against an earlier anchor', async () => {
    const result = await verifySwoopJwt(expired.token, {
      ...expired.verifier,
      // the anchor the api would have minted this token against
      anchorNow: 1789689480,
      elapsedSeconds: 2,
      keys: keys(expired.verifier.keys),
    });
    expect(result.ok).toBe(true);
  });

  it('monotonic elapsed time alone expires it', async () => {
    const result = await verifySwoopJwt(expired.token, {
      ...expired.verifier,
      anchorNow: 1789689480,
      elapsedSeconds: 120,
      keys: keys(expired.verifier.keys),
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an unknown kid before it ever looks at the signature', async () => {
    const result = await verifySwoopJwt(expired.token, {
      ...expired.verifier,
      anchorNow: 1789689480,
      keys: keys(['test-kid-2']),
    });
    expect(result).toEqual({ ok: false, reason: 'unknown_kid', detail: 'test-kid-1' });
  });

  it('refuses a tampered claim set', async () => {
    const [header, , signature] = expired.token.split('.');
    const forged = `${header}.${base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ iss: 'owlette-api', aud: 'swoop-host', role: 'viewer', site: 'site_goldenvector', machine: 'machine_goldenvector', sid: 'sid_0000000000000001', viewer: 'viewer_0000000001', ctl: true, fp: expired.verifier.offerFingerprint, iat: 1789689600, exp: 1789689660, jti: 'jti_forged' })),
    )}.${signature}`;
    const result = await verifySwoopJwt(forged, { ...expired.verifier, keys: keys(expired.verifier.keys) });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('signaling refusals', () => {
  it('rejects a binary frame and an oversized one', () => {
    expect(decodeSignalingMessage(new ArrayBuffer(8))).toEqual({ ok: false, reason: 'binary_unsupported' });
    const huge = JSON.stringify({ type: 'bye', reason: 'x'.repeat(65 * 1024) });
    expect(decodeSignalingMessage(huge)).toEqual({ ok: false, reason: 'message_too_large' });
  });

  it('rejects an unparseable frame and an unknown type', () => {
    expect(decodeSignalingMessage('{')).toEqual({ ok: false, reason: 'malformed_message' });
    expect(verdict(decodeSignalingMessage(JSON.stringify({ type: 'nope' })))).toEqual({
      expect: 'reject',
      reason: 'unknown_type',
    });
  });

  it('a viewer never sends a server-only type', () => {
    expect(verdict(checkSendRights('viewer', 'ring'))).toEqual({ expect: 'reject', reason: 'forbidden_type' });
    expect(verdict(checkSendRights('host', 'offer'))).toEqual({ expect: 'reject', reason: 'wrong_role' });
    expect(checkSendRights('host', 'answer').ok).toBe(true);
  });
});

describe('frame records', () => {
  const key = decodeFrameHeader(new Uint8Array(readVectorFile('frame/frame-key-1080p.bin')));

  it('drops a record with an unknown kind or header version', () => {
    const bytes = new Uint8Array(readVectorFile('frame/frame-key-1080p.bin'));
    const badKind = bytes.slice();
    badKind[0] = 0x02;
    expect(verdict(decodeFrameHeader(badKind))).toEqual({ expect: 'reject', reason: 'unknown_record' });
    const badVersion = bytes.slice();
    badVersion[1] = 0x02;
    expect(verdict(decodeFrameHeader(badVersion))).toEqual({ expect: 'reject', reason: 'unknown_record' });
  });

  it('refuses a record whose payload length disagrees with the header', () => {
    const bytes = new Uint8Array(readVectorFile('frame/frame-key-1080p.bin'));
    new DataView(bytes.buffer).setUint32(20, 16, true);
    expect(verdict(decodeFrameHeader(bytes))).toEqual({ expect: 'reject', reason: 'malformed_message' });
  });

  it('waits for a recovery point before the first irap', () => {
    const delta = decodeFrameHeader(new Uint8Array(readVectorFile('frame/frame-delta-fragmented.bin')));
    expect(delta.ok).toBe(true);
    if (!delta.ok) return;
    expect(verdict(advanceFrameSequence({ lastFrameId: null, haveIrap: false }, delta.value))).toEqual({
      expect: 'reject',
      reason: 'dangling_reference',
    });
  });

  it('an irap resets the sequence whatever the gap', () => {
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const out = advanceFrameSequence({ lastFrameId: 7, haveIrap: false }, key.value);
    expect(out).toEqual({ ok: true, value: { lastFrameId: 41, haveIrap: true } });
  });

  it('wraps frameId at 2^32', () => {
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const wrapped = { ...key.value, irap: false, resolutionChanged: false, frameId: 0 };
    expect(advanceFrameSequence({ lastFrameId: 0xffffffff, haveIrap: true }, wrapped).ok).toBe(true);
  });
});

describe('channel messages', () => {
  it('gates input and the paste direction on ctl, and nothing else', () => {
    const press = JSON.stringify({ t: 'k', code: 'KeyA', down: true, seq: 1 });
    expect(decodeInputMessage(press, { ctl: false })).toEqual({
      ok: false,
      reason: 'not_permitted',
      detail: 'input requires ctl',
    });
    expect(decodeInputMessage(press, { ctl: true }).ok).toBe(true);
    // quality is per viewer and allowed for watchers; display is shared state.
    expect(decodeControlMessage(JSON.stringify({ t: 'quality', preset: 'balanced', maxBitrateKbps: 1, maxFps: 30 }), { ctl: false }).ok).toBe(true);
    expect(verdict(decodeControlMessage(JSON.stringify({ t: 'display', index: 1 }), { ctl: false }))).toEqual({
      expect: 'reject',
      reason: 'not_permitted',
    });
    const paste = { t: 'clip', dir: 'to-viewer', fmt: 'text', seq: 1, chunk: 0, chunks: 1, totalBytes: 5, data: 'aGVsbG8=' };
    expect(decodeControlMessage(JSON.stringify(paste), { ctl: false }).ok).toBe(true);
    expect(verdict(decodeControlMessage(JSON.stringify({ ...paste, dir: 'to-host' }), { ctl: false }))).toEqual({
      expect: 'reject',
      reason: 'not_permitted',
    });
  });

  it('checks the clipboard cap before buffering a chunk', () => {
    const base = { t: 'clip', dir: 'to-host', fmt: 'text', seq: 1, chunk: 0, chunks: 1, data: 'aGVsbG8=' };
    expect(decodeControlMessage(JSON.stringify({ ...base, totalBytes: 256 * 1024 }), { ctl: true }).ok).toBe(true);
    expect(verdict(decodeControlMessage(JSON.stringify({ ...base, totalBytes: 256 * 1024 + 1 }), { ctl: true }))).toEqual({
      expect: 'reject',
      reason: 'clipboard_too_large',
    });
    // an image gets the larger cap, and a single chunk still cannot exceed 16 KiB
    expect(decodeControlMessage(JSON.stringify({ ...base, fmt: 'png', totalBytes: 2 * 1024 * 1024 }), { ctl: true }).ok).toBe(true);
    const fatChunk = { ...base, totalBytes: 100, data: Buffer.alloc(17 * 1024, 0x41).toString('base64') };
    expect(verdict(decodeControlMessage(JSON.stringify(fatChunk), { ctl: true }))).toEqual({
      expect: 'reject',
      reason: 'clipboard_too_large',
    });
  });

  it('a cached cursor shape is id-only, a partial upload is malformed', () => {
    expect(decodeCursorMessage(JSON.stringify({ t: 'cshape', id: 7 })).ok).toBe(true);
    expect(verdict(decodeCursorMessage(JSON.stringify({ t: 'cshape', id: 7, w: 32 })))).toEqual({
      expect: 'reject',
      reason: 'malformed_message',
    });
  });

  it('a cursor shape upload carries its scale, absent meaning as captured, and never below one', () => {
    const upload = { t: 'cshape', id: 7, hotX: 1, hotY: 2, w: 32, h: 32, png: 'AA==' };
    const plain = decodeCursorMessage(JSON.stringify(upload));
    expect(plain.ok && plain.value.t === 'cshape' && plain.value.scale).toBeUndefined();
    const shrunk = decodeCursorMessage(JSON.stringify({ ...upload, scale: 2 }));
    expect(shrunk.ok && shrunk.value.t === 'cshape' && shrunk.value.scale).toBe(2);
    expect(verdict(decodeCursorMessage(JSON.stringify({ ...upload, scale: 0 })))).toEqual({
      expect: 'reject',
      reason: 'malformed_message',
    });
  });

  it('never throws on junk', () => {
    for (const decode of [decodeInputMessage, decodeCursorMessage, decodeControlMessage, decodeFeedbackMessage]) {
      expect(decode('not json').ok).toBe(false);
      expect(decode(new Uint8Array([1, 2, 3])).ok).toBe(false);
      expect(decode('[]').ok).toBe(false);
      expect(decode('null').ok).toBe(false);
    }
  });
});

describe('the bundle is refused rather than repaired', () => {
  const valid = readVectorFile('bundle/bundle-valid.json').toString('utf8');
  const expectations = { protocolVersion: 1, agentVersion: REFERENCE_AGENT_VERSION };

  it('accepts overrides only under a testhooks build', () => {
    const withOverrides = readVectorFile('bundle/bundle-overrides-no-testhooks.json').toString('utf8');
    expect(verdict(validateBundle(withOverrides, expectations))).toEqual({
      expect: 'reject',
      reason: 'overrides_not_permitted',
    });
    expect(validateBundle(withOverrides, { ...expectations, allowOverrides: true }).ok).toBe(true);
  });

  it('refuses a protocol version mismatch as well as an agent version one', () => {
    expect(verdict(validateBundle(valid, { ...expectations, protocolVersion: 2 }))).toEqual({
      expect: 'reject',
      reason: 'version_mismatch',
    });
  });

  it('carries no bundle field in a rejection', () => {
    const rejected = validateBundle(valid, { ...expectations, agentVersion: '9.9.9' });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    const rendered = JSON.stringify(rejected);
    for (const secret of ['FAKE.HOST.TOKEN', 'FAKE-TURN-CREDENTIAL', 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo']) {
      expect(rendered).not.toContain(secret);
    }
  });
});
