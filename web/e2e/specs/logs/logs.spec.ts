import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedLogEvents } from '../../helpers/coverageSeed';

test.use(roleState('superadmin'));

test.beforeEach(async () => {
  await seedLogEvents('site-A');
});

async function gotoSiteALogs(page: Page) {
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();

  const siteSwitcher = page.getByTestId('site-switcher-trigger');
  await expect(siteSwitcher).toBeVisible();
  if (!((await siteSwitcher.textContent()) ?? '').includes('Site A')) {
    await siteSwitcher.click();
    await page.getByRole('menuitem', { name: /Site A \(Assigned\)/ }).click();
    await expect(siteSwitcher).toContainText('Site A');
  }
}

test('filters by action, machine, level, and custom date; reset restores rows', async ({ page }) => {
  await gotoSiteALogs(page);
  await expect(page.getByText('TouchDesigner', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: /show filters/i }).click();

  await page.getByTestId('logs-filter-level').click();
  await page.getByRole('option', { name: 'warning' }).click();
  await expect(page.getByText(/deployment failed/i)).toBeVisible();
  await expect(page.getByText('agent started', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: /reset filters/i }).click();
  await expect(page.getByText('agent started', { exact: true })).toBeVisible();

  await page.getByTestId('logs-filter-machine').click();
  await page.getByRole('option', { name: 'e2e-logs-alt' }).click();
  await expect(page.getByText('agent started', { exact: true })).toBeVisible();
  await expect(page.getByText('TouchDesigner', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: /reset filters/i }).click();
  await page.getByTestId('logs-filter-action').click();
  await page.getByRole('option', { name: 'scheduled restart completed', exact: true }).click();
  await expect(page.getByText(/no logs found for this site/i)).toBeVisible();

  await page.getByRole('button', { name: /reset filters/i }).click();
  await page.getByTestId('logs-filter-date').click();
  await page.getByRole('option', { name: /custom range/i }).click();
  // Native <input type="date"> was replaced by the themed DatePicker (text input
  // + calendar popover); assert the two typed-entry fields by their placeholders.
  await expect(page.getByPlaceholder('start date')).toBeVisible();
  await expect(page.getByPlaceholder('end date')).toBeVisible();
});

test('expands rows, expands all, and opens the screenshot modal', async ({ page }) => {
  await gotoSiteALogs(page);
  await expect(page.getByTestId('log-row-e2e-log-crash')).toBeVisible();

  await page.getByTestId('log-row-e2e-log-crash').click();
  await expect(page.getByText(/TouchDesigner crashed with exit code 1/i)).toBeVisible();
  await page.getByAltText(/crash screenshot/i).first().click();
  await expect(page.getByAltText(/crash screenshot/i).last()).toBeVisible();
  await page.mouse.click(10, 10);

  await page.getByTestId('logs-expand-all').click();
  await expect(page.getByText(/Installer returned retryable warning/i)).toBeVisible();
  await page.getByTestId('logs-expand-all').click();
  await expect(page.getByText(/Installer returned retryable warning/i)).toHaveCount(1);
});

test('clear filtered logs removes only matching rows', async ({ page }) => {
  await gotoSiteALogs(page);
  await page.getByRole('button', { name: /show filters/i }).click();
  await page.getByTestId('logs-filter-level').click();
  await page.getByRole('option', { name: 'warning' }).click();

  await page.getByRole('button', { name: /clear logs/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: /clear logs/i }).click();

  await expect(page.getByText(/no logs found for this site/i)).toBeVisible();
  const remaining = await getAdminDb()
    .collection('sites')
    .doc('site-A')
    .collection('logs')
    .get();
  expect(remaining.docs.map((doc) => doc.id).sort()).toEqual(['e2e-log-crash', 'e2e-log-info']);
});

test('the process column reveals a clipped name, and stays quiet when it fits', async ({ page }) => {
  // jsdom can't prove this one — it needs real layout in a 116px column.
  await seedLogEvents('site-A', [
    {
      id: 'e2e-log-long-proc',
      action: 'process_crash',
      level: 'error',
      machineId: 'e2e-logs-machine',
      processName: 'constellation renderer node 07 (primary)',
      timestamp: new Date(),
    },
    {
      id: 'e2e-log-short-proc',
      action: 'agent_started',
      level: 'info',
      machineId: 'e2e-logs-machine',
      processName: 'td',
      timestamp: new Date(Date.now() - 60_000),
    },
  ]);
  await gotoSiteALogs(page);

  // The quiet case goes FIRST, while no tooltip exists anywhere: an open tooltip
  // renders over the row beneath it, so hovering the second cell would land on
  // the first cell's tooltip and Radix would keep it open.
  const whole = page.getByTestId('log-row-e2e-log-short-proc').getByTestId('log-process');
  await expect(whole).toBeVisible();
  // Radix stamps `data-state` on the trigger it wraps; a cell that fits is a
  // bare span with no trigger at all.
  await expect(whole).not.toHaveAttribute('data-state');
  await whole.hover();
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  const clipped = page.getByTestId('log-row-e2e-log-long-proc').getByTestId('log-process');
  await expect(clipped).toHaveAttribute('data-state', 'closed');
  await clipped.hover();
  await expect(page.getByRole('tooltip')).toContainText('constellation renderer node 07 (primary)');
});
