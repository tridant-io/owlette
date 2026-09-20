/**
 * PreToolUse hook — pre-commit build check.
 *
 * On git commit/push, reads session-edits.json and runs tsc + jest for web/
 * changes and py_compile + pytest for agent/ changes. Blocks on any error.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { agentPython, AGENT_VENV_SETUP_HINT } from './lib/agent-python.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = join(__dirname, '..', 'session-edits.json')
const PROJECT_ROOT = join(__dirname, '..', '..')

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const data = JSON.parse(input)
  const toolInput = data.tool_input || {}

  const command = toolInput.command || ''
  const isCommit = /\bgit\s+(commit|push)\b/.test(command)
  if (!isCommit) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }))
    process.exit(0)
  }

  const editedFiles = getEditedFiles()
  if (editedFiles.length === 0) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }))
    process.exit(0)
  }

  const hasWeb = editedFiles.some(f => /[/\\]web[/\\]/.test(f))
  // The Python agent dir only — web/app/api/agent/* is TypeScript, not Python.
  const hasAgent = editedFiles.some(f => /[/\\]agent[/\\]/.test(f) && !/[/\\]web[/\\]/.test(f))

  if (!hasWeb && !hasAgent) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }))
    process.exit(0)
  }

  const errors = []
  const python = hasAgent ? agentPython(PROJECT_ROOT) : null
  if (hasAgent && !python) errors.push(AGENT_VENV_SETUP_HINT)

  if (hasWeb) {
    try {
      execSync('npx tsc --noEmit', {
        cwd: join(PROJECT_ROOT, 'web'),
        timeout: 60000,
        stdio: 'pipe'
      })
    } catch (err) {
      const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '')
      const tsErrors = output.split('\n').filter(l => /\.tsx?\(\d+,\d+\): error TS/.test(l))
      errors.push(`Web: ${tsErrors.length || 'unknown'} TypeScript error(s)`)
      tsErrors.slice(0, 5).forEach(e => errors.push(`  ${e.trim()}`))
      if (tsErrors.length > 5) errors.push(`  ... and ${tsErrors.length - 5} more`)
    }
  }

  if (python) {
    const pyFiles = editedFiles
      .filter(f => /[/\\]agent[/\\]/.test(f) && f.endsWith('.py'))

    for (const file of pyFiles) {
      try {
        execSync(`"${python}" -m py_compile "${file}"`, {
          cwd: PROJECT_ROOT,
          timeout: 10000,
          stdio: 'pipe'
        })
      } catch (err) {
        const msg = err.stderr?.toString().trim()
        errors.push(`Agent: syntax error in ${file.split(/[/\\]/).pop()}`)
        if (msg) errors.push(`  ${msg}`)
      }
    }
  }

  if (hasWeb) {
    try {
      // 300s: the suite outgrew 90s during the billing sprint (~2900 tests,
      // 100-140s warm). An execSync timeout kill surfaces as a bare "Jest tests
      // failed" with no summary, which reads like a red suite when it isn't.
      execSync('npx jest --bail --forceExit', {
        cwd: join(PROJECT_ROOT, 'web'),
        timeout: 300000,
        stdio: 'pipe'
      })
    } catch (err) {
      const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '')
      const lines = output.split('\n')
      const summary = lines.find(l => /Tests:\s+/.test(l))
      const failSuites = lines.filter(l => /^FAIL\s/.test(l))
      errors.push(`Web: ${summary?.trim() || 'Jest tests failed'}`)
      failSuites.slice(0, 5).forEach(s => errors.push(`  ${s.trim()}`))
      if (failSuites.length > 5) errors.push(`  ... and ${failSuites.length - 5} more`)
    }
  }

  if (python) {
    // Captured on both paths: a green run's stdout still carries the skip
    // summary, and that is the only place the module-skip check below can read.
    let output = ''
    try {
      output = execSync(`"${python}" -m pytest agent/tests/ -x -q --tb=line`, {
        cwd: PROJECT_ROOT,
        // 300s, not 60s: tests/lifecycle (added 2026-09-05, process-identity
        // Wave 0) spawns real processes and takes ~60s by itself, so the whole
        // suite runs ~75s. At 60s execSync killed pytest mid-run and the gate
        // reported a bare "pytest failed" with no summary on every agent
        // commit. The budget is headroom, not a target — a hung suite still
        // dies here rather than wedging the commit forever.
        timeout: 300000,
        stdio: 'pipe'
      }).toString()
    } catch (err) {
      output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '')
      const lines = output.split('\n')
      const summary = lines.find(l => /\d+ (failed|passed|error)/.test(l))
      const failTests = lines.filter(l => /^FAILED\s/.test(l))
      errors.push(`Agent: ${summary?.trim() || 'pytest failed'}`)
      failTests.slice(0, 5).forEach(t => errors.push(`  ${t.trim()}`))
      if (failTests.length > 5) errors.push(`  ... and ${failTests.length - 5} more`)
    }

    // A test module whose imports blow up skips itself with
    // pytest.skip(..., allow_module_level=True), so the suite still exits 0 and
    // a broken source file passes the gate silently. agent/pytest.ini's `-ra`
    // prints those SKIPPED lines on every run, so match the import-shaped
    // reasons ("... not importable: ...", "... import failed: ...") and block.
    // The suite's six deliberate platform skips (posix-only, win32gui) carry
    // none of those words and keep passing silently.
    const importSkips = output
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^SKIPPED \[\d+\]/.test(l) && /not importable|import failed/i.test(l))
    if (importSkips.length > 0) {
      errors.push(`Agent: ${importSkips.length} test module(s) skipped on a failed import`)
      importSkips.slice(0, 5).forEach(s => errors.push(`  ${s}`))
      if (importSkips.length > 5) errors.push(`  ... and ${importSkips.length - 5} more`)
    }
  }

  if (errors.length > 0) {
    const reason = [
      'BUILD CHECK FAILED — fix errors before committing:',
      ...errors
    ].join('\n')
    process.stdout.write(JSON.stringify({ decision: 'block', reason }))
  } else {
    process.stdout.write(JSON.stringify({ decision: 'approve' }))
  }

} catch (err) {
  // Fail open.
  process.stdout.write(JSON.stringify({ decision: 'approve' }))
}

process.exit(0)

function getEditedFiles() {
  if (!existsSync(SESSION_FILE)) return []
  try {
    const entries = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
    const seen = new Set()
    return entries
      .map(e => e.path)
      .filter(p => { if (seen.has(p)) return false; seen.add(p); return true })
  } catch { return [] }
}
