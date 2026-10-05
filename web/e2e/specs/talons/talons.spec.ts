/**
 * Talons — the `/talons` surface end to end: the nav entry, the list row
 * (enabled dot, trigger summary, last-run status), the expanded run history,
 * the editor's create round-trip, the enable/disable toggle, and the empty
 * state's "sits where the list would" guarantee.
 *
 * Seeding is Admin SDK only, deliberately: firestore.rules 2.7.0 denies every
 * CLIENT write to `talons` / `talon_runs` (both are server-mediated, the run
 * history is an audit surface) and the Admin SDK bypasses rules. The create
 * test is the one path that writes through the api — which is the point of it.
 *
 * Every relative timestamp is seeded in whole hours, not minutes: the row
 * renders `formatRelative` against the real wall clock, so an hours-granularity
 * value keeps its rendered label for the best part of an hour rather than for
 * the seconds between seeding and first paint.
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine, TEST_USERS } from '../../helpers/seed';
import type { TalonDoc, TalonRunDoc } from '@/lib/talons/types';

// admin-uid is a site admin on site-A, which is what TALON_MANAGE needs; it is
// also the only site in its `sites[]`, so `useCurrentSite` resolves site-A with
// no site-picker interaction to race.
test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-talon-machine';

const WALL_CHECK_ID = 'e2e-talon-wall-check';
const WALL_CHECK_NAME = 'e2e wall check';
const CRASH_PAGE_ID = 'e2e-talon-crash-page';
const CRASH_PAGE_NAME = 'e2e crash page';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function tsAgo(ms: number): Timestamp {
  return Timestamp.fromMillis(Date.now() - ms);
}

/** Authorship/bookkeeping half shared by both seeded talons. */
function authored(): Pick<
  TalonDoc,
  'schemaVersion' | 'createdBy' | 'createdVia' | 'createdAt' | 'updatedAt'
> {
  return {
    schemaVersion: 1,
    createdBy: TEST_USERS.admin.uid,
    createdVia: 'ui',
    createdAt: tsAgo(30 * 24 * HOUR_MS),
    updatedAt: tsAgo(2 * 24 * HOUR_MS),
  };
}

/**
 * Two talons spanning the shapes the row has to render differently: a schedule
 * trigger gated by a visual check (badge + entries summary), and an event
 * trigger with no condition. `useTalons` sorts by name client-side, so
 * "e2e crash page" renders above "e2e wall check".
 */
function seededTalons(): Array<{ id: string; doc: TalonDoc }> {
  return [
    {
      id: WALL_CHECK_ID,
      doc: {
        ...authored(),
        name: WALL_CHECK_NAME,
        description: 'look at the wall before doors open',
        enabled: true,
        trigger: {
          type: 'schedule',
          entries: [
            {
              id: 'entry-wall-check',
              days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
              time: '09:00',
            },
          ],
        },
        condition: {
          type: 'visual_check',
          expectation: 'the wall should be showing the content loop, not the windows desktop.',
          monitor: 1,
        },
        outputs: [{ type: 'email' }],
        scope: { machineIds: [MACHINE_ID] },
        cooldownMinutes: 60,
        nextRunAt: Timestamp.fromMillis(Date.now() + 6 * HOUR_MS),
        lastRunAt: tsAgo(3 * HOUR_MS),
        lastRunStatus: 'failed',
        lastRunId: 'e2e-run-wall-fail',
        consecutiveFailures: 1,
      },
    },
    {
      id: CRASH_PAGE_ID,
      doc: {
        ...authored(),
        name: CRASH_PAGE_NAME,
        description: 'page the on-call tech when the show process dies',
        enabled: true,
        trigger: { type: 'event', eventTypes: ['process_crash'] },
        condition: { type: 'none' },
        outputs: [{ type: 'email' }],
        scope: { machineIds: null },
        cooldownMinutes: 15,
        lastRunAt: tsAgo(26 * HOUR_MS),
        lastRunStatus: 'succeeded',
        lastRunId: 'e2e-run-crash-page',
        consecutiveFailures: 0,
      },
    },
  ];
}

/**
 * Four runs: three on the wall check (so the expanded history has an order to
 * assert and covers the fail-verdict, pass-verdict and no-outputs renders) and
 * one on the crash talon, which must NOT leak into the wall check's panel —
 * `useTalonRuns` filters by `talonId`.
 */
function seededRuns(): Array<{ id: string; doc: TalonRunDoc }> {
  return [
    {
      id: 'e2e-run-wall-fail',
      doc: {
        talonId: WALL_CHECK_ID,
        talonName: WALL_CHECK_NAME,
        triggerType: 'schedule',
        triggerSummary: 'daily at 09:00',
        machineId: MACHINE_ID,
        machineName: MACHINE_ID,
        status: 'failed',
        startedAt: tsAgo(3 * HOUR_MS),
        completedAt: tsAgo(3 * HOUR_MS - 4_200),
        durationMs: 4_200,
        condition: {
          type: 'visual_check',
          verdict: 'fail',
          confidence: 0.92,
          reason: 'the windows desktop is on screen',
        },
        outputs: [{ type: 'email', status: 'sent' }],
        correlationId: 'e2e-corr-wall-fail',
      },
    },
    {
      id: 'e2e-run-wall-pass',
      doc: {
        talonId: WALL_CHECK_ID,
        talonName: WALL_CHECK_NAME,
        triggerType: 'schedule',
        triggerSummary: 'daily at 09:00',
        machineId: MACHINE_ID,
        machineName: MACHINE_ID,
        status: 'succeeded',
        startedAt: tsAgo(9 * HOUR_MS),
        completedAt: tsAgo(9 * HOUR_MS - 3_100),
        durationMs: 3_100,
        condition: {
          type: 'visual_check',
          verdict: 'pass',
          confidence: 0.97,
          reason: 'the content loop is playing',
        },
        outputs: [{ type: 'email', status: 'sent' }],
        correlationId: 'e2e-corr-wall-pass',
      },
    },
    {
      id: 'e2e-run-wall-skip',
      doc: {
        talonId: WALL_CHECK_ID,
        talonName: WALL_CHECK_NAME,
        triggerType: 'schedule',
        triggerSummary: 'daily at 09:00',
        machineId: MACHINE_ID,
        machineName: MACHINE_ID,
        status: 'skipped',
        startedAt: tsAgo(26 * HOUR_MS),
        outputs: [],
        error: 'machine_offline',
        correlationId: 'e2e-corr-wall-skip',
      },
    },
    {
      id: 'e2e-run-crash-page',
      doc: {
        talonId: CRASH_PAGE_ID,
        talonName: CRASH_PAGE_NAME,
        triggerType: 'event',
        triggerSummary: 'on process_crash',
        machineId: MACHINE_ID,
        machineName: MACHINE_ID,
        status: 'succeeded',
        startedAt: tsAgo(26 * HOUR_MS),
        completedAt: tsAgo(26 * HOUR_MS - 900),
        durationMs: 900,
        outputs: [{ type: 'email', status: 'sent' }],
        correlationId: 'e2e-corr-crash-page',
      },
    },
  ];
}

async function seedTalons(): Promise<void> {
  const site = getAdminDb().collection('sites').doc(SITE_ID);
  await Promise.all(
    seededTalons().map(({ id, doc }) => site.collection('talons').doc(id).set(doc)),
  );
  await Promise.all(
    seededRuns().map(({ id, doc }) => site.collection('talon_runs').doc(id).set(doc)),
  );
}

/**
 * Wipes the three talon collections wholesale. Nothing else in the suite writes
 * them, and the create test mints an auto-id document that only a wholesale
 * clear can catch.
 */
async function clearTalons(): Promise<void> {
  const site = getAdminDb().collection('sites').doc(SITE_ID);
  for (const collectionName of ['talons', 'talon_runs', 'talon_secrets'] as const) {
    const refs = await site.collection(collectionName).listDocuments();
    await Promise.all(refs.map((ref) => ref.delete()));
  }
}

async function readTalon(talonId: string): Promise<TalonDoc | undefined> {
  const snap = await getAdminDb()
    .collection('sites').doc(SITE_ID)
    .collection('talons').doc(talonId)
    .get();
  return snap.data() as TalonDoc | undefined;
}

test.beforeEach(async () => {
  await clearTalons();
  // The scope column and the editor's machine picker both read the site's
  // machines; one is enough and matches how sibling specs seed site-A.
  await seedMachine(SITE_ID, MACHINE_ID);
});

test.afterEach(async () => {
  await clearTalons();
});

async function gotoTalons(page: Page): Promise<void> {
  await page.goto('/talons');
  // 10s, not the 5s default: AuthContext hydrates against the auth emulator
  // before the page renders, which races the default on cold runs.
  await expect(page.getByRole('heading', { name: 'talons', exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

function rowByName(page: Page, name: string) {
  return page.getByTestId('talon-row').filter({ hasText: name });
}

test('the page switcher navigates from the dashboard to /talons', async ({ page }) => {
  await page.goto('/dashboard');

  // The page-switcher trigger is the breadcrumb button carrying the current
  // page name, lowercase.
  const pageSwitcher = page.getByRole('button', { name: /^dashboard$/i });
  await expect(pageSwitcher).toBeVisible({ timeout: 15_000 });
  await pageSwitcher.click();

  // NAV_ITEMS renders name + description in one menuitem, so anchor on the name.
  await page.getByRole('menuitem').filter({ hasText: /^talons/ }).first().click();

  await expect(page).toHaveURL(/\/talons$/);
  await expect(page.getByRole('heading', { name: 'talons', exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

test('the list renders seeded talons with their state, trigger and last run', async ({ page }) => {
  await seedTalons();
  await gotoTalons(page);

  const rows = page.getByTestId('talon-row');
  await expect(rows).toHaveCount(2);
  // Client-side name sort (useTalons) — "e2e crash page" before "e2e wall check".
  await expect(rows.nth(0)).toContainText(CRASH_PAGE_NAME);
  await expect(rows.nth(1)).toContainText(WALL_CHECK_NAME);

  const wall = rowByName(page, WALL_CHECK_NAME);
  // Filled-vs-hollow dot; its aria-label is the whole state vocabulary.
  await expect(wall.getByRole('img', { name: 'enabled' })).toBeVisible();
  // formatTrigger collapses all seven days to "daily"; the clock half follows
  // the viewer's 12h/24h preference, so it is deliberately not asserted.
  await expect(wall).toContainText('daily at');
  await expect(wall).toContainText('visual check');
  await expect(wall).toContainText('email');
  await expect(wall.getByRole('img', { name: 'failed' })).toBeVisible();
  await expect(wall).toContainText('3h ago');

  const crash = rowByName(page, CRASH_PAGE_NAME);
  await expect(crash).toContainText('on process_crash');
  await expect(crash.getByRole('img', { name: 'succeeded' })).toBeVisible();
  await expect(crash).toContainText('1d ago');
});

test('expanding a row loads that talon run history, newest first', async ({ page }) => {
  await seedTalons();
  await gotoTalons(page);

  const wall = rowByName(page, WALL_CHECK_NAME);
  await expect(wall.getByTestId('talon-run-row')).toHaveCount(0);

  await wall.getByRole('button', { name: 'expand run history' }).click();
  await expect(wall.getByText('recent runs', { exact: true })).toBeVisible();

  // Three, not four: the crash talon's run must not leak across the talonId filter.
  const runs = wall.getByTestId('talon-run-row');
  await expect(runs).toHaveCount(3);

  const newest = runs.nth(0);
  await expect(newest).toContainText('daily at 09:00');
  await expect(newest).toContainText('verdict: fail');
  await expect(newest).toContainText('the windows desktop is on screen');
  await expect(newest).toContainText('1/1 sent');
  await expect(newest).toContainText('4.2s');
  await expect(newest).toContainText('3h ago');

  await expect(runs.nth(1)).toContainText('verdict: pass');
  await expect(runs.nth(1)).toContainText('9h ago');

  // No outputs recorded and no condition — the row falls through to the error.
  await expect(runs.nth(2)).toContainText('no outputs');
  await expect(runs.nth(2)).toContainText('machine_offline');

  await wall.getByRole('button', { name: 'collapse run history' }).click();
  await expect(wall.getByTestId('talon-run-row')).toHaveCount(0);
});

test('the editor creates a schedule + email talon and the list picks it up', async ({ page }) => {
  await gotoTalons(page);
  await expect(page.getByText('no talons yet', { exact: true })).toBeVisible();

  await page.getByTestId('talon-create').click();

  const editor = page.getByTestId('talon-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByText('new talon', { exact: true })).toBeVisible();

  // The editor's defaults ARE the case under test: an "at times" schedule with
  // one weekday entry, no condition, all machines, one email output.
  await expect(editor.getByTestId('trigger-schedule')).toBeVisible();
  await expect(editor.getByTestId('output-row')).toHaveCount(1);

  const name = `e2e created talon ${Date.now()}`;
  await editor.locator('#talon-name').fill(name);

  const createResponse = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/sites/${SITE_ID}/talons`) && res.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await editor.getByTestId('talon-editor-save').click();
  expect((await createResponse).status()).toBe(201);

  await expect(page.getByText('talon created', { exact: true })).toBeVisible();
  await expect(editor).not.toBeVisible();
  await expect(rowByName(page, name)).toBeVisible();

  // Admin SDK read-back: the store persisted the validator's NORMALIZED value,
  // and stamped the server-owned authorship fields itself.
  const snap = await getAdminDb()
    .collection('sites').doc(SITE_ID)
    .collection('talons').get();
  expect(snap.size).toBe(1);
  const created = snap.docs[0].data() as TalonDoc;
  expect(created.name).toBe(name);
  expect(created.enabled).toBe(true);
  expect(created.trigger).toMatchObject({
    type: 'schedule',
    entries: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:00' }],
  });
  expect(created.condition).toEqual({ type: 'none' });
  expect(created.outputs).toEqual([{ type: 'email' }]);
  expect(created.scope).toEqual({ machineIds: null });
  expect(created.createdBy).toBe(TEST_USERS.admin.uid);
  expect(created.createdVia).toBe('ui');
});

test('the row toggle disables and re-enables the talon', async ({ page }) => {
  await seedTalons();
  await gotoTalons(page);

  const crash = rowByName(page, CRASH_PAGE_NAME);
  await expect(crash.getByRole('img', { name: 'enabled' })).toBeVisible();

  await crash.getByTestId('talon-toggle').click();
  await expect(page.getByText('talon disabled', { exact: true })).toBeVisible();
  // The dot flips off the live snapshot, so seeing it proves the write landed.
  await expect(crash.getByRole('img', { name: 'disabled' })).toBeVisible();
  expect((await readTalon(CRASH_PAGE_ID))?.enabled).toBe(false);

  await crash.getByTestId('talon-toggle').click();
  await expect(crash.getByRole('img', { name: 'enabled' })).toBeVisible();
  expect((await readTalon(CRASH_PAGE_ID))?.enabled).toBe(true);
});

test('the empty state sits where the list did, without pushing the page down', async ({ page }) => {
  await seedTalons();
  await gotoTalons(page);
  await expect(page.getByTestId('talon-row')).toHaveCount(2);

  // `main` holds exactly two element children: the heading + "create talon"
  // block, then whichever of error / loading / no-sites / empty / list the page
  // resolved to. Measuring the second child compares the two branches directly.
  const branch = page.locator('main > *:nth-child(2)');
  const heading = page.getByRole('heading', { name: 'talons', exact: true });

  const listBox = await branch.boundingBox();
  const listHeadingBox = await heading.boundingBox();
  if (!listBox || !listHeadingBox) {
    throw new Error('populated /talons geometry was unavailable');
  }

  // Dropping the documents flips the SAME mounted page to its empty state via
  // the live listener — the transition the "must not push content down" comment
  // on page.tsx is about, and the one a reserved-space regression would break.
  await clearTalons();
  await expect(page.getByText('no talons yet', { exact: true })).toBeVisible();
  await expect(page.getByTestId('talon-row')).toHaveCount(0);

  const emptyBox = await branch.boundingBox();
  const emptyHeadingBox = await heading.boundingBox();
  if (!emptyBox || !emptyHeadingBox) {
    throw new Error('empty /talons geometry was unavailable');
  }

  expect(Math.abs(emptyBox.y - listBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(emptyBox.x - listBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(emptyHeadingBox.y - listHeadingBox.y)).toBeLessThanOrEqual(1);
});
