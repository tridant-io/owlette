/**
 * did this request come through cloudflare? the edge adds `X-Owlette-Edge`
 * (`infra/cloudflare`, a transform rule) carrying a secret the origins hold as
 * `EDGE_SHARED_SECRET`. every origin also answers requests that came around
 * cloudflare, where `CF-Connecting-IP` and `X-Owlette-Asn` are whatever the
 * client sent, so those headers count only beside this secret.
 */

import { secretMatches } from '@/lib/secretMatches.server';

/** an origin without the secret configured cannot tell, and says no. */
export function edgeSecretConfigured(): boolean {
  return Boolean(process.env.EDGE_SHARED_SECRET);
}

/** the request carried the edge's shared secret. */
export function edgeVouches(presented: string | null): boolean {
  return secretMatches(presented, process.env.EDGE_SHARED_SECRET);
}
