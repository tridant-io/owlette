/**
 * the "signed in as <email>" footer of the pages owlette swoop opens in the
 * browser (AuthSignedInAs in components/auth/AuthShell.tsx).
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * at a phone's width and at owlette swoop's window width (1060 px), the email
 * stays on one line inside the card and "not you? sign in as someone else"
 * sits on a line of its own under it. attaches the card at each width and
 * restores the viewport after.
 */
export async function expectSignedInFooterOnOneLine(page: Page): Promise<void> {
  const original = page.viewportSize();
  const card = page.locator('[data-slot="card"]');
  const email = page.getByTestId('signed-in-email');
  const way = page.getByTestId('sign-in-as-someone-else');
  for (const width of [390, 1060]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(way).toBeVisible();
    const lineHeight = await email.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const [e, w, c] = await Promise.all([email.boundingBox(), way.boundingBox(), card.boundingBox()]);
    expect(e!.height, `email wrapped at ${width} px`).toBeLessThan(lineHeight * 1.5);
    expect(e!.x + e!.width, `email ran out of the card at ${width} px`).toBeLessThanOrEqual(c!.x + c!.width);
    expect(w!.y, `the way out shares the email's line at ${width} px`).toBeGreaterThanOrEqual(e!.y + e!.height - 1);

    const shot = test.info().outputPath(`signed-in-footer-${width}.png`);
    await card.screenshot({ path: shot, animations: 'disabled' });
    await test.info().attach(`signed-in footer at ${width} px`, { path: shot, contentType: 'image/png' });
  }
  if (original) await page.setViewportSize(original);
}
