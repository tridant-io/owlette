/**
 * Resolve a user-entered "extract to" string into a canonical agent-side path
 * (the UI previews the result before distribute):
 *   empty        -> ~/Documents/Owlette/
 *   absolute     -> verbatim (`C:\render`, `/opt/exhibit`)
 *   otherwise    -> ~/Documents/<input>
 *
 * Relative paths deliberately do NOT nest under `Owlette`: the default is a
 * landing pad for operators who don't care, so a named path should be the
 * folder's actual name.
 *
 * The agent's `destination_allowlist` default roots are per-OS, so an absolute
 * path is allowlist-valid only on a machine whose own default root contains it;
 * anywhere else it needs an `agent_config.allowed_extract_roots` entry.
 */
import type { MachineOsFamily } from '@/lib/machineOs';

export const DEFAULT_EXTRACT_PATH = '~/Documents/Owlette/';

/** Windows drive-letter prefix: `C:\`, `D:/`, etc. */
const DRIVE_LETTER_RE = /^[a-zA-Z]:[\\/]/;

/** Absolute anywhere: a drive letter, or a POSIX leading `/`. */
const ABSOLUTE_RE = /^([a-zA-Z]:[\\/]|\/)/;

/** Mirrors the agent's `destination_allowlist` per-OS default roots. */
const DEFAULT_ROOT_BY_OS: Record<MachineOsFamily, string> = {
  windows: '~/Documents',
  macos: '/Users/Shared/Owlette',
  linux: '/var/lib/owlette/projects',
};

export function resolveExtractPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_EXTRACT_PATH;
  if (DRIVE_LETTER_RE.test(trimmed)) {
    // verbatim, but normalise separators so the display isn't a mixed `C:/foo\bar`
    return trimmed.replace(/\//g, '\\');
  }
  // POSIX absolute: verbatim, separators untouched. `/opt/exhibit` is a path a
  // mac or linux agent can use as typed; rewriting it would bury it under
  // Documents on a machine that has no such folder.
  if (ABSOLUTE_RE.test(trimmed)) return trimmed;
  // strip leading separators so the template's `/` isn't doubled
  const rel = trimmed.replace(/^[\\/]+/, '');
  // and trailing, so appending one is deterministic (agents ignore it either way)
  const cleaned = rel.replace(/[\\/]+$/, '');
  return `~/Documents/${cleaned}/`;
}

/**
 * True when the agent's default allowlist would accept this input on every
 * selected machine. Each OS permits only its own default root, so a mixed
 * selection warns as soon as one target would refuse.
 */
export function isLikelyAllowed(
  input: string,
  osFamilies: ReadonlySet<MachineOsFamily>,
): boolean {
  const trimmed = input.trim();
  // the empty field is the one input that needs no verdict: the fanout sends
  // the windows default to every target and a POSIX agent swaps in its own
  // (`sync_commands._substitute_legacy_default_root`). every other input is
  // measured against the target's own root, relative ones included — `show1`
  // resolves under `~/Documents`, which neither POSIX default root contains.
  if (!trimmed) return true;
  const resolved = resolveExtractPath(trimmed);
  for (const osFamily of targetFamilies(osFamilies)) {
    if (!isUnderRoot(resolved, DEFAULT_ROOT_BY_OS[osFamily])) return false;
  }
  return true;
}

/**
 * True when the input is POSIX-absolute and every selected machine runs windows,
 * where it is not an absolute path at all: the agent refuses it before it ever
 * consults the allowlist, so an `allowed_extract_roots` entry cannot help.
 */
export function isPosixPathOnWindowsTargets(
  input: string,
  osFamilies: ReadonlySet<MachineOsFamily>,
): boolean {
  if (!input.trim().startsWith('/')) return false;
  return targetFamilies(osFamilies).every((osFamily) => osFamily === 'windows');
}

/**
 * The machines a verdict is measured against. An empty selection means the
 * targets aren't known yet — the extract-path field sits above the target picker
 * — and an absent `osFamily` is windows.
 */
function targetFamilies(
  osFamilies: ReadonlySet<MachineOsFamily>,
): readonly MachineOsFamily[] {
  return osFamilies.size > 0 ? [...osFamilies] : ['windows'];
}

/** `path` is `root`, or sits under it on either separator. */
function isUnderRoot(path: string, root: string): boolean {
  const trimEnd = (s: string) => s.replace(/[\\/]+$/, '');
  const p = trimEnd(path);
  const r = trimEnd(root);
  return p === r || p.startsWith(`${r}/`) || p.startsWith(`${r}\\`);
}
