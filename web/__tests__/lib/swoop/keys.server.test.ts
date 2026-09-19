/**
 * @jest-environment node
 *
 * The HKDF literals are re-derived here from the strings written out in full,
 * rather than imported — so a drifted salt, info or length fails this test
 * instead of failing interop with the Rust streamer at a customer.
 */

import { hkdfSync } from 'crypto';

import {
  SESSION_HKDF_SALT,
  SWOOP_KEY_LENGTH,
  SwoopKeyError,
  VIEWER_HKDF_SALT,
  deriveSessionKey,
  deriveViewerKey,
  sessionKeyForBundle,
  viewerKeyForResponse,
} from '@/lib/swoop/keys.server';

const MASTER = 'test-only-master-key-not-a-real-secret';

beforeEach(() => {
  process.env.SWOOP_SESSION_MASTER_KEY = MASTER;
});

describe('literals', () => {
  it('pins the salts and the length', () => {
    expect(SESSION_HKDF_SALT).toBe('owlette-swoop/session/v1');
    expect(VIEWER_HKDF_SALT).toBe('owlette-swoop/viewer/v1');
    expect(SWOOP_KEY_LENGTH).toBe(32);
  });

  it('K_session = HKDF-SHA256(master, salt "owlette-swoop/session/v1", info sid, 32)', () => {
    const expected = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(MASTER, 'utf8'),
        Buffer.from('owlette-swoop/session/v1', 'utf8'),
        Buffer.from('sid-1', 'utf8'),
        32,
      ),
    );
    expect(deriveSessionKey('sid-1').equals(expected)).toBe(true);
  });

  it('k = HKDF-SHA256(K_session, salt "owlette-swoop/viewer/v1", info viewerId, 32)', () => {
    const expected = Buffer.from(
      hkdfSync(
        'sha256',
        deriveSessionKey('sid-1'),
        Buffer.from('owlette-swoop/viewer/v1', 'utf8'),
        Buffer.from('viewer-a', 'utf8'),
        32,
      ),
    );
    expect(deriveViewerKey('sid-1', 'viewer-a').equals(expected)).toBe(true);
  });
});

describe('derivation', () => {
  it('is deterministic — nothing is stored, so it must be recomputable', () => {
    expect(deriveViewerKey('sid-1', 'viewer-a').equals(deriveViewerKey('sid-1', 'viewer-a'))).toBe(
      true,
    );
  });

  it('gives two viewers of one session different keys, and neither is K_session', () => {
    const kSession = deriveSessionKey('sid-1');
    const a = deriveViewerKey('sid-1', 'viewer-a');
    const b = deriveViewerKey('sid-1', 'viewer-b');

    expect(a.equals(b)).toBe(false);
    expect(a.equals(kSession)).toBe(false);
    expect(b.equals(kSession)).toBe(false);

    // HKDF is one-way: `k` carries nothing that reproduces K_session, so a
    // viewer holding its own k cannot derive the other viewer's.
    const forgedFromK = Buffer.from(
      hkdfSync(
        'sha256',
        a,
        Buffer.from(VIEWER_HKDF_SALT, 'utf8'),
        Buffer.from('viewer-b', 'utf8'),
        32,
      ),
    );
    expect(forgedFromK.equals(b)).toBe(false);
  });

  it('separates sessions — the same viewer id under another sid is another key', () => {
    expect(deriveViewerKey('sid-1', 'viewer-a').equals(deriveViewerKey('sid-2', 'viewer-a'))).toBe(
      false,
    );
  });

  it('is 32 bytes, base64url, on both wire helpers', () => {
    expect(Buffer.from(viewerKeyForResponse('sid-1', 'viewer-a'), 'base64url')).toHaveLength(32);
    expect(Buffer.from(sessionKeyForBundle('sid-1'), 'base64url')).toHaveLength(32);
    expect(viewerKeyForResponse('sid-1', 'viewer-a')).not.toMatch(/[+/=]/);
  });

  it('never returns K_session where k is expected', () => {
    expect(viewerKeyForResponse('sid-1', 'viewer-a')).not.toBe(sessionKeyForBundle('sid-1'));
  });
});

describe('refusals', () => {
  it('refuses an empty sid or viewer id', () => {
    expect(() => deriveSessionKey('')).toThrow(SwoopKeyError);
    expect(() => deriveViewerKey('sid-1', '')).toThrow(/viewer_id_missing/);
  });

  it('refuses to derive without the master key rather than using a default', () => {
    delete process.env.SWOOP_SESSION_MASTER_KEY;
    expect(() => deriveSessionKey('sid-1')).toThrow(/swoop_session_master_key_missing/);
  });
});
