/** @jest-environment node */

/**
 * Registry test for the swoop keys in `scripts/env-manifest.json`.
 *
 * The manifest is the canonical list of env var NAMES + metadata — values live only in
 * Railway and Vercel. `sync-env.mjs` reads `class` and `targets` from it: `class` decides
 * whether a value syncs to Vercel as `--sensitive`, and `targets` is what a coverage check
 * compares live state against.
 *
 * The failures this guards are both silent. (1) A key dropped from the registry, or parked
 * on `targets: []`, stops being reported as missing — `sync-env.mjs check` goes green while
 * the variable is absent from a deploy target, and the first symptom is a swoop session that
 * cannot be created in production. (2) A key material that lands on railway-prod but not
 * vercel-prod, or with a different value, breaks nothing until a failover: swoop JWTs minted
 * by the standby origin fail verification at the signaling worker, per-viewer keys derive
 * differently, and doorbell rings 401. `must-match` is what tells an operator (and the sync
 * tool) that those three are catastrophic-if-divergent, not merely secret.
 *
 * Node builtins + jest globals only. No import.meta — jest transpiles to CJS.
 */

import fs from 'node:fs';
import path from 'node:path';

// web/__tests__/infra -> web/__tests__ -> web -> repo root
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const manifestPath = path.join(repoRoot, 'scripts', 'env-manifest.json');

interface VarEntry {
  class: string;
  targets: string[];
  note?: string;
}

interface EnvManifest {
  targets: Record<string, unknown>;
  classes: Record<string, string>;
  vars: Record<string, VarEntry>;
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as EnvManifest;

/** Every deploy surface the web app runs on. swoop needs its keys on all three. */
const ALL_TARGETS: readonly string[] = ['railway-dev', 'railway-prod', 'vercel-prod'];

/** The eight keys swoop introduces, with the class each must carry. */
const SWOOP_VARS: ReadonlyArray<{ name: string; class: string }> = [
  { name: 'CLOUDFLARE_TURN_KEY_API_TOKEN', class: 'secret' },
  { name: 'CLOUDFLARE_TURN_KEY_ID', class: 'config' },
  { name: 'SWOOP_JWT_KID', class: 'config' },
  { name: 'SWOOP_JWT_PRIVATE_KEY', class: 'must-match' },
  { name: 'SWOOP_JWT_PUBLIC_KEY', class: 'config' },
  { name: 'SWOOP_SESSION_MASTER_KEY', class: 'must-match' },
  { name: 'SWOOP_SIGNAL_RING_SECRET', class: 'must-match' },
  { name: 'SWOOP_SIGNAL_URL', class: 'config' },
];

/** Byte-identical across the railway-prod/vercel-prod mirror, or failover breaks silently. */
const MUST_MATCH: readonly string[] = [
  'SWOOP_JWT_PRIVATE_KEY',
  'SWOOP_SESSION_MASTER_KEY',
  'SWOOP_SIGNAL_RING_SECRET',
];

/** Fields a registry entry may carry. Anything else risks being a value. */
const ALLOWED_ENTRY_FIELDS: readonly string[] = ['class', 'targets', 'note'];

describe('scripts/env-manifest.json — swoop keys', () => {
  it('registers all eight with the class each one needs', () => {
    const problems: string[] = [];
    for (const expected of SWOOP_VARS) {
      const entry = manifest.vars[expected.name];
      if (!entry) {
        problems.push(
          `${expected.name} — missing from "vars". swoop reads it server-side; an ` +
            'unregistered key is invisible to `sync-env.mjs check` and turns up as a ' +
            'production-only failure.',
        );
        continue;
      }
      if (entry.class !== expected.class) {
        problems.push(
          `${expected.name} — class is "${entry.class}", expected "${expected.class}"`,
        );
      }
      if (!manifest.classes[entry.class]) {
        problems.push(`${expected.name} — class "${entry.class}" is not defined in "classes"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('targets all three deploy surfaces, never an empty list', () => {
    // `targets: []` silences the drift report. These keys are unprovisioned until the
    // owner sets the values, and `check` listing them as missing IS the signal.
    const problems: string[] = [];
    for (const { name } of SWOOP_VARS) {
      const entry = manifest.vars[name];
      if (!entry) continue; // already reported above
      const declared = [...(entry.targets ?? [])].sort();
      if (declared.join(',') !== [...ALL_TARGETS].sort().join(',')) {
        problems.push(
          `${name} — targets are [${declared.join(', ')}], expected ` +
            `[${ALL_TARGETS.join(', ')}]. An empty or partial list hides the key from the ` +
            'coverage check instead of reporting it as missing.',
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('classifies the three catastrophic-on-mismatch keys as must-match, with a written reason', () => {
    const problems: string[] = [];
    for (const name of MUST_MATCH) {
      const entry = manifest.vars[name];
      if (!entry) continue; // already reported above
      if (entry.class !== 'must-match') {
        problems.push(
          `${name} — class is "${entry.class}". It is sensitive AND silently catastrophic ` +
            'if railway-prod and vercel-prod differ, which is what "must-match" means.',
        );
      }
      if (!entry.note || entry.note.trim().length < 20) {
        problems.push(
          `${name} — a must-match key carries a note saying what a mismatch breaks, so the ` +
            'next operator does not have to rediscover it during an outage.',
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('carries names and metadata only — never a value', () => {
    const problems: string[] = [];
    for (const { name } of SWOOP_VARS) {
      const entry = manifest.vars[name];
      if (!entry) continue; // already reported above
      for (const field of Object.keys(entry)) {
        if (!ALLOWED_ENTRY_FIELDS.includes(field)) {
          problems.push(
            `${name} — unexpected field "${field}". This file is checked into a public ` +
              `repo and holds ${ALLOWED_ENTRY_FIELDS.join('/')} only; values live in the ` +
              'hosting provider.',
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
