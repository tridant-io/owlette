/**
 * a person's swoop mode on a site: the `swoop` field of their member row.
 *
 * pure, with no firebase or server import, because the dashboard reads it too.
 */

export const SWOOP_MODES = ['none', 'view', 'control'] as const;

export type SwoopMode = (typeof SWOOP_MODES)[number];

export const SWOOP_MODE_LABELS: Record<SwoopMode, string> = {
  none: 'no swoop',
  view: 'watch',
  control: 'control',
};

/** a stored `swoop` field. `null` means the row carries no mode, so the role decides. */
export function parseSwoopMode(raw: unknown): SwoopMode | null {
  if (raw === undefined) return null;
  // fail closed, so a hand-edited value never reads as a grant
  return (SWOOP_MODES as readonly unknown[]).includes(raw) ? (raw as SwoopMode) : 'none';
}

/** what the capability check grants: the owner always controls, and no mode means the role's default. */
export function grantedSwoopMode(
  role: 'owner' | 'admin' | 'member',
  mode: SwoopMode | null,
): SwoopMode {
  if (role === 'owner') return 'control';
  return mode ?? (role === 'member' ? 'view' : 'control');
}

/**
 * what the person gets on a site with swoop on. the site's `membersMayWatch` is
 * the default for members with no mode of their own; an explicit mode wins.
 */
export function effectiveSwoopMode(
  role: 'owner' | 'admin' | 'member',
  mode: SwoopMode | null,
  membersMayWatch: boolean,
): SwoopMode {
  if (role === 'member' && mode === null && !membersMayWatch) return 'none';
  return grantedSwoopMode(role, mode);
}
