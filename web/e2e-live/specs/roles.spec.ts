/**
 * live smoke: per-site member management on dev (dev/active/live-smoke, Task 3.4).
 *
 * three checks on smoke-live and the persistent users global setup seeds there (lib/seed.mjs):
 * smoke-siteadmin holds an admin row, smoke-member a member row, and smoke-target none — it is the
 * subject the site admin and member checks add and remove.
 *
 *   site admin  from the dashboard's user menu into smoke-live's members section: admin panel
 *               (/admin/sites), the site's gear, then members. it adds smoke-target as a member,
 *               makes them an admin through "change access...", and removes them.
 *               sites/smoke-live/members/smoke-target is read back after each step.
 *   hard loads  as the site admin, fresh loads of /admin/sites and of the members section each stay
 *               on their page, with no "access denied" toast.
 *   member      the UI offers a member no member management: no "admin panel" in the user menu, and
 *               /admin/sites turns a direct visit away. the members route refuses the member's add
 *               with 403 and writes nothing. the positive control sends the same request as the site
 *               admin (200 and a member row), then undoes it.
 *
 * site admins change roles in the UI (owner ruling, 2026-11-04). the row menu offers "change
 * access..." on every row but your own and the owner's, and its dialog sets the role and swoop mode
 * on this site only. the check changes the role with the dialog's role select and save.
 *
 * the members section takes its site from the url (/admin/sites/smoke-live?section=members), and
 * every members list the page requests must be smoke-live's.
 *
 * RequireAdminAccess decides only once the memberships have loaded, so a hard load of an admin page
 * no longer meets the gate before the admin row is known. the hard loads check proves it on dev with
 * two such loads; the site admin check walks the user menu, as a person would.
 *
 * each check starts and ends with smoke-target holding no standing in smoke-live. the app's add also
 * mirrors the site into the legacy users/{uid}.sites[] and its removal strips it again (addMember and
 * removeMember, web/lib/membership.server.ts), so the cleanup strips it too. global teardown removes
 * the member row as well.
 */
import { randomUUID } from 'node:crypto';
import type { Locator, Page, Response as PageResponse } from '@playwright/test';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { expect, test } from '../fixtures';
import { DEV_ORIGIN, getDb } from '../lib/devAdmin.mjs';
import { PERSISTENT_USERS, SITE_ID, ensureMemberRow } from '../lib/seed.mjs';

const SITE_ADMIN = PERSISTENT_USERS.siteadmin;
const MEMBER = PERSISTENT_USERS.member;
const TARGET = PERSISTENT_USERS.target;

/** where the user menu's "admin panel" sends a site admin who is not a superadmin. */
const SITES_PAGE = '/admin/sites';
/** smoke-live's site settings, as siteSettingsPath (web/lib/siteSettingsPath.ts) builds it. */
const SITE_PAGE = `${SITES_PAGE}/${SITE_ID}`;
const MEMBERS_SECTION = `${SITE_PAGE}?section=members`;
/** GET lists and POST adds; PATCH and DELETE take the member's uid (app/api/sites/[siteId]/members). */
const MEMBERS_ROUTE = `/api/sites/${SITE_ID}/members`;
const TARGET_ROUTE = `${MEMBERS_ROUTE}/${TARGET.uid}`;
const TARGET_ROW = `sites/${SITE_ID}/members/${TARGET.uid}`;

/** authorizedSiteHandler's refusal of a caller without the route's capability. */
const CAPABILITY_REFUSAL = 'capability not granted';
const MEMBER_ADD_HINT =
  '; a member row grants no SITE_MEMBER_MANAGE, and the route skips that check only while ' +
  'global/security_config switches capability_enforcement off (web/lib/securityConfig.server.ts)';

/** First paint of a page on dev: the app boots, then reads the user's memberships and sites. */
const PAGE_READY_TIMEOUT_MS = 30_000;

type AssignableRole = 'admin' | 'member';

function firestore(): Firestore {
  return getDb();
}

/** What the check reads off sites/smoke-live/members/smoke-target (MemberDoc, web/lib/membership.server.ts). */
interface StoredMemberRow {
  uid: unknown;
  role: unknown;
  status: unknown;
  addedBy: unknown;
  addedAt: 'a timestamp' | 'not a timestamp';
}

async function readTargetRow(): Promise<StoredMemberRow | null> {
  const data = (await firestore().doc(TARGET_ROW).get()).data();
  if (!data) return null;
  return {
    uid: data.uid,
    role: data.role,
    status: data.status,
    addedBy: data.addedBy,
    addedAt: typeof data.addedAt?.toMillis === 'function' ? 'a timestamp' : 'not a timestamp',
  };
}

/** The row an add by smoke-siteadmin writes (addMember), at `role`. A role change touches only the role. */
function rowAddedBySiteAdmin(role: AssignableRole): StoredMemberRow {
  return { uid: TARGET.uid, role, status: 'active', addedBy: SITE_ADMIN.uid, addedAt: 'a timestamp' };
}

/** smoke-live's name, which seed holds at its own (ensureSite, lib/seed.mjs). the site's gear is named for it. */
async function readSiteName(): Promise<string> {
  const name: unknown = (await firestore().doc(`sites/${SITE_ID}`).get()).data()?.name;
  if (typeof name !== 'string' || name === '') throw new Error(`sites/${SITE_ID} has no name`);
  return name;
}

/**
 * Take away whatever standing in smoke-live an earlier attempt left smoke-target: the member row, and
 * smoke-live in the legacy users/{uid}.sites[] the app's add mirrors it into. Returns what it removed.
 */
async function clearTargetStanding(): Promise<string[]> {
  const removed: string[] = await ensureMemberRow({ siteId: SITE_ID, uid: TARGET.uid, role: null });
  const userRef = firestore().collection('users').doc(TARGET.uid);
  const legacySites: unknown = (await userRef.get()).data()?.sites;
  if (Array.isArray(legacySites) && legacySites.includes(SITE_ID)) {
    await userRef.update({ sites: FieldValue.arrayRemove(SITE_ID) });
    removed.push(`${userRef.path}: remove ${SITE_ID} from sites[]`);
  }
  return removed;
}

function annotateCleanup(removed: string[], when: 'before' | 'after'): void {
  for (const description of removed) {
    test.info().annotations.push({ type: `cleanup ${when} the check`, description });
  }
}

/** A members route request, as the app's own client sends it. */
interface MembersRequest {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
  /** Whether the app's client sends this one with an Idempotency-Key. */
  idempotent: boolean;
}

/**
 * The add the members section sends for a typed email (addMember, web/hooks/useSiteMembers.ts):
 * smoke-target as a member.
 */
const ADD_TARGET: MembersRequest = {
  method: 'POST',
  path: MEMBERS_ROUTE,
  body: { email: TARGET.email, role: 'member' },
  idempotent: true,
};

/** The removal the members section sends (removeMember, web/hooks/useSiteMembers.ts). */
const REMOVE_TARGET: MembersRequest = { method: 'DELETE', path: TARGET_ROUTE, body: {}, idempotent: true };

/** The route's answer: its status and JSON body, problem+json on a refusal. */
interface RouteAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * Send `request` with the page's own fetch: same origin, the context's session cookie, no
 * Authorization header — the way the members section calls the route.
 */
async function sendFromPage(page: Page, request: MembersRequest): Promise<RouteAnswer> {
  const idempotencyKey = request.idempotent ? `smoke-roles-${randomUUID()}` : null;
  return page.evaluate(
    async ({ method, path, body, key }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (key) headers['Idempotency-Key'] = key;
      const response = await fetch(path, { method, headers, body: JSON.stringify(body) });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      return { status: response.status, body: isObject ? (parsed as Record<string, unknown>) : null };
    },
    { method: request.method, path: request.path, body: request.body, key: idempotencyKey },
  );
}

/** `what` and the route's answer, for a failure message. Its bodies carry ids and problem text, never a credential. */
function answered(what: string, answer: RouteAnswer): string {
  return `${what} answered ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`;
}

/**
 * The page's next response to a `method` request for `pathname` on dev. A check that fails before
 * awaiting it leaves it pending; the no-op catch keeps its eventual rejection from surfacing unhandled.
 */
function nextResponse(page: Page, method: string, pathname: string): Promise<PageResponse> {
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return candidate.request().method() === method && url.origin === DEV_ORIGIN && url.pathname === pathname;
  });
  response.catch(() => undefined);
  return response;
}

/** Fails unless `response` has status `want`, quoting its body: problem+json on a refusal, member ids otherwise. */
async function expectStatus(response: PageResponse, want: number, what: string): Promise<void> {
  if (response.status() === want) return;
  const detail = (await response.text().catch(() => '')).slice(0, 300);
  throw new Error(`${what} answered ${response.status()}, expected ${want}: ${detail}`);
}

/** Every site whose members list the page requests from now on. */
function trackListedSites(page: Page): () => Set<string> {
  const listed = new Set<string>();
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    const url = new URL(request.url());
    const match = url.origin === DEV_ORIGIN ? /^\/api\/sites\/([^/]+)\/members$/.exec(url.pathname) : null;
    if (match) listed.add(decodeURIComponent(match[1]));
  });
  return () => new Set(listed);
}

function memberRow(page: Page, email: string): Locator {
  return page.getByRole('row').filter({ hasText: email });
}

/** The row's role column, whose badge reads owner, admin or member (displayRole). */
function roleCell(page: Page, email: string): Locator {
  return memberRow(page, email).getByRole('cell').nth(1);
}

/** Open a row's options menu. Its trigger is the row's only button. */
async function openRowOptions(page: Page, email: string): Promise<Locator> {
  await memberRow(page, email).getByRole('button').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * The dashboard's site switcher appears once the user's sites have loaded. The smoke users hold no
 * legacy users/{uid}.sites[], so their sites come from the membership listener alone: once the
 * switcher shows, the user menu reflects their real standing, not a listener still loading.
 */
async function waitForMembershipsOnDashboard(page: Page): Promise<void> {
  await expect(page.getByTestId('site-switcher-trigger'), 'the dashboard site switcher').toBeVisible({
    timeout: PAGE_READY_TIMEOUT_MS,
  });
}

function isMembersSection(url: URL): boolean {
  return url.origin === DEV_ORIGIN && url.pathname === SITE_PAGE && url.searchParams.get('section') === 'members';
}

/**
 * /dashboard, then the user menu's "admin panel" (/admin/sites), smoke-live's gear and the members
 * section. returns once the section shows smoke-live's members, with the tracker of the sites it has
 * listed.
 */
async function openMembersSection(page: Page): Promise<() => Set<string>> {
  const siteName = await readSiteName();
  await page.goto('/dashboard');
  await waitForMembershipsOnDashboard(page);
  const listedSites = trackListedSites(page);
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'admin panel' }).click();
  await page.waitForURL((url) => url.origin === DEV_ORIGIN && url.pathname === SITES_PAGE);
  await page.getByRole('link', { name: `settings for ${siteName}`, exact: true }).click();
  await page.waitForURL((url) => url.origin === DEV_ORIGIN && url.pathname === SITE_PAGE);
  const listed = nextResponse(page, 'GET', MEMBERS_ROUTE);
  await page
    .getByRole('group', { name: 'site settings sections' })
    .getByRole('button', { name: 'members', exact: true })
    .click();
  await page.waitForURL(isMembersSection);
  await expectStatus(await listed, 200, `GET ${MEMBERS_ROUTE}`);
  expect(listedSites(), 'the sites the members section listed').toEqual(new Set([SITE_ID]));
  // The roles the seed wrote, as the page renders them from the rows.
  await expect(roleCell(page, SITE_ADMIN.email), `${SITE_ADMIN.email}'s role on the page`).toHaveText('admin');
  await expect(roleCell(page, MEMBER.email), `${MEMBER.email}'s role on the page`).toHaveText('member');
  return listedSites;
}

/**
 * a hard load settled on `path` (pathname and query) with no "access denied": RequireAdminAccess
 * raises that toast as it turns someone away to /dashboard.
 */
async function expectAdmittedAt(page: Page, path: string): Promise<void> {
  const url = new URL(page.url());
  expect(`${url.pathname}${url.search}`, 'where the hard load settled').toBe(path);
  await expect(page.getByText('access denied', { exact: true }), 'the gate refusal').toHaveCount(0);
}

test.describe('per-site member management on dev', () => {
  test.beforeEach(async () => {
    annotateCleanup(await clearTargetStanding(), 'before');
  });

  test.afterEach(async () => {
    annotateCleanup(await clearTargetStanding(), 'after');
  });

  test('a site admin adds a member, makes them an admin, and removes them', async ({ siteAdminPage: page }) => {
    const listedSites = await test.step('open the members section from the user menu', () => openMembersSection(page));

    await test.step('add smoke-target as a member', async () => {
      await expect(memberRow(page, TARGET.email), `${TARGET.email} on the page before the add`).toHaveCount(0);
      await page.getByRole('button', { name: 'add member', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'add member' });
      await dialog.getByLabel('name or email', { exact: true }).fill(TARGET.email);
      await expect(dialog.getByLabel('role', { exact: true }), 'the role the dialog adds with').toHaveText('member');
      const added = nextResponse(page, 'POST', MEMBERS_ROUTE);
      const relisted = nextResponse(page, 'GET', MEMBERS_ROUTE);
      await dialog.getByRole('button', { name: 'add member', exact: true }).click();
      const response = await added;
      await expectStatus(response, 200, `POST ${MEMBERS_ROUTE}`);
      expect(await response.json(), `POST ${MEMBERS_ROUTE}`).toMatchObject({
        uid: TARGET.uid,
        siteId: SITE_ID,
        requestedRole: 'member',
      });
      await expect(dialog).toBeHidden();
      await expectStatus(await relisted, 200, `GET ${MEMBERS_ROUTE} after the add`);
      await expect(roleCell(page, TARGET.email), `${TARGET.email}'s role on the page`).toHaveText('member');
      expect(await readTargetRow(), `${TARGET_ROW} after the add`).toEqual(rowAddedBySiteAdmin('member'));
    });

    await test.step('make smoke-target an admin', async () => {
      const options = await openRowOptions(page, TARGET.email);
      await expect(options.getByRole('menuitem'), `${TARGET.email}'s row options for a site admin`).toHaveText([
        'change access...',
        'remove...',
      ]);
      await options.getByRole('menuitem', { name: 'change access...' }).click();
      const dialog = page.getByRole('dialog', { name: 'change access' });
      await expect(dialog, 'the access dialog names the member').toContainText(TARGET.email);
      await dialog.getByLabel('role', { exact: true }).click();
      await page.getByRole('option', { name: 'admin', exact: true }).click();
      await expect(dialog.getByLabel('role', { exact: true }), 'the role the dialog saves').toHaveText('admin');
      const changed = nextResponse(page, 'PATCH', TARGET_ROUTE);
      const relisted = nextResponse(page, 'GET', MEMBERS_ROUTE);
      await dialog.getByRole('button', { name: 'save', exact: true }).click();
      const response = await changed;
      await expectStatus(response, 200, `PATCH ${TARGET_ROUTE}`);
      // swoop untouched in the dialog is not sent, so the row stays on its role's default
      expect(await response.json(), `PATCH ${TARGET_ROUTE}`).toMatchObject({
        siteId: SITE_ID,
        uid: TARGET.uid,
        role: 'admin',
        swoop: null,
      });
      await expect(dialog).toBeHidden();
      await expectStatus(await relisted, 200, `GET ${MEMBERS_ROUTE} after the role change`);
      await expect(roleCell(page, TARGET.email), `${TARGET.email}'s role on the page`).toHaveText('admin');
      expect(await readTargetRow(), `${TARGET_ROW} after the role change`).toEqual(rowAddedBySiteAdmin('admin'));
    });

    await test.step('remove smoke-target', async () => {
      const options = await openRowOptions(page, TARGET.email);
      await options.getByRole('menuitem', { name: 'remove...' }).click();
      const dialog = page.getByRole('dialog', { name: 'remove member' });
      await expect(dialog, 'the removal dialog names the member').toContainText(TARGET.email);
      const removed = nextResponse(page, 'DELETE', TARGET_ROUTE);
      const relisted = nextResponse(page, 'GET', MEMBERS_ROUTE);
      await dialog.getByRole('button', { name: 'remove member', exact: true }).click();
      const response = await removed;
      await expectStatus(response, 200, `DELETE ${TARGET_ROUTE}`);
      expect(await response.json(), `DELETE ${TARGET_ROUTE}`).toMatchObject({
        siteId: SITE_ID,
        uid: TARGET.uid,
        wasMember: true,
      });
      await expectStatus(await relisted, 200, `GET ${MEMBERS_ROUTE} after the removal`);
      await expect(memberRow(page, TARGET.email), `${TARGET.email} on the page after the removal`).toHaveCount(0);
      expect(await readTargetRow(), `${TARGET_ROW} after the removal`).toBeNull();
    });

    expect(listedSites(), 'the sites the members section listed').toEqual(new Set([SITE_ID]));
  });

  test('a site admin who hard-loads the sites page or the members section stays there', async ({
    siteAdminPage: page,
  }) => {
    const siteName = await readSiteName();

    await test.step(`a fresh load of ${SITES_PAGE}`, async () => {
      await page.goto(SITES_PAGE);
      await expect(
        page.getByRole('link', { name: `settings for ${siteName}`, exact: true }),
        `${siteName}'s gear on ${SITES_PAGE}`,
      ).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
      await expectAdmittedAt(page, SITES_PAGE);
    });

    await test.step(`a fresh load of ${MEMBERS_SECTION}`, async () => {
      await page.goto(MEMBERS_SECTION);
      await expect(roleCell(page, SITE_ADMIN.email), `${SITE_ADMIN.email}'s role in the members section`).toHaveText(
        'admin',
        { timeout: PAGE_READY_TIMEOUT_MS },
      );
      await expectAdmittedAt(page, MEMBERS_SECTION);
    });
  });

  test('a member gets no member management, and the members route refuses their add', async ({
    memberPage,
    siteAdminPage,
  }) => {
    await test.step('the sites page turns a member away', async () => {
      await memberPage.goto(SITES_PAGE);
      // RequireAdminAccess sends a signed-in user who administers no site to /dashboard, and says why.
      await memberPage.waitForURL((url) => url.origin === DEV_ORIGIN && url.pathname === '/dashboard', {
        timeout: PAGE_READY_TIMEOUT_MS,
      });
      await expect(memberPage.getByText('access denied', { exact: true }).first(), 'the gate refusal').toBeVisible();
      await expect(memberPage.getByRole('button', { name: 'add member', exact: true })).toHaveCount(0);
    });

    await test.step('the user menu offers a member no admin panel', async () => {
      await waitForMembershipsOnDashboard(memberPage);
      await memberPage.getByTestId('user-menu-trigger').click();
      const menu = memberPage.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: 'sign out' }), 'the open user menu').toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'admin panel' }), "a member's user menu").toHaveCount(0);
      await memberPage.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    });

    await test.step("the members route refuses the member's add", async () => {
      const answer = await sendFromPage(memberPage, ADD_TARGET);
      expect(answer.status, answered(`POST ${MEMBERS_ROUTE} as ${MEMBER.uid}`, answer) + MEMBER_ADD_HINT).toBe(403);
      expect(answer.body?.detail, 'why the route refused the member').toBe(CAPABILITY_REFUSAL);
      expect(await readTargetRow(), `${TARGET_ROW} after the refused add`).toBeNull();
    });

    await test.step('positive control: the same add as the site admin lands, then is undone', async () => {
      await siteAdminPage.goto('/dashboard');
      await expect(siteAdminPage.getByTestId('user-menu-trigger'), 'the signed-in dashboard').toBeVisible({
        timeout: PAGE_READY_TIMEOUT_MS,
      });
      const added = await sendFromPage(siteAdminPage, ADD_TARGET);
      expect(added.status, answered(`POST ${MEMBERS_ROUTE} as ${SITE_ADMIN.uid}`, added)).toBe(200);
      expect(added.body, `POST ${MEMBERS_ROUTE}`).toMatchObject({
        uid: TARGET.uid,
        siteId: SITE_ID,
        requestedRole: 'member',
      });
      expect(await readTargetRow(), `${TARGET_ROW} after the site admin's add`).toEqual(rowAddedBySiteAdmin('member'));

      const removed = await sendFromPage(siteAdminPage, REMOVE_TARGET);
      expect(removed.status, answered(`DELETE ${TARGET_ROUTE} as ${SITE_ADMIN.uid}`, removed)).toBe(200);
      expect(removed.body, `DELETE ${TARGET_ROUTE}`).toMatchObject({ siteId: SITE_ID, uid: TARGET.uid, wasMember: true });
      expect(await readTargetRow(), `${TARGET_ROW} after the undo`).toBeNull();
    });
  });
});
