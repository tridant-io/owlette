/**
 * the "signed in as <email>" footer of the pages owlette swoop opens in the
 * browser (AuthSignedInAs in components/auth/AuthShell.tsx).
 */

import { expect, type Page } from '@playwright/test';

/**
 * at a phone's width and at owlette swoop's window width (1060 px), the email
 * stays on one line inside the card and "not you? sign in as someone else"
 * sits on a line of its own under it. restores the viewport after.
 */
export async function expectSignedInFooterOnOneLine(page: Page): Promise<void> {
  const original = page.viewportSize();
  const email = page.getByTestId('signed-in-email');
  const way = page.getByTestId('sign-in-as-someone-else');
  for (const width of [390, 1060]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(way).toBeVisible();
    const lineHeight = await email.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const [e, w, card] = await Promise.all([
      email.boundingBox(),
      way.boundingBox(),
      page.locator('[data-slot="card"]').boundingBox(),
    ]);
    expect(e!.height, `email wrapped at ${width} px`).toBeLessThan(lineHeight * 1.5);
    expect(e!.x + e!.width, `email ran out of the card at ${width} px`).toBeLessThanOrEqual(card!.x + card!.width);
    expect(w!.y, `the way out shares the email's line at ${width} px`).toBeGreaterThanOrEqual(e!.y + e!.height - 1);
  }
  if (original) await page.setViewportSize(original);
}
