/**
 * PostToolUse Hook — File Edit Tracker
 *
 * Logs Edit/Write/NotebookEdit operations to session-edits.json
 * so other hooks can know which files were recently changed.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { EDIT_LOG as SESSION_FILE } from './lib/edit-log.mjs'

const MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes

// Read JSON from stdin
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const data = JSON.parse(input)
  const filePath = data.tool_input?.file_path
  if (!filePath) process.exit(0)

  // Read existing entries
  let entries = []
  if (existsSync(SESSION_FILE)) {
    try {
      entries = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
    } catch { entries = [] }
  }

  // Prune old entries
  const now = Date.now()
  entries = entries.filter(e => (now - e.timestamp) < MAX_AGE_MS)

  // Append new entry
  entries.push({
    path: filePath,
    timestamp: now,
    tool: data.tool_name,
    session: data.session_id
  })

  writeFileSync(SESSION_FILE, JSON.stringify(entries, null, 2))
} catch {
  // Silent failure — don't block Claude
}

process.exit(0)
