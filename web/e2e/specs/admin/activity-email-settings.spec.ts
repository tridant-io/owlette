/**
 * Admin — activity email settings: the superadmin-only `platform` card on
 * `/admin/alerts` (a switch and up to ten addresses) and its API
 * (`GET`/`PUT /api/admin/activity/settings`).
 *
 * The settings live in two fields on `global/activity_watch`, the doc the cron
 * keeps its own state on, so cleanup removes just those two fields.
 *
 * A session call from a test would lose the HttpOnly+Secure `__session` cookie on
 * plain http (see access-control/admin-api-403), so the site admin's refused PUT
 * is a same-origin fetch inside the page.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { test, expect, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';

const STATE = () => getAdminDb().collection('global').doc('activity_watch');

const FIRST = 'first-e2e@example.test';
const SECOND = 'second-e2e@example.test';

async function reset() {
  await STATE().set({ emailEnabled: FieldValue.delete(), emailRecipients: FieldValue.delete() }, { merge: true });
}

async function openAlerts(page: Page) {
  await page.goto('/admin/alerts');
  await expect(page.getByRole('heading', { name: 'alerts', exact: true })).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(reset);
test.afterAll(reset);

test.describe('as a superadmin', () => {
  test.use(roleState('superadmin'));

  test('the card sits under platform, after built-in and before custom rules', async ({ page }) => {
    await openAlerts(page);

    await expect(page.getByRole('heading', { name: /^platform/ })).toContainText('superadmins only');
    await expect(page.getByRole('switch', { name: 'activity findings' })).toBeChecked();
    await expect(page.getByText('no addresses: nothing is sent')).toBeVisible();
    await expect(page.getByRole('link', { name: 'see what was flagged' })).toHaveAttribute('href', '/admin/activity?view=flagged');

    const y = async (name: string | RegExp) => (await page.getByRole('heading', { name }).boundingBox())!.y;
    expect(await y(/^built-in/)).toBeLessThan(await y(/^platform/));
    expect(await y(/^platform/)).toBeLessThan(await y('custom rules'));
  });

  test('two addresses survive a reload, one can be removed, and the switch saves', async ({ page }) => {
    await openAlerts(page);
    const input = page.getByPlaceholder('add an email address');

    await input.fill(FIRST);
    await page.getByRole('button', { name: 'add', exact: true }).click();
    await expect(page.getByRole('button', { name: `remove ${FIRST}` })).toBeVisible();
    await input.fill(SECOND.toUpperCase());
    await input.press('Enter');
    await expect(page.getByRole('button', { name: `remove ${SECOND}` })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: `remove ${FIRST}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `remove ${SECOND}` })).toBeVisible();
    expect((await STATE().get()).get('emailRecipients')).toEqual([FIRST, SECOND]);

    await page.getByRole('button', { name: `remove ${FIRST}` }).click();
    await expect(page.getByRole('button', { name: `remove ${FIRST}` })).toHaveCount(0);
    await expect.poll(async () => (await STATE().get()).get('emailRecipients')).toEqual([SECOND]);

    const toggle = page.getByRole('switch', { name: 'activity findings' });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(async () => (await STATE().get()).get('emailEnabled')).toBe(false);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(async () => (await STATE().get()).get('emailEnabled')).toBe(true);
  });

  test('refuses an invalid and a duplicate address inline', async ({ page }) => {
    await openAlerts(page);
    const input = page.getByPlaceholder('add an email address');

    await input.fill('not-an-address');
    await input.press('Enter');
    await expect(page.getByText('that is not an email address')).toBeVisible();

    await input.fill(FIRST);
    await input.press('Enter');
    await expect(page.getByRole('button', { name: `remove ${FIRST}` })).toBeVisible();
    await input.fill(FIRST);
    await input.press('Enter');
    await expect(page.getByText('already on the list')).toBeVisible();
    expect((await STATE().get()).get('emailRecipients')).toEqual([FIRST]);
  });

  test('keeps the cron fields the state doc already holds', async ({ page }) => {
    await STATE().set({ scannedThrough: 12345 }, { merge: true });
    await openAlerts(page);
    await page.getByPlaceholder('add an email address').fill(FIRST);
    await page.getByRole('button', { name: 'add', exact: true }).click();
    await expect(page.getByRole('button', { name: `remove ${FIRST}` })).toBeVisible();

    await expect.poll(async () => (await STATE().get()).get('emailRecipients')).toEqual([FIRST]);
    expect((await STATE().get()).get('scannedThrough')).toBe(12345);
    await STATE().set({ scannedThrough: FieldValue.delete() }, { merge: true });
  });
});

test.describe('at a phone width', () => {
  test.use({ ...roleState('superadmin'), viewport: { width: 390, height: 844 } });

  test('the card has no horizontal overflow and every control is on screen', async ({ page }) => {
    await STATE().set({ emailRecipients: [FIRST, 'a-rather-long-address-for-a-phone@subdomain.example.test'] }, { merge: true });
    await openAlerts(page);
    await expect(page.getByRole('switch', { name: 'activity findings' })).toBeVisible();

    await assertNoHorizontalOverflow(page);
    await expectFullyWithinViewport(page, page.getByRole('switch', { name: 'activity findings' }), 'the switch');
    await expectFullyWithinViewport(page, page.getByPlaceholder('add an email address'), 'the address field');
    await expectFullyWithinViewport(page, page.getByRole('button', { name: 'add', exact: true }), 'the add button');
    await expectFullyWithinViewport(page, page.getByRole('link', { name: 'see what was flagged' }), 'the feed link');
    for (const remove of await page.getByRole('button', { name: /^remove / }).all()) {
      await expectFullyWithinViewport(page, remove, 'a remove button');
    }
  });
});

test.describe('as a site admin', () => {
  test.use(roleState('admin'));

  test('sees no platform section and is refused by the API', async ({ page }) => {
    await openAlerts(page);
    await expect(page.getByRole('heading', { name: 'custom rules' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^platform/ })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'activity findings' })).toHaveCount(0);

    const status = await page.evaluate(async () => {
      const r = await fetch('/api/admin/activity/settings', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, recipients: [] }),
      });
      return r.status;
    });
    expect(status).toBe(403);
    expect((await STATE().get()).get('emailEnabled')).toBeUndefined();
  });
});
