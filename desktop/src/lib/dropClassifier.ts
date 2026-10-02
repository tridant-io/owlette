/**
 * Drag-and-drop classification: dropped paths in, owlette process entries out.
 *
 * All disk contact goes through the injected {@link FsProbe} and there is no
 * module state, so the rule matrix is unit-testable without Tauri.
 *
 * Drafts mirror the python service's on-disk schema (`owlette_gui.py:1043-1057`).
 * Numeric fields are STRINGS to match every other writer of `config.json`; the
 * service coerces with int()/float() (`owlette_service.py:2097,:2271`).
 */

import { launchCopyFor, type DesktopOs } from '@/lib/launchCopy'
import {
  NEW_PROCESS_DEFAULTS,
  type LaunchMode,
  type Priority,
  type ProcessEntry,
  type Visibility,
} from '@/lib/owletteConfig'

/**
 * A `processes[]` entry minus the `id`, minted on confirm. Deliberately stricter
 * than {@link ProcessEntry}: that describes what may be read from a file three
 * writers have edited, this describes what we are allowed to write.
 */
export interface ProcessEntryDraft {
  name: string
  exe_path: string
  /** A document opened by `exe_path` — never CLI arguments, see below. */
  file_path: string
  cwd: string
  priority: Priority
  visibility: Visibility
  time_delay: string
  time_to_init: string
  relaunch_attempts: string
  launch_mode: LaunchMode
  autolaunch: boolean
  schedules: null
}

/**
 * Fields the classifier could not derive; the confirm card prompts for them.
 * Only `exe_path`: the interpreter or host app may not be installed here.
 */
export type NeedsInput = 'exe_path'

/** What a dropped path turned out to be. */
export type DropKind = 'touchdesigner' | 'unity' | 'executable' | 'script'

export interface ClassifiedDrop {
  kind: DropKind
  path: string
  entry: ProcessEntryDraft
  needsInput: NeedsInput[]
  /** Lowercase, user-facing notes for the confirm card. Usually empty. */
  warnings: string[]
}

export interface UnsupportedDrop {
  kind: 'unsupported'
  path: string
  /** Lowercase, user-facing explanation for the toast. */
  reason: string
}

export type DropResult = ClassifiedDrop | UnsupportedDrop

/**
 * Values every dropped entry starts with. The numbers come from
 * {@link NEW_PROCESS_DEFAULTS} so drop and `+` produce identical entries — do
 * not fork them. `launch_mode: 'off'` means a drop configures but never starts.
 */
export const DROP_DEFAULTS = {
  priority: 'Normal',
  visibility: 'Normal',
  time_delay: NEW_PROCESS_DEFAULTS.time_delay,
  time_to_init: NEW_PROCESS_DEFAULTS.time_to_init,
  relaunch_attempts: NEW_PROCESS_DEFAULTS.relaunch_attempts,
  launch_mode: 'off',
  autolaunch: false,
  schedules: null,
} as const satisfies Omit<ProcessEntryDraft, 'name' | 'exe_path' | 'file_path' | 'cwd'>

export interface ClassifyOptions {
  /** Where Derivative installs; one sub-directory per TouchDesigner version. */
  touchDesignerRoot?: string
  /** Interpreters tried in order for a `.py`; the first that exists wins. */
  pythonCandidates?: string[]
  /** Scanned for `Python*` install directories when no candidate above exists. */
  pythonInstallRoot?: string
  /** Interpreters tried in order for a `.ps1`. */
  powershellCandidates?: string[]
  /** The desktop the drop landed on: on macos an `.app` folder is the app to run. */
  os?: DesktopOs
}

/**
 * Stock Windows locations. Overridable so tests never touch the real disk and so
 * callers can prepend per-user installs, which this module cannot expand.
 */
export const DEFAULT_CLASSIFY_OPTIONS: Required<ClassifyOptions> = {
  touchDesignerRoot: 'C:\\Program Files\\Derivative',
  // py.exe (PEP 397) honours the shebang and falls back to the newest interpreter.
  pythonCandidates: ['C:\\Windows\\py.exe'],
  pythonInstallRoot: 'C:\\Program Files',
  powershellCandidates: [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ],
  os: 'windows',
}

/** Everything the classifier needs to know about the disk. */
export interface FsProbe {
  exists(path: string): Promise<boolean>
  isDir(path: string): Promise<boolean>
  /** Entry NAMES, not full paths. */
  listDir(path: string): Promise<string[]>
}

/** Suffix Unity gives the data folder beside its player executable. */
const UNITY_DATA_SUFFIX = '_Data'

/** Fallback for the rare name that trims to nothing, so no entry is nameless. */
const FALLBACK_NAME = 'untitled'

/**
 * For a `.ps1` under a spaced path: it must travel in `file_path`, and powershell
 * strips the launcher's quotes and reads the spaced path as command + args
 * (verified against real powershell.exe).
 */
const POWERSHELL_SPACED_PATH_WARNING =
  'powershell mishandles a script path containing spaces — move the script somewhere without spaces, or check the launch'

/**
 * Classify dropped paths concurrently, returned in drop order. Shared probes
 * ("where is TouchDesigner?") run once per call — the resolver memoises the
 * promise, not the result. A path whose probes throw becomes `unsupported`
 * rather than rejecting the whole batch.
 */
export function classifyDrop(
  paths: string[],
  fs: FsProbe,
  options: ClassifyOptions = {},
): Promise<DropResult[]> {
  const resolved: Required<ClassifyOptions> = { ...DEFAULT_CLASSIFY_OPTIONS, ...options }
  const resolver = createResolver(fs, resolved)

  return Promise.all(
    paths.map(async (path) => {
      try {
        return await classifyOne(path, fs, resolver, resolved.os)
      } catch (error) {
        return unsupported(path, `could not read this path (${messageOf(error)})`)
      }
    }),
  )
}

/** Keeps the service's field order. */
export function toProcessEntry(draft: ProcessEntryDraft, id: string): ProcessEntry {
  return { id, ...draft }
}

async function classifyOne(
  path: string,
  fs: FsProbe,
  resolver: Resolver,
  os: DesktopOs,
): Promise<DropResult> {
  if (!(await fs.exists(path))) return unsupported(path, 'this path no longer exists')
  if (await fs.isDir(path)) return classifyDirectory(path, fs, os)

  switch (extname(path)) {
    case '.toe':
      return classifyTouchDesignerProject(path, resolver)
    case '.exe':
      return classifyExecutable(path, fs)
    case '.bat':
    case '.cmd':
      return classifyBatchScript(path)
    case '.py':
      return classifyPythonScript(path, resolver)
    case '.ps1':
      return classifyPowerShellScript(path, resolver)
    default:
      return unsupported(path, unsupportedFileReason(path))
  }
}

/**
 * A dropped folder is a macos `.app` bundle — the agent runs the binary inside
 * it (`shared_utils.resolve_exec_target`) — or a windows Unity build:
 * `<name>.exe` beside `<name>_Data`.
 */
async function classifyDirectory(path: string, fs: FsProbe, os: DesktopOs): Promise<DropResult> {
  if (os === 'macos' && extname(path) === '.app') return classifyExecutable(path, fs)

  const unity = await findUnityPlayer(path, fs)
  if (!unity) return unsupported(path, launchCopyFor(os).folderRefusal)

  return {
    kind: 'unity',
    path,
    entry: draft({
      name: lowerName(unity.stem),
      exe_path: unity.exePath,
      file_path: '',
      // trailing separator dropped to match the service's own cwd entries
      cwd: trimTrailing(path),
    }),
    needsInput: [],
    warnings: [],
  }
}

/**
 * `TouchDesigner.exe <file.toe>`; cwd is the project folder so relative asset
 * paths resolve as they do on double-click.
 */
async function classifyTouchDesignerProject(path: string, resolver: Resolver): Promise<DropResult> {
  const exePath = await resolver.touchDesigner()

  return {
    kind: 'touchdesigner',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: exePath ?? '',
      file_path: path,
      cwd: dirname(path),
    }),
    needsInput: exePath ? [] : ['exe_path'],
    warnings: [],
  }
}

/** A bare executable; labelled `unity` when a `_Data` sibling exists. Entry is identical either way. */
async function classifyExecutable(path: string, fs: FsProbe): Promise<DropResult> {
  const directory = dirname(path)
  const isUnityPlayer = await fs.isDir(join(directory, `${stem(path)}${UNITY_DATA_SUFFIX}`))

  return {
    kind: isUnityPlayer ? 'unity' : 'executable',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: path,
      file_path: '',
      cwd: directory,
    }),
    needsInput: [],
    warnings: [],
  }
}

/**
 * `.bat`/`.cmd` go in as the executable, never as an arg to cmd.exe: the launcher
 * already wraps batch files (`process_launcher.py:170-174`), and `/c "<script>"`
 * in `file_path` gets mangled by the service's abspath validator
 * (`owlette_service.py:1902-1910`).
 */
function classifyBatchScript(path: string): DropResult {
  return {
    kind: 'script',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: path,
      file_path: '',
      cwd: dirname(path),
    }),
    needsInput: [],
    warnings: [],
  }
}

/** `py.exe "<script>"` — the launcher quotes an existing file for us. */
async function classifyPythonScript(path: string, resolver: Resolver): Promise<DropResult> {
  const exePath = await resolver.python()

  return {
    kind: 'script',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: exePath ?? '',
      file_path: path,
      cwd: dirname(path),
    }),
    needsInput: exePath ? [] : ['exe_path'],
    warnings: [],
  }
}

/**
 * `powershell.exe "<script>"`. The script must go in `file_path` — anything there
 * that is not an existing file is rewritten by the service's path validator,
 * which rules out `-File`. Costs the {@link POWERSHELL_SPACED_PATH_WARNING} case.
 */
async function classifyPowerShellScript(path: string, resolver: Resolver): Promise<DropResult> {
  const exePath = await resolver.powershell()

  return {
    kind: 'script',
    path,
    entry: draft({
      name: lowerName(stem(path)),
      exe_path: exePath ?? '',
      file_path: path,
      cwd: dirname(path),
    }),
    needsInput: exePath ? [] : ['exe_path'],
    warnings: /\s/.test(path) ? [POWERSHELL_SPACED_PATH_WARNING] : [],
  }
}

interface UnityPlayer {
  exePath: string
  stem: string
}

/**
 * The `_Data` folder is the anchor, not the exe: a build ships several
 * executables but only one is named after a `_Data` folder. On multiple pairs,
 * the one named after the folder wins.
 */
async function findUnityPlayer(directory: string, fs: FsProbe): Promise<UnityPlayer | null> {
  const entries = await fs.listDir(directory)
  const executables = new Set(
    entries.filter((entry) => extname(entry) === '.exe').map((entry) => entry.toLowerCase()),
  )

  const candidates: UnityPlayer[] = []
  for (const entry of [...entries].sort(compareVersionNames)) {
    if (!entry.toLowerCase().endsWith(UNITY_DATA_SUFFIX.toLowerCase())) continue

    const base = entry.slice(0, -UNITY_DATA_SUFFIX.length)
    if (!base || !executables.has(`${base.toLowerCase()}.exe`)) continue

    const exePath = join(directory, `${base}.exe`)
    if (!(await fs.isDir(join(directory, entry)))) continue
    if (!(await isFile(fs, exePath))) continue

    candidates.push({ exePath, stem: base })
  }

  const folder = basename(directory).toLowerCase()
  const named = candidates.find((candidate) => candidate.stem.toLowerCase() === folder)
  return named ?? candidates[0] ?? null
}

interface Resolver {
  touchDesigner(): Promise<string | null>
  python(): Promise<string | null>
  powershell(): Promise<string | null>
}

/** Per-call lookups for the host applications, each probed at most once. */
function createResolver(fs: FsProbe, options: Required<ClassifyOptions>): Resolver {
  let touchDesigner: Promise<string | null> | undefined
  let python: Promise<string | null> | undefined
  let powershell: Promise<string | null> | undefined

  return {
    touchDesigner: () =>
      (touchDesigner ??= newestInstall(fs, options.touchDesignerRoot, 'TouchDesigner', [
        'bin',
        'TouchDesigner.exe',
      ])),
    python: () =>
      (python ??= firstExistingFile(fs, options.pythonCandidates).then(
        (found) => found ?? newestInstall(fs, options.pythonInstallRoot, 'Python', ['python.exe']),
      )),
    powershell: () => (powershell ??= firstExistingFile(fs, options.powershellCandidates)),
  }
}

/**
 * Newest `<prefix>*` dir under `root` that actually contains `<tail>` — an
 * uninstall leaves the version directory behind, so the name proves nothing.
 */
async function newestInstall(
  fs: FsProbe,
  root: string,
  prefix: string,
  tail: string[],
): Promise<string | null> {
  if (!(await fs.isDir(root))) return null

  const entries = await fs.listDir(root)
  const versions = entries
    .filter((entry) => entry.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort(compareVersionNames)
    .reverse()

  for (const version of versions) {
    const candidate = join(root, version, ...tail)
    if (await isFile(fs, candidate)) return candidate
  }
  return null
}

async function firstExistingFile(fs: FsProbe, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isFile(fs, candidate)) return candidate
  }
  return null
}

async function isFile(fs: FsProbe, path: string): Promise<boolean> {
  return (await fs.exists(path)) && !(await fs.isDir(path))
}

/**
 * Natural sort: digit runs compare numerically, so `TouchDesigner.2025.9999`
 * sorts below `.30060` — a string sort gets that backwards and picks the wrong
 * build. An unversioned name sorts oldest.
 */
export function compareVersionNames(a: string, b: string): number {
  const left = chunk(a)
  const right = chunk(b)

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1

    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
      continue
    }

    const xs = String(x).toLowerCase()
    const ys = String(y).toLowerCase()
    if (xs !== ys) return xs < ys ? -1 : 1
  }
  return 0
}

/** Split a name into alternating text and numeric runs. */
function chunk(value: string): Array<string | number> {
  return value
    .split(/(\d+)/)
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
}

type DerivedFields = Pick<ProcessEntryDraft, 'name' | 'exe_path' | 'file_path' | 'cwd'>

/** Everything a rule derives, wrapped in the defaults every entry shares. */
function draft(fields: DerivedFields): ProcessEntryDraft {
  return {
    name: fields.name,
    exe_path: fields.exe_path,
    file_path: fields.file_path,
    cwd: fields.cwd,
    ...DROP_DEFAULTS,
  }
}

function unsupported(path: string, reason: string): UnsupportedDrop {
  return { kind: 'unsupported', path, reason }
}

function unsupportedFileReason(path: string): string {
  const extension = extname(path)
  return extension
    ? `owlette does not know how to launch a ${extension} file`
    : 'owlette does not know how to launch a file with no extension'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Process names are lowercase like the rest of the UI. */
function lowerName(value: string): string {
  return value.trim().toLowerCase() || FALLBACK_NAME
}

/*
 * Path helpers. Tauri hands us backslashes, the python GUI's file dialog writes
 * forward slashes — so these read both and echo back the input's separator.
 */

function separatorOf(path: string): string {
  return !path.includes('\\') && path.includes('/') ? '/' : '\\'
}

function trimTrailing(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  // A drive root trims to `C:`, which no longer names a directory.
  return trimmed === '' ? path : trimmed
}

function basename(path: string): string {
  const trimmed = trimTrailing(path)
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

function dirname(path: string): string {
  const trimmed = trimTrailing(path)
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (index === -1) return ''
  const parent = trimmed.slice(0, index)
  // `C:\app.exe` — keep the root's separator rather than returning a bare `C:`.
  return /^[a-z]:$/i.test(parent) ? parent + separatorOf(path) : parent
}

function extname(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLowerCase() : ''
}

function stem(path: string): string {
  const name = basename(path)
  const extension = extname(path)
  return extension ? name.slice(0, -extension.length) : name
}

function join(base: string, ...parts: string[]): string {
  const separator = separatorOf(base)
  return [trimTrailing(base), ...parts].filter((segment) => segment !== '').join(separator)
}
