/**
 * What a Bash call landed on dev/main, for the post-push hooks. Covers a
 * `git push` to dev/main and a `gh pr merge` into dev/main, which is how most
 * work lands. Returns null when nothing reached dev/main or the call failed.
 */

import { execSync } from 'child_process'

const BRANCHES = ['dev', 'main']

const PUSH = /^\s*git\s+push\b/
const MERGE = /^\s*gh\s+pr\s+merge\b/

// only the part of a compound command that runs it, and only when it starts
// with it: `git push -u origin x && gh pr create --base dev` is not a push to
// dev, and an echo that mentions `gh pr merge` is not a merge
const segment = (command, re) => command.split(/&&|\|\||[;|\n]/).find((s) => re.test(s)) ?? null

export const namedBranch = (command) =>
  segment(command, PUSH)?.match(/[\s:](dev|main)(?=\s|$)/)?.[1] ?? null

/** the merged pr's number or url ref ('' merges the current branch's pr), or null when nothing merges */
export function mergedPrRef(command) {
  const merge = segment(command, MERGE)
  if (merge === null) return null
  const args = merge.replace(MERGE, '')
  return args.match(/\/pull\/(\d+)/)?.[1] ?? args.match(/(?:^|\s)#?(\d+)(?=\s|$)/)?.[1] ?? ''
}

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

/** @returns {{ branch: string, sha: string, files: string[], known: boolean } | null} */
export function pushTarget(data) {
  const command = data.tool_input?.command || ''
  const cwd = data.cwd || process.cwd()
  const res = data.tool_response ?? {}
  const output = typeof res === 'string' ? res : `${res.stdout || ''}\n${res.stderr || ''}`
  if (/\[rejected\]|failed to push|^fatal:/m.test(output)) return null

  const ref = mergedPrRef(command)
  if (ref !== null) return mergedPr(ref, cwd)

  const push = segment(command, PUSH)
  if (push === null) return null
  if (/--dry-run\b|--delete\b|\s:\S/.test(push)) return null

  let branch = namedBranch(command)
  try {
    branch ??= run('git rev-parse --abbrev-ref HEAD', cwd)
  } catch {
    return null
  }
  if (!BRANCHES.includes(branch)) return null

  // origin/<branch>@{1} is the remote-tracking ref before this push.
  let sha = ''
  try {
    sha = run(`git rev-parse "origin/${branch}"`, cwd)
    const files = run(`git diff --name-only "origin/${branch}@{1}..origin/${branch}"`, cwd)
    return { branch, sha, files: files.split('\n').filter(Boolean), known: true }
  } catch {
    return { branch, sha, files: [], known: false }
  }
}

function mergedPr(ref, cwd) {
  try {
    const pr = JSON.parse(run(`gh pr view ${ref} --json state,baseRefName,mergeCommit,files`, cwd))
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
