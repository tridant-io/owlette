/**
 * hoot's internal shared secret — presented by every server-to-server caller of the internal
 * endpoints (`/api/hoot/autonomous`, `/api/hoot/escalation`, `/api/alerts/trigger`,
 * and `/api/talons/internal/match`).
 *
 * The env var is still `CORTEX_INTERNAL_SECRET`: it is provisioned on Railway (dev + prod), Vercel
 * and the Firebase Functions runtime config, and `functions/src/lib/requireInternalSecret` compares
 * the same value. Renaming means rotating one secret across four deploy targets in a single release
 * window, so the name stays and this module is the only place in `web/` that spells it.
 *
 * Read at call time, not module scope, so a test that assigns the var after import still sees it.
 * See `web/lib/hoot/WIRE_NAMES.md` for the full survivor inventory.
 */

import { secretMatches } from '@/lib/secretMatches.server';

/** The configured internal secret, or `undefined` when the env is unset. */
export function hootInternalSecret(): string | undefined {
  return process.env.CORTEX_INTERNAL_SECRET;
}

/** the caller presented the internal secret; false whenever it is unset. */
export function hootInternalSecretMatches(presented: string | null): boolean {
  return secretMatches(presented, hootInternalSecret());
}
