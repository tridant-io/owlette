/**
 * The only way a hook here writes to stdout. Claude Code reads a fixed schema
 * and silently ignores any other field: `{prompt}`, `{message}` and
 * `{decision:'approve'}` each left a hook dead for months without an error.
 * scripts/check-claude-hooks.mjs fails CI on a hook that writes stdout itself.
 */

/** Text the model sees after this event (PostToolUse, UserPromptSubmit, SessionStart). */
export function addContext(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }))
}

/** Blocks a PreToolUse call; the reason goes back to the model. */
export function deny(permissionDecisionReason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason },
  }))
}
