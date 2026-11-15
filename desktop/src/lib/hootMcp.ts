/** The guide to hoot mcp, which the settings window sets up. */
export const HOOT_MCP_DOCS_URL = 'https://owlette.app/docs/agent/hoot-mcp'

/**
 * One path as a shell argument. A path from the mac or linux starts with a slash
 * and goes in single quotes, which a POSIX shell takes literally (a space, a
 * dollar sign or a bang stays itself); a windows path stays in double quotes.
 */
function shellArg(path: string): string {
  return path.startsWith('/') ? `'${path.replaceAll("'", String.raw`'\''`)}'` : `"${path}"`
}

/** The command and its script as one line for another tool's mcp setup. Each path is quoted: an install path may hold a space. */
export function hootCommandLine([python, script]: string[]): string {
  return `${shellArg(python)} ${shellArg(script)}`
}
