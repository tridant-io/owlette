#!/usr/bin/env node
/**
 * Security preflight: no unaddressed vulnerability alert on this checkout.
 *
 * Owlette's problem is not that GitHub is quiet — it is that GitHub is loud in
 * the wrong place. Dependabot raises *security* alerts and PRs against the
 * default branch (`main`), which trails `dev` by hundreds of commits, and
 * `target-branch` in `.github/dependabot.yml` does not apply to them. So the
 * alert list is a mix of three things that look identical in the UI:
 *
 *   1. genuinely vulnerable code that is still shipping           -> BLOCK
 *   2. already fixed on `dev`, still open because `main` is stale -> warn
 *   3. filed against a manifest this branch no longer has         -> re-resolved
 *      against every sibling manifest of the same ecosystem before it is
 *      allowed to warn (a workspace that moved is not a dependency that left)
 *
 * In September 2026 that mix reached 39 open alerts, of which 5 were real and
 * two were an unauthenticated RCE in Next.js. Nobody could tell, so nobody
 * looked. This script tells them apart by resolving every open alert against
 * the lockfiles *in this working tree* rather than trusting the alert's state.
 *
 * Fails CLOSED, and that is load-bearing: anything unreadable — a malformed
 * range, an unrecognised lockfile shape, an unknown ecosystem, a throttled API
 * call — BLOCKS. It must never be possible for a parser limitation to read as
 * "safe"; every such path is covered by a negative control in --test.
 *
 * GitHub's feed is not the only source. `npm audit` runs over production
 * dependencies as an independent check, because the alert feed's recall lags:
 * measured 2026-09-12, a published high-severity js-yaml advisory had no alert
 * four days on while npm audit flagged it immediately.
 *
 * Usage:
 *   node scripts/check-security-alerts.mjs [--ack "KEY=reason"[,...]] [--json]
 *                                          [--repo OWNER/NAME] [--stale-days N]
 *                                          [--no-audit]
 *   node scripts/check-security-alerts.mjs --test      # self-test, no network
 *
 * Every --ack needs a written reason, and it is echoed in the verdict so it can
 * be pasted into the release commit body. `verify:*` keys are NOT ackable: a
 * check that could not run must be fixed, never waived.
 *
 * Exit: 0 = clear (or every blocker acknowledged), 1 = blocked.
 * Needs: an authenticated `gh` CLI, run from anywhere inside the checkout.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 120_000;

/** A Dependabot PR left open longer than this is itself a blocker. */
const DEFAULT_STALE_DAYS = 30;

/** Alert severities that block even when only reachable in a dev dependency. */
const BLOCKING_SEVERITIES = new Set(['critical', 'high', 'medium', 'moderate', 'low']);

class CheckError extends Error {}

// ---------------------------------------------------------------------------
// version ranges
//
// GitHub's `vulnerable_version_range` is a deliberately small grammar: a
// comma-separated list of `<op> <version>` comparators, ANDed together
// (e.g. ">= 16.0.0, < 16.3.3", "<= 1.7.0", "< 0.35.4", "= 1.2.3"). It is not
// npm range syntax — no carets, no `||`. Parsing it directly keeps this script
// dependency-free, which is what lets the CI job run on a bare checkout.
// ---------------------------------------------------------------------------

/** Split a version into numeric release parts plus a prerelease tag. */
function parseVersion(raw) {
  const text = String(raw).trim().replace(/^[=vV]+/, '');
  // Strip build metadata first: semver says it is not part of precedence, and
  // treating `+build.5` as a fourth release part made 1.0.0+build.5 sort above
  // 1.0.0. Split the prerelease on the FIRST hyphen only, keeping the whole
  // remainder ("rc-1" must not truncate to "rc").
  const core0 = text.split('+')[0];
  const hyphen = core0.indexOf('-');
  const core = hyphen === -1 ? core0 : core0.slice(0, hyphen);
  const prerelease = hyphen === -1 ? '' : core0.slice(hyphen + 1);
  const parts = core.split('.').map((n) => {
    const v = Number.parseInt(n, 10);
    return Number.isNaN(v) ? 0 : v;
  });
  while (parts.length < 3) parts.push(0);
  return { parts, prerelease };
}

/**
 * Semver prerelease precedence: dot-separated identifiers, compared left to
 * right; all-numeric identifiers compare numerically (so rc.10 > rc.9 — plain
 * string compare got this backwards), numeric sorts below alphanumeric, and a
 * longer identifier list wins when all earlier ones are equal.
 */
function comparePrerelease(a, b) {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    if (pa[i] === pb[i]) continue;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Compare two versions: -1, 0, or 1. A prerelease sorts below its release. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (va.prerelease === vb.prerelease) return 0;
  if (va.prerelease === '') return 1; // 1.0.0 > 1.0.0-rc.1
  if (vb.prerelease === '') return -1;
  return comparePrerelease(va.prerelease, vb.prerelease);
}

/** Does `version` satisfy every comparator in a GitHub vulnerable range? */
export function inVulnerableRange(version, range) {
  // An absent or empty range is not "not vulnerable" — it is a range we failed
  // to read. Throwing routes it to the caller's catch, which blocks. Returning
  // false here would silently clear the alert.
  if (!range || !String(range).trim()) throw new CheckError('alert carries no vulnerable_version_range');
  const clauses = String(range).split(',').map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) throw new CheckError(`unparseable vulnerable range: "${range}"`);
  for (const clause of clauses) {
    // The operand must be a whole version, not merely start like one: `^0.18.0`
    // and `~> 1.2` used to parse as an equality against a mangled number.
    const match = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(clause);
    if (!match) throw new CheckError(`unparseable version clause: "${clause}" in range "${range}"`);
    const op = match[1] ?? '=';
    const cmp = compareVersions(version, match[2].trim());
    const ok =
      (op === '>=' && cmp >= 0) ||
      (op === '<=' && cmp <= 0) ||
      (op === '>' && cmp > 0) ||
      (op === '<' && cmp < 0) ||
      (op === '=' && cmp === 0);
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// resolving an alert against THIS checkout
// ---------------------------------------------------------------------------

/** Every version of `pkg` pinned by an npm lockfile (v2/v3 `packages` map). */
function npmVersions(text, pkg) {
  const lock = JSON.parse(text);
  // A lockfile whose shape we do not understand must not read as "the package
  // isn't here". v1 lockfiles use `dependencies`; a manifest (package.json)
  // filed as the alert's manifest_path has neither. Both used to yield [].
  if (!lock || typeof lock.packages !== 'object' || lock.packages === null) {
    throw new CheckError('not an npm lockfile with a "packages" map (v1 lockfile or a bare package.json?)');
  }
  const suffix = `node_modules/${pkg}`;
  const found = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if ((path === suffix || path.endsWith(`/${suffix}`)) && entry?.version) {
      found.push(entry.version);
    }
  }
  // A workspace root can also declare the package as its own name/version.
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (entry?.name === pkg && entry?.version && !path.includes('node_modules')) {
      found.push(entry.version);
    }
  }
  return [...new Set(found)];
}

/** Every version of `crate` pinned by a Cargo.lock. */
function cargoVersions(text, crate) {
  const found = [];
  const blocks = text.split(/\[\[package\]\]/);
  for (const block of blocks) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block);
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block);
    if (name && version && name[1] === crate) found.push(version[1]);
  }
  return [...new Set(found)];
}

/**
 * Versions of `pkg` pinned by a pip requirements file. Only `==` pins are a
 * known version; a `>=` floor is reported as unknown so it never reads as
 * safe on a guess.
 */
function pipVersions(text, pkg) {
  const found = [];
  let loose = false;
  const normalize = (s) => s.toLowerCase().replace(/[-_.]+/g, '-');
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.split('#')[0].trim();
    if (!line) continue;
    // pyproject.toml / PEP 621 state dependencies as quoted strings inside an
    // array: `  "pytest>=8.0",`. Without unwrapping the quote and comma the
    // name never matched, every package in sdks/python read as absent, and the
    // alert resolved 'gone' — a silent pass on a manifest Dependabot watches.
    line = line.replace(/,\s*$/, '').replace(/^["']/, '').replace(/["']$/, '').trim();
    if (!line) continue;
    // A requirements include (`-r other.txt`) pulls in pins we are not reading.
    if (/^-{1,2}r\b/.test(line) || /^--requirement\b/.test(line)) { loose = true; continue; }
    if (line.startsWith('-')) continue; // other pip flags (--hash, --index-url)
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (!match) continue;
    if (normalize(match[1]) !== normalize(pkg)) {
      // A VCS/URL requirement can name the package only in an #egg= fragment.
      if (/^(git|hg|svn|bzr)\+|^https?:\/\//.test(line) && new RegExp(`[#&]egg=${pkg}(\\b|$)`, 'i').test(line)) loose = true;
      continue;
    }
    const pinned = /==\s*([A-Za-z0-9][A-Za-z0-9.!+*-]*)/.exec(match[3]);
    // `==1.2.*` is a wildcard, not a single version — it cannot be compared.
    if (pinned && !pinned[1].includes('*')) found.push(pinned[1]);
    else loose = true;
  }
  return { versions: [...new Set(found)], loose };
}

/**
 * Resolve one alert against the working tree.
 * Returns { state, versions } where state is one of:
 *   'live'      - a pinned version falls inside the vulnerable range
 *   'fixed'     - the manifest is here and no pinned version is vulnerable
 *   'gone'      - the manifest is here but no longer pins the package at all
 *   'orphaned'  - the manifest does not exist on this branch
 *   'unknown'   - present but unpinned, or an ecosystem we cannot resolve
 */
export function resolveAlert(alert, { root = REPO_ROOT, readFile = readFileSync, exists = existsSync } = {}) {
  const dep = alert?.dependency ?? {};
  const manifest = dep.manifest_path;
  const pkg = dep.package?.name;
  const ecosystem = (dep.package?.ecosystem ?? '').toLowerCase();
  const range = alert?.security_vulnerability?.vulnerable_version_range;

  if (!manifest || !pkg) throw new CheckError('alert is missing a package or manifest path');

  const full = join(root, manifest);
  if (!exists(full)) return { state: 'orphaned', versions: [] };

  const text = readFile(full, 'utf8');
  let versions = [];
  let loose = false;

  if (ecosystem === 'npm') {
    versions = npmVersions(text, pkg);
  } else if (ecosystem === 'rust' || ecosystem === 'cargo') {
    versions = cargoVersions(text, pkg);
  } else if (ecosystem === 'pip') {
    ({ versions, loose } = pipVersions(text, pkg));
  } else {
    // github-actions and anything new: we cannot resolve it, so we do not get
    // to call it safe.
    return { state: 'unknown', versions: [] };
  }

  if (versions.length === 0) return { state: loose ? 'unknown' : 'gone', versions: [] };

  const vulnerable = versions.filter((v) => inVulnerableRange(v, range));
  if (vulnerable.length > 0) return { state: 'live', versions: vulnerable };
  if (loose) return { state: 'unknown', versions };
  return { state: 'fixed', versions };
}

/** Every manifest in the tree that could pin a package of the given ecosystem. */
const ECOSYSTEM_MANIFESTS = {
  npm: ['package-lock.json', 'web/package-lock.json', 'functions/package-lock.json', 'desktop/package-lock.json'],
  rust: ['agent/host/Cargo.lock', 'desktop/src-tauri/Cargo.lock'],
  cargo: ['agent/host/Cargo.lock', 'desktop/src-tauri/Cargo.lock'],
  pip: ['agent/requirements.txt', 'agent/requirements-dev.txt', 'sdks/python/pyproject.toml',
    'test/integration/requirements.txt', 'test/infra/agent-runner/requirements.txt'],
};

/**
 * An alert's manifest is gone from this branch. Before calling that harmless,
 * look for the package in every other manifest of the same ecosystem — a
 * deleted lockfile usually means the workspace moved, not that the dependency
 * left. Returns which manifests pin it vulnerably and which pin it patched.
 */
function resolveElsewhere(alert, opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const ecosystem = (alert?.dependency?.package?.ecosystem ?? '').toLowerCase();
  const manifests = ECOSYSTEM_MANIFESTS[ecosystem] ?? [];
  const live = [];
  const fixed = [];
  for (const manifest of manifests) {
    let probe;
    try {
      probe = resolveAlert({ ...alert, dependency: { ...alert.dependency, manifest_path: manifest } }, opts);
    } catch {
      continue; // an unreadable sibling is not evidence either way
    }
    if (probe.state === 'live') live.push(`${manifest} (${probe.versions.join(', ')})`);
    else if (probe.state === 'fixed') fixed.push(`${manifest} (${probe.versions.join(', ')})`);
  }
  return { live, fixed };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n')[0];
    throw new CheckError(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${detail.slice(0, 300)}`);
  }
}

function ghJson(args) {
  const out = run('gh', args);
  if (!out.trim()) return null;
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new CheckError(`gh ${args.slice(0, 2).join(' ')}: unparseable output (${err.message})`);
  }
}

const finding = (level, key, text) => ({ level, key, text });

function checkDependabotAlerts(repo, findings, alertedPackages) {
  let alerts;
  try {
    alerts = ghJson(['api', '--paginate', `repos/${repo}/dependabot/alerts?state=open&per_page=100`]);
  } catch (err) {
    findings.push(finding('block', 'verify:dependabot', `could not read Dependabot alerts: ${err.message}`));
    return;
  }
  if (!Array.isArray(alerts)) {
    findings.push(finding('block', 'verify:dependabot', 'unexpected Dependabot alerts response'));
    return;
  }
  for (const alert of alerts) {
    const number = alert?.number;
    const advisory = alert?.security_advisory ?? {};
    const severity = (advisory.severity ?? '?').toLowerCase();
    const pkg = alert?.dependency?.package?.name ?? '?';
    const manifest = alert?.dependency?.manifest_path ?? '?';
    const fixedIn = alert?.security_vulnerability?.first_patched_version?.identifier ?? 'no patched release';
    const key = `alert:dependabot:${number}`;

    let resolved;
    try {
      resolved = resolveAlert(alert);
    } catch (err) {
      findings.push(finding('block', key, `could not resolve alert #${number} (${pkg}): ${err.message}`));
      continue;
    }

    const where = `${pkg} in ${manifest}`;
    const what = `[${severity}] ${where} -> fix ${fixedIn}: ${advisory.summary ?? ''}`;
    // Only an alert that is still live HERE makes a pending PR for that package
    // urgent. An alert left open because `main` is stale does not.
    // Arm the stale-security-PR rule only for packages this branch cannot show
    // to be safe. An orphaned alert whose package resolves patched in a sibling
    // manifest is settled, and must not make a superseded PR look urgent.
    const arms = resolved.state === 'live' || resolved.state === 'unknown' || resolved.state === 'gone';
    if (arms && pkg !== '?') alertedPackages.add(pkg);

    if (resolved.state === 'live') {
      // Unconditionally. Severity is reported, never used to excuse a live
      // pin: an unrecognised severity string used to fall past every branch
      // and land in the final else, warning with the wrong text entirely.
      const note = BLOCKING_SEVERITIES.has(severity) ? '' : ' (unrecognised severity — blocking anyway)';
      findings.push(finding('block', key, `LIVE on this branch (${resolved.versions.join(', ')})${note} ${what}`));
    } else if (resolved.state === 'unknown') {
      findings.push(finding('block', key, `UNRESOLVED — cannot prove this branch is safe. ${what}`));
    } else if (resolved.state === 'gone') {
      // The manifest parsed but does not pin the package. That is not proof of
      // safety — it is what every parser limitation looks like from here.
      findings.push(finding('block', key, `UNPROVEN — ${manifest} parsed but pins no ${pkg}; cannot confirm this branch is safe. ${what}`));
    } else if (resolved.state === 'orphaned') {
      // The manifest is gone from this branch, but the package may simply have
      // moved (cli/ and sdks/node/ became root workspaces in 1b30cc11). Re-resolve
      // against every other same-ecosystem manifest before downgrading.
      const elsewhere = resolveElsewhere(alert);
      if (elsewhere.live.length > 0 && pkg !== '?') alertedPackages.add(pkg);
      if (elsewhere.live.length > 0) {
        findings.push(finding('block', key, `LIVE elsewhere on this branch — ${manifest} is gone, but ${elsewhere.live.join('; ')} still pins a vulnerable version. ${what}`));
      } else if (elsewhere.fixed.length > 0) {
        findings.push(finding('warn', key, `${manifest} does not exist on this branch; ${pkg} resolved patched in ${elsewhere.fixed.join('; ')}. ${what}`));
      } else {
        findings.push(finding('warn', key, `${manifest} does not exist on this branch and ${pkg} appears in no other manifest. ${what}`));
      }
    } else {
      findings.push(finding('warn', key, `fixed here (${resolved.versions.join(', ')}), still open on the default branch — clears when dev reaches main. ${what}`));
    }
  }
}

function checkScanningAlerts(repo, findings, branch, gitRef) {
  for (const kind of ['code-scanning', 'secret-scanning']) {
    let alerts;
    // Code scanning is per-ref and DEFAULTS TO THE DEFAULT BRANCH. Asking
    // without `ref` returned main's alerts on every branch, so 14 open CodeQL
    // alerts on dev (10 of them high) were invisible to this gate entirely.
    // Secret scanning is repo-wide and takes no ref.
    const refParam = kind === 'code-scanning' && gitRef ? `&ref=${encodeURIComponent(gitRef)}` : '';
    try {
      alerts = ghJson(['api', '--paginate', `repos/${repo}/${kind}/alerts?state=open&per_page=100${refParam}`]);
    } catch (err) {
      // A repo with the feature switched off answers 404; that is not a finding.
      //
      // A 403 on SECRET scanning is a platform limit, not a broken check: there
      // is no GITHUB_TOKEN permission key that grants it, so in Actions this
      // feed can never be read. Blocking on a condition nobody can satisfy
      // would pin the gate red forever, which is the failure this whole script
      // exists to prevent. Push protection is the live control there anyway;
      // this read was only ever a backstop. Everything else still fails closed.
      const unreadable = /403|not accessible/i.test(err.message);
      if (/404|not enabled|disabled/i.test(err.message) || (kind === 'secret-scanning' && unreadable)) {
        findings.push(finding('warn', `verify:${kind}`,
          `${kind} not checked (${err.message.includes('403') ? 'GITHUB_TOKEN cannot read this feed' : 'feature disabled or absent'}) `
          + '— review it on github.com/security by hand.'));
        continue;
      }
      findings.push(finding('block', `verify:${kind}`, `could not read ${kind} alerts: ${err.message}`));
      continue;
    }
    if (!Array.isArray(alerts)) continue;
    // Zero alerts means "clean" only if an analysis actually exists for this
    // ref. A branch CodeQL has never scanned answers identically to one with
    // nothing wrong — which is the precise confusion this whole script exists
    // to remove, so say which it is.
    if (kind === 'code-scanning' && alerts.length === 0 && gitRef) {
      let analyses = null;
      try {
        analyses = ghJson(['api', `repos/${repo}/code-scanning/analyses?ref=${encodeURIComponent(gitRef)}&per_page=1`]);
      } catch { /* 403/404 handled as a warning below */ }
      if (!Array.isArray(analyses) || analyses.length === 0) {
        findings.push(finding('warn', 'verify:code-scanning-coverage',
          `no code-scanning analysis exists for ${gitRef} — SAST has not run on this ref, so "no alerts" is not evidence of anything. `
          + 'It will be graded once this lands on a scanned branch (dev/main).'));
      }
    }
    for (const alert of alerts) {
      const label =
        kind === 'code-scanning'
          ? `${alert?.rule?.id ?? '?'} in ${alert?.most_recent_instance?.location?.path ?? '?'}`
          : (alert?.secret_type_display_name ?? alert?.secret_type ?? '?');
      // The query is already scoped to this ref, so everything returned is
      // evidence about this branch. Severity decides the level: CodeQL's
      // security_severity_level for real findings, and `warning`-class lint
      // (zizmor's ref-version-mismatch) is reported without blocking a release.
      const sev = (alert?.rule?.security_severity_level ?? '').toLowerCase();
      const blocking = kind === 'secret-scanning' || sev === 'critical' || sev === 'high';
      const tag = sev ? `[${sev}] ` : '';
      findings.push(finding(blocking ? 'block' : 'warn', `alert:${kind}:${alert?.number}`,
        `open ${kind} alert: ${tag}${label} ${alert?.html_url ?? ''}`));
    }
  }
}

function checkAdvisories(repo, findings) {
  for (const state of ['triage', 'draft']) {
    let items;
    try {
      items = ghJson(['api', '--paginate', `repos/${repo}/security-advisories?state=${state}&per_page=100`]);
    } catch (err) {
      if (/404/i.test(err.message)) continue;
      // Repository advisories are the one feed the Actions GITHUB_TOKEN cannot
      // read (there is no permission key for them), so a 403 in CI is a token
      // limit, not a hidden advisory. Surface it as a warning to be checked by
      // hand rather than wedging the job permanently red.
      const level = /403|not accessible/i.test(err.message) ? 'warn' : 'block';
      findings.push(finding(level, `verify:advisory-${state}`,
        `could not read ${state} advisories (check github.com by hand): ${err.message}`));
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const adv of items) {
      findings.push(finding('block', `advisory:${adv?.ghsa_id}`, `${state} security advisory ${adv?.ghsa_id}: ${adv?.summary ?? ''} ${adv?.html_url ?? ''}`));
    }
  }
}

const DEPENDABOT_LOGINS = new Set(['app/dependabot', 'dependabot', 'dependabot[bot]']);

/**
 * @param alertedPackages packages that currently have an open Dependabot alert.
 *
 * Owlette's Dependabot PRs target `main` and land on `dev` by hand, so an open
 * one is normal and a backlog of major-version bumps (eslint 10, @types/node
 * 26) is a deliberate, reviewed queue — not a security problem. Blocking on
 * those would keep this gate permanently red, which is precisely how a gate
 * stops being read.
 *
 * So the rule is narrower and means something: a stale PR blocks only when it
 * carries a fix for a package that still has an OPEN security alert. That is a
 * real fix rotting in a queue. Everything else ages as a warning.
 */
function checkDependabotPrs(repo, findings, staleDays, alertedPackages) {
  let prs;
  try {
    prs = ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200',
      '--json', 'number,title,author,url,createdAt']);
  } catch (err) {
    findings.push(finding('block', 'verify:prs', `could not list pull requests: ${err.message}`));
    return;
  }
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  for (const pr of prs ?? []) {
    if (!DEPENDABOT_LOGINS.has(pr?.author?.login ?? '')) continue;
    const opened = Date.parse(pr.createdAt);
    const age = Number.isNaN(opened) ? 0 : Math.floor((Date.now() - opened) / 86_400_000);
    const label = `#${pr.number} ${pr.title} (open ${age}d) ${pr.url}`;
    const stale = !Number.isNaN(opened) && opened < cutoff;
    const carriesFix = [...alertedPackages].find((pkg) =>
      new RegExp(`(^|[\\s"'\`])${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s"'\`]|$)`, 'i').test(pr.title));

    if (stale && carriesFix) {
      findings.push(finding('block', `pr:${pr.number}`,
        `SECURITY PR stale >${staleDays}d — ${carriesFix} still has an open alert. Land it on dev or close it: ${label}`));
    } else if (stale) {
      findings.push(finding('warn', `pr:${pr.number}`, `Dependabot PR stale >${staleDays}d (no open alert for it) ${label}`));
    } else {
      findings.push(finding('warn', `pr:${pr.number}`, `open Dependabot PR ${label}`));
    }
  }
}

/** Workspaces with their own lockfile, each audited independently. */
const NPM_WORKSPACES = ['.', 'web', 'functions', 'desktop'];

/**
 * A second, independent source of truth.
 *
 * Everything above reads GitHub's alert feed, which improves *precision* and
 * adds no *recall*: it can only report what Dependabot has already filed.
 * Measured 2026-09-12 — GHSA-2883-xcg3-v3hh (js-yaml, high) was published four
 * days earlier and still had no alert on any manifest, while `npm audit`
 * flagged js-yaml 4.3.1 in web's PRODUCTION tree immediately. Relying on one
 * feed is how a live high-severity vulnerability reads as CLEAR.
 *
 * Production dependencies only, high and above: a dev-only advisory is not a
 * reason to block a release, and this runs on every push.
 */
function checkNpmAudit(findings, opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  for (const ws of NPM_WORKSPACES) {
    const dir = ws === '.' ? root : join(root, ws);
    if (!existsSync(join(dir, 'package-lock.json'))) continue;
    let report;
    try {
      // npm audit exits non-zero when it FINDS something, so a throw here is
      // the normal path; the JSON is on stdout either way.
      report = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
        cwd: dir, encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
      });
    } catch (err) {
      report = err.stdout;
      if (!report || !String(report).trim()) {
        findings.push(finding('block', `verify:audit:${ws}`,
          `npm audit could not run in ${ws}: ${String(err.stderr || err.message).trim().split('\n')[0].slice(0, 200)}`));
        continue;
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(report);
    } catch {
      findings.push(finding('block', `verify:audit:${ws}`, `npm audit in ${ws} returned unparseable JSON`));
      continue;
    }
    for (const [name, vuln] of Object.entries(parsed?.vulnerabilities ?? {})) {
      const severity = String(vuln?.severity ?? '').toLowerCase();
      if (severity !== 'high' && severity !== 'critical') continue;
      const via = (vuln.via ?? []).filter((v) => typeof v === 'object');
      const title = via[0]?.title ?? 'see npm audit';
      const url = via[0]?.url ?? '';
      const fix = vuln?.fixAvailable === false ? 'NO FIX AVAILABLE'
        : (vuln?.fixAvailable?.version ? `fix ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}` : 'fix available');
      findings.push(finding('block', `audit:${ws}:${name}`,
        `npm audit (production deps, ${ws === '.' ? 'repo root' : ws}): [${severity}] ${name} ${vuln.range ?? ''} — ${title}. ${fix}. ${url}`));
    }
  }
}

// ---------------------------------------------------------------------------
// self-test — a checker that cannot fail is worth nothing
// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  let assertions = 0;
  const check = (name, actual, expected) => {
    assertions += 1;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) failures.push(`${name}: expected ${e}, got ${a}`);
  };

  // Range matching, both directions.
  check('next 16.3.2 is vulnerable', inVulnerableRange('16.3.2', '>= 16.0.0, < 16.3.3'), true);
  check('next 16.3.4 is NOT vulnerable', inVulnerableRange('16.3.4', '>= 16.0.0, < 16.3.3'), false);
  check('next 15.9.9 is below the range', inVulnerableRange('15.9.9', '>= 16.0.0, < 16.3.3'), false);
  check('sharp 0.35.3 is vulnerable', inVulnerableRange('0.35.3', '< 0.35.4'), true);
  check('sharp 0.35.4 is NOT vulnerable', inVulnerableRange('0.35.4', '< 0.35.4'), false);
  check('smol-toml 1.7.0 is vulnerable (<=)', inVulnerableRange('1.7.0', '<= 1.7.0'), true);
  check('smol-toml 1.8.0 is NOT vulnerable', inVulnerableRange('1.8.0', '<= 1.7.0'), false);
  check('prerelease sorts below its release', inVulnerableRange('4.0.0-beta.10', '>= 4.0.0-beta.10, < 4.0.33'), true);
  check('short version pads to zero', inVulnerableRange('0.18', '< 0.20.0'), true);

  // Prerelease precedence, numeric not lexicographic. The old assertion above
  // compared beta.10 to itself and so never reached this code: a mutation that
  // returned 0 from compareVersions still passed the whole suite.
  check('rc.10 is newer than rc.9', compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1);
  check('a prerelease is below its release', compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  check('prerelease floor catches a later prerelease',
    inVulnerableRange('1.0.0-rc.10', '>= 1.0.0-rc.9, < 2.0.0'), true);
  check('hyphenated prerelease is not truncated', compareVersions('1.0.0-rc-2', '1.0.0-rc-1'), 1);
  check('build metadata is not a release part', compareVersions('1.0.0+build.5', '1.0.0'), 0);
  check('build metadata still lands in range', inVulnerableRange('1.0.0+build.5', '<= 1.0.0'), true);

  // Fail-closed contract: an unreadable range must THROW, never read as safe.
  const throws = (name, fn) => {
    assertions += 1;
    try { fn(); failures.push(`${name}: expected a throw, got none`); } catch { /* expected */ }
  };
  throws('missing range throws', () => inVulnerableRange('1.0.0', undefined));
  throws('empty range throws', () => inVulnerableRange('1.0.0', '   '));
  throws('caret range throws', () => inVulnerableRange('0.18.5', '^0.18.0'));
  throws('unknown operator throws', () => inVulnerableRange('1.2.0', '~> 1.2'));
  throws('prose range throws', () => inVulnerableRange('1.2.0', 'sometimes'));
  throws('v1 lockfile throws', () => npmVersions(JSON.stringify({ lockfileVersion: 1, dependencies: { next: { version: '16.3.2' } } }), 'next'));
  throws('bare package.json throws', () => npmVersions(JSON.stringify({ name: 'cli', dependencies: { 'smol-toml': '^1.7.1' } }), 'smol-toml'));

  // Lockfile parsing, including a nested (non-hoisted) copy.
  const npmLock = JSON.stringify({
    packages: {
      '': { name: 'root', version: '1.0.0' },
      'node_modules/next': { version: '16.3.4' },
      'cli/node_modules/smol-toml': { version: '1.6.1' },
      'node_modules/unrelated': { version: '9.9.9' },
    },
  });
  check('hoisted npm version', npmVersions(npmLock, 'next'), ['16.3.4']);
  check('nested npm version', npmVersions(npmLock, 'smol-toml'), ['1.6.1']);
  check('absent npm package', npmVersions(npmLock, 'sharp'), []);
  // A package whose name is a suffix of another must not match.
  check('suffix names do not collide', npmVersions(JSON.stringify({
    packages: { 'node_modules/@scope/next': { version: '1.0.0' } },
  }), 'next'), []);

  const cargoLock = '[[package]]\nname = "glib"\nversion = "0.18.5"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n';
  check('cargo version', cargoVersions(cargoLock, 'glib'), ['0.18.5']);
  check('absent crate', cargoVersions(cargoLock, 'tokio'), []);

  check('pip pin', pipVersions('pytest==9.0.3\nblack==24.3.0\n', 'pytest'), { versions: ['9.0.3'], loose: false });
  check('pip loose floor is not a pin', pipVersions('pytest>=7.0\n', 'pytest'), { versions: [], loose: true });
  check('pip name normalization', pipVersions('pytest_asyncio==1.4.0\n', 'pytest-asyncio'), { versions: ['1.4.0'], loose: false });
  check('pip comment ignored', pipVersions('# pytest==1.0.0\npytest==9.0.3\n', 'pytest'), { versions: ['9.0.3'], loose: false });
  // pyproject arrays: the form that made every sdks/python dependency invisible.
  check('pyproject quoted dep is seen',
    pipVersions('dependencies = [\n  "pytest>=8.0",\n  "httpx>=0.27.0",\n]\n', 'pytest'), { versions: [], loose: true });
  check('pyproject exact pin is read',
    pipVersions('  "pytest==9.1.1",\n', 'pytest'), { versions: ['9.1.1'], loose: false });
  check('requirements include is not silence', pipVersions('-r base.txt\n', 'pytest'), { versions: [], loose: true });
  check('wildcard pin is not a version', pipVersions('pytest==9.0.*\n', 'pytest'), { versions: [], loose: true });

  // End-to-end classification against a synthetic tree — the negative control
  // is the same alert resolving to 'fixed' once the lockfile is patched.
  const alert = {
    dependency: { manifest_path: 'web/package-lock.json', package: { name: 'next', ecosystem: 'npm' } },
    security_vulnerability: { vulnerable_version_range: '>= 16.0.0, < 16.3.3' },
  };
  const fakeTree = (version) => ({
    root: '/fake',
    exists: () => true,
    readFile: () => JSON.stringify({ packages: { 'node_modules/next': { version } } }),
  });
  check('vulnerable lockfile is LIVE', resolveAlert(alert, fakeTree('16.3.2')).state, 'live');
  check('patched lockfile is FIXED', resolveAlert(alert, fakeTree('16.3.4')).state, 'fixed');
  check('missing manifest is ORPHANED',
    resolveAlert(alert, { root: '/fake', exists: () => false, readFile: () => '' }).state, 'orphaned');
  check('removed package is GONE', resolveAlert(alert, {
    root: '/fake', exists: () => true, readFile: () => JSON.stringify({ packages: {} }),
  }).state, 'gone');
  check('unresolvable ecosystem is UNKNOWN', resolveAlert({
    ...alert, dependency: { ...alert.dependency, package: { name: 'actions/checkout', ecosystem: 'github-actions' } },
  }, fakeTree('16.3.2')).state, 'unknown');

  // An orphaned manifest must be re-checked against its siblings: a workspace
  // that moved is not a dependency that left.
  const orphanAlert = {
    dependency: { manifest_path: 'cli/package-lock.json', package: { name: 'smol-toml', ecosystem: 'npm' } },
    security_vulnerability: { vulnerable_version_range: '<= 1.7.0' },
  };
  const siblingTree = (version) => ({
    root: '/fake',
    exists: (p) => !String(p).includes('cli'),
    readFile: () => JSON.stringify({ packages: { 'node_modules/smol-toml': { version } } }),
  });
  check('orphan still vulnerable elsewhere is caught',
    resolveElsewhere(orphanAlert, siblingTree('1.6.1')).live.length > 0, true);
  check('orphan patched elsewhere is not a blocker',
    resolveElsewhere(orphanAlert, siblingTree('1.8.0')).live.length, 0);

  if (failures.length > 0) {
    console.error(`self-test FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`self-test passed (${assertions} assertions)`);
  return 0;
}

// ---------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--test')) return selfTest();

  const asJson = args.includes('--json');
  const valueOf = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const staleDays = Number.parseInt(valueOf('--stale-days', String(DEFAULT_STALE_DAYS)), 10);
  if (!Number.isFinite(staleDays) || staleDays < 0) {
    console.error(`RESULT: BLOCKED — --stale-days must be a non-negative integer (got "${valueOf('--stale-days', '')}")`);
    return 1;
  }
  // Every ack must carry a reason: `--ack "key=why"`. The reason is printed in
  // the verdict so it can be pasted into the release commit body, which is the
  // one thing that makes a waiver auditable later.
  const acks = new Map();

  // Standing waivers live in git (.github/security-acks.json) so they are
  // reviewable in a PR and attributable in `git log`, and they EXPIRE — an
  // expired waiver stops applying and its finding blocks again, so nothing
  // accumulates here unnoticed.
  const expired = [];
  const ackFile = join(REPO_ROOT, '.github', 'security-acks.json');
  if (existsSync(ackFile)) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(ackFile, 'utf8'));
    } catch (err) {
      console.error(`RESULT: BLOCKED — .github/security-acks.json is unreadable (${err.message}); fix it rather than deleting it`);
      return 1;
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, entry] of Object.entries(doc?.acks ?? {})) {
      const reason = entry?.reason?.trim();
      if (!reason || !entry?.expires || !entry?.accepted_by) {
        console.error(`RESULT: BLOCKED — .github/security-acks.json entry "${key}" needs reason, accepted_by and expires`);
        return 1;
      }
      if (entry.expires < today) { expired.push(`${key} (expired ${entry.expires})`); continue; }
      acks.set(key, `${reason} [accepted by ${entry.accepted_by} on ${entry.accepted_on ?? '?'}, expires ${entry.expires}]`);
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--ack' || !args[i + 1]) continue;
    for (const entry of args[i + 1].split(',')) {
      const text = entry.trim();
      if (!text) continue;
      const eq = text.indexOf('=');
      acks.set(eq === -1 ? text : text.slice(0, eq).trim(), eq === -1 ? '' : text.slice(eq + 1).trim());
    }
  }
  const reasonless = [...acks].filter(([, why]) => !why).map(([k]) => k);
  if (reasonless.length > 0) {
    console.error(`RESULT: BLOCKED — every --ack needs a reason: --ack "${reasonless[0]}=<why the user accepted it>". `
      + `Missing a reason for: ${reasonless.join(', ')}`);
    return 1;
  }
  // A check that could not RUN is never waivable. Allowing --ack verify:dependabot
  // would switch off dependency checking entirely and leave no trace.
  const unwaivable = [...acks.keys()].filter((k) => k.startsWith('verify:'));
  if (unwaivable.length > 0) {
    console.error(`RESULT: BLOCKED — verify:* keys cannot be acked; a check that cannot run must be fixed, `
      + `not waived. Refused: ${unwaivable.join(', ')}`);
    return 1;
  }

  let repo = valueOf('--repo', null);
  if (!repo) {
    try {
      repo = ghJson(['repo', 'view', '--json', 'nameWithOwner'])?.nameWithOwner;
    } catch (err) {
      console.error(`RESULT: BLOCKED — cannot resolve the repo (${err.message}); pass --repo OWNER/NAME`);
      return 1;
    }
  }

  // Resolve the branch first: code-scanning findings are graded against it.
  // In Actions a PR checkout is detached, so prefer the ref the workflow gives us.
  let branch = process.env.GITHUB_REF_NAME ?? '';
  if (!branch) {
    try {
      branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    } catch { /* a detached or absent git is not itself a security finding */ }
  }
  if (!branch || branch === 'HEAD') branch = '';

  // The ref the code-scanning feed must be asked about. GITHUB_REF is exact in
  // Actions (refs/pull/N/merge on a PR, where GITHUB_REF_NAME is "N/merge" and
  // matches no branch); fall back to this checkout's branch.
  const gitRef = process.env.GITHUB_REF || (branch ? `refs/heads/${branch}` : '');

  const findings = [];
  const alertedPackages = new Set();
  checkDependabotAlerts(repo, findings, alertedPackages);
  checkScanningAlerts(repo, findings, branch, gitRef);
  checkAdvisories(repo, findings);
  checkDependabotPrs(repo, findings, staleDays, alertedPackages);
  if (!args.includes('--no-audit')) checkNpmAudit(findings);

  const blockers = findings.filter((f) => f.level === 'block');
  const openBlockers = blockers.filter((f) => !acks.has(f.key));
  const warnings = findings.filter((f) => f.level === 'warn');

  if (asJson) {
    console.log(JSON.stringify({
      repo, ref: gitRef, blockers, warnings,
      acked: [...acks].map(([key, reason]) => ({ key, reason })),
      blocked: openBlockers.length > 0,
    }, null, 2));
    return openBlockers.length > 0 ? 1 : 0;
  }

  console.log(`owlette security preflight: ${repo} (resolved against ${branch || 'this checkout'})`);
  console.log(`BLOCKING (${blockers.length})`);
  for (const f of blockers) console.log(`  ${acks.has(f.key) ? 'ACKED ' : ''}[${f.key}] ${f.text}`);

  // Warnings are dominated by two expected steady states on `dev`: alerts
  // already fixed here that stay open until dev reaches main, and alerts
  // against manifests this branch does not carry. Enumerating 80+ of those at
  // every release is the same noise that made the alert list unreadable to
  // begin with, so they collapse to a count and only the rest are listed.
  const isRoutine = (f) => /still open on the default branch|does not exist on this branch/.test(f.text);
  const routine = warnings.filter(isRoutine);
  const actionable = warnings.filter((f) => !isRoutine(f));
  console.log(`WARNING (${warnings.length})`);
  for (const f of actionable) console.log(`  [${f.key}] ${f.text}`);
  if (routine.length > 0) {
    console.log(`  ... plus ${routine.length} routine: already patched on this branch, or filed against a manifest `
      + 'this branch does not carry. Re-run with --json to enumerate.');
  }
  for (const [key, why] of acks) {
    if (findings.some((f) => f.key === key)) console.log(`ACKED ${key} — ${why}`);
    else console.log(`NOTE: ack ${key} matched nothing; the finding is gone — remove the entry`);
  }
  for (const item of expired) {
    console.log(`EXPIRED WAIVER: ${item} — no longer applied. Re-accept it with a new expiry, or fix the finding.`);
  }

  if (openBlockers.length > 0) {
    console.log(`RESULT: BLOCKED by ${openBlockers.length} item(s). Fix each one, dismiss it on GitHub with a ` +
      'reason, or re-run with --ack "<key>" for items the user explicitly accepted. Report every warning too.');
    return 1;
  }
  console.log(`RESULT: CLEAR (${blockers.length} acknowledged blocker(s), ${warnings.length} warning(s) to report)`);
  return 0;
}

// `file://${argv[1]}` never matches on Windows (backslashes, drive letter), so
// the guard rested entirely on the filename check — meaning a renamed copy ran
// nothing and exited 0. pathToFileURL normalises both sides on every platform.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv));
}
