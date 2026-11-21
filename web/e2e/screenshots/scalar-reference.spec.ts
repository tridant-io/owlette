/**
 * Screenshot - docs Scalar API reference.
 *
 * Output: `web/public/docs-screens/scalar-reference.png`
 * Used by: `web/content/docs/api/overview.mdx`
 */
import { expect } from '@playwright/test';
import {
  disableAnimations,
  saveDocsScreenshot,
  test,
} from './docs-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

test('scalar reference docs screenshot', async ({ page }) => {
  await page.goto('/docs/api', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);

  const scalarApp = page.locator('.scalar-app').first();
  await expect(scalarApp).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.introduction-section .section-header')).toContainText(
    /owlette api/i,
    { timeout: 30_000 },
  );

  await disableAnimations(page);
  await page.addStyleTag({
    content: `
      .scalar-app {
        height: 1000px !important;
        max-height: 1000px !important;
        overflow: hidden !important;
      }
    `,
  });
  await page.waitForTimeout(1000);
  await saveDocsScreenshot(scalarApp, 'scalar-reference.png');
});
