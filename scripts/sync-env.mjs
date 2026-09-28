#!/usr/bin/env node
/**
 * sync-env.mjs — manage Owlette web env vars across Railway (dev + prod) and the Vercel
 * failover origin, against the canonical registry in env-manifest.json.
 *
 * Values NEVER pass through this script's output: status/check/diff use key NAMES only,
 * and sync pipes values provider→provider via stdin. The manifest stores keys + metadata.
 *
 *   node scripts/sync-env.mjs                       status matrix (✓/✗ grid + drift)
 *   node scripts/sync-env.mjs check                 exit 1 on any drift (CI gate)
 *   node scripts/sync-env.mjs diff A B              key-presence diff between targets
 *   node scripts/sync-env.mjs sync TARGET           dry run
 *   node scripts/sync-env.mjs sync TARGET --apply   write to the target
 *
 * Targets: railway-dev | railway-prod | vercel-prod (defined in env-manifest.json).
 * Prereqs: `railway` authed (services addressed by flag), `vercel` linked to the owlette
 * project (.vercel lives in web/).
 *
 * Vercel caveat: sensitive secrets cannot be read back, so this detects COVERAGE drift
 * but not VALUE drift. Parity for railway-prod↔vercel-prod comes from re-running
 * `sync vercel-prod --apply` (idempotent). See .claude/skills/env-management.md.
 */
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, '..', 'web');
const MANIFEST_PATH = resolve(HERE, 'env-manifest.json');
const SHELL = true; // resolve .cmd/.exe CLI shims on Windows PATH
const SENSITIVE_CLASSES = new Set(['secret', 'must-match', 'build']);

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// live readers (NAMES only)

function railwayKeys(target) {
  const out = execFileSync(
    'railway',
    ['variables', '-s', target.service, '-e', target.environment, '--json'],
    { encoding: 'utf8', shell: SHELL, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // RAILWAY_* are platform-injected — not part of the tracked app config.
  return new Set(Object.keys(JSON.parse(out)).filter((k) => !k.startsWith('RAILWAY_')));
}

function vercelKeys(target) {
  const out = execFileSync('vercel', ['env', 'ls', target.target, '-F', 'json'], {
    cwd: WEB_DIR,
    encoding: 'utf8',
    shell: SHELL,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  const list = parsed.envs || [];
  return new Set(list.map((e) => e.key || e.name).filter(Boolean));
}

function liveKeys(target) {
  try {
    return target.provider === 'railway' ? railwayKeys(target) : vercelKeys(target);
  } catch (err) {
    fail(
      `could not read ${target.provider} target "${target.serves}". ` +
        `Is the CLI authed${target.provider === 'vercel' ? ' + linked (web/.vercel)' : ''}?\n  ${err.message}`,
    );
  }
}

// analysis

/** For each target: which manifest vars are declared, present, missing, undeclared. */
function analyze(manifest) {
  const targetIds = Object.keys(manifest.targets);
  const live = Object.fromEntries(targetIds.map((id) => [id, liveKeys(manifest.targets[id])]));

  const declaredByTarget = Object.fromEntries(targetIds.map((id) => [id, new Set()]));
  for (const [name, meta] of Object.entries(manifest.vars)) {
    for (const id of meta.targets) declaredByTarget[id]?.add(name);
  }

  const missing = {}; // declared in manifest but absent live
  const undeclared = {}; // present live but not in manifest
  for (const id of targetIds) {
    missing[id] = [...declaredByTarget[id]].filter((k) => !live[id].has(k)).sort();
    undeclared[id] = [...live[id]].filter((k) => !manifest.vars[k]).sort();
  }
  return { targetIds, live, declaredByTarget, missing, undeclared };
}

function hasDrift({ targetIds, missing, undeclared }) {
  return targetIds.some((id) => missing[id].length || undeclared[id].length);
}

// commands

function cmdStatus(manifest) {
  const a = analyze(manifest);
  const names = Object.keys(manifest.vars).sort();
  const cols = a.targetIds;
  const w = Math.max(...names.map((n) => n.length), 'variable'.length);
  const cw = 14;
  const head = `  ${'variable'.padEnd(w)}  ${cols.map((c) => c.padEnd(cw)).join('')}class`;
  console.log(`\nenv coverage  (✓ present · ✗ missing · ·  not expected)\n`);
  console.log(head);
  console.log(`  ${'-'.repeat(w)}  ${cols.map(() => '-'.repeat(cw)).join('')}-----`);
  for (const name of names) {
    const meta = manifest.vars[name];
    const cells = cols.map((id) => {
      const declared = meta.targets.includes(id);
      if (!declared) return '·'.padEnd(cw);
      return (a.live[id].has(name) ? '✓' : '✗ MISSING').padEnd(cw);
    });
    console.log(`  ${name.padEnd(w)}  ${cells.join('')}${meta.class}`);
  }

  console.log('');
  for (const id of cols) {
    const parts = [];
    if (a.missing[id].length) parts.push(`${a.missing[id].length} missing`);
    if (a.undeclared[id].length) parts.push(`${a.undeclared[id].length} undeclared`);
    const status = parts.length ? `⚠ ${parts.join(', ')}` : '✓ in sync';
    console.log(`  ${id.padEnd(14)} ${status}`);
    if (a.missing[id].length) console.log(`      missing:    ${a.missing[id].join(', ')}`);
    if (a.undeclared[id].length) console.log(`      undeclared: ${a.undeclared[id].join(', ')}`);
  }
  console.log('');
}

function cmdCheck(manifest) {
  const a = analyze(manifest);
  if (hasDrift(a)) {
    console.error('✗ env drift detected:\n');
    for (const id of a.targetIds) {
      if (a.missing[id].length) console.error(`  ${id} missing: ${a.missing[id].join(', ')}`);
      if (a.undeclared[id].length) console.error(`  ${id} undeclared: ${a.undeclared[id].join(', ')}`);
    }
    console.error('\nUpdate env-manifest.json or run `sync <target> --apply`.');
    process.exit(1);
  }
  console.log('✓ all targets match the manifest.');
}

function cmdDiff(manifest, aId, bId) {
  for (const id of [aId, bId]) {
    if (!manifest.targets[id]) fail(`unknown target "${id}". Known: ${Object.keys(manifest.targets).join(', ')}`);
  }
  const aKeys = liveKeys(manifest.targets[aId]);
  const bKeys = liveKeys(manifest.targets[bId]);
  const onlyA = [...aKeys].filter((k) => !bKeys.has(k)).sort();
  const onlyB = [...bKeys].filter((k) => !aKeys.has(k)).sort();
  console.log(`\n${aId} vs ${bId}  (key presence only — values not compared)\n`);
  console.log(`  only in ${aId}: ${onlyA.length ? onlyA.join(', ') : '(none)'}`);
  console.log(`  only in ${bId}: ${onlyB.length ? onlyB.join(', ') : '(none)'}`);
  console.log(`  in both:        ${[...aKeys].filter((k) => bKeys.has(k)).length} keys\n`);
}

function mirrorSourceFor(manifest, targetId) {
  const pair = manifest.mirror.find((p) => p.includes(targetId));
  if (!pair) fail(`no mirror source defined for "${targetId}" in env-manifest.json`);
  const sourceId = pair.find((id) => id !== targetId);
  if (!manifest.targets[sourceId].readable) fail(`mirror source "${sourceId}" is not readable`);
  return sourceId;
}

function readRailwayValues(target) {
  const out = execFileSync(
    'railway',
    ['variables', '-s', target.service, '-e', target.environment, '--json'],
    { encoding: 'utf8', shell: SHELL, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out);
}

// the value travels on stdin so it never shows in a process listing. an EMPTY
// value is the exception: vercel reads empty stdin as "no value given" and
// refuses, so it goes as an explicit `--value ""` — nothing to hide there. the
// quotes are literal because SHELL joins the args into one command line, where
// a bare empty string would vanish.
export function vercelAddArgs(key, value, sensitive, vercelTarget) {
  const flag = sensitive ? '--sensitive' : '--no-sensitive';
  const args = ['env', 'add', key, vercelTarget, '--force', flag];
  return value === '' ? [...args, '--value', '""'] : args;
}

function pushVercel(key, value, sensitive, vercelTarget) {
  const res = spawnSync('vercel', vercelAddArgs(key, value, sensitive, vercelTarget), {
    cwd: WEB_DIR,
    input: value,
    encoding: 'utf8',
    shell: SHELL,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return res.status === 0;
}

function cmdSync(manifest, targetId, apply) {
  const target = manifest.targets[targetId];
  if (!target) fail(`unknown target "${targetId}". Known: ${Object.keys(manifest.targets).join(', ')}`);
  if (target.provider !== 'vercel') fail(`sync currently supports vercel targets only (got "${targetId}")`);

  const sourceId = mirrorSourceFor(manifest, targetId);
  const source = manifest.targets[sourceId];
  const sourceValues = readRailwayValues(source);

  // Vars the manifest says belong in this target, in deterministic order.
  const wanted = Object.entries(manifest.vars)
    .filter(([, meta]) => meta.targets.includes(targetId))
    .map(([name, meta]) => ({ name, sensitive: SENSITIVE_CLASSES.has(meta.class) }))
    .sort((x, y) => x.name.localeCompare(y.name));

  const missingAtSource = wanted.filter(({ name }) => !(name in sourceValues)).map((v) => v.name);

  console.log(`\nsource:  ${sourceId} (${source.service})`);
  console.log(`target:  ${targetId} (vercel "${target.target}")`);
  console.log(`mode:    ${apply ? 'APPLY (writing)' : 'DRY RUN (nothing written)'}\n`);
  if (missingAtSource.length) {
    console.log(`⚠ declared for ${targetId} but absent at source ${sourceId} — will skip:`);
    console.log(`    ${missingAtSource.join(', ')}\n`);
  }

  const toSync = wanted.filter(({ name }) => name in sourceValues);
  if (!apply) {
    for (const { name, sensitive } of toSync) {
      console.log(`  would set  ${name}${sensitive ? '  (sensitive)' : ''}`);
    }
    console.log(`\n${toSync.length} vars. Re-run with --apply to push them.`);
    return;
  }

  let ok = 0;
  const failed = [];
  for (const { name, sensitive } of toSync) {
    if (pushVercel(name, sourceValues[name], sensitive, target.target)) {
      ok += 1;
      console.log(`  ✓ ${name}`);
    } else {
      failed.push(name);
      console.log(`  ✗ ${name}`);
    }
  }
  console.log(`\nset ${ok}/${toSync.length} vars in ${targetId}.`);
  if (failed.length) fail(`failed: ${failed.join(', ')}`);
}

// entry

function main() {
  const manifest = loadManifest();
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const cmd = positional[0] || 'status';

  switch (cmd) {
    case 'status':
      return cmdStatus(manifest);
    case 'check':
      return cmdCheck(manifest);
    case 'diff':
      if (positional.length < 3) fail('usage: sync-env.mjs diff <targetA> <targetB>');
      return cmdDiff(manifest, positional[1], positional[2]);
    case 'sync':
      if (positional.length < 2) fail('usage: sync-env.mjs sync <target> [--apply]');
      return cmdSync(manifest, positional[1], apply);
    default:
      fail(`unknown command "${cmd}". Use: status | check | diff | sync`);
  }
}

// importable for its own tests; runs only as the entry point
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
