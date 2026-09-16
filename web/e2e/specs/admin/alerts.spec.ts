/**
 * Admin — alerts page.
 *
 * Unlike webhooks/schedules, alert rules live in ONE doc at
 * `sites/{siteId}/settings/alerts` under a `rules` array (id, name, metric,
 * operator, value, severity, channels, enabled, cooldownMinutes).
 *
 * Covers list rendering, create, add-preset, toggle-enabled and delete — each
 * asserted through the UI and then read back with the Admin SDK.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SITE_ID = 'site-alert-tests';
const SITE_NAME = 'Z Alert Test Site';

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  operator: '>' | '<' | '>=' | '<=';
  value: number;
  severity: 'info' | 'warning' | 'critical';
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
}

const SEEDED_RULE: AlertRule = {
  id: 'seeded-rule-id',
  name: 'seeded test rule',
  metric: 'cpu_percent',
  operator: '>',
  value: 80,
  severity: 'warning',
  channels: ['email'],
  enabled: true,
  cooldownMinutes: 30,
};

async function setAlertRules(rules: AlertRule[]) {
  const db = getAdminDb();
  await db
    .collection('sites').doc(SITE_ID)
    .collection('settings').doc('alerts')
    .set({ rules }, { merge: true });
}

async function getAlertRules(): Promise<AlertRule[]> {
  const db = getAdminDb();
  const snap = await db
    .collection('sites').doc(SITE_ID)
    .collection('settings').doc('alerts')
    .get();
  return (snap.data()?.rules ?? []) as AlertRule[];
}

test.beforeEach(async () => {
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  // Reset to empty; each test seeds what it needs.
  await setAlertRules([]);
});

async function gotoAlertsForSeededSite(page: Page) {
  await page.goto('/admin/alerts');
  // 10s, not 5s: RequireAdminAccess holds a "verifying permissions..." gate while
  // AuthContext hydrates against the auth emulator, racing the default on cold runs.
  await expect(
    page.getByRole('heading', { name: 'alerts', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  const siteSelect = page.getByRole('combobox').first();
  await siteSelect.click();
  await page.getByRole('option', { name: SITE_NAME, exact: true }).click();
  await expect(siteSelect).toContainText(SITE_NAME);
}

test('lists a seeded rule with its severity badge and summary line', async ({ page }) => {
  await setAlertRules([SEEDED_RULE]);
  await gotoAlertsForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_RULE.name });
  await expect(row).toBeVisible();
  await expect(row.getByText('warning', { exact: true })).toBeVisible();
  // getMetricLabel renders "cpu_percent" as "CPU usage (%)"; assert on the
  // operator + threshold + channel instead.
  await expect(row).toContainText('> 80');
  await expect(row).toContainText('email');
  await expect(row).toContainText('cooldown 30m');
});

test('creating a rule adds it to the Firestore rules array', async ({ page }) => {
  await gotoAlertsForSeededSite(page);

  // Empty rules renders TWO "create rule" buttons (header + empty-state CTA).
  await page.getByRole('button', { name: /^create rule$/i }).first().click();

  const dialog = page.getByRole('dialog', { name: /^create alert rule$/i });
  await expect(dialog).toBeVisible();

  const ruleName = `E2E rule ${Date.now()}`;
  await dialog.getByLabel('name').fill(ruleName);
  // metric/operator/severity keep their defaults (cpu_percent, >, warning)
  await dialog.getByLabel('threshold').fill('95');
  // cooldown defaults to 30 (see openCreateDialog)

  await dialog.getByRole('button', { name: /^create$/i }).click();

  await expect(page.getByText('Rule created', { exact: true })).toBeVisible();

  const row = page.locator('div.rounded-lg.border').filter({ hasText: ruleName });
  await expect(row).toBeVisible();

  // Admin SDK — exactly one matching entry.
  const rules = await getAlertRules();
  const matching = rules.find((r) => r.name === ruleName);
  expect(matching).toBeDefined();
  expect(matching!.metric).toBe('cpu_percent');
  expect(matching!.operator).toBe('>');
  expect(matching!.value).toBe(95);
  expect(matching!.severity).toBe('warning');
  expect(matching!.channels).toEqual(expect.arrayContaining(['email', 'webhook']));
  expect(matching!.enabled).toBe(true);
});

test('adding a preset from the dropdown writes the template rule to Firestore', async ({ page }) => {
  await gotoAlertsForSeededSite(page);

  await page.getByRole('button', { name: /^presets$/i }).click();
  // Menu items read "GPU Overheating (gpu temp > 85)".
  await page.getByRole('menuitem', { name: /^GPU Overheating/ }).click();

  await expect(page.getByText('Preset "GPU Overheating" added', { exact: true })).toBeVisible();

  const rules = await getAlertRules();
  const gpu = rules.find((r) => r.name === 'GPU Overheating');
  expect(gpu).toBeDefined();
  expect(gpu!.metric).toBe('gpu_temp');
  expect(gpu!.operator).toBe('>');
  expect(gpu!.value).toBe(85);
});

test('toggling the enabled switch flips the rule in Firestore', async ({ page }) => {
  await setAlertRules([SEEDED_RULE]);
  await gotoAlertsForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_RULE.name });
  // shadcn Switch renders as role="switch".
  const toggle = row.getByRole('switch');
  await expect(toggle).toHaveAttribute('data-state', 'checked');
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-state', 'unchecked');

  // Admin SDK — rule is now disabled.
  const rules = await getAlertRules();
  const updated = rules.find((r) => r.id === SEEDED_RULE.id);
  expect(updated).toBeDefined();
  expect(updated!.enabled).toBe(false);
});

test('deleting a rule removes it from the Firestore rules array', async ({ page }) => {
  await setAlertRules([SEEDED_RULE]);
  await gotoAlertsForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_RULE.name });
  await row.locator('button:has(svg.lucide-trash-2)').click();

  const confirm = page.getByRole('dialog', { name: /^delete alert rule$/i });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(SEEDED_RULE.name);
  await confirm.getByRole('button', { name: /^delete$/i }).click();

  await expect(page.getByText('Rule deleted', { exact: true })).toBeVisible();

  const rules = await getAlertRules();
  expect(rules.find((r) => r.id === SEEDED_RULE.id)).toBeUndefined();
});
