#!/usr/bin/env node
// swoop spike 2.12 - click through the `perms` mode without a human.
//
//   cd agent/swoop/spikes/browser-matrix
//   node server.mjs                                   # in another terminal
//   node drive-perms.mjs --channel chrome --label chrome-win
//   node drive-perms.mjs --channel msedge --label edge-win
//
// What this DOES measure: whether keyboard lock, pointer lock with
// `unadjustedMovement` and the async clipboard resolve or reject when the page
// has a real user activation, on the installed browser (playwright drives the
// real chrome/edge here, not its bundled chromium).
//
// What it CANNOT measure, and what therefore stays a [human] cell in the memo:
// whether a *permission prompt appeared*. Under automation the permission state
// is set by the harness, so the prompt is exactly the observable that is gone.
// The script answers the page's "did a prompt appear?" question with "unsure"
// so no run file ever claims otherwise.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const channel = arg('channel', 'chrome');
const label = arg('label', `${channel}-perms`);
const grant = arg('grant', '1') === '1';
const PAGE = process.env.MATRIX_URL ?? 'http://127.0.0.1:17450';

// playwright-core is commonjs, so a dynamic import puts it on `default`;
// the named export only exists when the lexer finds it, and here it does not.
const pw = await import(pathToFileURL(join(repo, 'web', 'node_modules', 'playwright-core', 'index.js')).href);
const chromium = pw.chromium ?? pw.default.chromium;

const browser = await chromium.launch({ channel, headless: false, args: ['--disable-extensions'] });
try {
  const context = await browser.newContext();
  if (grant) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: PAGE });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error(`  console: ${m.text()}`); });
  await page.goto(`${PAGE}/?mode=perms&label=${label}-granted-${grant ? 1 : 0}&autorun=1`, { waitUntil: 'load' });

  const steps = ['keyboard lock (fullscreen)', 'pointer lock (unadjustedMovement)', 'clipboard write', 'clipboard read'];
  for (const step of steps) {
    const button = page.getByRole('button', { name: step, exact: true });
    await button.waitFor({ state: 'visible', timeout: 30000 });
    await button.click();
    // The page then asks whether a prompt appeared. Automation cannot see one.
    await page.getByRole('button', { name: 'unsure', exact: true }).click({ timeout: 30000 });
  }
  await page.waitForFunction(() => document.getElementById('state')?.textContent === 'done', null, { timeout: 60000 });
  console.log(await page.locator('#out').innerText());
  console.log(`browser: ${browser.version()} (channel ${channel})`);
} finally {
  await browser.close();
}
