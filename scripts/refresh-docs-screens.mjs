#!/usr/bin/env node
/**
 * Release-time refresh of the agent docs screenshots.
 *
 * WHY THIS EXISTS RATHER THAN JUST `npm run screenshots:desktop`: the capture
 * harness drives the app INSTALLED at C:\ProgramData\Owlette\app, not the one
 * you just built. Running the bare capture after a build silently photographs
 * the PREVIOUS version — the shots look fine, they are just wrong, and nobody
 * notices until a customer sees an old version string in the docs. That is how
 * the screenshots ended up three minor versions stale.
 *
 * So this does the whole thing in order:
 *   1. refuse unless the built desktop exe matches VERSION
 *   2. swap it into the install (needs the service stopped — it respawns the
 *      tray within seconds of it dying, which holds the exe lock)
 *   3. run the capture
 *   4. record what was photographed, so staleness is detectable later
 *      (`--check`) instead of remembered
 *
 * Every shot is captured in both themes: `x.png`, and `x-light.png` beside it.
 * The web half comes from `npm run screenshots`, the desktop half from step 3.
 * The docs pick a light shot from `light-variants.json`, which this script
 * writes from what is on disk, so a page never points at a file that is not there.
 *
 * Step 2 needs elevation and step 3 needs an interactive desktop session with
 * the owlette tray icon VISIBLE — not in the hidden-icons overflow, or the
 * tray-menu shot fails while the others succeed.
 *
 * Usage:
 *   node scripts/refresh-docs-screens.mjs             full refresh
 *   node scripts/refresh-docs-screens.mjs --no-swap   capture only, exe as-is
 *   node scripts/refresh-docs-screens.mjs --manifest  rewrite light-variants.json
 *                                                     only (after `npm run screenshots`)
 *   node scripts/refresh-docs-screens.mjs --check     report staleness and unpaired
 *                                                     shots, write nothing
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();

const BUILT_EXE = join(ROOT, 'agent', 'build', 'installer_package', 'app', 'owlette-desktop.exe');
const INSTALLED_EXE = 'C:\\ProgramData\\Owlette\\app\\owlette-desktop.exe';
const DOCS_SCREENS = join(ROOT, 'web', 'public', 'docs-screens');
const LANDING_SCREENS = join(ROOT, 'web', 'public', 'landing-screens');
const MANIFEST = join(DOCS_SCREENS, 'captured.json');
/** The docs shots that have a light capture, by name; read by `web/mdx-components.tsx`. */
const LIGHT_MANIFEST = join(DOCS_SCREENS, 'light-variants.json');

const THEMES = ['dark', 'light'];
const LIGHT_SUFFIX = '-light.png';

/**
 * Dark only by design. The tray menu is a native popup that Windows draws in the
 * os theme, not the app's, so a light capture would be the same picture.
 */
const DARK_ONLY = new Set(['agent-right-click.png']);

const args = process.argv.slice(2);
const noSwap = args.includes('--no-swap');
const checkOnly = args.includes('--check');
const manifestOnly = args.includes('--manifest');

/** The desktop shots come from step 3, not from `npm run screenshots`. */
const isDesktopShot = (file) => file === 'agent.png' || file.startsWith('agent-');

const lightOf = (file) => file.replace(/\.png$/, LIGHT_SUFFIX);

function pngs(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.png')) : [];
}

/** Dark shots in `dir` with no light pair, and light shots with no dark one. */
function unpaired(dir) {
  const files = new Set(pngs(dir));
  const noLight = [];
  const noDark = [];
  for (const file of files) {
    if (file.endsWith(LIGHT_SUFFIX)) {
      if (!files.has(`${file.slice(0, -LIGHT_SUFFIX.length)}.png`)) noDark.push(file);
    } else if (!DARK_ONLY.has(file) && !files.has(lightOf(file))) {
      noLight.push(file);
    }
  }
  return { noLight, noDark };
}

/** Each docs shot, by name, that has both captures. */
function lightManifestBody() {
  const files = new Set(pngs(DOCS_SCREENS));
  const names = [...files]
    .filter((file) => !file.endsWith(LIGHT_SUFFIX) && files.has(lightOf(file)))
    .map((file) => file.slice(0, -'.png'.length))
    .sort();
  return `${JSON.stringify(names, null, 2)}\n`;
}

function writeLightManifest() {
  const body = lightManifestBody();
  writeFileSync(LIGHT_MANIFEST, body);
  console.log(`wrote ${LIGHT_MANIFEST} (${JSON.parse(body).length} light shot(s))`);
}

/** The tests the list reporter's summary names as failed, one `[theme] › ...` per line. */
function failedTests(out) {
  const block = out.match(/^ *\d+ failed\r?\n((?: {4}\S.*(?:\r?\n|$))+)/m);
  return block ? block[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

/** File version of a Windows exe, or null if absent/unreadable. */
function exeVersion(path) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-Item '${path}' -ErrorAction SilentlyContinue).VersionInfo.FileVersion`],
    { encoding: 'utf8' },
  );
  const v = (r.stdout ?? '').trim();
  return v || null;
}

if (manifestOnly) {
  writeLightManifest();
  process.exit(0);
}

if (checkOnly) {
  const problems = [];
  const pending = [];

  const m = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
  if (!m) {
    problems.push(`docs screenshots have no capture record (${MANIFEST} missing). Run: node scripts/refresh-docs-screens.mjs`);
  } else if (m.version !== VERSION) {
    problems.push(`docs screenshots are STALE: captured against ${m.version}, VERSION is ${VERSION}. Run: node scripts/refresh-docs-screens.mjs`);
  } else {
    console.log(`docs screenshots are current (captured against ${m.version} on ${m.capturedAt}).`);
  }
  if (m?.missing?.length) {
    console.log(`note: ${m.missing.length} shot(s) failed in that run: ${m.missing.join(', ')}`);
  }

  // a record without `themes` predates light mode, so its desktop shots are dark
  // only until the next full refresh; once it records light, a gap is a failure
  const desktopHasLight = m?.themes?.includes('light') ?? false;
  for (const dir of [DOCS_SCREENS, LANDING_SCREENS]) {
    const { noLight, noDark } = unpaired(dir);
    for (const file of noLight) {
      const desktop = isDesktopShot(file);
      if (desktop && !desktopHasLight) pending.push(lightOf(file));
      else {
        const fix = desktop ? 'node scripts/refresh-docs-screens.mjs' : 'cd web && npm run screenshots';
        problems.push(`${file} has no light pair (${lightOf(file)}). Run: ${fix}`);
      }
    }
    for (const file of noDark) problems.push(`${file} has no dark pair`);
  }

  if (!existsSync(LIGHT_MANIFEST) || readFileSync(LIGHT_MANIFEST, 'utf8') !== lightManifestBody()) {
    problems.push(`${LIGHT_MANIFEST} does not match the files on disk. Run: node scripts/refresh-docs-screens.mjs --manifest`);
  }

  if (pending.length) {
    console.log(
      `pending a release build: ${pending.length} desktop light shot(s), taken by the full refresh: ${pending.sort().join(', ')}`,
    );
  }
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(pending.length ? 'every other shot has its light pair.' : `every shot has its ${THEMES.join(' and ')} pair.`);
  process.exit(0);
}

// 1. The built exe must be the version we are releasing.
if (!noSwap) {
  if (!existsSync(BUILT_EXE)) {
    console.error(`no built desktop exe at ${BUILT_EXE}`);
    console.error('Build the installer first: agent/build_installer_full.bat');
    process.exit(1);
  }
  const built = exeVersion(BUILT_EXE);
  if (built !== VERSION) {
    console.error(`built desktop exe is ${built}, VERSION is ${VERSION} — refusing.`);
    console.error('Rebuild the installer so the capture photographs what ships.');
    process.exit(1);
  }
  console.log(`built desktop exe: ${built}`);

  // 2. Swap it in. Elevated, because the service must stop for the copy.
  const installed = exeVersion(INSTALLED_EXE);
  if (installed === VERSION) {
    console.log(`installed desktop exe already ${installed} — no swap needed.`);
  } else {
    console.log(`installed desktop exe is ${installed ?? 'absent'} — swapping in ${VERSION}...`);
    const cmd = [
      'net stop OwletteService',
      'taskkill /F /IM owlette-desktop.exe',
      'ping -n 4 127.0.0.1 > nul',
      `copy /Y "${BUILT_EXE}" "${INSTALLED_EXE}"`,
      'net start OwletteService',
    ].join(' & ');
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command',
       `Start-Process cmd -ArgumentList '/c ${cmd.replace(/'/g, "''")}' -Verb RunAs -Wait`],
      { encoding: 'utf8', stdio: 'inherit' },
    );
    if (r.status !== 0) {
      console.error('elevated swap failed — see the UAC prompt / console output above.');
      process.exit(1);
    }
    const now = exeVersion(INSTALLED_EXE);
    if (now !== VERSION) {
      console.error(`swap did not take: installed exe is ${now}, expected ${VERSION}.`);
      process.exit(1);
    }
    console.log(`installed desktop exe now ${now}.`);
    // The service respawns the tray on its next status check; the capture needs it.
    console.log('waiting for the service to respawn the tray...');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 20']);
  }
}

// 3. Capture, once per theme (the config's projects).
console.log('\ncapturing...');
const cap = spawnSync('npm', ['run', 'screenshots:desktop'], {
  cwd: join(ROOT, 'web'),
  encoding: 'utf8',
  shell: true,
});
const out = `${cap.stdout ?? ''}${cap.stderr ?? ''}`;
process.stdout.write(out.slice(-4000));

// A partial capture is still worth recording: the tray-menu shot fails whenever
// the icon sits in the hidden-icons overflow, and the others are fine. Any other
// failure, a light one included, would make the record a lie.
const failed = failedTests(out);
const missing = [];
if (failed.length > 0 && failed.every((title) => /the tray right-click menu/.test(title))) {
  missing.push('agent-right-click.png (tray menu — icon likely in the hidden-icons overflow)');
}
if (cap.status !== 0 && missing.length === 0) {
  console.error('\ncapture failed for reasons beyond the known tray-menu case — not recording.');
  process.exit(1);
}

// 4. Record what was photographed.
writeFileSync(
  MANIFEST,
  `${JSON.stringify(
    {
      version: VERSION,
      capturedAt: new Date().toISOString(),
      installedExe: exeVersion(INSTALLED_EXE),
      themes: THEMES,
      missing,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nrecorded ${MANIFEST} (version ${VERSION})`);
writeLightManifest();
if (missing.length) {
  console.log(`NOTE: ${missing.length} shot(s) not refreshed:`);
  for (const m of missing) console.log(`  - ${m}`);
}
console.log('\nCheck what changed: git diff --stat web/public/docs-screens');
