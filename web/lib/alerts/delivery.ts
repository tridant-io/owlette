/**
 * How a person's alert emails reach them: each one as it happens, or one digest
 * an hour, a day or a week. Stored at `users/{uid}.preferences.alertDelivery`,
 * which the client writes, so every reader goes through {@link parseAlertDelivery}.
 */

export const ALERT_DELIVERY_MODES = ['immediate', 'hourly', 'daily', 'weekly'] as const;

export type AlertDelivery = (typeof ALERT_DELIVERY_MODES)[number];

/** the daily digest unless a known mode is stored: a missing value means daily, so nobody needs a backfill */
export function parseAlertDelivery(value: unknown): AlertDelivery {
  return ALERT_DELIVERY_MODES.includes(value as AlertDelivery) ? (value as AlertDelivery) : 'daily';
}
