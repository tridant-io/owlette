/** @jest-environment node */

/**
 * eslint config test for `no-client-firestore-writes` (wave-2.1 "rule B").
 *
 * Reads `web/eslint.config.mjs` as TEXT rather than running eslint, matching the
 * precedent in `system-invoker-allowlist.test.ts` — flat config resolves the
 * @next plugin chain, which is heavyweight and flaky under jest.
 *
 * This replaces `__tests__/lib/authorizedHandler.eslint.test.ts`, deleted
 * 2026-09-07. That file spawned the eslint binary twice per `npm test` to assert
 * that NOTHING was flagged, and passed because the rules it named had never been
 * written — three of its five cases were `.skip`ped, and the two live ones
 * asserted absence. A test that reddens when the rule DISAPPEARS is the property
 * it lacked, and the only one worth having here.
 */

import { readFileSync } from 'fs';
import path from 'path';

const ESLINT_CONFIG_PATH = path.join(__dirname, '..', '..', 'eslint.config.mjs');

describe('eslint config — no client-side firestore writes', () => {
  let configText: string;

  beforeAll(() => {
    configText = readFileSync(ESLINT_CONFIG_PATH, 'utf8');
  });

  it('declares the client-write selector against firebase/firestore', () => {
    expect(configText).toMatch(/noClientFirestoreWritesRule/);
    expect(configText).toMatch(/ImportDeclaration\[source\.value='firebase\/firestore'\]/);
  });

  it('covers every client write primitive', () => {
    for (const fn of [
      'setDoc',
      'updateDoc',
      'deleteDoc',
      'addDoc',
      'writeBatch',
      'runTransaction',
    ]) {
      expect(configText).toContain(fn);
    }
  });

  it('applies the rule globally, not only to an opt-in glob', () => {
    // other global selectors may follow (the raw-palette guardrail does)
    expect(configText).toMatch(
      /"no-restricted-syntax":\s*\["error",\s*noTokenLogsRule,\s*noClientFirestoreWritesRule[,\]]/,
    );
  });

  it('allowlists exactly the server paths and the per-device preference hooks', () => {
    for (const allowed of [
      '"app/api/**/*.{ts,tsx}"',
      '"lib/**/*.server.ts"',
      '"contexts/AuthContext.tsx"',
      '"hooks/useDevicePrefs.ts"',
      '"hooks/useDevicePrefFlag.ts"',
      '"hooks/useHoot.ts"',
      '"hooks/useHootSidebarPrefs.ts"',
    ]) {
      expect(configText).toContain(allowed);
    }
  });

  it('re-declares the token-log guard inside the allowlist override', () => {
    // THE regression this file exists to catch. Flat-config rule OPTIONS replace
    // rather than merge, so an override that omits `noTokenLogsRule` silently
    // disables the token-logging guard for app/api/** and lib/**/*.server.ts —
    // the files that actually handle tokens. Green here is load-bearing.
    expect(configText).toMatch(
      /rules:\s*\{\s*"no-restricted-syntax":\s*\["error",\s*noTokenLogsRule\]\s*\}/,
    );
  });

  it('does not claim a rule A that was deliberately never written', () => {
    // Rule A ("no raw route exports under app/api/**") would flag 127 of 186
    // route files: this repo has two sanctioned authorization paths and ~75
    // routes on neither by design. The reason is recorded in the config so the
    // next reader does not refile it as missing work.
    expect(configText).toMatch(/Rule A of that pair/);
  });
});
