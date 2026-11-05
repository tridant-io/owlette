/**
 * PostToolUse hook: after a push or PR merge lands on dev/main touching the
 * e2e.yml path filter, tell Claude to watch the triggered "playwright e2e" run
 * and, on failure, diagnose and PROPOSE a fix (never auto-repush — dev
 * auto-deploys, main is protected).
 *
 * Detects only; it does NOT poll CI, because a 6-30 min `gh run watch` would
 * hang the harness.
 */

import { addContext } from './lib/hook-output.mjs'
import { pushTarget } from './lib/push-target.mjs'

// Keep in sync with .github/workflows/e2e.yml.
const PATH_FILTER = [
  (f) => f.startsWith('web/'),
  (f) => f === 'firestore.rules',
  (f) => f === 'firebase.json',
  (f) => f === '.github/workflows/e2e.yml',
]

const matchesFilter = (file) => PATH_FILTER.some((m) => m(file))

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const target = pushTarget(JSON.parse(input))
  // Fail open when the diff is unknowable — over-verifying beats missing a red run.
  if (target && !(target.known && !target.files.some(matchesFilter))) {
    const { branch, sha, files, known } = target
    addContext('PostToolUse', [
      `Landed on ${branch} (${sha.slice(0, 8) || 'sha unknown'}) inside the playwright e2e path filter, so the "playwright e2e" workflow (.github/workflows/e2e.yml) should run. Verify it succeeded:`,
      '',
      `1. Find the run: gh run list --workflow="playwright e2e" --branch ${branch}${sha ? ` --commit ${sha}` : ''} --limit 5 --json databaseId,status,conclusion`,
      `   GitHub can lag a few seconds; if none has appeared, wait ~15s and retry once.`,
      `2. Watch it in the BACKGROUND (cold CI can take ~30 min, target <6): gh run watch <databaseId> --exit-status`,
      `3. On success: report green and stop.`,
      `4. On failure: gh run view <databaseId> --log-failed (and if needed gh run download <databaseId> -n playwright-report), diagnose the root cause, then PROPOSE a fix and wait for review. Do NOT auto-fix-and-repush.`,
      '',
      known
        ? `Changed files in e2e scope: ${files.filter(matchesFilter).join(', ')}`
        : `(Could not determine the landed diff — check whether a run was actually triggered.)`,
    ].join('\n'))
  }
} catch (err) {
  process.stderr.write(`[post-push-e2e] Error: ${err.message}\n`)
}

process.exit(0)
