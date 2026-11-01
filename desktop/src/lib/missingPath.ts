/**
 * whether a path the operator just entered is one the agent can launch from, and
 * if not, what is wrong and where browsing should start. it only ever warns: the
 * value is saved as typed, because a drive may be unplugged or a project not yet
 * copied over.
 *
 * the rules mirror the agent's launch: `launch_process_as_user` and `_validate_path`
 * in owlette_service.py on windows, `_managed_command` and `_managed_cwd` in
 * osadapter/posix.py elsewhere. the agent has its own reader of these rules for the
 * dashboard's path check, so a rule changed here has to change there too.
 */

import type { PathStatus } from '@/lib/ipc'
import type { DesktopOs } from '@/lib/launchCopy'

export const PATH_FIELDS = ['exe_path', 'file_path', 'cwd'] as const
export type PathField = (typeof PATH_FIELDS)[number]
export type PathProbe = (path: string) => Promise<PathStatus>
export type PathProblem = 'missing' | 'folder' | 'file' | 'network' | 'refused' | 'link'

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
/** a server and a share; `\\\\?\\` and `//flag` start the same way and are not network paths. */
const NETWORK_PATH = /^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]/
/** how many whitespace cuts of a value are tried as a file with arguments after it. */
const MAX_CUTS = 8

export interface MissingPath {
  /** the field's value this was found in. */
  value: string
  path: string
  problem: PathProblem
  /** where browsing starts; null when nothing on the way up exists, or no disk was asked. */
  folder: string | null
  /** the arguments after the path, which browsing must not lose. */
  rest: string
}

function isAbsolute(path: string, os: DesktopOs): boolean {
  return os === 'windows' ? WINDOWS_ABSOLUTE.test(path) : path.startsWith('/')
}

/**
 * on windows the agent refuses a value that starts with two slashes, having turned
 * every `/` into `\` first in all but `cwd`. elsewhere `//x` is an ordinary path.
 */
function refusal(value: string, field: PathField, os: DesktopOs): 'network' | 'refused' | null {
  if (os !== 'windows') return null
  if (!(field === 'cwd' ? /^(?:\\\\|\/\/)/ : /^[\\/]{2}/).test(value)) return null
  return NETWORK_PATH.test(value) ? 'network' : 'refused'
}

function isLink(status: PathStatus): boolean {
  return status === 'file-link' || status === 'folder-link' || status === 'broken-link'
}

/** only a macos bundle launches as a folder; a trailing slash is still the bundle. */
function launchesAsFolder(path: string, os: DesktopOs): boolean {
  return os === 'macos' && /\.app\/*$/.test(path)
}

/** the value cut at each whitespace, longest first, where a file may end and its arguments begin. */
function fileCandidates(value: string): string[] {
  const cuts = [...value.matchAll(/\s+/g)].map((match) => match.index).reverse()
  return cuts.slice(0, MAX_CUTS).map((cut) => value.slice(0, cut))
}

/**
 * the path and arguments to report for a value nothing on disk matched. arguments
 * start at the first flag: a lone dash is not one (`OneDrive - Acme` is a folder),
 * and neither is a piece with a slash in it (`show -v2/main.toe`). before that, the
 * path ends at the last piece with a file extension, whose letter tells it from
 * `v1.2` and `127.0.0.1`.
 */
function splitArgs(value: string, os: DesktopOs): { path: string; rest: string } {
  const quoted = value.match(/^"([^"]+)"\s*(.*)$/)
  if (quoted) return { path: quoted[1], rest: quoted[2] }
  const flag = value.search(
    os === 'windows' ? /\s+(?:-{1,2}|\/)\w[^\s\\/=]*(?:=\S*)?(?=\s|$)/ : /\s+-{1,2}\w[^\s/=]*(?:=\S*)?(?=\s|$)/,
  )
  const head = flag < 0 ? value : value.slice(0, flag)
  const end = head.match(/^.*\.\w*[a-zA-Z]\w*(?=\s|$)/)?.[0].length ?? head.length
  return { path: value.slice(0, end), rest: value.slice(end).trim() }
}

/**
 * the agent reads `path / args` as a file when the whole value is one and as
 * arguments otherwise, so a value only warns when it starts like an absolute
 * path and no cut of it is a file, nor a folder with arguments after it. a link is
 * refused only as the whole value: always on windows, and off it only when it
 * points at a file.
 */
async function findMissingFile(value: string, probe: PathProbe, os: DesktopOs): Promise<MissingPath | null> {
  const { path, rest } = splitArgs(value, os)
  const refused = refusal(value, 'file_path', os)
  if (refused) return { value, path, rest, problem: refused, folder: null }
  if (!isAbsolute(path, os) || /[%$]/.test(path)) return null

  const whole = await probe(value)
  if (os === 'windows' ? isLink(whole) : whole === 'file-link') {
    return { value, path: value, rest: '', problem: 'link', folder: parentOf(value) }
  }
  if (whole !== 'missing') return null
  if (rest) {
    const status = await probe(path)
    if (status === 'folder' || status === 'folder-link') return null
  }
  for (const candidate of value.startsWith('"') ? [path] : fileCandidates(value)) {
    if (!isAbsolute(candidate, os)) continue
    const status = await probe(candidate)
    if (status === 'file' || status === 'file-link' || status === 'unknown') return null
  }
  return { value, path, rest, problem: 'missing', folder: await nearestExistingFolder(path, probe) }
}

export async function findMissingPath(
  field: PathField,
  raw: string,
  probe: PathProbe,
  os: DesktopOs,
): Promise<MissingPath | null> {
  const value = raw.trim()
  if (!value) return null
  if (field === 'file_path') return findMissingFile(value, probe, os)

  const warning = { value, path: value, rest: '' }
  const refused = refusal(value, field, os)
  if (refused) return { ...warning, problem: refused, folder: null }
  if (!isAbsolute(value, os)) {
    // a relative working directory is resolved at launch. a launch target never
    // is: the agent expands nothing and searches no PATH, so it will not start.
    return field === 'cwd' ? null : { ...warning, problem: 'missing', folder: null }
  }

  const status = await probe(value)
  if (isLink(status)) return { ...warning, problem: 'link', folder: parentOf(value) }
  if (status === 'missing') return { ...warning, problem: 'missing', folder: await nearestExistingFolder(value, probe) }
  if (field === 'cwd' && status === 'file') return { ...warning, problem: 'file', folder: parentOf(value) }
  if (field === 'exe_path' && status === 'folder' && !launchesAsFolder(value, os)) {
    return { ...warning, problem: 'folder', folder: value }
  }
  return null
}

/** the folder above `path`, stopping at its drive or root. */
function parentOf(path: string): string | null {
  const root = path.match(/^[a-zA-Z]:[\\/]/)?.[0] ?? (path.startsWith('/') ? '/' : '')
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed.length <= root.length) return null
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut < root.length ? root || null : trimmed.slice(0, cut)
}

export async function nearestExistingFolder(path: string, probe: PathProbe): Promise<string | null> {
  for (let folder = parentOf(path); folder !== null; folder = parentOf(folder)) {
    const status = await probe(folder)
    if (status === 'folder' || status === 'folder-link') return folder
    // a drive that does not answer costs its timeout on every level above it too.
    if (status === 'unknown') return null
  }
  return null
}

/** what a picked file becomes in a field that also held arguments. */
export function withArgs(picked: string, rest: string): string {
  if (!rest) return picked
  return `${/\s/.test(picked) ? `"${picked}"` : picked} ${rest}`
}
