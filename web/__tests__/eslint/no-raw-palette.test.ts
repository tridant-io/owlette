/** @jest-environment node */

/**
 * eslint config test for the raw-palette guardrail (light mode, task 5.2).
 *
 * Like the other eslint config tests this reads `web/eslint.config.mjs` as text
 * (loading the flat config pulls in the @next plugin chain), but it runs the
 * config's own RAW_PALETTE through eslint's Linter, so it proves what the rule
 * catches and lets through, not only that it is declared.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { Linter } from 'eslint';

const configText = readFileSync(path.join(__dirname, '..', '..', 'eslint.config.mjs'), 'utf8');

// the pattern as the config writes it: a js string literal, read the same way
const declared = configText.match(/const RAW_PALETTE =\s*("(?:[^"\\]|\\.)*");/);
const RAW_PALETTE: string = declared ? JSON.parse(declared[1]) : '';

function rawPaletteFindings(code: string): number {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, {
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=/${RAW_PALETTE}/]`, message: 'raw' },
        { selector: `TemplateElement[value.raw=/${RAW_PALETTE}/]`, message: 'raw' },
      ],
    },
  }).length;
}

describe('eslint config — no raw palette colours', () => {
  it('declares the pattern and builds both selectors from it', () => {
    expect(RAW_PALETTE).not.toBe('');
    expect(configText).toContain('selector: `Literal[value=/${RAW_PALETTE}/]`');
    expect(configText).toContain('selector: `TemplateElement[value.raw=/${RAW_PALETTE}/]`');
  });

  it('applies to the web source, while server code and tests keep raw colour', () => {
    expect(configText).toMatch(
      /"no-restricted-syntax":\s*\["error",\s*noTokenLogsRule,\s*noClientFirestoreWritesRule,\s*\.\.\.noRawPaletteRules\]/,
    );
    // the server and test allowlist block repeats only the token-log rule
    expect(configText).toMatch(/rules: \{ "no-restricted-syntax": \["error", noTokenLogsRule\] \}/);
  });

  it.each([
    ['a palette colour', '<div className="text-red-400" />'],
    ['one behind a variant', '<div className="p-2 hover:text-red-400" />'],
    ['a tinted fill', '<div className="dark:bg-emerald-950/30" />'],
    ['white text', '<div className="text-white" />'],
    ['white at an alpha', '<div className="text-white/70" />'],
    ['ink on cyan', '<div className="text-gray-900" />'],
    ['one inside a template literal', 'const c = `p-2 ${on} bg-amber-500`;'],
  ])('flags %s', (_name, code) => {
    expect(rawPaletteFindings(code)).toBe(1);
  });

  it.each([
    ['a status token', '<div className="text-danger" />'],
    ['a translucent token', '<div className="bg-accent-cyan/10 text-accent-warm" />'],
    ['a block token', '<div className="bg-block-2 text-block-2-ink" />'],
    ['a scrim', '<div className="bg-black/50" />'],
    ['a token in a template literal', 'const c = `p-2 ${on} bg-warning-surface`;'],
  ])('lets %s through', (_name, code) => {
    expect(rawPaletteFindings(code)).toBe(0);
  });
});
