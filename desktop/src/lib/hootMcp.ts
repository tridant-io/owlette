/** The guide to hoot mcp, which the connect dialog sets up. */
export const HOOT_MCP_DOCS_URL = 'https://owlette.app/docs/agent/hoot-mcp'

/**
 * One path as a shell argument. A path from the mac or linux starts with a slash
 * and goes in single quotes, which a POSIX shell takes literally (a space, a
 * dollar sign or a bang stays itself); a windows path stays in double quotes.
 */
function shellArg(path: string): string {
  return path.startsWith('/') ? `'${path.replaceAll("'", String.raw`'\''`)}'` : `"${path}"`
}

/** The line that registers hoot in Claude Code. Each path is quoted: an install path may hold a space. */
export function claudeCodeCommand([python, script]: string[]): string {
  return `claude mcp add hoot -- ${shellArg(python)} ${shellArg(script)}`
}
