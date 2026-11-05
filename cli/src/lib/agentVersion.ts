/**
 * Agent version comparison that agrees with web's `compareVersions`
 * (web/lib/versionUtils.ts), which the API uses for the same decisions:
 * `major.minor.patch[-prerelease]` with an optional `v`, a prerelease below its
 * release, and prereleases compared alphabetically.
 */

type Parsed = [major: number, minor: number, patch: number, prerelease: string | undefined];

function parse(version: unknown): Parsed | null {
  if (typeof version !== 'string') return null;
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4]] : null;
}

/** `version` is `min` or later; a missing or unparseable one never is. */
export function isAgentVersionAtLeast(version: unknown, min: string): boolean {
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (const i of [0, 1, 2] as const) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  if (a[3] === b[3] || !a[3]) return true;
  if (!b[3]) return false;
  return a[3] > b[3];
}
