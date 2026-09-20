/**
 * Admin — email page. Configuration is READ-ONLY (driven by `RESEND_API_KEY` / `ADMIN_EMAIL_*`),
 * so the only interactive surface is the 9-template selector and the "send test email" button.
 *
 * Covers: config card read-through from /api/platform/email/config, the template selector updating
 * its description, and /api/test-email stubbed for both success and failure panels.
 *
 * Stubbed rather than hitting Resend — deterministic, and no live API key in the emulator env.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { roleState } from '../../helpers/roles';

test.use(roleState('superadmin'));

async function stubTestEmail(page: Page, response: Record<string, unknown>, status = 200) {
  await page.route('**/api/test-email', async (route: Route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

test('config card renders provider + from/admin emails + environment', async ({ page }) => {
  await page.goto('/admin/email');

  // 10s because RequireAdminAccess gates on AuthContext hydrating against the auth emulator, which
  // races the default 5s timeout on cold-emulator runs. Same bump throughout this spec.
  await expect(
    page.getByRole('heading', { name: 'email', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // The <dd> reads "Resend connected" — badge is inline — so substring match, not `exact: true`.
  await expect(page.getByText('Resend').first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('provider', { exact: true })).toBeVisible();
  await expect(page.getByText('environment', { exact: true })).toBeVisible();
  await expect(page.getByText('from address', { exact: true })).toBeVisible();
  await expect(page.getByText('admin email', { exact: true })).toBeVisible();
});

test('template selector shows all 10 templates and updates the description', async ({ page }) => {
  await page.goto('/admin/email');

  await expect(
    page.getByRole('heading', { name: 'email', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const select = page.locator('#template-select');
  await expect(select).toBeVisible();

  // Default is "test" — its description lives underneath the select.
  await expect(page.getByText('generic config verification')).toBeVisible();

  // Pick "process crashed" — description updates to its text.
  await select.selectOption('process_crash');
  await expect(page.getByText('monitored process stopped unexpectedly')).toBeVisible();

  // The newest template registers in the selector too (guards the
  // hand-duplicated preview lists staying in sync).
  await select.selectOption('api_key_expiring');
  await expect(page.getByText('daily notice ladder before an api key expires')).toBeVisible();

  // All 10 template options present.
  const optionCount = await select.locator('option').count();
  expect(optionCount).toBe(10);
});

test('clicking "send test email" with a stubbed success response shows the success panel', async ({ page }) => {
  await stubTestEmail(page, {
    success: true,
    to: 'e2e-recipient@example.test',
    emailId: 're_e2e_stubbed_123',
    template: 'test',
  });

  await page.goto('/admin/email');
  await expect(
    page.getByRole('heading', { name: 'email', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /^send test email$/i }).click();

  await expect(page.getByText('Test email sent successfully!', { exact: true })).toBeVisible();
  // Scope to main so the toast's duplicate text doesn't trip strict-mode.
  const main = page.getByRole('main');
  await expect(main.getByText('Email sent successfully', { exact: true })).toBeVisible();
  await expect(main.getByText('e2e-recipient@example.test', { exact: true })).toBeVisible();
  await expect(main.getByText('re_e2e_stubbed_123', { exact: true })).toBeVisible();
});

test('clicking "send test email" with a stubbed failure surfaces the error', async ({ page }) => {
  await stubTestEmail(
    page,
    { success: false, error: 'RESEND_API_KEY missing', details: 'env var unset' },
    500,
  );

  await page.goto('/admin/email');
  await expect(
    page.getByRole('heading', { name: 'email', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /^send test email$/i }).click();

  await expect(page.getByText('Failed to send test email', { exact: true })).toBeVisible();
  // Scope to main; the toast description echoes the same `error` / `details` strings.
  const main = page.getByRole('main');
  await expect(main.getByText('Failed to send email', { exact: true })).toBeVisible();
  await expect(main.getByText('RESEND_API_KEY missing', { exact: true })).toBeVisible();
  await expect(main.getByText(/env var unset/)).toBeVisible();
});
