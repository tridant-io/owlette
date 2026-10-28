/** @jest-environment node */

/**
 * the server render of ThemeProvider: next-themes' head script must carry the
 * csp nonce (strict-dynamic blocks it otherwise, and every page flashes), and
 * the script it emits must pick the theme the way the owner brief says: the
 * stored choice first, else the os, never touching the other <html> classes.
 */

import vm from 'vm';
import { renderToString } from 'react-dom/server';
import { ThemeProvider } from '@/components/ThemeProvider';
import { THEME_STORAGE_KEY } from '@/lib/theme';

function renderHeadScript(nonce?: string) {
  const html = renderToString(<ThemeProvider nonce={nonce}>page</ThemeProvider>);
  const match = html.match(/<script([^>]*)>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no head script rendered');
  return { attributes: match[1], code: match[2] };
}

/** runs the head script against a stub <html> that starts as the server rendered it */
function runHeadScript({ stored, prefersDark }: { stored: string | null; prefersDark: boolean }) {
  const classes = new Set(['dark', 'scroll-smooth']);
  const root = {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
    },
    setAttribute: () => {},
    style: {} as { colorScheme?: string },
  };
  vm.runInNewContext(renderHeadScript('n').code, {
    document: { documentElement: root },
    localStorage: { getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null) },
    window: { matchMedia: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && prefersDark }) },
  });
  return { classes: [...classes].sort(), colorScheme: root.style.colorScheme };
}

describe('ThemeProvider', () => {
  it('puts the request nonce on the head script', () => {
    expect(renderHeadScript('r4nd0m-n0nce').attributes).toContain('nonce="r4nd0m-n0nce"');
  });

  it('follows the os when nothing is stored', () => {
    expect(runHeadScript({ stored: null, prefersDark: true })).toEqual({
      classes: ['dark', 'scroll-smooth'],
      colorScheme: 'dark',
    });
    expect(runHeadScript({ stored: null, prefersDark: false })).toEqual({
      classes: ['light', 'scroll-smooth'],
      colorScheme: 'light',
    });
    expect(runHeadScript({ stored: 'system', prefersDark: false }).classes).toEqual(['light', 'scroll-smooth']);
  });

  it('lets a stored choice override the os', () => {
    expect(runHeadScript({ stored: 'dark', prefersDark: false }).classes).toEqual(['dark', 'scroll-smooth']);
    expect(runHeadScript({ stored: 'light', prefersDark: true }).classes).toEqual(['light', 'scroll-smooth']);
  });
});
