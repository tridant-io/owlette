/**
 * Admin — issues: the superadmin pages (`/admin/issues`, `/admin/issues/{number}`),
 * the `issue` API key scope on `GET/PATCH /api/admin/issues[/{id}]`, who may mint
 * that scope, and the numbers `POST /api/bug-report` hands out.
 *
 * Issues are written straight through the Admin SDK in the shape the bug-report
 * route stores, with nine-digit numbers so they cannot collide with the small
 * ones the counter hands out. Every seeded or submitted issue, and the audit rows
 * a status change writes, is removed afterwards.
 *
 * `page.request` drops the HttpOnly+Secure `__session` cookie on plain http
 * (see access-control/admin-api-403), so session calls send the role's cookies by hand.
 */

import crypto from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { test, expect, type Page } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const DAY = 24 * 60 * 60 * 1000;
const NEW_NUMBER = 100_000_000 + crypto.randomInt(899_999_998);
const TRIAGED_NUMBER = NEW_NUMBER + 1;
const NEW_ID = `issues-new-${SUFFIX}`;
const TRIAGED_ID = `issues-triaged-${SUFFIX}`;
const NEW_TITLE = `the lobby wall goes black ${SUFFIX}`;
const TRIAGED_TITLE = `pin machines to the top ${SUFFIX}`;
const USER_TEXT = 'it goes black every few minutes and comes back on its own.';

const SYSTEM_INFO = ['  hostname: LOBBY-WALL-03', '  cpu percent: 38.4', '  agent version: 4.1.17'].join('\n');
const LOG_LINE = '2026-10-15 09:58:00 ERROR process_monitor: TouchDesigner.exe exited with code 3221225477';

// submitted through the bug-report route; cleaned up with the seeded ones
const submittedIds: string[] = [];

test.beforeAll(async () => {
  const db = getAdminDb();
  await Promise.all([
    db.doc(`bug_reports/${NEW_ID}`).set({
      number: NEW_NUMBER,
      source: 'agent',
      category: 'bug',
      title: NEW_TITLE,
      description: `${USER_TEXT}\n\nscreenshots attached: 1\n\n--- system info ---\n${SYSTEM_INFO}\n\n--- recent logs (last ~100 lines) ---\n${LOG_LINE}`,
      status: 'new',
      createdAt: Timestamp.now(),
      userEmail: '',
      browserUA: 'Owlette Agent v4.1.17 / Windows',
      pageUrl: 'agent://LOBBY-WALL-03',
      siteId: 'site-A',
      machineId: `mach-issues-${SUFFIX}`,
      logs: {
        key: `issues/site-A/mach-issues-${SUFFIX}/${crypto.randomUUID()}.zip`,
        size: 1024,
        expiresAt: Timestamp.fromMillis(Date.now() + 30 * DAY),
        screenshots: 1,
        hasLogs: true,
      },
    }),
    db.doc(`bug_reports/${TRIAGED_ID}`).set({
      number: TRIAGED_NUMBER,
      source: 'web',
      category: 'feature_request',
      title: TRIAGED_TITLE,
      description: 'the three that matter most end up in the middle of the list.',
      status: 'triaged',
      triageNote: 'on the list',
      createdAt: Timestamp.fromMillis(Date.now() - DAY),
      userEmail: 'ops@example.test',
      pageUrl: 'http://127.0.0.1/dashboard',
    }),
  ]);
});

test.afterAll(async () => {
  const db = getAdminDb();
  const targets = [NEW_ID, TRIAGED_ID, String(NEW_NUMBER), String(TRIAGED_NUMBER)];
  const audits = await db.collection('global/audit_log/entries').where('target.id', 'in', targets).get();
  await Promise.all([
    ...[NEW_ID, TRIAGED_ID, ...submittedIds].map((id) => db.doc(`bug_reports/${id}`).delete()),
    ...audits.docs.filter((d) => d.data().target?.kind === 'issue').map((d) => d.ref.delete()),
  ]);
});

async function sessionCookie(page: Page): Promise<string> {
  return (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
}

test.describe('the pages, as a superadmin', () => {
  test.use(roleState('superadmin'));

  test('filters by status, opens an issue, and sets its status with a note that persists', async ({ page }) => {
    await page.goto('/admin/issues');

    const newList = page.getByRole('list', { name: 'new issues' });
    await expect(newList.getByRole('link', { name: new RegExp(NEW_TITLE) })).toBeVisible();
    await expect(newList.getByRole('link', { name: new RegExp(TRIAGED_TITLE) })).toHaveCount(0);

    const filters = page.getByRole('group', { name: 'status' });
    await filters.getByRole('button', { name: 'triaged', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/issues\?status=triaged$/);
    const triagedList = page.getByRole('list', { name: 'triaged issues' });
    await expect(triagedList.getByRole('link', { name: new RegExp(TRIAGED_TITLE) })).toBeVisible();
    await expect(triagedList.getByRole('link', { name: new RegExp(NEW_TITLE) })).toHaveCount(0);

    await filters.getByRole('button', { name: 'new', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/issues$/);
    const row = page.getByRole('list', { name: 'new issues' }).getByRole('link', { name: new RegExp(NEW_TITLE) });
    await expect(row).toContainText(`#${NEW_NUMBER}`);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/admin/issues/${NEW_NUMBER}$`));

    await expect(page.getByRole('heading', { level: 1, name: NEW_TITLE })).toBeVisible();
    for (const heading of ['description', 'triage', 'details', 'attachments', 'system info']) {
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    await expect(page.getByText(USER_TEXT)).toBeVisible();
    await expect(page.getByRole('row', { name: /cpu percent/ })).toContainText('38.4');
    await expect(page.getByRole('link', { name: 'download attachments' })).toHaveAttribute(
      'href',
      `/api/admin/issues/${NEW_NUMBER}/logs`,
    );
    await expect(page.getByText(LOG_LINE)).toBeHidden();
    await page.getByRole('button', { name: /log tail/ }).click();
    await expect(page.getByText(LOG_LINE)).toBeVisible();

    const note = `reproduced on the kiosk vm ${SUFFIX}`;
    await page.getByRole('combobox', { name: 'status' }).click();
    await page.getByRole('option', { name: 'fixed' }).click();
    await page.getByRole('textbox', { name: 'note' }).fill(note);
    await page.getByRole('button', { name: 'save' }).click();
    await expect(page.getByText(`issue #${NEW_NUMBER} marked fixed`)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: NEW_TITLE })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'status' })).toHaveText('fixed');
    await expect(page.getByRole('textbox', { name: 'note' })).toHaveValue(note);

    const stored = (await getAdminDb().doc(`bug_reports/${NEW_ID}`).get()).data();
    expect(stored).toMatchObject({ status: 'fixed', triageNote: note, statusUpdatedBy: 'super-uid' });
  });
});

test.describe('the pages, as a site admin', () => {
  test.use(roleState('admin'));

  test('/admin/issues redirects away', async ({ page }) => {
    await page.goto('/admin/issues');
    await expect(page).not.toHaveURL(/\/admin\/issues$/, { timeout: 10_000 });
  });

  test('minting the issue scope is refused', async ({ page }) => {
    const res = await page.request.post('/api/keys', {
      headers: { cookie: await sessionCookie(page), 'Content-Type': 'application/json' },
      data: {
        name: `e2e-issue-mint-${SUFFIX}`,
        scopes: [{ resource: 'issue', id: '*', permissions: ['read', 'write'] }],
      },
    });

    expect(res.status()).toBe(403);
    expect((await res.json()).detail).toMatch(/superadmin access required/);
  });
});

test.describe('with an API key', () => {
  let issueKey: MintedApiKey | undefined;
  let readKey: MintedApiKey | undefined;
  let userKey: MintedApiKey | undefined;

  test.beforeAll(async () => {
    // issue is superadmin-only, so every key belongs to the seeded superadmin (the helper's default)
    [issueKey, readKey, userKey] = await Promise.all([
      mintApiKey({
        name: 'e2e-issue-read-write',
        scopes: [{ resource: 'issue', id: '*', permissions: ['read', 'write'] }],
      }),
      mintApiKey({
        name: 'e2e-issue-read',
        scopes: [{ resource: 'issue', id: '*', permissions: ['read'] }],
      }),
      mintApiKey({
        name: 'e2e-user-admin',
        scopes: [{ resource: 'user', id: '*', permissions: ['admin'] }],
      }),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([issueKey, readKey, userKey].flatMap((key) => (key ? [revokeApiKey(key)] : [])));
  });

  test('issue=*:read and issue=*:write list, read by number, and set a status', async ({ request }) => {
    const list = await request.get('/api/admin/issues?status=triaged&page_size=100', {
      headers: authHeaders(issueKey!, false),
    });
    expect(list.status()).toBe(200);
    const { issues } = (await list.json()) as { issues: { id: string; status: string }[] };
    expect(issues.map((i) => i.id)).toContain(TRIAGED_ID);
    expect(issues.every((i) => i.status === 'triaged')).toBe(true);

    const one = await request.get(`/api/admin/issues/${TRIAGED_NUMBER}`, {
      headers: authHeaders(issueKey!, false),
    });
    expect(one.status()).toBe(200);
    expect(await one.json()).toMatchObject({
      id: TRIAGED_ID,
      number: TRIAGED_NUMBER,
      status: 'triaged',
      title: TRIAGED_TITLE,
      from: 'ops@example.test',
      triageNote: 'on the list',
    });

    const patch = await request.patch(`/api/admin/issues/${TRIAGED_NUMBER}`, {
      headers: authHeaders(issueKey!),
      data: { status: 'wontfix', note: 'out of scope for now' },
    });
    expect(patch.status()).toBe(200);
    expect(await patch.json()).toMatchObject({
      id: TRIAGED_ID,
      status: 'wontfix',
      triageNote: 'out of scope for now',
      statusUpdatedBy: 'super-uid',
    });
    expect((await getAdminDb().doc(`bug_reports/${TRIAGED_ID}`).get()).data()?.status).toBe('wontfix');
  });

  test('a key without the issue scope is refused', async ({ request }) => {
    const responses = await Promise.all([
      request.get('/api/admin/issues', { headers: authHeaders(userKey!, false) }),
      request.get(`/api/admin/issues/${TRIAGED_NUMBER}`, { headers: authHeaders(userKey!, false) }),
      request.patch(`/api/admin/issues/${TRIAGED_NUMBER}`, {
        headers: authHeaders(userKey!),
        data: { status: 'fixed' },
      }),
    ]);
    for (const res of responses) {
      expect(res.status()).toBe(403);
      expect((await res.json()).code).toBe('scope_insufficient');
    }
  });

  test('issue=*:read alone cannot set a status', async ({ request }) => {
    const res = await request.patch(`/api/admin/issues/${TRIAGED_NUMBER}`, {
      headers: authHeaders(readKey!),
      data: { status: 'fixed' },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('scope_insufficient');
  });
});

test.describe('the bug-report route, as a signed-in member', () => {
  test.use(roleState('member'));

  test('two submissions get consecutive numbers', async ({ page }) => {
    const cookie = await sessionCookie(page);

    const submit = async (n: number) => {
      const res = await page.request.post('/api/bug-report', {
        headers: { cookie, 'Content-Type': 'application/json' },
        data: {
          title: `e2e numbering ${SUFFIX} ${n}`,
          category: 'bug',
          description: 'checking that issues are numbered in order',
          browserUA: 'playwright',
          pageUrl: 'http://127.0.0.1/dashboard',
        },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { success: boolean; id: string; number: number };
      submittedIds.push(body.id);
      return body;
    };

    const first = await submit(1);
    const second = await submit(2);

    expect(first.success).toBe(true);
    expect(Number.isInteger(first.number)).toBe(true);
    expect(second.number).toBe(first.number + 1);
    const stored = await Promise.all(
      [first, second].map(async ({ id }) => (await getAdminDb().doc(`bug_reports/${id}`).get()).data()),
    );
    expect(stored.map((d) => d?.number)).toEqual([first.number, second.number]);
    expect(stored.every((d) => d?.status === 'new' && d?.userId === 'member-uid')).toBe(true);
  });
});
