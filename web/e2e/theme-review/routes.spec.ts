import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { INSTALLER_PLATFORMS, installerFileName, type InstallerPlatform } from '@/lib/installerPlatform';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import {
  FIXED_NOW_MS,
  hootFocusConversationId,
  seedScreenshotFixtures,
  type ScreenshotScenario,
} from '../screenshots/fixtures';

/**
 * Every route, both themes. Each capture seeds the scenario it needs, pins the
 * signed-in user to the scenario's site, follows the OS colour scheme (no stored
 * choice, so the app resolves 'system'), and saves a full-page PNG.
 */

type Role = 'admin' | 'superadmin' | 'member' | null;

interface Capture {
  slug: string;
  path: string | ((siteId: string) => string);
  role: Role;
  scenario?: ScreenshotScenario;
  /** wait for this before capturing; defaults to the page settling */
  ready?: (page: Page) => Promise<void>;
  /** put the page into the state under review (open a menu, a dialog...) */
  act?: (page: Page) => Promise<void>;
  /** data the page needs beyond the scenario */
  seed?: () => Promise<void>;
}

const OUT = 'e2e/.output/theme-review';
const BASE_URL = `http://127.0.0.1:${process.env.E2E_PORT || 3100}`;

const CAPTURES: Capture[] = [
  // public
  { slug: 'landing', path: '/', role: null },
  { slug: 'for-ai', path: '/for-ai', role: null },
  { slug: 'privacy', path: '/privacy', role: null },
  { slug: 'terms', path: '/terms', role: null },
  { slug: 'legal-dmca', path: '/legal/dmca', role: null },
  { slug: 'demo', path: '/demo', role: null },
  { slug: 'login', path: '/login', role: null },
  { slug: 'register', path: '/register', role: null },
  { slug: 'forgot-password', path: '/forgot-password', role: null },
  { slug: 'reset-password', path: '/reset-password?oobCode=theme-review', role: null },
  { slug: 'unsubscribe', path: '/unsubscribe?success=true', role: null },
  { slug: 'not-found', path: '/this-page-does-not-exist', role: null },
  { slug: 'docs-index', path: '/docs', role: null },
  { slug: 'docs-article-code', path: '/docs/agent/installation', role: null },
  { slug: 'docs-article-mermaid', path: '/docs/agent/configuration', role: null },
  { slug: 'docs-api', path: '/docs/api', role: null },
  // signed in
  {
    slug: 'dashboard-cards',
    path: '/dashboard',
    role: 'admin',
    scenario: 'dashboard-mixed-states',
    ready: (page) => expect(page.getByTestId('machine-card').first()).toBeVisible({ timeout: 15_000 }),
  },
  {
    slug: 'dashboard-list',
    path: '/dashboard',
    role: 'admin',
    scenario: 'dashboard-mixed-states',
    ready: (page) => expect(page.getByTestId('machine-card').first()).toBeVisible({ timeout: 15_000 }),
    act: async (page) => {
      await page.getByTestId('view-toggle-list').click();
      await expect(page.getByTestId('machine-row').first()).toBeVisible();
    },
  },
  {
    slug: 'dashboard-machine-menu',
    path: '/dashboard',
    role: 'admin',
    scenario: 'dashboard-mixed-states',
    ready: (page) => expect(page.getByTestId('machine-card').first()).toBeVisible({ timeout: 15_000 }),
    act: async (page) => {
      await page.getByTestId('machine-context-menu-trigger').first().click();
      await expect(page.getByRole('menu')).toBeVisible();
    },
  },
  {
    slug: 'dashboard-nav-menu',
    path: '/dashboard',
    role: 'admin',
    scenario: 'dashboard-mixed-states',
    ready: (page) => expect(page.getByTestId('machine-card').first()).toBeVisible({ timeout: 15_000 }),
    act: async (page) => {
      // the page switcher at desktop width, the drawer on a phone
      const banner = page.getByRole('banner');
      const pages = banner.getByRole('button', { name: /^dashboard$/ });
      await (await pages.isVisible() ? pages : banner.getByRole('button', { name: 'menu' })).click();
      await expect(page.getByRole('menu').or(page.getByRole('dialog', { name: 'menu' }))).toBeVisible();
    },
  },
  {
    slug: 'dashboard-user-menu',
    path: '/dashboard',
    role: 'admin',
    scenario: 'dashboard-mixed-states',
    ready: (page) => expect(page.getByTestId('machine-card').first()).toBeVisible({ timeout: 15_000 }),
    act: async (page) => {
      await page.getByTestId('user-menu-trigger').click();
      await expect(page.getByRole('menu')).toBeVisible();
    },
  },
  {
    slug: 'dashboard-metrics-panel',
    path: '/dashboard',
    role: 'admin',
    scenario: 'monitor-single-machine',
    ready: (page) => expect(page.getByTestId('machine-card').first()).toBeVisible({ timeout: 15_000 }),
    act: async (page) => {
      // the cpu tile opens the panel, as in screenshots/monitor.spec.ts
      await page.getByTestId('machine-card').first().getByText('cpu', { exact: true }).first().click();
      await expect(page.getByTestId('metrics-detail-close-button')).toBeVisible({ timeout: 15_000 });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    },
  },
  {
    slug: 'account-appearance',
    path: '/dashboard',
    role: 'admin',
    scenario: 'dashboard-mixed-states',
    ready: (page) => expect(page.getByTestId('machine-card').first()).toBeVisible({ timeout: 15_000 }),
    act: async (page) => {
      await page.getByTestId('user-menu-trigger').click();
      await page.getByRole('menuitem', { name: /account settings/i }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: /^preferences$/i }).first().click();
      await expect(dialog.getByRole('radiogroup', { name: 'appearance' })).toBeVisible();
    },
  },
  { slug: 'deployments', path: '/deployments', role: 'admin', scenario: 'deploy-roost-rolling' },
  { slug: 'roosts', path: '/roosts?roost=stage-show', role: 'admin', scenario: 'deploy-roost-rolling' },
  { slug: 'hoot', path: (siteId) => `/hoot/${hootFocusConversationId(siteId)}`, role: 'admin', scenario: 'diagnose-cortex-chat' },
  { slug: 'talons', path: '/talons', role: 'admin', scenario: 'automate-talons-list' },
  { slug: 'logs', path: '/logs', role: 'admin', scenario: 'dashboard-mixed-states' },
  { slug: 'settings-api-keys', path: '/settings/api-keys', role: 'admin', scenario: 'dashboard-mixed-states' },
  { slug: 'settings-webhooks', path: '/settings/webhooks', role: 'admin', scenario: 'dashboard-mixed-states' },
  { slug: 'settings-alerts', path: '/settings/alerts', role: 'admin', scenario: 'dashboard-mixed-states' },
  { slug: 'add-machine', path: '/add?code=silver-compass-drift', role: 'admin', scenario: 'dashboard-mixed-states' },
  // admin panel
  { slug: 'admin-installers-seeded', path: '/admin/installers', role: 'superadmin', scenario: 'dashboard-mixed-states', seed: seedInstallers },
  ...(['installers', 'presets', 'members', 'users', 'tokens', 'schedules', 'alerts', 'webhooks', 'email'] as const).map(
    (page): Capture => ({ slug: `admin-${page}`, path: `/admin/${page}`, role: 'superadmin', scenario: 'dashboard-mixed-states' }),
  ),
];

/** releases as the field has them: the newest on every platform, an old one windows-only */
async function seedInstallers(): Promise<void> {
  const releases: Array<{ version: string; daysAgo: number; platforms: readonly InstallerPlatform[]; notes?: string }> = [
    { version: '4.1.0', daysAgo: 1, platforms: INSTALLER_PLATFORMS, notes: 'swoop on macOS; 4K60 on a Mac; keyboard and quality menus; clipboard images' },
    { version: '4.0.6', daysAgo: 6, platforms: INSTALLER_PLATFORMS, notes: 'mac swoop token (.local ids); clean exits are not crashes; swoop paste fixes' },
    { version: '3.3.16', daysAgo: 30, platforms: ['windows_x64'] },
  ];
  const db = getAdminDb();
  const versions = db.collection('installer_metadata').doc('data').collection('versions');
  const docs = releases.map(({ version, daysAgo, platforms, notes }) => {
    const at = FIXED_NOW_MS - daysAgo * 86_400_000;
    const files = Object.fromEntries(platforms.map((platform, i) => [platform, {
      download_url: `https://storage.emulator/installers/${version}/${installerFileName(version, platform)}`,
      checksum_sha256: `${i}`.repeat(64),
      file_size: [44_200_000, 134_600_000, 129_600_000][i],
      file_name: installerFileName(version, platform),
      uploaded_at: at,
    }]));
    return {
      version,
      download_url: files.windows_x64.download_url,
      file_size: files.windows_x64.file_size,
      release_date: Timestamp.fromMillis(at),
      uploaded_at: at,
      uploaded_by: 'ZwcAnXy2t2WxwA9LPz7Sst0YnKA3',
      deletedAt: null,
      files,
      ...(notes ? { release_notes: notes } : {}),
    };
  });
  await Promise.all(docs.map((doc) => versions.doc(doc.version).set(doc)));
  await db.collection('installer_metadata').doc('latest').set(docs[0]);
}

async function pinSite(role: Exclude<Role, null>, siteId: string): Promise<void> {
  await getAdminDb()
    .collection('users')
    .doc(TEST_USERS[role].uid)
    .set(
      {
        sites: [siteId],
        lastSiteId: siteId,
        preferences: { statsExpanded: true, processesExpanded: true, displaysExpanded: true, activeGraphPanel: null },
      },
      { merge: true },
    );
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important; animation-delay: 0s !important;
      transition-duration: 0s !important; transition-delay: 0s !important;
    }`,
  });
  await page.evaluate(() => document.fonts?.ready);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    for (const capture of CAPTURES) {
      test(capture.slug, async ({ browser }, testInfo) => {
        const fixture = capture.scenario ? await seedScreenshotFixtures(capture.scenario) : null;
        try {
          if (fixture && capture.role) await pinSite(capture.role, fixture.siteId);
          await capture.seed?.();
          const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = testInfo.project.use;
          const context = await browser.newContext({
            viewport, deviceScaleFactor, isMobile, hasTouch, userAgent,
            ...(capture.role ? roleState(capture.role) : { storageState: { cookies: [], origins: [] } }),
            colorScheme: theme,
            baseURL: BASE_URL,
          });
          const page = await context.newPage();
          await page.clock.install({ time: FIXED_NOW_MS });
          const path = typeof capture.path === 'function' ? capture.path(fixture?.siteId ?? '') : capture.path;
          await page.goto(path);
          if (capture.ready) await capture.ready(page);
          if (capture.act) await capture.act(page);
          await settle(page);
          const dir = `${OUT}/${testInfo.project.name}`;
          await mkdir(dir, { recursive: true });
          await page.screenshot({ path: `${dir}/${capture.slug}.${theme}.png`, fullPage: true });
          await context.close();
        } finally {
          await fixture?.cleanup();
        }
      });
    }
  });
}
