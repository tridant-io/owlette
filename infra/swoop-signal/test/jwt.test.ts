// task 1.1's jwt golden vectors, run against the worker's own verifier. the
// vectors are signed against a fixed anchor, so the clock is injected.

import { describe, expect, it } from 'vitest';

import { verifySwoopToken, type JwtEnv } from '../src/jwt';
import { claimsFor, currentKey, previousKey, rawPublicKey, readVector, signToken, testKeys, unknownKid, vectorsOfKind } from './vectors';

interface JwtVector {
  token: string;
  verifier: {
    aud: string;
    site: string;
    machine: string;
    sid: string | null;
    anchorNow: number;
    elapsedSeconds: number;
    keys: string[];
  };
  claims: Record<string, unknown>;
}

const env: JwtEnv = {
  SWOOP_JWT_KID: currentKey.kid,
  SWOOP_JWT_PUBLIC_KEY: rawPublicKey(currentKey),
  SWOOP_JWT_KID_PREV: previousKey.kid,
  SWOOP_JWT_PUBLIC_KEY_PREV: rawPublicKey(previousKey),
};

describe('test key material', () => {
  it('derives the published public key from each published seed', () => {
    for (const key of testKeys) expect(rawPublicKey(key)).toBe(key.publicKey);
  });
});

describe('golden jwt vectors', () => {
  const vectors = vectorsOfKind('jwt');

  it('covers every jwt vector in the manifest', () => {
    expect(vectors.length).toBe(8);
  });

  for (const entry of vectors) {
    it(`${entry.file} -> ${entry.expect} (${entry.reason})`, async () => {
      const vector = readVector<JwtVector>(entry.file);
      // both keys are active during the overlap window every vector assumes.
      expect(vector.verifier.keys).toEqual([currentKey.kid, previousKey.kid]);

      const result = await verifySwoopToken(vector.token, env, {
        nowMs: (vector.verifier.anchorNow + vector.verifier.elapsedSeconds) * 1000,
        expect: { site: vector.verifier.site, machine: vector.verifier.machine },
      });

      if (entry.expect === 'accept') {
        expect(result).toEqual({ ok: true, claims: vector.claims });
      } else {
        expect(result).toEqual({ ok: false, code: entry.reason });
      }
    });
  }
});

describe('verification order and refusals', () => {
  const now = Date.now();

  it('refuses an unknown kid without trying the other key', async () => {
    const token = signToken(claimsFor('host'), currentKey, unknownKid);
    expect(await verifySwoopToken(token, env)).toEqual({ ok: false, code: 'unknown_kid' });
  });

  it('refuses a token whose kid names a key it was not signed with', async () => {
    const token = signToken(claimsFor('host'), previousKey, currentKey.kid);
    expect(await verifySwoopToken(token, env)).toEqual({ ok: false, code: 'bad_signature' });
  });

  it('refuses alg none', async () => {
    const claims = claimsFor('host');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: currentKey.kid })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    expect(await verifySwoopToken(`${header}.${body}.`, env)).toEqual({ ok: false, code: 'bad_alg' });
  });

  it('refuses a host token presented with the viewer audience', async () => {
    const token = signToken({ ...claimsFor('host'), aud: 'swoop-host' });
    expect(await verifySwoopToken(token, env)).toEqual({ ok: false, code: 'bad_audience' });
  });

  it('refuses a viewer token whose ttl exceeds 60 s', async () => {
    const token = signToken(claimsFor('viewer', { ttlSeconds: 61 }));
    expect(await verifySwoopToken(token, env)).toEqual({ ok: false, code: 'ttl_too_long' });
  });

  it('refuses a doorbell token that names a session', async () => {
    const token = signToken({ ...claimsFor('doorbell'), sid: 'sid_0000000000000001' });
    expect(await verifySwoopToken(token, env)).toEqual({ ok: false, code: 'bad_claims' });
  });

  it('accepts the current and the previous key alike', async () => {
    for (const key of [currentKey, previousKey]) {
      const result = await verifySwoopToken(signToken(claimsFor('doorbell'), key), env, { nowMs: now });
      expect(result.ok).toBe(true);
    }
  });

  it('refuses a token larger than the ceiling without parsing it', async () => {
    expect(await verifySwoopToken('a'.repeat(4097), env)).toEqual({ ok: false, code: 'malformed_token' });
  });

  it('refuses a missing token', async () => {
    expect(await verifySwoopToken(null, env)).toEqual({ ok: false, code: 'missing_token' });
  });

  it('reports a missing keyset as a server-side failure, not a client one', async () => {
    const result = await verifySwoopToken(signToken(claimsFor('doorbell')), {});
    expect(result).toEqual({ ok: false, code: 'keyset_unavailable' });
  });
});
