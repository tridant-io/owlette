/**
 * did this request come through cloudflare? the edge adds `X-Owlette-Edge`
 * (`infra/cloudflare`, a transform rule) carrying a secret the origins hold as
 * `EDGE_SHARED_SECRET`. every origin also answers requests that came around
 * cloudflare, where `CF-Connecting-IP` and `X-Owlette-Asn` are whatever the
 * client sent, so those headers count only beside this secret.
 */

import { createHash, timingSafeEqual } from 'crypto';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** an origin without the secret configured cannot tell, and says no. */
export function edgeSecretConfigured(): boolean {
  return Boolean(process.env.EDGE_SHARED_SECRET);
}

/** the request carried the edge's shared secret. */
export function edgeVouches(presented: string | null): boolean {
  const secret = process.env.EDGE_SHARED_SECRET;
  if (!secret || !presented) return false;
  // hashed first, so the comparison takes the same time whatever was presented
  return timingSafeEqual(sha256(presented), sha256(secret));
}
