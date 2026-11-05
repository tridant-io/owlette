/**
 * .claude/session-edits.json: files edited in the last 10 minutes, written by
 * track-edits.mjs and read by pre-commit-check.mjs. Every session working in
 * this checkout writes to the same file, so each entry carries its session.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export const EDIT_LOG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'session-edits.json')

/** the distinct paths one session edited */
export function sessionEdits(session, file = EDIT_LOG) {
  if (!existsSync(file)) return []
  try {
    const paths = JSON.parse(readFileSync(file, 'utf-8')).filter((e) => e.session === session).map((e) => e.path)
    return [...new Set(paths)]
  } catch {
    return []
  }
}
