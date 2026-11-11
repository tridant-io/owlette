/** The guide to hoot mcp, which the connect dialog sets up. */
export const HOOT_MCP_DOCS_URL = 'https://owlette.app/docs/agent/hoot-mcp'

/** The line that registers hoot in Claude Code. Each path is quoted: an install path may hold a space. */
export function claudeCodeCommand([python, script]: string[]): string {
  return `claude mcp add hoot -- "${python}" "${script}"`
}
