/**
 * Landing — pricing regression.
 *
 * Locks the two-tier layout (core + pro): the per-machine rates, the "free during beta"
 * label, the 3-machine pro minimum and the roost storage allowance must break CI rather
 * than silently ship. The landing page is public, so this spec runs without storage state.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('landing — pricing', () => {
  test('renders core and pro tier cards with the expected copy and CTAs', async ({ page }) => {
    await page.goto('/');

    const pricing = page.locator('section#pricing');
    await expect(pricing).toBeVisible();

    await expect(
      pricing.getByRole('heading', { name: /simple, transparent pricing\./i }),
    ).toBeVisible();

    // Two tier cards — start at the tier heading, then climb to the card
    // shell so layout wrappers with both cards are not selected.
    const tierCard = (name: string) => pricing
      .getByRole('heading', { name, exact: true })
      .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-2xl ")][1]');
    const coreCard = tierCard('core');
    const proCard = tierCard('pro');

    await expect(coreCard).toBeVisible();
    await expect(proCard).toBeVisible();

    // Core card — $20 per machine per month, free during beta, $10 founders rate.
    await expect(coreCard).toContainText('$20');
    await expect(coreCard).toContainText('$10 founders rate');
    await expect(coreCard).toContainText('/machine/month');
    await expect(coreCard).toContainText('free during beta');

    // Pro card — $60 per machine per month with a 3-machine minimum, free
    // during beta, roost storage copy.
    await expect(proCard).toContainText('$60');
    await expect(proCard).toContainText('$30 founders rate');
    await expect(proCard).toContainText('/machine/month');
    await expect(proCard).toContainText('3-machine minimum');
    await expect(proCard).toContainText('free during beta');
    await expect(proCard).toContainText('roost');
    await expect(proCard).toContainText('1 TB included project storage per site');
    await expect(proCard).toContainText('$0.05/GB overage');

    // Pro-only integration surface (gated out of core).
    await expect(proCard).toContainText('REST API');
    await expect(proCard).toContainText('CLI + TypeScript SDK');
    await expect(proCard).toContainText('webhooks');
    await expect(proCard).toContainText('unlimited sites');
    await expect(proCard).toContainText('swoop — live remote desktop in the browser');
    await expect(coreCard).not.toContainText('swoop');
    await expect(coreCard).not.toContainText('REST API');
    await expect(coreCard).not.toContainText('CLI');
    await expect(coreCard).not.toContainText('webhooks');

    // Pro-only product surface — deployment, hoot and talons moved out of core.
    await expect(proCard).toContainText('software & file deployment');
    await expect(proCard).toContainText('hoot');
    await expect(proCard).toContainText('talons');
    await expect(coreCard).not.toContainText('deployment');
    await expect(coreCard).not.toContainText('hoot');
    await expect(coreCard).not.toContainText('talons');

    // Core scope constraint — single-site only.
    await expect(coreCard).toContainText('1 site with role-based access');

    // Pro card visual marker — the `new` chip is rendered inside the card,
    // and the card container carries the accent-cyan border class.
    await expect(proCard.getByText('new', { exact: true })).toBeVisible();
    await expect(proCard).toHaveClass(/border-accent-cyan\/40/);

    // Pro card prelude — "everything in core, plus:" only appears on pro.
    await expect(proCard).toContainText('everything in core, plus:');
    await expect(coreCard).not.toContainText('everything in core, plus:');

    // Both cards CTA → /register.
    await expect(coreCard.getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');
    await expect(proCard.getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');
  });
});
