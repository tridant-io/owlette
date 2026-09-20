import { test, expect } from '@playwright/test';
import {
  deleteDocIfExists,
  seedInstallerLatest,
} from '../../helpers/coverageSeed';
import { HERO_HEADLINE } from '../../helpers/landing';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('public routes', () => {
  test('landing page exposes the primary CTAs', async ({ page }) => {
    await page.goto('/');
    const hero = page.locator('section', {
      has: page.getByRole('heading', { name: HERO_HEADLINE }),
    }).first();
    await expect(hero.getByRole('heading', { name: HERO_HEADLINE })).toBeVisible();
    await expect(hero.getByRole('link', { name: 'get started', exact: true })).toHaveAttribute('href', '/register');
    await expect(page.getByRole('banner').getByRole('link', { name: 'sign in', exact: true })).toHaveAttribute('href', '/login');
  });

  test('legal static pages render and cross-link', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: /privacy policy/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /terms of service/i })).toHaveAttribute('href', '/terms');

    await page.goto('/terms');
    await expect(page.getByRole('heading', { name: /terms of service/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /privacy policy/i })).toHaveAttribute('href', '/privacy');
  });

  test('unsubscribe success and failure states render', async ({ page }) => {
    await page.goto('/unsubscribe?success=true');
    await expect(page.getByRole('heading', { name: /unsubscribed/i })).toBeVisible();
    await expect(page.getByText(/all alert emails, including offline notifications, have been turned off/i)).toBeVisible();

    await page.goto('/unsubscribe');
    await expect(page.getByRole('heading', { name: /^unsubscribe$/i })).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toBeVisible();
  });

  test('DMCA form accepts a complete notice', async ({ page }) => {
    await page.goto('/legal/dmca');
    await expect(page.getByRole('heading', { name: /dmca takedown notice/i })).toBeVisible();

    await page.getByLabel(/\(1\).*copyrighted work/i).fill('E2E copyrighted installation');
    await page.getByLabel(/\(2\).*material/i).fill('https://owlette.test/e2e/material');
    await page.getByLabel(/\(3\).*your name/i).fill('E2E Copyright Owner');
    await page.getByLabel(/^email$/i).fill('owner@example.test');
    await page.getByLabel(/^address$/i).fill('123 E2E Street, Test City, CA 90000');
    await page.getByRole('checkbox').nth(0).click();
    await page.getByRole('checkbox').nth(1).click();
    await page.getByLabel(/\(6\).*electronic signature/i).fill('E2E Copyright Owner');
    await page.getByRole('button', { name: /submit notice/i }).click();

    await expect(page.getByText(/notice received/i)).toBeVisible();
    await expect(page.getByText(/reference id/i)).toBeVisible();
  });

  test('demo route mounts and switches between list and card views', async ({ page }) => {
    await page.goto('/demo');
    await expect(page.getByRole('heading', { name: /welcome to owlette/i })).toBeVisible();

    await page.getByRole('button', { name: /card view/i }).click();
    await expect(page.getByText(/machines/i).first()).toBeVisible();
    await page.getByRole('button', { name: /list view/i }).click();
    await expect(page.locator('table')).toBeVisible();
  });

  test('docs routes resolve to Fumadocs and Scalar surfaces', async ({ request }) => {
    const docs = await request.get('/docs');
    expect(docs.status()).toBe(200);
    const docsHtml = await docs.text();
    expect(docsHtml).toContain('id="nd-docs-layout"');
    expect(docsHtml).toContain('owlette docs');

    const scalar = await request.get('/docs/api');
    expect(scalar.status()).toBe(200);
    const scalarHtml = await scalar.text();
    // Scalar boots the reference with createApiReference('#app', {...}); 0.10 exposed it as a
    // `Scalar.` global, 0.11+ imports it as an ES module, so match the call, not the namespace.
    expect(scalarHtml).toContain('createApiReference(');
    expect(scalarHtml).toContain('"url": "/api/openapi"');

    const authentication = await request.get('/docs/api/authentication');
    expect(authentication.status()).toBe(200);
    const authenticationHtml = await authentication.text();
    expect(authenticationHtml).toContain('id="nd-docs-layout"');
    expect(authenticationHtml).toContain('authentication');

    // Pages that exist only because they were added to a meta.json — a typo in
    // the nav list silently drops them from the sidebar while the URL still works.
    const inNav = ['restart-schedules', 'displays', 'account-settings'];
    const dashboardIndex = await request.get('/docs/dashboard');
    const dashboardHtml = await dashboardIndex.text();
    for (const slug of inNav) {
      const page = await request.get(`/docs/dashboard/${slug}`);
      expect(page.status(), `/docs/dashboard/${slug}`).toBe(200);
      expect(dashboardHtml, `${slug} in sidebar`).toContain(`/docs/dashboard/${slug}`);
    }

    const schedulePresets = await request.get('/docs/dashboard/admin/schedule-presets');
    expect(schedulePresets.status()).toBe(200);
  });

  test('docs search caps its results, honours keywords, and survives a typo', async ({ request }) => {
    // fumadocs hands the engine `limit: undefined` when the client omits one,
    // which clobbers its own default and returns every matching section. the
    // bundled client never sends a limit, so the route has to impose one.
    const broad = await request.get('/api/search?query=machine');
    expect(broad.status()).toBe(200);
    const broadRows = await broad.json();
    expect(broadRows.length).toBeGreaterThan(0);
    expect(broadRows.length).toBeLessThanOrEqual(24);

    const capped = await request.get('/api/search?query=machine&limit=5');
    expect((await capped.json()).length).toBe(5);

    // `keywords` frontmatter is folded into the index, so a word the page never
    // uses still reaches it — swoop's prose says "remote desktop", not "remote
    // control".
    const synonym = await request.get('/api/search?query=remote+control');
    const synonymPages = (await synonym.json())
      .filter((row: { type: string }) => row.type === 'page')
      .map((row: { url: string }) => row.url);
    expect(synonymPages).toContain('/docs/dashboard/swoop');

    // a misspelling falls back to the tolerant index instead of dead-ending.
    const typo = await request.get('/api/search?query=sceduled');
    expect((await typo.json()).length).toBeGreaterThan(0);
  });

  test('download permalink redirects to latest installer and falls back when empty', async ({ request }) => {
    await seedInstallerLatest('https://example.test/downloads/owlette-e2e.exe');
    const latest = await request.get('/download', { maxRedirects: 0 });
    expect([307, 308]).toContain(latest.status());
    expect(latest.headers().location).toBe('https://example.test/downloads/owlette-e2e.exe');

    await deleteDocIfExists('installer_metadata/latest');
    const fallback = await request.get('/download', { maxRedirects: 0 });
    expect([307, 308]).toContain(fallback.status());
    expect(fallback.headers().location).toMatch(/\/login$/);
  });
});
