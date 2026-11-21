/** @jest-environment node */

// the catalog's imports (hoot-utils.server, executeMachineCommand.server) reach
// the admin sdk, which initialises on import.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetCatalog } from '@/lib/fleet/catalog.server';

const PAGE = 'content/docs/reference/hoot-mcp-tools.mdx';

/** answered by the script on the calling machine, so it is not in the catalog. */
const LOCAL_TOOLS = ['fleet_status'];

/** every table row whose first cell is a tool name in backticks, with its tier cell. */
function pageRows(): Array<{ name: string; tier: string }> {
  const text = readFileSync(join(process.cwd(), PAGE), 'utf8');
  const rows: Array<{ name: string; tier: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*`([a-z0-9_]+)`\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (match) rows.push({ name: match[1], tier: match[2] });
  }
  return rows;
}

describe('hoot mcp tools reference page', () => {
  const rows = pageRows();
  const catalog = fleetCatalog(3);

  it('lists exactly the tools the catalog serves, plus fleet_status', () => {
    const inPage = new Set(rows.map((row) => row.name));
    const inCode = new Set([...catalog.map((tool) => tool.name), ...LOCAL_TOOLS]);
    const missing = [...inCode].filter((name) => !inPage.has(name));
    const extra = [...inPage].filter((name) => !inCode.has(name));
    const message = [
      missing.length ? `in the code but not on ${PAGE}, add a row for: ${missing.join(', ')}` : '',
      extra.length ? `on ${PAGE} but not in the code, remove or rename the row for: ${extra.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    expect(message).toBe('');
  });

  it('gives every tool the tier the code gives it', () => {
    const wrong = catalog.flatMap((tool) => {
      const row = rows.find((r) => r.name === tool.name);
      return row && row.tier !== String(tool.tier)
        ? [`${tool.name}: the page says tier ${row.tier}, the code says ${tool.tier}`]
        : [];
    });
    expect(wrong.length ? `fix the tier column in ${PAGE}:\n${wrong.join('\n')}` : '').toBe('');
  });

  it('lists no tool twice', () => {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const { name } of rows) (seen.has(name) ? twice : seen).add(name);
    expect(twice.size ? `${PAGE} has more than one row for: ${[...twice].join(', ')}; keep one` : '').toBe('');
  });
});
