import { test, expect } from '@playwright/test';
import { LICENSE_URL } from '@/lib/repoLinks';

// Public landing page — no auth required.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('landing faq + footer', () => {
  test('renders exactly eight faq items and excludes the cut mayonnaise question', async ({ page }) => {
    await page.goto('/');

    // FAQ heading anchors the section so we can scope all assertions to it.
    const faqHeading = page.getByRole('heading', { name: 'questions, answered.' });
    await expect(faqHeading).toBeVisible();

    const faqSection = page.locator('section').filter({ has: faqHeading });
    const questionButtons = faqSection.locator('button[aria-expanded]');
    await expect(questionButtons).toHaveCount(8);

    // Regression check — the joke FAQ was cut and must not come back.
    await expect(page.getByText(/is mayonnaise an instrument/i)).toHaveCount(0);
  });

  test('pricing answer keeps beta free and states the after-beta model', async ({ page }) => {
    await page.goto('/');

    const question = page.getByRole('button', { name: /is it actually free/i });
    await question.click();
    // the answer panel is the button's next sibling.
    const answer = question.locator('xpath=following-sibling::div[1]//p');

    await expect(answer).toContainText('during beta, yes');
    await expect(answer).toContainText('14-day pro trial, no card');
    await expect(answer).toContainText('falls back to owlette free');
    await expect(answer).toContainText('owlette free covers 1 machine and 1 site');
    await expect(answer).toContainText('a machine counts if it was online at any point in the billing period');
    await expect(answer).toContainText('$20/machine/month');
    await expect(answer).toContainText('$60/machine/month');
  });

  test('self-host answer cites FSL-1.1-Apache-2.0, not agpl-3.0', async ({ page }) => {
    await page.goto('/');

    // Open the self-host accordion to reveal its answer.
    await page.getByRole('button', { name: /can i self-host it/i }).click();

    // Load-bearing assertions — wave 0.1 fixed an incorrect agpl-3.0 reference.
    await expect(page.getByText('FSL-1.1-Apache-2.0').first()).toBeVisible();
    await expect(page.getByText(/agpl-3\.0/i)).toHaveCount(0);
  });

  test('footer license link points at the github LICENSE file', async ({ page }) => {
    await page.goto('/');

    const licenseLink = page.locator('footer').getByRole('link', { name: 'FSL-1.1-Apache-2.0' });
    await expect(licenseLink).toBeVisible();
    await expect(licenseLink).toHaveAttribute('href', LICENSE_URL);
  });
});
