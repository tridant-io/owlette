/**
 * Roosts — version history renders newest-first with #N numbers, relative
 * timestamps, descriptions (or the "(no description)" placeholder), and the
 * current-version dot only on the head row. No data plane: no push, no chunks.
 * Also how the panel's sections (contents, targets, version history) open and close.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { clippedFocusRings } from '../../helpers/focusRing';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';
import { recordSlides, slideSettled } from '../../helpers/slide';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-version-history-machine';
const ROOST_ID = 'rst_test_history_001';
const VERSION_COUNT = 5;
const DESCRIPTIONS: Array<string | null> = [
  null,
  'v2 work',
  'v3 work',
  'v4 work',
  'Bumped Q2 ads',
];
// Matches relativeTime() output in VersionRow.tsx (e.g. "just now", "12s ago",
// "3m ago", "2h ago", "5d ago", "1mo ago", "1y ago").
const TIMESTAMP_REGEX = /^(just now|\d+(s|m|h|d|mo|y) ago)$/;

async function cleanup() {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

test.beforeEach(async () => {
  await cleanup();
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: VERSION_COUNT,
    descriptions: DESCRIPTIONS,
  });
});

test.afterEach(async () => {
  await cleanup();
});

test('expanded roost renders version rows newest-first with current marker on head', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  const row = page.locator(`[data-roost-row="${ROOST_ID}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();

  const versionRows = page.getByTestId('roost-version-row');
  await expect(versionRows).toHaveCount(VERSION_COUNT);
  const versionNumbers = versionRows.locator('span.font-mono', { hasText: /^#\d+$/ });
  await expect(versionNumbers).toHaveCount(VERSION_COUNT);

  // Newest-first ordering: #5 on top, #1 on bottom.
  const expectedOrder = ['#5', '#4', '#3', '#2', '#1'];
  for (let i = 0; i < expectedOrder.length; i++) {
    await expect(versionNumbers.nth(i)).toHaveText(expectedOrder[i]);
  }

  // Exactly one aria-label="current version" dot across the whole panel.
  const currentMarkers = versionRows.getByLabel('current version');
  await expect(currentMarkers).toHaveCount(1);

  // Marker sits inside #5's row container.
  const headRow = page.locator('[data-testid="roost-version-row"][data-version-number="5"]');
  await expect(headRow).toContainText('#5');
  await expect(headRow).toContainText('Bumped Q2 ads');

  // v1 had description=null → "(no description)" placeholder renders.
  const v1Row = page.locator('[data-testid="roost-version-row"][data-version-number="1"]');
  await expect(v1Row).toContainText('(no description)');

  // Each row exposes a tabular-nums timestamp span; assert format on each.
  for (let i = 0; i < VERSION_COUNT; i++) {
    const timestamp = versionRows.nth(i)
      .locator('span.tabular-nums')
      .first();
    await expect(timestamp).toHaveText(TIMESTAMP_REGEX);
  }

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});

async function gotoRoosts(page: Page): Promise<void> {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });
}

/** opens the roost's detail panel and waits for its version history */
async function openPanel(page: Page): Promise<Locator> {
  await page.locator(`[data-roost-row="${ROOST_ID}"]`).click();
  const panel = page.locator('#roost-detail-panel');
  await expect(panel.getByTestId('roost-version-row')).toHaveCount(VERSION_COUNT);
  return panel;
}

// the slide clips what a section holds, so its outlines must stay inside it. that
// check goes last in a test, because it turns animation off for the rest of the page
test.describe('the panel sections slide open and closed, as the other expandable panels do', () => {
  test('version history, open by default, slides only when clicked', async ({ page }) => {
    await gotoRoosts(page);
    // watched from before the panel mounts: the sections open by default show with it, not slide in
    const mounted = await recordSlides(page.locator('body'));
    const panel = await openPanel(page);
    expect(await mounted()).toBe('');

    const slides = await recordSlides(panel);
    const toggle = panel.getByRole('button', { name: 'version history' });
    const rows = panel.getByTestId('roost-version-row');

    await toggle.click();
    await expect.poll(slides).toBe('collapsible-up');
    await expect(rows).toHaveCount(0);

    await toggle.click();
    await expect.poll(slides).toBe('collapsible-up collapsible-down');
    await expect(rows).toHaveCount(VERSION_COUNT);

    await slideSettled(panel);
    const history = panel.locator('[data-slot="collapsible-content"]', { has: page.getByTestId('roost-version-row') });
    expect(await clippedFocusRings(page, history)).toEqual([]);
  });

  test('targets, open by default, slide only when clicked', async ({ page }) => {
    await gotoRoosts(page);
    const panel = await openPanel(page);
    const slides = await recordSlides(panel);
    const toggle = panel.getByRole('button', { name: /^targets \(\d+\)$/ });
    const machine = panel.getByRole('checkbox', { name: new RegExp(MACHINE_ID) });
    await expect(machine).toBeVisible();

    await toggle.click();
    await expect.poll(slides).toBe('collapsible-up');
    await expect(machine).toHaveCount(0);

    await toggle.click();
    await expect.poll(slides).toBe('collapsible-up collapsible-down');
    await expect(machine).toBeVisible();

    await slideSettled(panel);
    const targets = panel.locator('[data-slot="collapsible-content"]', { has: page.getByRole('checkbox') });
    expect(await clippedFocusRings(page, targets)).toEqual([]);
  });

  test('the file list slides open and closed', async ({ page }) => {
    // enough files that the list scrolls
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `show/file-${i}.bin`, size: 1024 }));
    // the seed carries no totals, and without them the contents row does not render
    await getAdminDb()
      .collection('sites').doc(SITE_ID)
      .collection('roosts').doc(ROOST_ID)
      .set({ totalFiles: files.length, totalSize: files.length * 1024 }, { merge: true });
    // the list is read from the version's manifest in r2, which the rig does not have
    const filesRoute = (url: URL) =>
      url.pathname.startsWith(`/api/roosts/${ROOST_ID}/versions/`) && url.pathname.endsWith('/files');
    await page.route(filesRoute, (route) => route.fulfill({ json: { files } }));

    await gotoRoosts(page);
    const panel = await openPanel(page);
    const slides = await recordSlides(panel);
    // named for what a click does next: show, then hide
    const toggle = panel.getByRole('button', { name: /^(show|hide) file list$/ });
    const file = panel.getByText('show/file-0.bin', { exact: true });

    await toggle.click();
    await expect.poll(slides).toBe('collapsible-down');
    await expect(file).toBeVisible();

    await toggle.click();
    await expect.poll(slides).toBe('collapsible-down collapsible-up');
    await expect(file).toHaveCount(0);

    // chromium makes a scroller with nothing focusable in it a tab stop, outline and all,
    // and the helper finds tab stops by attribute, so the list gets one
    await toggle.click();
    await expect(file).toBeVisible();
    await slideSettled(panel);
    const list = panel.locator('[data-slot="collapsible-content"]', { has: page.getByText('show/file-0.bin', { exact: true }) });
    await list.locator('.overflow-y-auto').evaluate((el) => {
      el.tabIndex = 0;
    });
    expect(await clippedFocusRings(page, list)).toEqual([]);
  });
});
