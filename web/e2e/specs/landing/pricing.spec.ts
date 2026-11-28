/**
 * Landing — pricing regression.
 *
 * Locks the three-tier layout (owlette free + core + pro): the free limits, the
 * per-machine rates, the "free until 1 April 2027" label, the 3-machine pro minimum, the
 * roost storage allowance and the model after the free period must break CI rather than
 * silently ship.
 * The landing page is public, so this spec runs without storage state.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('landing — pricing', () => {
  test('renders free, core and pro tier cards with the expected copy and CTAs', async ({ page }) => {
    await page.goto('/');

    const pricing = page.locator('section#pricing');
    await expect(pricing).toBeVisible();

    await expect(
      pricing.getByRole('heading', { name: /simple, transparent pricing\./i }),
    ).toBeVisible();
    await expect(pricing).toContainText('three tiers.');

    // Three tier cards — start at the tier heading, then climb to the card
    // shell so layout wrappers with every card are not selected.
    const tierCard = (name: string) => pricing
      .getByRole('heading', { name, exact: true })
      .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-2xl ")][1]');
    const freeCard = tierCard('owlette free');
    const coreCard = tierCard('core');
    const proCard = tierCard('pro');

    await expect(freeCard).toBeVisible();
    await expect(coreCard).toBeVisible();
    await expect(proCard).toBeVisible();

    // Free card — 1 machine and 1 site, monitoring only, still free after the free period.
    await expect(freeCard).toContainText('after 1 April 2027, too');
    await expect(freeCard).not.toContainText('free until');
    await expect(freeCard).toContainText('1 machine and 1 site');
    await expect(freeCard).toContainText('live status & metrics');
    await expect(freeCard).toContainText('crash detection & auto-restart');
    await expect(freeCard).toContainText('owlette updates');
    await expect(freeCard).not.toContainText('/machine/month');
    await expect(freeCard).not.toContainText('process control');
    await expect(freeCard).not.toContainText('alerts');
    await expect(freeCard).not.toContainText('deployment');
    await expect(freeCard).not.toContainText('swoop');
    await expect(freeCard).not.toContainText('hoot');

    // Core card — $20 per machine per month, free until 1 April 2027, $10 founders rate.
    await expect(coreCard).toContainText('$20');
    await expect(coreCard).toContainText('$10 founders rate');
    await expect(coreCard).toContainText('/machine/month');
    await expect(coreCard).toContainText('free until 1 April 2027');

    // Pro card — $60 per machine per month with a 3-machine minimum, free
    // until 1 April 2027, roost storage copy.
    await expect(proCard).toContainText('$60');
    await expect(proCard).toContainText('$30 founders rate');
    await expect(proCard).toContainText('/machine/month');
    await expect(proCard).toContainText('3-machine minimum');
    await expect(proCard).toContainText('free until 1 April 2027');
    await expect(proCard).toContainText('roost');
    await expect(proCard).toContainText('1 TB included project storage per site');
    await expect(proCard).toContainText('$0.05/GB overage');

    // Pro-only integration surface (gated out of core).
    await expect(proCard).toContainText('REST API');
    await expect(proCard).toContainText('CLI + TypeScript SDK');
    await expect(proCard).toContainText('webhooks');
    await expect(coreCard).not.toContainText('REST API');
    await expect(coreCard).not.toContainText('CLI');
    await expect(coreCard).not.toContainText('webhooks');

    // swoop is part of core; pro carries it under "everything in core" and doesn't list it again.
    await expect(coreCard).toContainText('swoop — live remote desktop in the browser');
    await expect(proCard).not.toContainText('swoop');

    // Pro-only product surface — deployment, hoot and talons moved out of core.
    await expect(proCard).toContainText('software & file deployment');
    await expect(proCard).toContainText('hoot');
    await expect(proCard).toContainText('talons');
    await expect(coreCard).not.toContainText('deployment');
    await expect(coreCard).not.toContainText('hoot');
    await expect(coreCard).not.toContainText('talons');

    // A plan belongs to a site: core has no site cap, and pro no "unlimited sites" to add.
    await expect(coreCard).toContainText('sites with role-based access, each on its own plan');
    await expect(coreCard).not.toContainText('1 site');
    await expect(proCard).not.toContainText('unlimited sites');

    // Pro card visual marker — the `new` chip is rendered inside the card,
    // and the card container carries the accent-cyan border class.
    await expect(proCard.getByText('new', { exact: true })).toBeVisible();
    await expect(proCard).toHaveClass(/border-accent-cyan\/40/);

    // Pro card prelude — "everything in core, plus:" only appears on pro.
    await expect(proCard).toContainText('everything in core, plus:');
    await expect(coreCard).not.toContainText('everything in core, plus:');

    // Every card CTA → /register.
    await expect(freeCard.getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');
    await expect(coreCard.getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');
    await expect(proCard.getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');

    // The model after the free period — trial, fallback to free, per-site and per-active-machine billing.
    await expect(pricing).toContainText(
      'after 1 April 2027, every account starts with a 14-day pro trial, no card, once its email is verified.',
    );
    await expect(pricing).toContainText('a site falls back to owlette free');
    await expect(pricing).toContainText('each site has its own plan, billed per active machine per month.');
    await expect(pricing).toContainText('a machine counts if it was online at any point in the billing period.');
    await expect(pricing).toContainText(
      'a billing period is a calendar month from the 1st (UTC). the first month you are billed is charged by the day, and a site added later is charged for the whole month it is added in.',
    );
  });
});
