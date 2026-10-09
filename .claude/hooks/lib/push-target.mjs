/**
 * What a Bash call landed on this project's dev/main, for the post-push hooks.
 * Covers a `git push` to dev/main and a `gh pr merge` into dev/main, which is
 * how most work lands. Returns null when nothing reached dev/main, the call
 * failed, or the push or merge went to another repo or remote.
 */

import { execSync } from 'child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const BRANCHES = ['dev', 'main']

const PATH_ARG = `(?:"[^"]+"|'[^']+'|\\S+)`
const GIT_C = `-C\\s+(${PATH_ARG})`
const PUSH = new RegExp(`^\\s*git\\s+(?:${GIT_C}\\s+)?push\\b`)
const MERGE = /^\s*gh\s+pr\s+merge\b/
const CD = new RegExp(`^\\s*(?:cd|pushd)\\s+(${PATH_ARG})\\s*$`)
const REPO_FLAG = /(?:\s-R|\s--repo)[\s=]+(?:[\w.-]+\/)?([\w.-]+\/[\w.-]+)(?=\s|$)/
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/

// heredoc bodies are data written to a file, not commands
const withoutHeredocs = (command) =>
  command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '')

// one shell command per segment, and only a segment that starts with the
// command counts: `git push -u origin x && gh pr create --base dev` is not a
// push to dev, and an echo that mentions `gh pr merge` is not a merge
const segments = (command) => withoutHeredocs(command).split(/&&|\|\||[;|\n]/)
const segment = (command, re) => segments(command).find((s) => re.test(s)) ?? null

const unquote = (p) => p.replace(/^(["'])(.*)\1$/, '$2')

/** git bash writes /c/Users/...; node on windows resolves c:/Users/... */
export function nativePath(p) {
  const home = p.replace(/^~(?=[/\\]|$)/, homedir())
  return process.platform === 'win32' ? home.replace(/^\/([a-z])(?=\/|$)/i, '$1:') : home
}

/** where the push or merge ran: the session cwd, moved by any `cd`/`pushd` before it and by `git -C` */
export function runDir(command, cwd, exists = existsSync) {
  let dir = cwd
  for (const s of segments(command)) {
    if (PUSH.test(s) || MERGE.test(s)) {
      const c = s.match(new RegExp(`^\\s*git\\s+${GIT_C}`))
      return c ? resolve(dir, nativePath(unquote(c[1]))) : dir
    }
    const cd = s.match(CD)
    if (!cd) continue
    // the reported cwd can already be past an in-project cd; then the target isn't there twice
    const next = resolve(dir, nativePath(unquote(cd[1])))
    if (exists(next)) dir = next
  }
  return dir
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

const pushArgs = (command) => segment(command, PUSH)?.replace(PUSH, '').trim().split(/\s+/).filter(Boolean) ?? null

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

/** @returns {{ branch: string, sha: string, files: string[], known: boolean } | null} */
export function pushTarget(data) {
  const command = data.tool_input?.command || ''
  const res = data.tool_response ?? {}
  const output = typeof res === 'string' ? res : `${res.stdout || ''}\n${res.stderr || ''}`
  if (/\[rejected\]|failed to push|^fatal:/m.test(output)) return null

  // most Bash calls stop here, before any git process starts
  const ref = mergedPrRef(command)
  const push = ref === null ? segment(command, PUSH) : null
  if (ref === null && push === null) return null

  const cwd = data.cwd || process.cwd()
  const project = slugAt(process.env.CLAUDE_PROJECT_DIR || cwd)
  if (!project) return null
  const dir = runDir(command, cwd)

  if (ref !== null) {
    if ((mergeRepo(command) ?? slugAt(dir)) !== project) return null
    // a bare `gh pr merge` names its pr only in gh's own output
    return mergedPr(ref || output.match(/erged pull request (?:[\w.-]+\/[\w.-]+)?#(\d+)/)?.[1] || '', project, dir)
  }

  if (slugAt(dir) !== project) return null
  const remote = pushRemote(command)
  if (remote && remote !== 'origin') return null
  if (/--dry-run\b|--delete\b|\s:\S/.test(push)) return null

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
