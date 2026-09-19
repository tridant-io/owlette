/** Semver parsing/comparison for agent updates (e.g. "2.1.0", "2.1.0-beta"). */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  original: string;
}

/** Parse `major.minor.patch[-prerelease]`, tolerating a `v` prefix. Null if invalid. */
export function parseVersion(version: string | undefined | null): ParsedVersion | null {
  if (!version || typeof version !== 'string') {
    return null;
  }

  const cleanVersion = version.trim().replace(/^v/i, '');

  const match = cleanVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?$/);

  if (!match) {
    return null;
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
    original: cleanVersion
  };
}

/** -1 / 0 / 1, or null if either side is unparseable. */
export function compareVersions(
  v1: string | undefined | null,
  v2: string | undefined | null
): number | null {
  const parsed1 = parseVersion(v1);
  const parsed2 = parseVersion(v2);

  if (!parsed1 || !parsed2) {
    return null;
  }

  if (parsed1.major !== parsed2.major) {
    return parsed1.major < parsed2.major ? -1 : 1;
  }

  if (parsed1.minor !== parsed2.minor) {
    return parsed1.minor < parsed2.minor ? -1 : 1;
  }

  if (parsed1.patch !== parsed2.patch) {
    return parsed1.patch < parsed2.patch ? -1 : 1;
  }

  // No prerelease outranks a prerelease: "2.1.0" > "2.1.0-beta".
  if (parsed1.prerelease && !parsed2.prerelease) {
    return -1;
  }
  if (!parsed1.prerelease && parsed2.prerelease) {
    return 1;
  }
  if (parsed1.prerelease && parsed2.prerelease) {
    // Alphabetical, not semver's dot-segment rules.
    if (parsed1.prerelease < parsed2.prerelease) return -1;
    if (parsed1.prerelease > parsed2.prerelease) return 1;
  }

  return 0;
}

/**
 * Whether the machine needs an update. Unknown machine version counts as
 * outdated; unknown latest version, or an unparseable pair, does not.
 */
export function isOutdated(
  machineVersion: string | undefined | null,
  latestVersion: string | undefined | null
): boolean {
  if (!machineVersion) {
    return true;
  }

  if (!latestVersion) {
    return false;
  }

  const comparison = compareVersions(machineVersion, latestVersion);

  if (comparison === null) {
    return false;
  }

  return comparison < 0;
}

/** Display form; "Unknown" when unparseable. */
export function formatVersion(
  version: string | undefined | null,
  includePrefix: boolean = false
): string {
  if (!version) {
    return 'Unknown';
  }

  const parsed = parseVersion(version);
  if (!parsed) {
    return 'Unknown';
  }

  const prefix = includePrefix ? 'v' : '';
  return `${prefix}${parsed.original}`;
}

/** "major update" / "minor update" / "patch update" / "prerelease update" / "no update". */
export function getVersionDifference(
  fromVersion: string | undefined | null,
  toVersion: string | undefined | null
): string {
  const from = parseVersion(fromVersion);
  const to = parseVersion(toVersion);

  if (!from || !to) {
    return 'version update';
  }

  if (from.major !== to.major) {
    return 'major update';
  }
  if (from.minor !== to.minor) {
    return 'minor update';
  }
  if (from.patch !== to.patch) {
    return 'patch update';
  }
  if (from.prerelease !== to.prerelease) {
    return 'prerelease update';
  }

  return 'no update';
}

export function isValidVersion(version: string | undefined | null): boolean {
  return parseVersion(version) !== null;
}

/**
 * Oldest agent whose schedule evaluation honors a site's opted-in timezone.
 * COPY ONLY (plan decision D3): older agents get an advisory line in the UI,
 * never a version block — blocking would strand a fleet over one offline
 * machine. '3.2.3', not '3.3.0': Wave 2 landed 2026-08-26 and shipped inside
 * the 3.2.3 installer (site-time-schedules tasks.md, 2026-09-05 gate
 * correction) — at '3.3.0' every current machine would see a spurious
 * "needs a newer agent" warning.
 */
export const SITE_TIME_MIN_AGENT_VERSION = '3.2.3';

/**
 * Oldest agent that can serve a swoop session. COPY ONLY, exactly like
 * SITE_TIME_MIN_AGENT_VERSION above: the authorization gate is the machine's
 * own `capabilities.swoop == 1` heartbeat key, never this string — a version
 * number cannot see an upgrade that is still waiting on a reboot, and the
 * dashboard must keep offering legacy live view to every machine that has no
 * swoop. Provisional: Task 10.1, the swoop release, sets the real version and
 * must confirm this matches the installer that actually shipped.
 */
export const SWOOP_MIN_AGENT_VERSION = '3.4.0';
