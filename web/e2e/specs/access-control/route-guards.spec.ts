/**
 * RequireAdminAccess wraps /admin/layout.tsx with the role each path demands
 * (see app/admin/navItems.ts): members go to /dashboard from every admin path,
 * admins reach the site-scoped ones but are bounced from the platform ones, and
 * unauthenticated users go to /login. Asserts URLs — the guard runs in a
 * useEffect, so each assertion waits for router.push to settle — and, for an
 * admin on the sites pages, the h1 only an admitted page renders.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';

/** Site-scoped destinations: global role `admin` and above. */
const SITE_SCOPED_ROUTES = [
  '/admin/sites',
  '/admin/sites/site-A',
  '/admin/webhooks',
  '/admin/alerts',
  '/admin/tokens',
  '/admin/schedules',
  '/admin/swoop',
];

/** each sites page's h1, which renders only once the guard admits the caller. */
const SITES_PAGE_HEADINGS: Record<string, string> = {
  '/admin/sites': 'sites',
  '/admin/sites/site-A': 'Site A (Assigned)',
};

/** Platform destinations: superadmin only. */
const PLATFORM_ROUTES = [
  '/admin/users',
  '/admin/installers',
  '/admin/email',
  '/admin/presets',
];

const ADMIN_ROUTES = [...SITE_SCOPED_ROUTES, ...PLATFORM_ROUTES];

test.describe('route guards — unauthenticated', () => {
  // No storageState = no auth.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('visiting /dashboard redirects to /login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('visiting /admin/users redirects to /login', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});

test.describe('route guards — member', () => {
  test.use(roleState('member'));

  for (const route of ADMIN_ROUTES) {
    test(`visiting ${route} redirects away`, async ({ page }) => {
      await page.goto(route);
      await expect(page).not.toHaveURL(new RegExp(`${route}$`), { timeout: 10_000 });
    });
  }
});

test.describe('route guards — admin (site-scoped, NOT platform)', () => {
  test.use(roleState('admin'));

  // a URL check passes while the guard still shows its spinner, before any
  // bounce, so the sites pages wait for the h1 only an admitted page renders
  for (const [route, heading] of Object.entries(SITES_PAGE_HEADINGS)) {
    test(`can reach ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
      const url = new URL(page.url());
      expect(`${url.pathname}${url.search}`, 'where the load settled').toBe(route);
      await expect(page.getByText('access denied', { exact: true }), 'the gate refusal').toHaveCount(0);
    });
  }

  for (const route of SITE_SCOPED_ROUTES.filter((r) => !(r in SITES_PAGE_HEADINGS))) {
    test(`can reach ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(route.replace(/\//g, '\\/')));
    });
  }

  for (const route of PLATFORM_ROUTES) {
    test(`visiting ${route} redirects away (admins are site-scoped)`, async ({ page }) => {
      await page.goto(route);
      await expect(page).not.toHaveURL(new RegExp(`${route}$`), { timeout: 10_000 });
    });
  }

  test('visiting /admin/members ends on /admin/sites', async ({ page }) => {
    await page.goto('/admin/members');
    await expect(page).toHaveURL(/\/admin\/sites$/, { timeout: 10_000 });
  });
});

test.describe('route guards — superadmin', () => {
  test.use(roleState('superadmin'));

  for (const route of ADMIN_ROUTES) {
    test(`can reach ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(route.replace(/\//g, '\\/')));
    });
  }
});
