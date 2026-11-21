/**
 * Where a Bash call's git work landed, for the hooks that care which repo it
 * hit. pre-commit-check gates only commits and pushes that land in this
 * project (landsInProject); the post-push hooks react only to a push or
 * `gh pr merge` that reached this project's dev/main (pushTarget).
 */

import { execSync } from 'child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const BRANCHES = ['dev', 'main']

const PATH_ARG = `(?:"[^"]+"|'[^']+'|\\S+)`
// what may stand before the command: a subshell or group, env / VAR=value, sh -c "
const LEAD = `^\\s*[({]*\\s*(?:env\\s+)?(?:\\w+=\\S*\\s+)*(?:(?:ba)?sh\\s+-c\\s+["']?)?`
// git's global options sit between `git` and the subcommand: -C dir, -c k=v, --no-pager
const OPTS = `(?:(?:-C|-c)\\s+${PATH_ARG}\\s+|--[\\w-]+(?:=\\S+)?\\s+)*`
const git = (sub) => new RegExp(`${LEAD}git\\s+${OPTS}${sub}\\b`)
const PUSH = git('push')
export const COMMIT_OR_PUSH = git('(?:commit|push)')
const MERGE = new RegExp(`${LEAD}gh\\s+pr\\s+merge\\b`)
// -C counts only among the global options; after the subcommand it is commit's reuse-message flag
const GIT_DIR = new RegExp(`${LEAD}git\\s+(?:(?:-c\\s+\\S+|--[\\w-]+(?:=\\S+)?)\\s+)*-C\\s+(${PATH_ARG})`)
const CD = new RegExp(`^\\s*[({]*\\s*(?:cd|pushd)\\s+(${PATH_ARG})\\s*$`)
const REPO_FLAG = /(?:\s-R|\s--repo)[\s=]+(?:[\w.-]+\/)?([\w.-]+\/[\w.-]+)(?=\s|$)/
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/

// heredoc bodies are data written to a file, not commands
const withoutHeredocs = (command) =>
  command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '')

/** one shell command per segment; a segment counts only when it starts with the command */
export const segments = (command) => withoutHeredocs(command).split(/&&|\|\||[;|\n]/)
const segment = (command, re) => segments(command).find((s) => re.test(s)) ?? null

const unquote = (p) => p.replace(/^(["'])(.*)\1$/, '$2')
// a closing quote, paren or brace can trail the last argument: (git push origin dev)
const bare = (a) => a.replace(/["')}]+$/, '')

/** git bash writes /c/Users/...; node on windows resolves c:/Users/... */
export function nativePath(p) {
  const home = p.replace(/^~(?=[/\\]|$)/, homedir())
  return process.platform === 'win32' ? home.replace(/^\/([a-z])(?=\/|$)/i, '$1:') : home
}

/** the folder each segment matching `re` ran in: the cwd, moved by `cd`/`pushd` before it, or its own `git -C` */
export function runDirs(command, cwd, re, exists = existsSync) {
  let dir = cwd
  const dirs = []
  for (const s of segments(command)) {
    if (re.test(s)) {
      const c = s.match(GIT_DIR)
      dirs.push(c ? resolve(dir, nativePath(unquote(c[1]))) : dir)
      continue
    }
    const cd = s.match(CD)
    if (!cd) continue
    // the reported cwd can already be past an in-project cd; then the target isn't there twice
    const next = resolve(dir, nativePath(unquote(cd[1])))
    if (exists(next)) dir = next
  }
  return dirs
}

/** owner/repo from a git remote url, lowercased */
export const repoSlug = (url) => url.trim().match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1]?.toLowerCase() ?? null

/** the repo a merge names by `-R [host/]owner/repo` or by pr url, or null */
export function mergeRepo(command) {
  const merge = segment(command, MERGE)
  return (merge?.match(REPO_FLAG)?.[1] ?? merge?.match(PR_URL)?.[1])?.toLowerCase() ?? null
}

/** the merged pr's number ('' merges the current branch's pr), or null when nothing merges */
export function mergedPrRef(command) {
  const merge = segment(command, MERGE)
  if (merge === null) return null
  const args = merge.replace(MERGE, '')
  return args.match(/\/pull\/(\d+)/)?.[1] ?? args.match(/(?:^|\s)#?(\d+)(?=\s|$)/)?.[1] ?? ''
}

const pushArgs = (command) =>
  segment(command, PUSH)?.replace(PUSH, '').trim().split(/\s+/).map(bare).filter(Boolean) ?? null

/** the remote a push names (`git push mba dev` is not origin), or null when it names none */
export function pushRemote(command) {
  const args = pushArgs(command) ?? []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--push-option') i++
    else if (!args[i].startsWith('-')) return args[i]
  }
  return null
}

export const namedBranch = (command) =>
  pushArgs(command)?.find((a) => /^(?:.*:)?(?:refs\/heads\/)?(dev|main)$/.test(a))?.match(/(dev|main)$/)[1] ?? null

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const slugAt = (dir) => {
  try {
    return repoSlug(run('git remote get-url origin', dir))
  } catch {
    return null
  }
}

const projectOf = (data) => slugAt(process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd())

/** true when any segment matching `re` ran in this project's repo (any worktree of it) */
export function landsInProject(data, re) {
  const command = data.tool_input?.command || ''
  // most Bash calls stop here, before any git process starts
  if (!segments(command).some((s) => re.test(s))) return false
  const project = projectOf(data)
  return Boolean(project) && runDirs(command, data.cwd || process.cwd(), re).some((d) => slugAt(d) === project)
}

/** @returns {{ branch: string, sha: string, files: string[], known: boolean } | null} */
export function pushTarget(data) {
  const command = data.tool_input?.command || ''
  const res = data.tool_response ?? {}
  const output = typeof res === 'string' ? res : `${res.stdout || ''}\n${res.stderr || ''}`
  if (/\[rejected\]|failed to push|^fatal:/m.test(output)) return null

  // most Bash calls stop here, before any git process starts
  const ref = mergedPrRef(command)
  if (ref === null && segment(command, PUSH) === null) return null

  const project = projectOf(data)
  if (!project) return null
  const cwd = data.cwd || process.cwd()

  if (ref !== null) {
    const dir = runDirs(command, cwd, MERGE)[0]
    if ((mergeRepo(command) ?? slugAt(dir)) !== project) return null
    // a bare `gh pr merge` names its pr only in gh's own output
    return mergedPr(ref || output.match(/erged pull request (?:[\w.-]+\/[\w.-]+)?#(\d+)/)?.[1] || '', project, dir)
  }

  const dir = runDirs(command, cwd, PUSH).find((d) => slugAt(d) === project)
  if (!dir) return null
  const remote = pushRemote(command)
  if (remote && remote !== 'origin') return null
  if (/--dry-run\b|--delete\b|\s:\S/.test(segment(command, PUSH))) return null

  let branch = namedBranch(command)
  try {
    branch ??= run('git rev-parse --abbrev-ref HEAD', dir)
  } catch {
    return null
  }
  if (!BRANCHES.includes(branch)) return null

  // origin/<branch>@{1} is the remote-tracking ref before this push.
  let sha = ''
  try {
    sha = run(`git rev-parse "origin/${branch}"`, dir)
    const files = run(`git diff --name-only "origin/${branch}@{1}..origin/${branch}"`, dir)
    return { branch, sha, files: files.split('\n').filter(Boolean), known: true }
  } catch {
    return { branch, sha, files: [], known: false }
  }
}

function mergedPr(ref, repo, dir) {
  try {
    // gh needs a pr when given --repo; without one it resolves the branch's pr in dir
    const target = ref ? `${ref} --repo ${repo}` : ''
    const pr = JSON.parse(run(`gh pr view ${target} --json state,baseRefName,mergeCommit,files`, dir))
    if (pr.state !== 'MERGED' || !BRANCHES.includes(pr.baseRefName)) return null
    return {
      branch: pr.baseRefName,
      sha: pr.mergeCommit?.oid || '',
      files: (pr.files || []).map((f) => f.path),
      known: Boolean(pr.files),
    }
  } catch {
    return null
  }
}
