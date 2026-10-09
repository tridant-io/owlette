#!/usr/bin/env node
/**
 * Proves the Claude Code hooks in .claude/ can actually reach the model.
 * Three hooks sat dead for months: one never parsed, two wrote output fields
 * Claude Code ignores. Each check below would have caught one of them.
 *
 *   1. every hook command in .claude/settings.json points at a file that exists
 *   2. every .mjs under .claude/hooks parses (node --check)
 *   3. only lib/hook-output.mjs writes stdout, so the schema lives in one place
 *   4. each registered hook, fed a no-op call for its event, emits nothing or
 *      valid hook JSON; so do the lib/hook-output.mjs writers
 *
 * Run: node scripts/check-claude-hooks.mjs (CI: .github/workflows/claude-hooks.yml)
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')
const HOOKS = join(ROOT, '.claude', 'hooks')
const OUTPUT_LIB = join(HOOKS, 'lib', 'hook-output.mjs')
const TOP_LEVEL = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason', 'hookSpecificOutput'])
const PERMISSION = new Set(['allow', 'deny', 'ask', 'defer'])

// A call each hook must let through silently.
const NOOP = {
  PreToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' } },
  PostToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '', stderr: '' } },
}

const failures = []
const fail = (msg) => failures.push(msg)

function schemaError(event, stdout) {
  if (!stdout.trim()) return null
  let out
  try {
    out = JSON.parse(stdout)
  } catch {
    return 'stdout is not JSON'
  }
  const unknown = Object.keys(out).filter((k) => !TOP_LEVEL.has(k))
  if (unknown.length) return `unknown top-level field(s): ${unknown.join(', ')}`
  if ('decision' in out && out.decision !== 'block') return `decision "${out.decision}" is not "block"`
  const h = out.hookSpecificOutput
  if (h && h.hookEventName !== event) return `hookEventName "${h.hookEventName}" is not "${event}"`
  if (h?.permissionDecision && !PERMISSION.has(h.permissionDecision)) return `permissionDecision "${h.permissionDecision}"`
  return null
}

const hookFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? hookFiles(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : [])

// 1. registered commands resolve
const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf-8'))
const registered = []
for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      const rel = hook.command.match(/\.claude\/hooks\/[\w./-]+\.mjs/)?.[0]
      if (!rel) { fail(`${event}: cannot find a hook path in "${hook.command}"`); continue }
      if (!existsSync(join(ROOT, rel))) fail(`${event}: ${rel} does not exist`)
      else registered.push({ event, file: join(ROOT, rel) })
    }
  }
}

for (const file of hookFiles(HOOKS)) {
  const name = relative(ROOT, file)
  // 2. parses
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    fail(`${name} does not parse: ${err.stderr.toString().split('\n').find((l) => /Error/.test(l))}`)
  }
  // 3. stdout only through the output lib
  if (file !== OUTPUT_LIB && /process\.stdout\.write|console\.log/.test(readFileSync(file, 'utf-8'))) {
    fail(`${name} writes stdout directly; use lib/hook-output.mjs`)
  }
}

// 4. no-op calls stay silent or valid
for (const { event, file } of registered) {
  const input = NOOP[event]
  if (!input) { fail(`${relative(ROOT, file)}: no fixture for ${event}; add one to NOOP`); continue }
  const run = spawnSync(process.execPath, [file], { input: JSON.stringify({ ...input, cwd: ROOT }), cwd: ROOT, encoding: 'utf-8', timeout: 30000 })
  const err = run.status !== 0 ? `exited ${run.status}` : schemaError(event, run.stdout)
  if (err) fail(`${relative(ROOT, file)} (${event}): ${err}`)
}

const lib = pathToFileURL(OUTPUT_LIB).href
const libCalls = {
  PostToolUse: `import('${lib}').then((m) => m.addContext('PostToolUse', 'x'))`,
  PreToolUse: `import('${lib}').then((m) => m.deny('x'))`,
}
for (const [event, code] of Object.entries(libCalls)) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8' })
  const err = run.status !== 0 ? 'failed to run' : run.stdout.trim() ? schemaError(event, run.stdout) : 'wrote nothing'
  if (err) fail(`lib/hook-output.mjs (${event}): ${err}`)
}

if (failures.length) {
  console.error(`claude hooks: ${failures.length} problem(s)\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log(`claude hooks: ${registered.length} registered hooks and ${hookFiles(HOOKS).length} files ok`)
