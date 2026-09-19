// Generates the spike's throwaway Ed25519 keyset and ring secret.
//
// Two keypairs, because the Worker must accept two active public keys so a
// rotation is not a flag day (review-3-delivery.md F6.3). Output goes to
// .dev.vars (public keys + ring secret, for `wrangler dev`) and testdata/keys.json
// (private keys, for the test signer). Both are gitignored; neither is ever a real
// key, and nothing here is printed to stdout.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function keypair(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    // JWK 'x' is the base64url-encoded raw 32-byte public key the Worker imports.
    publicKey: publicKey.export({ format: 'jwk' }).x,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

const keys = [keypair('spike-k1'), keypair('spike-k2')];
const ringSecret = randomBytes(32).toString('hex');
const publicKeyset = JSON.stringify(keys.map(({ kid, publicKey }) => ({ kid, key: publicKey })));

mkdirSync(join(root, 'testdata'), { recursive: true });
writeFileSync(
  join(root, 'testdata', 'keys.json'),
  `${JSON.stringify({ keys, ringSecret }, null, 2)}\n`
);
writeFileSync(
  join(root, '.dev.vars'),
  `SWOOP_JWT_PUBLIC_KEYS='${publicKeyset}'\nSWOOP_SIGNAL_RING_SECRET='${ringSecret}'\n`
);

process.stdout.write(`wrote .dev.vars and testdata/keys.json (kids: ${keys.map((k) => k.kid).join(', ')})\n`);
