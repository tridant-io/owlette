/** @jest-environment node */
/**
 * /docs/api — the Scalar reference follows the app's theme choice with no flash
 * and wears the app palette in both modes.
 *
 * Scalar's renderer is ESM-only and cannot load under jest, so the stand-in
 * renders the same document skeleton (head style, body app div, init script
 * carrying the config): the route's post-processing is what is on trial.
 */
import { readFileSync } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';

jest.mock('@scalar/nextjs-api-reference', () => ({
  ApiReference: (config: { customCss?: string }) => () =>
    new Response(
      `<!doctype html>\n<html>\n  <head>\n    <style type="text/css">${config.customCss ?? ''}</style>\n  </head>\n` +
        `  <body>\n    <div id="app"></div>\n    <script type="module">\n` +
        `      createApiReference('#app', ${JSON.stringify(config)})\n    </script>\n  </body>\n</html>`,
    ),
}));

import { GET } from '@/app/docs/api/route';

const NONCE = 'test-nonce';

async function render(nonce: string | null = NONCE): Promise<string> {
  const headers = new Headers(nonce ? { 'x-nonce': nonce } : {});
  const response = await GET(new Request('http://localhost/docs/api', { headers }) as unknown as NextRequest);
  return response.text();
}

/** the custom properties a `selector { ... }` block declares, in the first block that matches */
function declarations(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.]/g, '\\.');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no ${selector} block`);
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

/** every token a top-level block in globals.css declares, merged across repeats */
function appTokens(selector: string): Record<string, string> {
  const css = readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8');
  const escaped = selector.replace(/[.]/g, '\\.');
  const tokens: Record<string, string> = {};
  for (const [, body] of css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))) {
    const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, name, value] of clean.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[name] = value.trim();
  }
  return tokens;
}

function bootstrapSource(html: string): string {
  const match = html.match(/<body>\s*<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no theme bootstrap at the top of <body>');
  return match[1];
}

/** runs the bootstrap against a stand-in browser and reports what it left behind */
function runBootstrap(
  source: string,
  { stored, prefersDark, storageThrows = false }: { stored?: string; prefersDark?: boolean; storageThrows?: boolean },
) {
  const store = new Map<string, string>(stored === undefined ? [] : [['owlette_theme', stored]]);
  const localStorage = {
    getItem: (key: string) => {
      if (storageThrows) throw new Error('storage blocked');
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storageThrows) throw new Error('storage blocked');
      store.set(key, value);
    },
  };
  const window = {
    matchMedia: prefersDark === undefined ? undefined : () => ({ matches: prefersDark }),
  };
  const classes = new Set<string>();
  const document = { body: { classList: { add: (name: string) => classes.add(name) } } };

  new Function('window', 'document', 'localStorage', source)(window, document, localStorage);
  return { bodyClasses: [...classes], scalarColorMode: store.get('colorMode') };
}

describe('GET /docs/api', () => {
  it('stamps the nonce on every script, the theme bootstrap first', async () => {
    const html = await render();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];

    expect(scripts).toHaveLength(2);
    for (const tag of scripts) expect(tag).toContain(`nonce="${NONCE}"`);
    expect(html.indexOf('colorMode')).toBeLessThan(html.indexOf('createApiReference'));
  });

  it('leaves the scripts bare without a nonce', async () => {
    const html = await render(null);

    expect(html).toMatch(/<body>\s*<script>\(function/);
    expect(html).not.toContain('nonce=');
  });

  it('hides scalar’s own mode toggle and forces no mode', async () => {
    const html = await render();
    const config = JSON.parse(html.match(/createApiReference\('#app', ([\s\S]*?)\)\n/)![1]);

    expect(config.hideDarkModeToggle).toBe(true);
    expect(config).not.toHaveProperty('darkMode');
    expect(config).not.toHaveProperty('forceDarkModeState');
  });

  it('paints both scalar modes in the app palette', async () => {
    const css = (await render()).match(/<style type="text\/css">([\s\S]*?)<\/style>/)![1];
    const pairs: Record<string, string> = {
      'scalar-background-1': 'background',
      'scalar-background-2': 'secondary',
      'scalar-background-3': 'accent',
      'scalar-color-1': 'foreground',
      'scalar-color-2': 'muted-foreground',
      'scalar-color-accent': 'accent-cyan',
      'scalar-border-color': 'border',
    };

    for (const [mode, selector] of [['.dark-mode', '.dark'], ['.light-mode', ':root']] as const) {
      const scalar = declarations(css, mode);
      const app = appTokens(selector);
      for (const [scalarVar, token] of Object.entries(pairs)) {
        expect([mode, scalarVar, scalar[scalarVar]]).toEqual([mode, scalarVar, app[token]]);
      }
    }
  });

  describe('theme bootstrap', () => {
    let source: string;
    beforeAll(async () => {
      source = bootstrapSource(await render());
    });

    it.each([
      { stored: 'light', prefersDark: true, body: 'light-mode', scalar: 'light' },
      { stored: 'dark', prefersDark: false, body: 'dark-mode', scalar: 'dark' },
      { stored: 'system', prefersDark: false, body: 'light-mode', scalar: 'system' },
      { stored: 'system', prefersDark: true, body: 'dark-mode', scalar: 'system' },
      { stored: undefined, prefersDark: false, body: 'light-mode', scalar: 'system' },
      { stored: 'sepia', prefersDark: true, body: 'dark-mode', scalar: 'system' },
      { stored: undefined, prefersDark: undefined, body: 'dark-mode', scalar: 'system' },
    ])('choice $stored with an os that prefers dark: $prefersDark → $body', ({ stored, prefersDark, body, scalar }) => {
      expect(runBootstrap(source, { stored, prefersDark })).toEqual({ bodyClasses: [body], scalarColorMode: scalar });
    });

    it('follows the os when storage is blocked', () => {
      expect(runBootstrap(source, { prefersDark: false, storageThrows: true })).toEqual({
        bodyClasses: ['light-mode'],
        scalarColorMode: undefined,
      });
    });
  });
});
