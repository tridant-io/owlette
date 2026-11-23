/**
 * The threshold rules a site has before its rule list is first saved: a
 * deliberate mirror of `web/lib/defaultAlertRules.ts`, since functions can't
 * import web code. `web/__tests__/lib/defaultAlertRules.test.ts` holds the two
 * equal, so change both together.
 *
 * `sites/{siteId}/settings/alerts` without a `rules` array is a site that never
 * saved one, and it gets these. A saved array, even an empty one, is the site's
 * own list and is read as stored, so a default an admin turned off, edited or
 * deleted stays that way.
 */

/** disk usage, in percent, past which the default rule fires: 90 leaves 10% free */
const LOW_DISK_PERCENT = 90;
/** one email a day per machine at most */
const LOW_DISK_COOLDOWN_MINUTES = 24 * 60;

export const DEFAULT_LOW_DISK_RULE = {
  // fixed: the cooldown doc is `{rule.id}_{machineId}`, so an id minted per read would never cool down
  id: 'default-low-disk',
  name: 'Low Disk',
  metric: 'disk_percent',
  operator: '>' as const,
  value: LOW_DISK_PERCENT,
  severity: 'warning' as const,
  channels: ['email', 'webhook'],
  enabled: true,
  cooldownMinutes: LOW_DISK_COOLDOWN_MINUTES,
};

/** the stored `rules` field as it is when it is an array, else the default rules */
export function alertRulesOrDefault(stored: unknown): unknown[] {
  if (Array.isArray(stored)) return stored;
  return [{ ...DEFAULT_LOW_DISK_RULE, channels: [...DEFAULT_LOW_DISK_RULE.channels] }];
}
