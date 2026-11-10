import { test, expect } from '@playwright/test';
import { CLI_DIR_URL } from '@/lib/repoLinks';

// Public landing-page section — no auth state required. Run unauthenticated so
// the test mirrors what an anonymous visitor sees and isn't sensitive to the
// shared storageState seeded in global-setup.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('developer section (landing)', () => {
  test('#developers anchor scrolls the section into view', async ({ page }) => {
    await page.goto('/#developers');

    const section = page.locator('section#developers');
    await expect(section).toBeVisible();
    await expect(section).toBeInViewport();
    await expect(
      section.getByRole('heading', { name: /every dashboard action, scriptable/i })
    ).toBeVisible();
  });

  test('both code tabs render and switching swaps the visible code', async ({ page }) => {
    await page.goto('/#developers');

    const section = page.locator('section#developers');
    const curlTab = section.getByRole('tab', { name: 'curl', exact: true });
    const cliTab = section.getByRole('tab', { name: 'cli', exact: true });

    await expect(section.getByRole('tab')).toHaveCount(2);
    await expect(curlTab).toBeVisible();
    await expect(cliTab).toBeVisible();

    // Default tab is curl — the curl invocation should be on screen.
    await expect(curlTab).toHaveAttribute('aria-selected', 'true');
    const codeBlock = section.locator('pre code');
    await expect(codeBlock).toContainText('curl -X POST');
    await expect(codeBlock).toContainText('Idempotency-Key');

    // Switch to cli — code should swap to the owlette CLI invocation. The
    // sample must only name things a visitor can run: neither package is on
    // npm, so no `npm i -g @owlette/…` and no SDK import.
    await cliTab.click();
    await expect(cliTab).toHaveAttribute('aria-selected', 'true');
    await expect(codeBlock).toContainText('owlette auth login');
    await expect(codeBlock).toContainText('owlette process restart');
    await expect(codeBlock).not.toContainText('curl -X POST');
    await expect(codeBlock).not.toContainText('@owlette/');
  });

  test('bottom CTAs link to the API reference and CLI repo', async ({ page }) => {
    await page.goto('/#developers');

    const section = page.locator('section#developers');

    await expect(
      section.getByRole('link', { name: /read the api reference/i })
    ).toHaveAttribute('href', '/docs/api');

    const cliLink = section.getByRole('link', { name: /install the cli/i });
    await expect(cliLink).toHaveAttribute('href', CLI_DIR_URL);
    await expect(cliLink).toHaveAttribute('target', '_blank');
    await expect(cliLink).toHaveAttribute('rel', /noopener/);
  });
});
