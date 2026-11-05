/**
 * the agent's `check_path` answer. the agent alone reads what a field's value
 * means (agent/src/path_commands.py); this only checks the answer's shape and writes
 * a picked path back. an agent older than the command completes it with the text
 * `Unknown command type: check_path`, which is why a result that isn't this shape
 * parses to null and null means say nothing.
 */

export const PATH_FIELDS = ['exe_path', 'file_path', 'cwd'] as const;
export type PathField = (typeof PATH_FIELDS)[number];

/** `folder` asks for a folder's entries, for the folder browser. */
export type PathCheckField = PathField | 'folder';

export const MAX_PATH_VALUE_CHARS = 1024;

/** `folder` and `file` are a path of the wrong kind: what it is, not what it should be. */
export type PathWarningKind = 'missing' | 'not_absolute' | 'network' | 'refused' | 'folder' | 'file' | 'link';

export interface PathAnswer {
  status: 'file' | 'folder' | 'missing' | 'unknown';
  warning: PathWarningKind | null;
  path: string | null;
  /** the arguments after the path, which a pick must not lose. */
  rest: string;
  /** the nearest folder that exists, when the path doesn't. */
  nearest: string | null;
  parent?: string | null;
  folders?: string[];
  files?: string[];
  truncated?: boolean;
}

const STATUSES: ReadonlySet<unknown> = new Set(['file', 'folder', 'missing', 'unknown']);
const WARNINGS: ReadonlySet<unknown> = new Set(['missing', 'not_absolute', 'network', 'refused', 'folder', 'file', 'link', null]);

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parsePathAnswer(result: string): PathAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const answer = parsed as Record<string, unknown>;
  if (!STATUSES.has(answer.status) || !WARNINGS.has(answer.warning)) return null;
  if (!isStringOrNull(answer.path) || !isStringOrNull(answer.nearest)) return null;
  if (typeof answer.rest !== 'string') return null;
  if (answer.folders !== undefined && !isStringList(answer.folders)) return null;
  if (answer.files !== undefined && !isStringList(answer.files)) return null;
  return parsed as PathAnswer;
}

/** an absolute path from the agent starts with `/` on macos and linux, and a drive on windows. */
export function childPath(folder: string, name: string): string {
  const separator = folder.startsWith('/') ? '/' : '\\';
  return folder.endsWith(separator) ? `${folder}${name}` : `${folder}${separator}${name}`;
}

/** what a picked path becomes in a field that also held arguments. */
export function withArgs(picked: string, rest: string): string {
  if (!rest) return picked;
  return `${/\s/.test(picked) ? `"${picked}"` : picked} ${rest}`;
}
