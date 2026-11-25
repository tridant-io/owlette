#!/usr/bin/env node
/**
 * check-no-token-logs (roost wave 5.10) — fails CI on any log call referencing an
 * auth token or credential. Tokens must never reach a log sink, not even
 * partially, in any path; a leak is a P0.
 *
 *   node scripts/check-no-token-logs.mjs          # scan repo
 *   node scripts/check-no-token-logs.mjs --test   # self-test against fixtures
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SCAN_ROOTS = [
  join(ROOT, 'web', 'app'),
  join(ROOT, 'web', 'components'),
  join(ROOT, 'web', 'hooks'),
  join(ROOT, 'web', 'lib'),
  join(ROOT, 'web', 'contexts'),
  join(ROOT, 'web', 'scripts'),
  join(ROOT, 'agent', 'src'),
  join(ROOT, 'scripts'),
];

const INCLUDE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py']);

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'out',
  'build',
  'dist',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.mypy_cache',
]);

// Word-boundary matched, and only inside a log call — so `authToken` catches but
// a `token_stream` parser identifier elsewhere does not.
const TOKEN_IDENTIFIERS = [
  'token',
  'tokens',
  'bearer',
  'authorization',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'apikey',
  'api_key',
  'x-api-key',
  'client_secret',
  'clientsecret',
  'authcode',
  'auth_code',
  'fernet',
  'private_key',
  'privatekey',
];

const TOKEN_WORD_RE = new RegExp(
  `\\b(${TOKEN_IDENTIFIERS.join('|')})\\b`,
  'i',
);

// order matters: longer prefixes first, else substrings double-match
const LOG_PATTERNS = [
  // javascript / typescript
  /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/,
  /\b(Sentry)\.(captureException|captureMessage|setContext|addBreadcrumb|setUser)\s*\(/,
  // python
  /\blogger\.(debug|info|warning|error|critical|exception|log)\s*\(/,
  /\blogging\.(debug|info|warning|error|critical|exception|log)\s*\(/,
  /\bprint\s*\(/,
];

// per-line opt-out marker; exempting has to be explicit
const ALLOW_COMMENT = 'no-token-logs-allow';

// Files skipped ENTIRELY — they name token identifiers as data, so scanning them
// is all noise.
const FILE_ALLOWLIST = new Set([
  // this file's own TOKEN_IDENTIFIERS array
  join('scripts', 'check-no-token-logs.mjs').replace(/\\/g, '/'),
  // declares no-restricted-syntax patterns using the same words
  join('web', 'eslint.config.mjs').replace(/\\/g, '/'),
]);

/**
 * Argument region of a log call, from `(` to the matching `)`, handling nested
 * parens and string literals. Single-line only: a multi-line call returns
 * whatever the first line held.
 */
function extractCallArgs(line, openIdx) {
  let depth = 0;
  let inStr = null; // the open quote char, or null
  let escape = false;
  for (let i = openIdx; i < line.length; i++) {
    const ch = line[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return line.slice(openIdx + 1, i);
      }
    }
  }
  // unbalanced on this line; cross-line detection is best-effort
  return line.slice(openIdx + 1);
}

/**
 * True when the argument region names a token identifier as an identifier.
 * String literals are stripped so `logger.info("oauth_token is a pattern")` is
 * clean, while `logger.info(f"oauth_token: {token}")` still trips — the
 * interpolated identifier survives stripping.
 */
function argsReferenceToken(argsText) {
  let stripped = argsText
    // python triple-quoted
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    // regular strings, escaped quotes allowed
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, '');

  // Template literals: drop the static text, KEEP ${...} contents. The char
  // class must allow `$` — excluding it made any interpolated literal
  // unmatchable and let its static text false-positive on the word "token".
  stripped = stripped.replace(
    /`((?:[^`\\]|\\.)*)`/g,
    (_full, inner) => {
      const exprMatches = [...inner.matchAll(/\$\{([^}]*)\}/g)];
      return exprMatches.map((m) => m[1]).join(' ');
    },
  );

  // f-strings: reparse the ORIGINAL argsText, the stripping above ate them
  const fstringMatches = [
    ...argsText.matchAll(/\bf["']((?:[^"'\\]|\\.)*)["']/g),
  ];
  for (const m of fstringMatches) {
    const exprs = [...m[1].matchAll(/\{([^}]*)\}/g)];
    for (const e of exprs) stripped += ' ' + e[1];
  }

  return TOKEN_WORD_RE.test(stripped);
}

function scanFile(absPath) {
  const relPath = relative(ROOT, absPath).replace(/\\/g, '/');
  if (FILE_ALLOWLIST.has(relPath)) return [];

  let text;
  try {
    text = readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const findings = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (line.includes(ALLOW_COMMENT)) continue;

    for (const pattern of LOG_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      const openIdx = line.indexOf('(', m.index);
      if (openIdx === -1) continue;
      const args = extractCallArgs(line, openIdx);
      if (argsReferenceToken(args)) {
        findings.push({
          file: relPath,
          line: lineNum + 1,
          snippet: line.trim().slice(0, 200),
        });
        break; // one finding per line
      }
    }
  }
  return findings;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
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
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot === -1) continue;
      if (INCLUDE_EXT.has(name.slice(dot))) out.push(full);
    }
  }
}

function runScan() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    if (existsSync(root)) walk(root, files);
  }
  const findings = [];
  for (const f of files) {
    findings.push(...scanFile(f));
  }
  return findings;
}

function runSelfTest() {
  // must flag
  const bad = [
    `console.log("access_token=" + accessToken);`,
    `console.error(\`auth failed for token=\${idToken}\`);`,
    `logger.debug(f"refresh_token: {refresh_token}")`,
    `logger.info("bearer", authorization)`,
    `print(access_token)`,
    `Sentry.captureMessage("user token", { extra: { token } });`,
  ];
  // must not flag
  const good = [
    `console.log("authenticated")`,
    `logger.info("login ok for user %s", userId)`,
    `logger.error("token refresh failed", exc_info=True)  // no-token-logs-allow`,
    `const pattern = "token stream parser";`,
    `// string mentions token but not in a log call`,
  ];

  let failures = 0;

  for (const line of bad) {
    let matched = false;
    for (const pat of LOG_PATTERNS) {
      const m = pat.exec(line);
      if (!m) continue;
      const openIdx = line.indexOf('(', m.index);
      if (openIdx === -1) continue;
      if (argsReferenceToken(extractCallArgs(line, openIdx))) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      console.error(`SELFTEST FAIL: expected flag on:\n  ${line}`);
      failures++;
    }
  }

  for (const line of good) {
    if (line.includes(ALLOW_COMMENT)) continue;
    let matched = false;
    for (const pat of LOG_PATTERNS) {
      const m = pat.exec(line);
      if (!m) continue;
      const openIdx = line.indexOf('(', m.index);
      if (openIdx === -1) continue;
      if (argsReferenceToken(extractCallArgs(line, openIdx))) {
        matched = true;
        break;
      }
    }
    if (matched) {
      console.error(`SELFTEST FAIL: false positive on:\n  ${line}`);
      failures++;
    }
  }

  if (failures === 0) {
    console.log('selftest: OK (6 must-flag + 5 must-pass fixtures)');
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    const failures = runSelfTest();
    process.exit(failures === 0 ? 0 : 1);
  }

  const findings = runScan();
  if (findings.length === 0) {
    console.log('no-token-logs: OK');
    process.exit(0);
  }

  console.error(
    `\nno-token-logs: FAILED — ${findings.length} potential token leak(s):\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.snippet}`);
  }
  console.error(
    `\nToken/credential references inside log/print calls are forbidden.`,
  );
  console.error(
    `If a finding is a genuine false positive (e.g. the "token" is the ` +
      `literal word, not a value), append "// ${ALLOW_COMMENT}" or ` +
      `"# ${ALLOW_COMMENT}" to that line.\n`,
  );
  process.exit(1);
}

main();
