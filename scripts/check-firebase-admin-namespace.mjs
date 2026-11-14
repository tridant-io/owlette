#!/usr/bin/env node
/**
 * Fail on the `firebase-admin` ROOT namespace under scripts/.
 *
 * firebase-admin 14 removed it. The root module now exports only
 * initializeApp/getApp/getApps/deleteApp/applicationDefault/cert/refreshToken,
 * so `admin.credential.cert(...)` and `admin.firestore()` are undefined and any
 * script using them throws the moment it authenticates.
 *
 * This exists because the v14 upgrade (a454e4cd) swept web/ and functions/ and
 * missed scripts/ and the since-removed e2e-machine/ entirely — 10 files stayed
 * broken for two weeks, including scripts/upload-cortex-cli.mjs, which is the
 * documented remedy for a hoot CLI failure the runbook labels SILENT per
 * machine. Nothing in CI runs any of them, so nothing noticed.
 *
 * web/ and functions/ are NOT scanned: they are covered by their own typecheck
 * and lint, and web/lib/firebase-admin.ts legitimately re-exports.
 *
 * Usage:
 *   node scripts/check-firebase-admin-namespace.mjs          scan the repo
 *   node scripts/check-firebase-admin-namespace.mjs --test   self-test
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['scripts'];
const EXTS = ['.mjs', '.js', '.cjs', '.ts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

// Root-namespace import only. A subpath import (firebase-admin/app,
// firebase-admin/firestore, ...) is the correct modern form and must pass.
const ROOT_IMPORT =
  /(?:require\(\s*['"]firebase-admin['"]\s*\)|from\s+['"]firebase-admin['"]|import\s+['"]firebase-admin['"])/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Findings for one file's text. Exported shape: [{ line, text }]. */
export function scanText(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const code = line.trim();
    // Comments describe the ban; they must not trip it.
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    if (ROOT_IMPORT.test(line)) hits.push({ line: i + 1, text: code });
  });
  return hits;
}

function selfTest() {
  const cases = [
    ["const admin = require('firebase-admin');", 1, 'cjs root require'],
    ['import admin from "firebase-admin";', 1, 'esm root default import'],
    ["const { initializeApp } = require('firebase-admin/app');", 0, 'subpath require'],
    ["import { getFirestore } from 'firebase-admin/firestore';", 0, 'subpath import'],
    ["// const admin = require('firebase-admin');", 0, 'commented out'],
    [" * so `admin.firestore()` from 'firebase-admin' is undefined", 0, 'jsdoc prose'],
  ];
  let failed = 0;
  for (const [src, expected, label] of cases) {
    const got = scanText(src).length;
    const ok = got === expected;
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} (expected ${expected}, got ${got})`);
  }
  if (failed) {
    console.error(`\nself-test failed: ${failed} case(s)`);
    process.exit(1);
  }
  console.log('\nself-test passed.');
}

if (process.argv.includes('--test')) {
  selfTest();
} else {
  const offenders = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      // This file's own self-test fixtures are literal examples of the ban.
      if (file === fileURLToPath(import.meta.url)) continue;
      for (const hit of scanText(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(ROOT, file).split(String.fromCharCode(92)).join('/')}:${hit.line}  ${hit.text}`);
      }
    }
  }
  if (offenders.length) {
    console.error('firebase-admin root namespace is not available in v14+:\n');
    for (const o of offenders) console.error(`  ${o}`);
    console.error(
      '\nUse the modular entry points instead:\n' +
        "  const { initializeApp, cert } = require('firebase-admin/app');\n" +
        "  const { getFirestore, FieldValue } = require('firebase-admin/firestore');\n" +
        "  const { getAuth } = require('firebase-admin/auth');\n" +
        "  const { getStorage } = require('firebase-admin/storage');\n" +
        'See scripts/migrations/backfill-site-owner-membership.mjs for a worked example.'
    );
    process.exit(1);
  }
  console.log('ok — no firebase-admin root-namespace usage under scripts/');
}
