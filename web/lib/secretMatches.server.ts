/**
 * shared-secret checks for the server-to-server and scheduled endpoints, in
 * constant time.
 */

import { createHash, timingSafeEqual } from 'crypto';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** the presented value is the secret; false whenever either is missing. */
export function secretMatches(presented: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !presented) return false;
  // hashed first, so the comparison takes the same time whatever was presented
  return timingSafeEqual(sha256(presented), sha256(secret));
}

/** the caller presented this environment's `CRON_SECRET`. */
export function cronSecretMatches(presented: string | null | undefined): boolean {
  return secretMatches(presented, process.env.CRON_SECRET);
}
