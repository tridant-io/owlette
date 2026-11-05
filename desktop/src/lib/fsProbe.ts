/**
 * The real disk behind {@link FsProbe}, plus the machine-specific search paths
 * the classifier can't derive.
 *
 * `@tauri-apps/plugin-fs` is scoped in `capabilities/default.json` to `exists`,
 * `readDir` and `stat` — metadata only. Do NOT add a content permission here:
 * classification decides from extension, folder neighbours and installed hosts,
 * so a dropped file can be misread but never read.
 */

import { localDataDir } from '@tauri-apps/api/path'
import { exists, readDir, stat } from '@tauri-apps/plugin-fs'
import {
  compareVersionNames,
  DEFAULT_CLASSIFY_OPTIONS,
  type ClassifyOptions,
  type FsProbe,
} from '@/lib/dropClassifier'
import { desktopOs } from '@/lib/launchCopy'

/**
 * Metadata probes; anything unreadable answers "no" rather than throwing the
 * whole batch (a drop may name a disconnected share or a path this process can't
 * see). `listDir` is the exception: an unlistable folder is indistinguishable
 * from an empty one, so it throws and `classifyDrop` reports unsupported with
 * the reason.
 */
export const tauriFsProbe: FsProbe = {
  async exists(path: string): Promise<boolean> {
    try {
      return await exists(path)
    } catch {
      return false
    }
  },

  async isDir(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory
    } catch {
      return false
    }
  },

  async listDir(path: string): Promise<string[]> {
    return (await readDir(path)).map((entry) => entry.name)
  },
}

/** Where python.org's per-user installer puts interpreters, under `%LOCALAPPDATA%`. */
const PER_USER_PYTHON_REL = ['Programs', 'Python']

/** Version directories there are `Python313`, `Python39`, … next to `Launcher`. */
const PYTHON_VERSION_DIR = /^python\d/i

/**
 * Classifier options for this machine. Only python needs help: TouchDesigner and
 * PowerShell live at fixed paths the defaults cover, but python.org's installer
 * defaults to per-user under `%LOCALAPPDATA%`, which the classifier can't expand
 * (it has no environment).
 *
 * Order matters — `py.exe` first (the launcher honours a script's shebang), then
 * the newest per-user interpreter. This list REPLACES the defaults, so they are
 * spread back in explicitly.
 */
export async function classifyOptionsFor(
  fs: FsProbe,
  localAppData: string,
): Promise<ClassifyOptions> {
  const root = joinPath(localAppData, ...PER_USER_PYTHON_REL)
  const candidates = [
    ...DEFAULT_CLASSIFY_OPTIONS.pythonCandidates,
    joinPath(root, 'Launcher', 'py.exe'),
  ]

  if (await fs.isDir(root)) {
    const versions = (await fs.listDir(root))
      .filter((entry) => PYTHON_VERSION_DIR.test(entry))
      .sort(compareVersionNames)
      .reverse()
    candidates.push(...versions.map((version) => joinPath(root, version, 'python.exe')))
  }

  return { pythonCandidates: candidates }
}

/**
 * {@link classifyOptionsFor} against the running machine, and which desktop it
 * is. A failure to resolve or list `%LOCALAPPDATA%` isn't worth failing a drop
 * over: the classifier falls back to its defaults and the confirm card asks for
 * an interpreter if needed.
 */
export async function classifyOptions(fs: FsProbe = tauriFsProbe): Promise<ClassifyOptions> {
  const os = desktopOs()
  try {
    return { ...(await classifyOptionsFor(fs, await localDataDir())), os }
  } catch {
    return { os }
  }
}

/** Windows path join. Everything this module builds is an absolute local path. */
function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...parts].join('\\')
}
