/**
 * @jest-environment node
 *
 * swoop JWT mint/verify. The verification ORDER is the contract the Rust
 * streamer and the Worker also implement, so the negative cases here name the
 * same reasons as `agent/swoop/PROTOCOL.md` §11.
 *
 * Keys are generated per run — nothing here is a real key.
 */

import { generateKeyPairSync } from 'crypto';

import {
  SWOOP_ISSUER,
  SwoopTokenError,
  VIEWER_MAX_TTL_SECONDS,
  canonicalizeFingerprint,
  mintDoorbellToken,
  mintHostToken,
  mintViewerToken,
  swoopJwtPublicKeys,
  verifySwoopToken,
} from '@/lib/swoop/tokens.server';

const FP = 'sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

const BASE = {
  uid: 'uid-1',
  site: 'site-a',
  machine: 'machine-x',
  sid: 'sid-1',
  viewer: 'viewer-1',
  ctl: true,
  fp: FP,
};

function newKeypair(): { priv: string; pub: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    // Raw 32-byte halves, base64url — the shape the bundle carries.
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16).toString('base64url'),
    pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url'),
  };
}

const KEYS = newKeypair();
const OTHER = newKeypair();

beforeEach(() => {
  process.env.SWOOP_JWT_PRIVATE_KEY = KEYS.priv;
  process.env.SWOOP_JWT_PUBLIC_KEY = KEYS.pub;
  process.env.SWOOP_JWT_KID = 'kid-current';
});

describe('canonicalizeFingerprint', () => {
  it('lowercases the hash token and uppercases the hex', () => {
    expect(canonicalizeFingerprint('SHA-256 aa:bb:cc:dd')).toBe('sha-256 AA:BB:CC:DD');
  });

  it('refuses anything that is not a fingerprint', () => {
    expect(canonicalizeFingerprint('')).toBeNull();
    expect(canonicalizeFingerprint('sha-256')).toBeNull();
    expect(canonicalizeFingerprint('sha-256 not-hex')).toBeNull();
    expect(canonicalizeFingerprint(undefined)).toBeNull();
  });
});

describe('mint', () => {
  it('round-trips a viewer token', () => {
    const minted = mintViewerToken(BASE);
    const result = verifySwoopToken(minted.token, {
      audience: 'swoop-host',
      roles: ['viewer'],
      site: BASE.site,
      machine: BASE.machine,
      sid: BASE.sid,
      fingerprint: FP,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject({
      iss: SWOOP_ISSUER,
      aud: 'swoop-host',
      role: 'viewer',
      site: 'site-a',
      machine: 'machine-x',
      sid: 'sid-1',
      viewer: 'viewer-1',
      uid: 'uid-1',
      ctl: true,
      fp: FP,
      jti: minted.jti,
    });
  });

  it('refuses to mint a viewer token without fp', () => {
    expect(() => mintViewerToken({ ...BASE, fp: '' })).toThrow(SwoopTokenError);
    expect(() => mintViewerToken({ ...BASE, fp: 'not a fingerprint' })).toThrow(/fp_missing/);
  });

  it('caps viewer exp at 60 s however long the caller asked for', () => {
    const minted = mintViewerToken({ ...BASE, ttlSeconds: 3600 });
    expect(minted.expiresAt - minted.issuedAt).toBe(VIEWER_MAX_TTL_SECONDS);
  });

  it('caps host and doorbell exp at 300 s', () => {
    const host = mintHostToken({ site: 'site-a', machine: 'machine-x', sid: 'sid-1', ttlSeconds: 9999 });
    const doorbell = mintDoorbellToken({ site: 'site-a', machine: 'machine-x', ttlSeconds: 9999 });
    expect(host.expiresAt - host.issuedAt).toBe(300);
    expect(doorbell.expiresAt - doorbell.issuedAt).toBe(300);
  });

  it('gives a doorbell token no sid — a doorbell names no session', () => {
    const minted = mintDoorbellToken({ site: 'site-a', machine: 'machine-x' });
    const result = verifySwoopToken(minted.token, {
      audience: 'swoop-signal',
      roles: ['doorbell'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sid).toBeUndefined();
  });

  it('refuses an id that is not `^[A-Za-z0-9_-]{1,64}$`', () => {
    expect(() => mintViewerToken({ ...BASE, machine: 'machine/../x' })).toThrow(/machine_invalid/);
  });
});

describe('verify', () => {
  it('rejects a tampered payload', () => {
    const minted = mintViewerToken(BASE);
    const [h, p, s] = minted.token.split('.');
    const forged = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    forged.ctl = true;
    forged.uid = 'someone-else';
    const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
    expect(verifySwoopToken(tampered, { audience: 'swoop-host' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an unknown kid before it ever looks at the signature', () => {
    const minted = mintViewerToken(BASE);
    process.env.SWOOP_JWT_KID = 'kid-next';
    expect(verifySwoopToken(minted.token, { audience: 'swoop-host' })).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
  });

  it('rejects a token signed by another key', () => {
    process.env.SWOOP_JWT_PRIVATE_KEY = OTHER.priv;
    const minted = mintViewerToken(BASE);
    process.env.SWOOP_JWT_PRIVATE_KEY = KEYS.priv;
    expect(verifySwoopToken(minted.token, { audience: 'swoop-host' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects alg none and any alg that is not EdDSA', () => {
    const minted = mintViewerToken(BASE);
    const [, p, s] = minted.token.split('.');
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'kid-current' }),
    ).toString('base64url');
    expect(verifySwoopToken(`${header}.${p}.${s}`, { audience: 'swoop-host' })).toEqual({
      ok: false,
      reason: 'bad_alg',
    });
  });

  it('rejects the wrong audience', () => {
    const minted = mintViewerToken(BASE);
    expect(verifySwoopToken(minted.token, { audience: 'swoop-signal' })).toEqual({
      ok: false,
      reason: 'aud_mismatch',
    });
  });

  it('rejects a role the verifier does not accept for this message', () => {
    const minted = mintHostToken({ site: 'site-a', machine: 'machine-x', sid: 'sid-1' });
    expect(
      verifySwoopToken(minted.token, { audience: 'swoop-signal', roles: ['doorbell'] }),
    ).toEqual({ ok: false, reason: 'role_not_permitted' });
  });

  it('rejects an expired token and accepts the same one against an earlier now', () => {
    const iat = Math.floor(Date.now() / 1000) - 120;
    const minted = mintViewerToken({ ...BASE, now: iat });
    expect(verifySwoopToken(minted.token, { audience: 'swoop-host' })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifySwoopToken(minted.token, { audience: 'swoop-host', now: iat + 30 }).ok).toBe(true);
  });

  it('rejects a viewer token whose fp does not match the live offer', () => {
    const minted = mintViewerToken(BASE);
    expect(
      verifySwoopToken(minted.token, {
        audience: 'swoop-host',
        fingerprint: 'sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
      }),
    ).toEqual({ ok: false, reason: 'fp_mismatch' });
  });

  it('rejects a token for another machine even when the room says otherwise', () => {
    const minted = mintViewerToken(BASE);
    expect(
      verifySwoopToken(minted.token, { audience: 'swoop-host', machine: 'machine-y' }),
    ).toEqual({ ok: false, reason: 'machine_mismatch' });
    expect(verifySwoopToken(minted.token, { audience: 'swoop-host', site: 'site-b' })).toEqual({
      ok: false,
      reason: 'site_mismatch',
    });
    expect(verifySwoopToken(minted.token, { audience: 'swoop-host', sid: 'sid-2' })).toEqual({
      ok: false,
      reason: 'sid_mismatch',
    });
  });

  it('rejects a replayed jti where the verifier has durable state', () => {
    const minted = mintViewerToken(BASE);
    const seen = new Set<string>([minted.jti]);
    expect(
      verifySwoopToken(minted.token, { audience: 'swoop-host', jtiSeen: (j) => seen.has(j) }),
    ).toEqual({ ok: false, reason: 'jti_replayed' });
  });

  it('rejects a malformed token without throwing', () => {
    expect(verifySwoopToken('not.a.jwt', { audience: 'swoop-host' }).ok).toBe(false);
    expect(verifySwoopToken('', { audience: 'swoop-host' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('swoopJwtPublicKeys', () => {
  it('returns the current kid with the raw base64url public key', () => {
    expect(swoopJwtPublicKeys()).toEqual([
      { kid: 'kid-current', alg: 'EdDSA', key: KEYS.pub },
    ]);
  });

  it('accepts a PEM-shaped env value too, escaped newlines included', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    process.env.SWOOP_JWT_PUBLIC_KEY = pem.replace(/\n/g, '\\n');
    expect(swoopJwtPublicKeys()[0].key).toBe(
      publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url'),
    );
  });

  it('throws when the key material is not configured', () => {
    delete process.env.SWOOP_JWT_PUBLIC_KEY;
    expect(() => swoopJwtPublicKeys()).toThrow(SwoopTokenError);
  });
});
