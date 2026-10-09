/**
 * What a Bash call landed on dev/main, for the post-push hooks. Covers a
 * `git push` to dev/main and a `gh pr merge` into dev/main, which is how most
 * work lands. Returns null when nothing reached dev/main or the call failed.
 */

import { execSync } from 'child_process'

const BRANCHES = ['dev', 'main']

const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

/** @returns {{ branch: string, sha: string, files: string[], known: boolean } | null} */
export function pushTarget(data) {
  const command = data.tool_input?.command || ''
  const cwd = data.cwd || process.cwd()
  const res = data.tool_response ?? {}
  const output = typeof res === 'string' ? res : `${res.stdout || ''}\n${res.stderr || ''}`
  if (/\[rejected\]|failed to push|^fatal:/m.test(output)) return null

  const merge = command.match(/\bgh\s+pr\s+merge\b(.*)/)
  if (merge) return mergedPr(merge[1], cwd)

  if (!/\bgit\s+push\b/.test(command)) return null
  if (/--dry-run\b|--delete\b|\s:\S/.test(command)) return null

  const named = command.match(/\bgit\s+push\b.*?[\s:](dev|main)(?=\s|$)/)?.[1]
  let branch = named
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

function mergedPr(args, cwd) {
  const ref = args.match(/\/pull\/(\d+)/)?.[1] ?? args.match(/(?:^|\s)#?(\d+)(?=\s|$)/)?.[1] ?? ''
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
