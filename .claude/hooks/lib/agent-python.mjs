/**
 * Resolves the interpreter the build hooks run agent checks with.
 *
 * The hooks inherit the environment Claude Code was launched with, not an
 * activated terminal, so a bare `python` is whatever the machine PATH puts
 * first. Windows orders the machine PATH ahead of the user PATH, so a stray
 * system Python (3.9 on the dev box) shadowed a per-user 3.11 and pytest ran
 * against the wrong interpreter with none of the agent's dependencies. The
 * repo's agent venv is the one interpreter guaranteed to be 3.11 with
 * agent/requirements*.txt installed.
 */

import { existsSync } from 'fs'
import { join } from 'path'

export const AGENT_VENV_SETUP_HINT =
  'agent venv missing: run `powershell -File scripts\\bootstrap-windows.ps1 -InstallAgentDeps`'

/** Absolute path to the agent venv's python, or null when the venv is absent. */
export function agentPython(projectRoot) {
  const candidates = [
    join(projectRoot, 'agent', '.venv', 'Scripts', 'python.exe'),
    join(projectRoot, 'agent', '.venv', 'bin', 'python'),
  ]
  return candidates.find(p => existsSync(p)) ?? null
}
