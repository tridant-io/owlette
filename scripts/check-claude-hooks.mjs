#!/usr/bin/env node
/**
 * Proves the Claude Code hooks, skills, agents and commands in .claude/ can
 * actually reach the model. Three hooks sat dead for months (one never parsed,
 * two wrote output fields Claude Code ignores) and an agent was dropped for an
 * unquoted ": " in its description. Each check below catches one of those.
 *
 *   1. every hook command in .claude/settings.json points at a file that exists
 *   2. every .mjs under .claude/hooks parses (node --check)
 *   3. only lib/hook-output.mjs writes stdout, so the schema lives in one place
 *   4. each registered hook, fed a no-op call for its event, emits nothing or
 *      valid hook JSON; so do the lib/hook-output.mjs writers
 *   5. every skill, agent and command has frontmatter Claude Code will load:
 *      skills are folders, names match, and no single-line value carries an
 *      unquoted ": " (invalid YAML, so the file is silently dropped)
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

// 5. frontmatter claude code will load
function frontmatterError(file, expectName) {
  const lines = readFileSync(file, 'utf-8').replace(/\r/g, '').split('\n')
  if (lines[0] !== '---') return 'no frontmatter'
  const end = lines.indexOf('---', 1)
  if (end < 0) return 'unterminated frontmatter'
  const fields = {}
  let key = null
  for (const line of lines.slice(1, end)) {
    // an indented line continues the previous key's value (wrapped text or a list)
    if (/^\s/.test(line)) {
      if (key && !fields[key]) fields[key] = line.trim()
      continue
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/)
    if (!m) continue
    key = m[1]
    fields[key] = m[2]
    // in a plain scalar, a colon before a space or the line end starts a mapping
    const plain = m[2].replace(/\s+#.*$/, '')
    if (!/^["'|>[{]/.test(plain) && /:(\s|$)/.test(plain)) return `${key} has an unquoted ":" (invalid YAML)`
  }
  if (!fields.description) return 'no description'
  if (expectName && fields.name?.replace(/^["']|["']$/g, '') !== expectName) return `name is not "${expectName}"`
  return null
}

const CLAUDE = join(ROOT, '.claude')
const mdIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md'))
for (const f of mdIn(join(CLAUDE, 'skills'))) fail(`.claude/skills/${f} is a flat file; skills load only from <name>/SKILL.md`)
const definitions = [
  ...readdirSync(join(CLAUDE, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => [join(CLAUDE, 'skills', e.name, 'SKILL.md'), e.name]),
  ...mdIn(join(CLAUDE, 'agents')).map((f) => [join(CLAUDE, 'agents', f), f.slice(0, -3)]),
  ...mdIn(join(CLAUDE, 'commands')).map((f) => [join(CLAUDE, 'commands', f), null]),
]
for (const [file, name] of definitions) {
  const err = existsSync(file) ? frontmatterError(file, name) : 'missing'
  if (err) fail(`${relative(ROOT, file)}: ${err}`)
}

if (failures.length) {
  console.error(`claude hooks: ${failures.length} problem(s)\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log(`claude hooks: ${registered.length} registered hooks, ${hookFiles(HOOKS).length} hook files and ${definitions.length} skills, agents and commands ok`)
