// the golden vectors of task 1.1 are the contract this worker is tested against.
// they live in the agent tree because the rust protocol core and the web library
// iterate the same manifest; nothing here copies them.

import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VECTOR_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'agent',
  'swoop',
  'testdata',
  'protocol'
);

export interface VectorEntry {
  file: string;
  kind: string;
  format: string;
  expect: 'accept' | 'reject';
  reason: string;
  description: string;
}

export interface TestKey {
  kid: string;
  seedAscii: string;
  publicKey: string;
  current: boolean;
}

export function readVector<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(VECTOR_ROOT, relativePath), 'utf8')) as T;
}

export const manifest = readVector<{ vectors: VectorEntry[] }>('index.json');

export function vectorsOfKind(kind: string): VectorEntry[] {
  return manifest.vectors.filter((vector) => vector.kind === kind);
}

const keyFile = readVector<{ keys: TestKey[]; unknownKid: string }>('keys.test-only.json');

/**
 * FAKE KEY MATERIAL, published on purpose in keys.test-only.json so a verifier test
 * can actually run. these sign nothing real; an environment that accepts them is
 * misconfigured.
 */
export const testKeys = keyFile.keys;
export const unknownKid = keyFile.unknownKid;

export const currentKey = testKeys.find((key) => key.current) as TestKey;
export const previousKey = testKeys.find((key) => !key.current) as TestKey;

// pkcs8 der prefix for a raw ed25519 seed: SEQUENCE, version 0, AlgorithmIdentifier
// 1.3.101.112, then the 32-byte seed in an OCTET STRING.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyFromSeed(seedAscii: string): KeyObject {
  const seed = Buffer.from(seedAscii, 'ascii');
  if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** the raw 32-byte public key, base64url — the form the worker's secret carries. */
export function rawPublicKey(key: TestKey): string {
  const spki = createPublicKey(privateKeyFromSeed(key.seedAscii)).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('base64url');
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function signToken(claims: Record<string, unknown>, key: TestKey = currentKey, kid = key.kid): string {
  const signingInput = `${base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }))}.${base64url(
    JSON.stringify(claims)
  )}`;
  const signature = sign(null, Buffer.from(signingInput), privateKeyFromSeed(key.seedAscii));
  return `${signingInput}.${signature.toString('base64url')}`;
}

export interface ClaimOverrides {
  site?: string;
  machine?: string;
  sid?: string | null;
  viewer?: string;
  ctl?: boolean;
  jti?: string;
  ttlSeconds?: number;
}

const FINGERPRINT =
  'sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

/**
 * durable-object state survives between runs, and jti is single use, so a test
 * token must be as unique as a real one. the same goes for room names: machineId()
 * keeps one run's rooms out of the next one's.
 */
export const RUN_ID = randomBytes(4).toString('hex');

export function machineId(name: string): string {
  return `machine_${name}_${RUN_ID}`;
}

/** a live-clock token in the shape section 8 specifies for the role. */
export function claimsFor(role: 'viewer' | 'host' | 'doorbell', overrides: ClaimOverrides = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const base: Record<string, unknown> = {
    iss: 'owlette-api',
    aud: role === 'viewer' ? 'swoop-host' : 'swoop-signal',
    role,
    site: overrides.site ?? 'site_goldenvector',
    machine: overrides.machine ?? 'machine_goldenvector',
    iat,
    exp: iat + (overrides.ttlSeconds ?? (role === 'viewer' ? 60 : 300)),
    jti: overrides.jti ?? `jti_${randomBytes(12).toString('hex')}`,
  };
  if (role !== 'doorbell') base.sid = overrides.sid ?? 'sid_0000000000000001';
  if (role === 'viewer') {
    base.viewer = overrides.viewer ?? 'viewer_0000000001';
    base.uid = 'uid_goldenvector';
    base.ctl = overrides.ctl ?? true;
    base.fp = FINGERPRINT;
  }
  return base;
}
