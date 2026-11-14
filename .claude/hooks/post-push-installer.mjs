/**
 * PostToolUse hook: after a push or PR merge lands agent/src/*.py or the
 * installer script on dev/main, remind Claude that the fleet only gets the
 * change through an installer release. The release itself stays with Claude:
 * it needs a version bump, a changelog entry, admin elevation and the upload flow.
 */

import { addContext } from './lib/hook-output.mjs'
import { pushTarget } from './lib/push-target.mjs'

const isInstallerInput = (f) =>
  (f.startsWith('agent/src/') && f.endsWith('.py')) || f === 'agent/owlette_installer.iss'

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const target = pushTarget(JSON.parse(input))
  const agentFiles = target?.files.filter(isInstallerInput) ?? []
  if (agentFiles.length > 0) {
    const env = target.branch === 'main' ? 'prod' : 'dev'
    addContext('PostToolUse', [
      `Agent files landed on ${target.branch}: ${agentFiles.join(', ')}.`,
      `Machines only get them through an installer release. If this change should reach the ${env} fleet, follow the build-system skill's "Agent Installer Release" recipe (version bump and changelog entry come before the build).`,
    ].join('\n'))
  }
} catch (err) {
  process.stderr.write(`[post-push-installer] Error: ${err.message}\n`)
}

process.exit(0)
