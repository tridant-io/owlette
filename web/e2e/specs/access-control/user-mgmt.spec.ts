/**
 * Access-control — /admin/users (RequireAdminAccess, superadmin). Covers the stats row,
 * per-role badges, the three sites-column variants, the "You" badge, the
 * role-change dialog, and the self-demote guard.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';

test.use(roleState('superadmin'));

test.describe('/admin/users — stats row', () => {
  test('shows 4 cards in ascending-privilege order', async ({ page }) => {
    await page.goto('/admin/users');

    const labels = ['total users', 'members', 'site admins', 'superadmins'];
    for (const label of labels) {
      // Scoped to main: the admin nav now carries a "members" link too
      // (e6e99cbf opened the panel to site admins), so the bare text match
      // resolves to two elements and trips strict mode.
      await expect(page.getByRole('main').getByText(label, { exact: true })).toBeVisible();
    }

    // DOM order must match ascending privilege. Scoped to main for the same
    // reason as above — the nav's "manage site members" description also
    // matches the regex.
    const texts = await page
      .getByRole('main')
      .locator('p.text-xs.text-muted-foreground')
      .filter({ hasText: /total users|members|site admins|superadmins/ })
      .allTextContents();
    expect(texts).toEqual(labels);
  });

  test('counts reflect seeded fleet (1 super, 1 admin, 2 members)', async ({ page }) => {
    await page.goto('/admin/users');

    // Chip = `.bg-card.rounded-lg` around a p.text-lg count and p.text-xs label.
    const card = (label: string) =>
      page.locator('div.bg-card.rounded-lg').filter({ hasText: label });

    // Four fixtures, and TWO of them are global `member`: the plain member and
    // the `owner` fixture. Owner is a per-site standing, not a global role — a
    // self-serve customer owns a site while remaining a global member — so this
    // chip counts it under members, which is what the column actually measures.
    await expect(card('total users').locator('p.text-lg')).toHaveText('4');
    await expect(card('members').locator('p.text-lg')).toHaveText('2');
    await expect(card('site admins').locator('p.text-lg')).toHaveText('1');
    await expect(card('superadmins').locator('p.text-lg')).toHaveText('1');
  });
});

test.describe('/admin/users — role badges', () => {
  test('superadmin row shows Crown badge + "all sites" + You pill', async ({ page }) => {
    await page.goto('/admin/users');

    const row = page.getByRole('row', { name: /super@e2e\.test/ });
    await expect(row.getByText('superadmin', { exact: true })).toBeVisible();
    await expect(row.getByText('all sites')).toBeVisible();
    await expect(row.getByText('you', { exact: true })).toBeVisible();
  });

  test('admin row shows admin badge + assigned site pill', async ({ page }) => {
    await page.goto('/admin/users');

    const row = page.getByRole('row', { name: /admin@e2e\.test/ });
    await expect(row.getByText('admin', { exact: true })).toBeVisible();
    // Green site-id pill; the seeded admin has sites: ['site-A'].
    await expect(row.getByText('site-A')).toBeVisible();
  });

  test('member row shows member badge + site count (not pill list)', async ({ page }) => {
    await page.goto('/admin/users');

    const row = page.getByRole('row', { name: /member@e2e\.test/ });
    await expect(row.getByText('member', { exact: true })).toBeVisible();
    // Two sibling spans ("1" + "site"), not one text run — target each.
    const sitesCell = row.locator('td').nth(2);
    await expect(sitesCell).toContainText('1');
    await expect(sitesCell).toContainText(/site/);
    await expect(row.getByText('site-A', { exact: true })).toHaveCount(0);
  });
});

test.describe('/admin/users — role-change dialog', () => {
  test('save button disabled until role changes', async ({ page }) => {
    await page.goto('/admin/users');

    const memberRow = page.getByRole('row', { name: /member@e2e\.test/ });
    await memberRow.getByRole('button').last().click(); // ⋮ menu
    await page.getByRole('menuitem', { name: /change role/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/current role:\s*member/i)).toBeVisible();

    // Disabled while newRole === currentRole.
    const saveBtn = dialog.getByRole('button', { name: /save role/i });
    await expect(saveBtn).toBeDisabled();
  });

  test('description updates live when new role picked; save enables', async ({ page }) => {
    await page.goto('/admin/users');

    const memberRow = page.getByRole('row', { name: /member@e2e\.test/ });
    await memberRow.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: /change role/i }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: /admin/i }).first().click();

    await expect(dialog.getByText(/site-scoped elevated tier/i)).toBeVisible();

    const saveBtn = dialog.getByRole('button', { name: /save role/i });
    await expect(saveBtn).toBeEnabled();
  });
});

test.describe('/admin/users — self-demote guard', () => {
  test('opening role change on own (superadmin) row is blocked', async ({ page }) => {
    await page.goto('/admin/users');

    const selfRow = page.getByRole('row', { name: /super@e2e\.test/ });
    await selfRow.getByRole('button').last().click();

    const changeRoleItem = page.getByRole('menuitem', { name: /change role/i });
    await expect(changeRoleItem).toBeDisabled();
  });
});
