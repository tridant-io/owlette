import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';
import {
  clearHootFixture,
  seedHootFixture,
  seedLogEvents,
  seedSystemPreset,
} from '../../helpers/coverageSeed';

test.use({ reducedMotion: 'reduce' });

async function stabilizeForA11y(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }

      .hero-enter,
      .hero-enter-nav,
      .hero-enter-delay-1,
      .hero-enter-delay-2,
      .hero-enter-delay-3 {
        opacity: 1 !important;
        transform: none !important;
      }
    `,
  });
  await page.evaluate(() => document.fonts?.ready);
}

/**
 * `within` scopes the scan to one open surface instead of the whole document.
 *
 * Needed for a modal Radix menu: while one is open the library marks everything
 * outside it `aria-hidden` (`hideOthers`, the aria-hidden package), and /hoot's
 * focusable window-splitter — the conversation-list resize handle — is then a
 * tabbable element inside an aria-hidden subtree, which axe reports as
 * `aria-hidden-focus` (serious). That is true of every modal menu in the app,
 * including the header's site switcher, and is not what the picker is being
 * asked about here; the page's own full-page pass runs with nothing open.
 */
async function expectNoSeriousA11yViolations(page: Page, within?: string) {
  await stabilizeForA11y(page);
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (within) builder.include(within);
  const results = await builder.analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        html: node.html,
        failureSummary: node.failureSummary,
        checks: [...node.any, ...node.all, ...node.none].map((check) => ({
          id: check.id,
          message: check.message,
          data: check.data,
        })),
      })),
    })),
  ).toEqual([]);
}

test.describe('public a11y smoke', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const route of ['/', '/privacy', '/terms', '/legal/dmca', '/unsubscribe?success=true', '/demo', '/login', '/register']) {
    test(`${route} has no serious/critical axe violations`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('body')).toBeVisible();
      await expectNoSeriousA11yViolations(page);
    });
  }
});

test.describe('authenticated a11y smoke', () => {
  test.use(roleState('admin'));

  test('logs has no serious/critical axe violations', async ({ page }) => {
    await seedLogEvents('site-A');
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  // /demo carries labels the real dashboard lacked, so the real one is scanned too:
  // card view (the default) and list view
  test('dashboard has no serious/critical axe violations', async ({ page }) => {
    await seedMachine(TEST_SITES[0].id, 'e2e-a11y-dashboard-machine');
    await page.goto('/dashboard');
    await expect(page.getByTestId('machine-card').first()).toBeVisible({ timeout: 15_000 });
    await expectNoSeriousA11yViolations(page);
    await page.getByTestId('view-toggle-list').click();
    await expect(page.getByTestId('machine-row').first()).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  for (const [route, heading] of [
    ['/deployments', 'deployments'],
    ['/roosts', 'roosts'],
    ['/settings/api-keys', 'api keys'],
  ] as const) {
    test(`${route} has no serious/critical axe violations`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 10_000 });
      await expectNoSeriousA11yViolations(page);
    });
  }

  test('hoot keyed state has no serious/critical axe violations', async ({ page }) => {
    await seedHootFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/hoot');
    await expect(page.getByLabel('chat message')).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test('hoot target picker and mention list have no serious/critical axe violations', async ({
    page,
  }) => {
    await seedHootFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/hoot');
    const composer = page.getByLabel('chat message');
    await expect(composer).toBeVisible();

    // The checkbox picker, open: a tri-state master row and one row per machine,
    // each carrying its status as text. Scoped — see the helper.
    await page.getByLabel(/hoot target/i).click();
    await expect(page.getByRole('menuitemcheckbox', { name: /^all machines/i })).toBeVisible();
    await expectNoSeriousA11yViolations(page, '[data-slot="dropdown-menu-content"]');
    await page.keyboard.press('Escape');

    // The `@` completion list, open. A Radix popover is NOT modal, so nothing is
    // aria-hidden and the whole page is scanned with the list up — which is the
    // state that matters: the listbox is named in its own right, and the
    // composer stays a textbox driving it through aria-activedescendant.
    //
    // The query matches both seeded machines, so the scan covers a highlighted
    // row and a plain one. Which is which is deterministic: `useMachines` sorts
    // by id and `filterMentionOptions` keeps that order, so the online
    // `e2e-cortex-machine` leads and carries the highlight.
    await composer.click();
    await composer.pressSequentially('@e2e-cortex');
    await expect(page.getByRole('listbox', { name: /machines to mention/i })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe('superadmin a11y smoke', () => {
  test.use(roleState('superadmin'));

  test('admin presets has no serious/critical axe violations', async ({ page }) => {
    await seedSystemPreset('e2e-a11y-system-preset', { name: 'E2E A11Y Template' });
    await page.goto('/admin/presets');
    await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe('member no-key hoot a11y smoke', () => {
  test.use(roleState('member'));

  test('hoot no-key overlay has no serious/critical axe violations', async ({ page }) => {
    await clearHootFixture(TEST_USERS.member.uid);
    await page.goto('/hoot');
    await expect(page.getByText(/hoot requires an LLM API key/i)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
