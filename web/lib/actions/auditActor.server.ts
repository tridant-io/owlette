/**
 * Audit-actor derivation for action cores that receive the raw
 * `SiteHandlerContext` instead of a pre-computed `auditActor` string.
 *
 * Produces the same identifier as `auditActorIdentifier` in
 * `app/api/_shared.ts` and the per-route `auditActor(ctx)` helpers:
 * api-key-mediated mutations are attributed to the key, session-mediated
 * ones to the signed-in user.
 */
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';

export function siteAuditActor(ctx: SiteHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

/**
 * a granted machine acting through the fleet routes (ADR 0017). no
 * SiteHandlerContext ever carries one, so the fleet code builds its string here.
 */
export function machineAuditActor(machineId: string): string {
  return `machine:${machineId}`;
}
