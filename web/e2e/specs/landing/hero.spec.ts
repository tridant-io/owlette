/**
 * Landing — hero regression. Pins the marketing-critical copy and CTAs so an
 * accidental edit fails CI instead of shipping. Public page, so no storage state.
 */

import { test, expect } from '@playwright/test';
import { HERO_HEADLINE, HERO_SUBHEADLINE } from '../../helpers/landing';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('landing — hero', () => {
  test('hero renders', async ({ page }) => {
    await page.goto('/');

    const hero = page.locator('section', {
      has: page.getByRole('heading', { name: HERO_HEADLINE }),
    }).first();

    // Whichever phrase this request rolled from HERO_HEADLINES.
    await expect(
      hero.getByRole('heading', { name: HERO_HEADLINE }),
    ).toBeVisible();

    await expect(
      hero.getByRole('link', { name: 'get started', exact: true }),
    ).toHaveAttribute('href', '/register');

    await expect(
      hero.getByRole('link', { name: 'see the live demo', exact: true }),
    ).toHaveAttribute('href', '/demo');

    // Substring matches, so punctuation tweaks around the middots don't
    // false-positive.
    const pillRow = hero.locator('p', { hasText: 'windows, macos and linux' });
    await expect(pillRow).toBeVisible();
    await expect(pillRow).toContainText('windows, macos and linux');
    await expect(pillRow).toContainText('free during beta');
    await expect(pillRow).toContainText('FSL-1.1');

    // Static copy, so a plain text match is deterministic.
    await expect(hero.getByText(HERO_SUBHEADLINE)).toBeVisible();

    // The animated eye carries `animate-eye-ignite`.
    await expect(hero.locator('svg.animate-eye-ignite')).toBeVisible();
  });
});
