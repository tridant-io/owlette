import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Every internal /docs link in the MDX resolves, anchors included.
 *
 * Fumadocs does not validate links at build time, so a renamed heading leaves a
 * live page with a dead jump and nothing goes red. Two such links shipped —
 * cli/reference/version.mdx and whoami.mdx both pointed at
 * `#json-envelope-schema` after the heading became "json output shapes".
 *
 * Anchor ids are read off the rendered HTML rather than derived from the
 * headings, so this cannot drift from whatever slugger fumadocs uses.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const DOCS_ROOT = resolve(__dirname, '../../../content/docs');
const LINK = /\]\((\/docs\/[^)\s]*)\)/g;

function mdxFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...mdxFilesIn(full));
    else if (entry.endsWith('.mdx')) out.push(full);
  }
  return out;
}

/** `{ target -> the mdx files that link to it }`, so a failure names the source. */
function collectLinks(): Map<string, string[]> {
  const links = new Map<string, string[]>();
  for (const file of mdxFilesIn(DOCS_ROOT)) {
    const source = file.slice(DOCS_ROOT.length + 1).replace(/\\/g, '/');
    const body = readFileSync(file, 'utf8');
    for (const [, target] of body.matchAll(LINK)) {
      const sources = links.get(target) ?? [];
      if (!sources.includes(source)) sources.push(source);
      links.set(target, sources);
    }
  }
  return links;
}

async function fetchPages(
  request: APIRequestContext,
  paths: string[],
): Promise<Map<string, { status: number; html: string }>> {
  const pages = new Map<string, { status: number; html: string }>();
  for (const path of paths) {
    const res = await request.get(path);
    pages.set(path, {
      status: res.status(),
      html: res.ok() ? await res.text() : '',
    });
  }
  return pages;
}

test.describe('docs internal links', () => {
  // One fetch per unique page, not per link — ~60 pages for ~240 links.
  test.setTimeout(180_000);

  test('every /docs link and anchor in the MDX resolves', async ({ request }) => {
    const links = collectLinks();
    expect(links.size, 'found no /docs links — the collector is broken, not the docs').toBeGreaterThan(50);

    const pagePaths = [...new Set([...links.keys()].map((t) => t.split('#')[0]))];
    const pages = await fetchPages(request, pagePaths);

    const broken: string[] = [];
    for (const [target, sources] of links) {
      const [path, anchor] = target.split('#');
      const page = pages.get(path);
      const from = sources.join(', ');

      if (!page || page.status !== 200) {
        broken.push(`${target} -> HTTP ${page?.status ?? '?'} (linked from ${from})`);
        continue;
      }
      if (anchor && !page.html.includes(`id="${anchor}"`)) {
        broken.push(`${target} -> no element with id="${anchor}" (linked from ${from})`);
      }
    }

    expect(broken, `broken docs links:\n  ${broken.join('\n  ')}`).toEqual([]);
  });
});
