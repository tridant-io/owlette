/** @jest-environment node */

/**
 * source guard: links read as links by colour and the .hl-link sweep, never by
 * an underline. scans class tokens and css, not prose, so comments may say the word.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const webRoot = path.join(__dirname, '..', '..');
const roots = ['app', 'components', 'lib'];
const exts = /\.(tsx?|css|mdx)$/;

// tailwind utilities (any variant prefix), and the css properties that draw one
const UTILITY = /(?<![\w-])(?:[\w[\]&>*:-]+:)*(?:underline|underline-offset-[\w[\].-]+)(?![\w-])/;
const CSS = /text-decoration(?:-line)?\s*:[^;}]*underline|text-underline-offset/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === '.next' || name === '__tests__') return [];
    if (statSync(full).isDirectory()) return sources(full);
    return exts.test(name) ? [full] : [];
  });
}

function findings(text: string): string[] {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line));
  return code.filter((line) => UTILITY.test(line) || CSS.test(line));
}

describe('no underlines in the web sources', () => {
  it('the patterns catch what they should', () => {
    expect(findings('<a className="underline">x</a>')).toHaveLength(1);
    expect(findings('<a className="a hover:underline b">x</a>')).toHaveLength(1);
    expect(findings('<a className="underline-offset-2">x</a>')).toHaveLength(1);
    expect(findings('<s className="line-through decoration-2">x</s>')).toHaveLength(0);
    expect(findings('a { text-decoration: underline; }')).toHaveLength(1);
    expect(findings('a { text-underline-offset: 2px; }')).toHaveLength(1);
    expect(findings('<a className="no-underline hl-link">x</a>')).toHaveLength(0);
    expect(findings('a { text-decoration: none; }')).toHaveLength(0);
    expect(findings('/* hover:underline */\n// underline')).toHaveLength(0);
  });

  it.each(roots)('web/%s has none', (root) => {
    const hits = sources(path.join(webRoot, root)).flatMap((file) =>
      findings(readFileSync(file, 'utf8')).map((l) => `${path.relative(webRoot, file)}: ${l.trim()}`),
    );
    expect(hits).toEqual([]);
  });
});
