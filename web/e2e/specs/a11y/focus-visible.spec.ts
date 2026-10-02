import { test, expect, type Page } from '@playwright/test';

/**
 * keyboard focus must be visible. axe can't measure a focus indicator, which is
 * how a 1px outline at 30% alpha (1.3:1 against the page) shipped app-wide.
 * this asserts the computed outline on whatever the keyboard lands on.
 */

test.use({ storageState: { cookies: [], origins: [] } });

async function tabUntil(page: Page, matches: () => Promise<boolean>, max = 20) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await matches()) return;
  }
  throw new Error(`no matching element within ${max} tab presses`);
}

async function focusedOutline(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      width: parseFloat(style.outlineWidth),
      style: style.outlineStyle,
      color: style.outlineColor,
      focusVisible: el.matches(':focus-visible'),
    };
  });
}

test('a keyboard-focused button draws a solid 2px ring', async ({ page }) => {
  await page.goto('/login');
  const google = page.getByRole('button', { name: /continue with google/i });
  await expect(google).toBeVisible();

  await tabUntil(page, () => google.evaluate((el) => el === document.activeElement));
  const outline = await focusedOutline(page);

  expect(outline.focusVisible).toBe(true);
  expect(outline.style).toBe('solid');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  expect(outline.color).not.toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent/);
});
