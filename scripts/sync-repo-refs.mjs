#!/usr/bin/env node
/**
 * Propagate the canonical GitHub owner/repo from the root package.json
 * `repository.url` into every tracked file that references it.
 *
 *   node scripts/sync-repo-refs.mjs           # rewrite files that are out of date
 *   node scripts/sync-repo-refs.mjs --check   # exit 1 if anything is stale (CI)
 *
 * `repository` is the canonical source because npm already requires it: publishing
 * with `--provenance` fails unless it matches the source repo, case-sensitively.
 *
 * Deliberately NOT derived from `git remote get-url origin`. Origin says where a
 * given clone came from, which is a different question — a fork's CI would rewrite
 * every file to the fork's slug, and these values are committed, shipped text
 * (Cargo.toml, the installer, the browser bundle, the npm README) that has to be
 * right in the tree with no git available.
 *
 * Web code should import from `web/lib/repoLinks.ts` rather than spelling the
 * owner out; this script exists for the places that can't import TypeScript —
 * Cargo.toml, the Inno Setup script, docs MDX, and the workflow examples that
 * customers copy verbatim.
 *
 * On a repository transfer the whole change is: edit the root package.json
 * `repository.url`, run this, commit.
 *
 * Note: the matcher keys off the repository *name* (`owlette`), so it rewrites
 * any owner that precedes it. If the repo is ever renamed as well as moved,
 * update REPO_NAME_PATTERN below in the same commit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Repo names this script is willing to rewrite the owner in front of. */
const REPO_NAME_PATTERN = 'owlette';

const SCAN_ROOTS = [
  '.github',
  'agent',
  'cli',
  'desktop',
  'docs',
  'e2e-machine',
  'examples',
  'functions',
  'infra',
  'monitoring',
  'scripts',
  'sdks',
  'site',
  'web',
];

// Root-level files only; `roadmap.md` now lives under the `docs` scan root.
const SCAN_FILES = ['README.md', 'SECURITY.md'];

const EXTENSIONS = new Set([
  '.bat',
  '.iss',
  '.md',
  '.mdx',
  '.mjs',
  '.ps1',
  '.py',
  '.rs',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

/**
 * Never rewritten:
 * - `dev/` holds historical agent/review transcripts — rewriting them would
 *   falsify a record of what was actually run.
 * - `.claude/` documents external resources whose names only look like a repo
 *   slug (the Vercel project is `theexperiential/owlette` regardless of where
 *   the GitHub repo lives).
 * - lockfiles and build output are generated.
 */
const EXCLUDED_DIRS = new Set([
  '.claude',
  '.git',
  '.next',
  '.next-e2e',
  '.source',
  'build',
  'coverage',
  'dev',
  'dist',
  'node_modules',
  'out',
  'target',
  'test-results',
]);

const EXCLUDED_FILES = new Set(['Cargo.lock', 'package-lock.json']);

const PACKAGE_JSONS = ['package.json', 'cli/package.json', 'sdks/node/package.json'];

function readCanonical() {
  const file = path.join(ROOT, 'package.json');
  const url = JSON.parse(fs.readFileSync(file, 'utf8')).repository?.url;
  const match =
    /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(
      url ?? '',
    );
  if (!match) {
    console.error(
      `package.json "repository.url" must be a github.com URL; found: ${JSON.stringify(url)}`,
    );
    process.exit(1);
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * npm matches `repository.url` against the publishing repo case-sensitively when
 * generating provenance, so the published packages are synced too.
 */
function syncPackageJsons({ owner, repo }, apply) {
  const changed = [];
  for (const rel of PACKAGE_JSONS) {
    const file = path.join(ROOT, rel);
    const before = fs.readFileSync(file, 'utf8');
    // `repository.url` (the form npm checks for provenance) and `bugs.url`, which
    // carries the same slug in a plain https form the generic rules never see
    // because `.json` is outside EXTENSIONS.
    const after = before
      .replace(/(git\+https:\/\/github\.com\/)[^"]*?(\.git")/g, `$1${owner}/${repo}$2`)
      .replace(
        new RegExp(`(https://github\\.com/)[A-Za-z0-9-]+/${REPO_NAME_PATTERN}(/issues")`, 'g'),
        `$1${owner}/${repo}$2`,
      );
    if (after === before) continue;
    if (apply) fs.writeFileSync(file, after, 'utf8');
    changed.push(rel);
  }
  return changed;
}

/**
 * The three shapes an owner/repo reference takes in this codebase:
 *   1. https://github.com/<owner>/<repo>       links, clone URLs, Cargo `repository`
 *   2. <owner>.github.io/<repo>                the published docs host
 *   3. uses: <owner>/<repo>/.github/actions/…  composite action refs
 * Owner is matched permissively so a half-finished transfer still converges.
 */
function buildRules({ owner, repo }) {
  const name = REPO_NAME_PATTERN;
  const ownerChars = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
  return [
    {
      find: new RegExp(`(github\\.com/)${ownerChars}/${name}\\b`, 'gi'),
      replace: `$1${owner}/${repo}`,
    },
    {
      find: new RegExp(`${ownerChars}\\.github\\.io/${name}\\b`, 'gi'),
      replace: `${owner}.github.io/${repo}`,
    },
    {
      find: new RegExp(`(^|[\\s"'\`])${ownerChars}/${name}/\\.github/`, 'g'),
      replace: `$1${owner}/${repo}/.github/`,
    },
  ];
}

/** `web/lib/repoLinks.ts` owns the constants the web app imports. */
function syncRepoLinks({ owner, repo }, apply) {
  const file = path.join(ROOT, 'web', 'lib', 'repoLinks.ts');
  const before = fs.readFileSync(file, 'utf8');
  const after = before
    .replace(/(export const GITHUB_OWNER = ')[^']*(')/, `$1${owner}$2`)
    .replace(/(export const GITHUB_REPO = ')[^']*(')/, `$1${repo}$2`);
  if (after === before) return null;
  if (apply) fs.writeFileSync(file, after, 'utf8');
  return path.relative(ROOT, file);
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      if (!EXTENSIONS.has(path.extname(entry.name))) continue;
      yield path.join(dir, entry.name);
    }
  }
}

function collectFiles() {
  const files = [];
  for (const rel of SCAN_ROOTS) files.push(...walk(path.join(ROOT, rel)));
  for (const rel of SCAN_FILES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) files.push(abs);
  }
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const canonical = readCanonical();
  const rules = buildRules(canonical);
  const changed = [];

  const linksChange = syncRepoLinks(canonical, !check);
  if (linksChange) changed.push(linksChange.replace(/\\/g, '/'));
  changed.push(...syncPackageJsons(canonical, !check));

  for (const file of collectFiles()) {
    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    for (const { find, replace } of rules) after = after.replace(find, replace);
    if (after === before) continue;
    if (!check) fs.writeFileSync(file, after, 'utf8');
    changed.push(path.relative(ROOT, file).replace(/\\/g, '/'));
  }

  const slug = `${canonical.owner}/${canonical.repo}`;

  if (changed.length === 0) {
    console.log(`✅ All repo references already point at ${slug}`);
    return;
  }

  if (check) {
    console.error(
      `❌ ${changed.length} file(s) do not match ${slug} (from package.json "repository.url"):`,
    );
    for (const file of changed) console.error(`   ${file}`);
    console.error('\nRun: node scripts/sync-repo-refs.mjs');
    process.exit(1);
  }

  console.log(`✨ Updated ${changed.length} file(s) → ${slug}`);
  for (const file of changed) console.log(`   ${file}`);
}

main();
