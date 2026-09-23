'use client';

/**
 * Migration observability for per-site membership (wave 4.4).
 *
 * `membership_fallback` counts the one thing that decides when the legacy
 * `users/{uid}.sites[]` field can be deleted: a site the legacy array grants and
 * the membership documents do not. Wave 6.1 strips the field only once this has
 * held at zero — a counter, not someone's reading of a dry-run.
 *
 * Mirrors `securityBoundaryMetrics.server.ts`: a stable, parseable log line that a
 * drain can turn into a counter, plus a Sentry message so it is alertable. That
 * helper is server-only, hence this client twin rather than an import.
 */

import * as Sentry from '@sentry/nextjs';

/** siteId|uid pairs already reported. */
const reported = new Set<string>();

/**
 * Report sites the legacy array grants but membership does not.
 *
 * Deduplicated for the life of the page: the listener re-fires on every snapshot,
 * and an un-backfilled user would otherwise emit on every render, drowning the
 * signal in its own repetition.
 */
export function emitMembershipFallback(uid: string, siteIds: readonly string[]): void {
  for (const siteId of siteIds) {
    const key = `${siteId}|${uid}`;
    if (reported.has(key)) continue;
    reported.add(key);

    const payload = {
      metric: 'membership_fallback',
      value: 1,
      labels: { siteId, uid },
      observedAt: new Date().toISOString(),
    };
    console.warn('[membership-metric] membership_fallback', payload);

    Sentry.captureMessage('membership_fallback', {
      level: 'warning',
      tags: { membership_metric: 'membership_fallback', siteId, uid },
      extra: { value: 1 },
    });
  }
}

/** Listener errors already reported, keyed by message. */
const reportedErrors = new Set<string>();

/**
 * Report a failure of the membership listener itself.
 *
 * Distinct from `membership_fallback`, and more urgent: a fallback means one
 * user's backfill has not landed, while this means the listener is not running at
 * all — misdeployed rules, a missing index — so EVERY user silently degrades to
 * the legacy array. That degradation is invisible today, because the union keeps
 * the app working, and becomes total the moment wave 6.1 strips the legacy field.
 */
export function emitMembershipListenerError(uid: string, message: string): void {
  if (reportedErrors.has(message)) return;
  reportedErrors.add(message);

  console.error('[membership-metric] membership_listener_error', {
    metric: 'membership_listener_error',
    value: 1,
    labels: { uid },
    message,
    observedAt: new Date().toISOString(),
  });

  Sentry.captureMessage('membership_listener_error', {
    level: 'error',
    tags: { membership_metric: 'membership_listener_error', uid },
    extra: { message },
  });
}

/** Test seam — the dedupe sets outlive a single test otherwise. */
export function __resetMembershipFallbackDedupe(): void {
  reported.clear();
  reportedErrors.clear();
}
