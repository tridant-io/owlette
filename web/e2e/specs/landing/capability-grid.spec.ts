import { test, expect } from '@playwright/test';

// Public landing page — no auth required.
test.use({ storageState: { cookies: [], origins: [] } });

const CAPABILITY_ROWS = [
  ['monitor', 'control', 'deploy'],
  ['diagnose', 'display', 'automate'],
] as const;

test.describe('landing capability grid', () => {
  test('renders all six capability cards in a 3-column desktop grid', async ({ page }) => {
    await page.goto('/');

    // Desktop variant — UseCaseSection renders both a mobile accordion
    // (lg:hidden) and a desktop grid (hidden lg:block). Playwright's
    // Desktop Chrome viewport (1280px) puts us in the lg breakpoint, so
    // scope to the desktop block to avoid matching the mobile duplicates.
    const desktop = page.locator('div.hidden.lg\\:block').first();
    await expect(desktop).toBeVisible();

    const rows = desktop.locator('.grid.grid-cols-3.gap-6.items-start');
    await expect(rows).toHaveCount(2);

    for (const [rowIndex, labels] of CAPABILITY_ROWS.entries()) {
      await expect(rows.nth(rowIndex).getByRole('heading', { level: 3 })).toHaveText(labels);
    }
  });

  test('clicking a card reveals its expanded description', async ({ page }) => {
    await page.goto('/');

    const desktop = page.locator('div.hidden.lg\\:block').first();
    // The "monitor" card's expanded copy is unique enough to assert against.
    const expandedSnippet = /live cpu, memory, gpu, and disk usage/i;
    await expect(desktop.getByText(expandedSnippet)).toHaveCount(0);

    await desktop.getByRole('button', { name: /^monitor/i }).click();
    await expect(desktop.getByText(expandedSnippet)).toBeVisible();
  });

  test('clicking a preview opens the lightbox and Escape closes it', async ({ page }) => {
    await page.goto('/');

    const desktop = page.locator('div.hidden.lg\\:block').first();

    // Open a card so the shared preview area appears below the grid.
    await desktop.getByRole('button', { name: /^monitor/i }).click();

    const monitorPreview = desktop.getByRole('button', { name: 'open monitor preview' });
    await expect(monitorPreview).toBeVisible();
    await monitorPreview.click();

    const lightbox = page.getByRole('dialog', { name: 'monitor preview' });
    await expect(lightbox).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
  });

  test('the lightbox takes focus, keeps tab inside, and hands it back', async ({ page }) => {
    await page.goto('/');

    const desktop = page.locator('div.hidden.lg\\:block').first();
    await desktop.getByRole('button', { name: /^monitor/i }).click();
    const monitorPreview = desktop.getByRole('button', { name: 'open monitor preview' });
    await monitorPreview.focus();
    await page.keyboard.press('Enter');

    const lightbox = page.getByRole('dialog', { name: 'monitor preview' });
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole('button', { name: 'close preview' })).toBeFocused();
    await expect(lightbox.getByRole('button', { name: 'previous preview' })).toBeVisible();
    await expect(lightbox.getByRole('button', { name: 'next preview' })).toBeVisible();
    await expect(lightbox.getByRole('button', { name: 'show monitor preview' })).toHaveAttribute(
      'aria-current',
      'true',
    );

    // backwards off the first control wraps to the last, not out to the page.
    await page.keyboard.press('Shift+Tab');
    expect(await lightbox.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    await expect(monitorPreview).toBeFocused();
  });

  test('focus returns to the preview of the capability shown last', async ({ page }) => {
    await page.goto('/');

    const desktop = page.locator('div.hidden.lg\\:block').first();
    await desktop.getByRole('button', { name: /^monitor/i }).click();
    await desktop.getByRole('button', { name: 'open monitor preview' }).click();

    await page.getByRole('dialog').getByRole('button', { name: 'next preview' }).click();
    await expect(page.getByRole('dialog', { name: 'control preview' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(desktop.getByRole('button', { name: 'open control preview' })).toBeFocused();
  });
});
