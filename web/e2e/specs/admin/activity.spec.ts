/**
 * Admin — activity: the superadmin feed (`/admin/activity`) and its API
 * (`GET /api/admin/activity`, key scope `user=*:read`).
 *
 * One row of every stored shape is written through the Admin SDK, exactly as the
 * feed reads them: a change row and a deny row under site-A's `audit_log`, a
 * platform change row under `sites/_platform/audit_log`, a sign-in and a failed
 * second factor in `global/audit_log/entries`, and a high and a digest finding in
 * `global/activity_watch/findings`. Fifty-five more change rows sit under a site
 * of their own so a view holds more than a page, and one change row sits on a
 * fixed day in 2024 for the date range. Everything seeded is removed afterwards.
 *
 * The last describe runs the real detection path: five failed second factors for
 * one user, then `GET /api/cron/activity-watch` twice. No mail goes out (resend is
 * not configured in e2e).
 *
 * The emulator does not enforce indexes. A green run here proves the feed's
 * logic, not that `firestore.indexes.json` holds every composite the production
 * queries need: that is checked by deploying the indexes to dev.
 *
 * `page.request` drops the HttpOnly+Secure `__session` cookie on plain http
 * (see access-control/admin-api-403), so a session call would send the role's
 * cookies by hand; this spec only calls the API with keys.
 */

import crypto from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { test, expect, type Page } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { E2E_CRON_SECRET } from '../../helpers/cron';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const ASN = 4_200_000_000 + crypto.randomInt(99_999_999);
const NOW = Date.now();
const FILL_SITE = `act-fill-${SUFFIX}`;
const FILL_COUNT = 55;

const FINDING_HIGH = `act-high-${SUFFIX}`;
const FINDING_DIGEST = `act-digest-${SUFFIX}`;

// text each seeded row shows, newest first (the order they are seeded in below)
const HIGH = `admin failed a second factor 5 times ${SUFFIX}`;
const DIGEST = `member was refused 6 times ${SUFFIX}`;
const CHANGE = `changed-${SUFFIX}`;
const PLATFORM = `installer-${SUFFIX}`;
const DENY = `mach-${SUFFIX}`;
const SIGN_IN = `AS${ASN}`;
const SECOND_FACTOR = `bad code ${SUFFIX}`;
// a host-reported refusal: not in NEWEST_FIRST, so the order checks above ignore it
const HOST_MACHINE = `tec-${SUFFIX}`;
const VIEWER_ID = `viewer-${SUFFIX}`;
// a machine's routine session renewals, which the feed leaves out
const ROUTINE = `renewed-${SUFFIX}`;
// a change on a fixed past day, at noon utc so the browser's own zone keeps it on that day
const OLD = `old-${SUFFIX}`;
const OLD_DAY = '2024-03-06';
const NEWEST_FIRST = [HIGH, DIGEST, CHANGE, PLATFORM, DENY, SIGN_IN, SECOND_FACTOR];

const ADMIN = 'admin@e2e.test';
const SITE_A = 'Site A (Assigned)';

const seeded: FirebaseFirestore.DocumentReference[] = [];

function changeRow(
  siteId: string,
  hash: string,
  recordedAt: number,
  event: { kind: string; actor: string; target: string; verb: string },
) {
  return {
    event: {
      kind: event.kind,
      siteId,
      actor: event.actor,
      occurredAt: recordedAt,
      target: event.target,
      attributes: { verb: event.verb, endpoint: '/api/e2e', method: 'PATCH' },
    },
    recordedAt,
    previousHash: '',
    hash,
  };
}

test.beforeAll(async () => {
  const db = getAdminDb();
  const siteLog = (siteId: string) => db.collection('sites').doc(siteId).collection('audit_log');
  const entries = db.collection('global').doc('audit_log').collection('entries');
  const findings = db.collection('global').doc('activity_watch').collection('findings');
  const ago = (seconds: number) => NOW - seconds * 1000;
  const batch = db.batch();
  const put = (ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) => {
    seeded.push(ref);
    batch.set(ref, data);
  };

  put(findings.doc(FINDING_HIGH), {
    id: FINDING_HIGH,
    rule: 'second_factor_burst',
    severity: 'high',
    title: 'second factor burst',
    summary: HIGH,
    subject: { userId: 'admin-uid' },
    at: ago(8),
    facts: [{ label: 'attempts', value: '5' }],
    rowIds: [],
    detectedAt: ago(5),
    emailedAt: null,
    digestedAt: null,
  });
  put(findings.doc(FINDING_DIGEST), {
    id: FINDING_DIGEST,
    rule: 'refusal_burst',
    severity: 'digest',
    title: 'refusal burst',
    summary: DIGEST,
    subject: { userId: 'member-uid', siteId: 'site-A' },
    at: ago(12),
    facts: [{ label: 'refusals', value: '6' }],
    rowIds: [],
    detectedAt: ago(10),
    emailedAt: null,
    digestedAt: null,
  });

  const changeHash = crypto.createHash('sha256').update(`change-${SUFFIX}`).digest('hex');
  put(
    siteLog('site-A').doc(changeHash),
    changeRow('site-A', changeHash, ago(20), {
      kind: 'user_mutated',
      actor: 'user:admin-uid',
      target: CHANGE,
      verb: 'promoted',
    }),
  );
  for (const n of [1, 2, 3]) {
    const hash = crypto.createHash('sha256').update(`routine-${n}-${SUFFIX}`).digest('hex');
    put(
      siteLog('site-A').doc(hash),
      changeRow('site-A', hash, ago(15 + n), {
        kind: 'site_mutated',
        actor: 'machine:tec-a4d',
        target: ROUTINE,
        verb: 'fleet_session_minted',
      }),
    );
  }
  const oldHash = crypto.createHash('sha256').update(`old-${SUFFIX}`).digest('hex');
  put(
    siteLog('site-A').doc(oldHash),
    changeRow('site-A', oldHash, Date.parse(`${OLD_DAY}T12:00:00Z`), {
      kind: 'user_mutated',
      actor: 'user:admin-uid',
      target: OLD,
      verb: 'promoted',
    }),
  );
  const platformHash = crypto.createHash('sha256').update(`platform-${SUFFIX}`).digest('hex');
  put(
    siteLog('_platform').doc(platformHash),
    changeRow('_platform', platformHash, ago(30), {
      kind: 'installer_mutated',
      actor: 'user:super-uid',
      target: PLATFORM,
      verb: 'uploaded',
    }),
  );

  put(siteLog('site-A').doc(`act-deny-${SUFFIX}`), {
    correlationId: `corr-deny-${SUFFIX}`,
    actor: { type: 'user', userId: 'admin-uid', role: 'admin' },
    capability: 'MACHINE_REMOVE',
    target: { kind: 'machine', id: DENY },
    outcome: 'deny',
    denyReason: 'not_site_owner',
    metadata: { route: '/api/machines/[id]', method: 'DELETE' },
    timestamp: Timestamp.fromMillis(ago(40)),
  });
  // the swoop host reports the refusal and knows only the viewer; the person is on the session's start row
  put(siteLog('site-A').doc(`act-start-${SUFFIX}`), {
    correlationId: `corr-start-${SUFFIX}`,
    actor: { type: 'user', userId: 'admin-uid', role: 'admin' },
    capability: 'MACHINE_REMOTE_CONTROL',
    target: { kind: 'swoop_session', id: `sid-${SUFFIX}`, machineId: HOST_MACHINE },
    outcome: 'allow',
    metadata: { event: 'session_started', sid: `sid-${SUFFIX}`, viewerId: VIEWER_ID, ctl: true },
    timestamp: Timestamp.fromMillis(ago(45)),
  });
  put(siteLog('site-A').doc(`act-host-${SUFFIX}`), {
    correlationId: `corr-host-${SUFFIX}`,
    actor: { type: 'system', name: 'swoop_host' },
    capability: 'MACHINE_REMOTE_CONTROL',
    target: { kind: 'swoop_session', id: `sid-${SUFFIX}`, machineId: HOST_MACHINE },
    outcome: 'deny',
    denyReason: 'input_not_permitted',
    metadata: { event: 'input_not_permitted', sid: `sid-${SUFFIX}`, viewerId: VIEWER_ID },
    timestamp: Timestamp.fromMillis(ago(45)),
  });
  put(entries.doc(`act-signin-${SUFFIX}`), {
    correlationId: `corr-signin-${SUFFIX}`,
    actor: { type: 'user', userId: 'super-uid', role: 'superadmin' },
    capability: 'AUTH_SIGN_IN',
    target: { kind: 'user', id: 'super-uid' },
    outcome: 'allow',
    metadata: { event: 'sign_in', method: 'passkey', network: { key: `asn:${ASN}`, prefix: '73.162.14.0/24', viaEdge: true } },
    timestamp: Timestamp.fromMillis(ago(50)),
  });
  put(entries.doc(`act-factor-${SUFFIX}`), {
    correlationId: `corr-factor-${SUFFIX}`,
    actor: { type: 'user', userId: 'admin-uid', role: 'admin' },
    capability: 'AUTH_SECOND_FACTOR',
    target: { kind: 'user', id: 'admin-uid' },
    outcome: 'deny',
    denyReason: `bad_code_${SUFFIX}`,
    metadata: { event: 'second_factor_failed', method: 'totp' },
    timestamp: Timestamp.fromMillis(ago(60)),
  });
  await batch.commit();

  // an hour back, so the fill never crowds the seeded rows off the first page
  const fill = db.batch();
  for (let i = 0; i < FILL_COUNT; i++) {
    const hash = crypto.createHash('sha256').update(`fill-${SUFFIX}-${i}`).digest('hex');
    const ref = siteLog(FILL_SITE).doc(hash);
    seeded.push(ref);
    fill.set(
      ref,
      changeRow(FILL_SITE, hash, NOW - 60 * 60 * 1000 - i * 1000, {
        kind: 'site_mutated',
        actor: 'user:admin-uid',
        target: `fill-${i}`,
        verb: 'updated',
      }),
    );
  }
  await fill.commit();
});

test.afterAll(async () => {
  const db = getAdminDb();
  for (let i = 0; i < seeded.length; i += 400) {
    const batch = db.batch();
    seeded.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
});

const feed = (page: Page) => page.getByRole('list', { name: 'activity' });
const item = (page: Page, text: string) => feed(page).getByRole('listitem').filter({ hasText: text });

/** the seeded rows on screen, in the order they appear */
async function seededOnScreen(page: Page): Promise<string[]> {
  await expect(feed(page)).toBeVisible();
  const texts = await feed(page).getByRole('listitem').allInnerTexts();
  return texts.flatMap((t) => NEWEST_FIRST.filter((marker) => t.includes(marker)));
}

async function badges(page: Page): Promise<string[]> {
  await expect(feed(page)).toBeVisible();
  return [...new Set(await feed(page).locator('[data-slot="badge"]').allInnerTexts())].sort();
}

async function pick(page: Page, picker: 'user' | 'site', option: string) {
  await page.getByRole('combobox', { name: picker }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test.describe('the page, as a superadmin', () => {
  test.use(roleState('superadmin'));

  test('lists every kind newest first', async ({ page }) => {
    await page.goto('/admin/activity');
    await expect(page.getByRole('heading', { level: 1, name: 'activity' })).toBeVisible();
    await expect(item(page, SECOND_FACTOR)).toBeVisible();

    expect(await seededOnScreen(page)).toEqual(NEWEST_FIRST);

    await expect(item(page, HIGH)).toContainText('flagged · high');
    await expect(item(page, DIGEST)).toContainText('flagged · digest');
    await expect(item(page, CHANGE)).toContainText(`${ADMIN} promoted user ${CHANGE}`);
    await expect(item(page, CHANGE)).toContainText(SITE_A);
    await expect(item(page, PLATFORM)).toContainText('uploaded installer');
    await expect(item(page, PLATFORM)).toContainText('platform');
    await expect(item(page, SIGN_IN)).not.toContainText('platform');
    await expect(item(page, SIGN_IN)).toContainText('superadmin');    await expect(item(page, DENY)).toContainText(`${ADMIN} was refused: machine remove on ${DENY}`);
    await expect(item(page, SIGN_IN)).toContainText('signed in with a passkey');
    await expect(item(page, SIGN_IN)).toContainText('73.162.14.0/24');
    await expect(item(page, SECOND_FACTOR)).toContainText('failed a second factor');
  });

  for (const view of ['all', 'changes']) {
    test(`the ${view} view leaves out routine fleet session rows`, async ({ page }) => {
      await page.goto(`/admin/activity?view=${view}`);
      await expect(item(page, CHANGE)).toBeVisible();
      await expect(item(page, ROUTINE)).toHaveCount(0);
    });
  }

  // one test per view, so a view that shows a stray row fails alone. refused is
  // everything owlette said no to, so it holds the failed second factor, with its sign-in badge
  const VIEWS: [string, string[], string[]][] = [
    ['flagged', [HIGH, DIGEST], ['flagged · digest', 'flagged · high']],
    ['changes', [CHANGE, PLATFORM], ['change']],
    ['refused', [DENY, SECOND_FACTOR], ['refused', 'sign-in']],
    ['sign-ins', [SIGN_IN, SECOND_FACTOR], ['sign-in']],
  ];
  for (const [view, shown, kinds] of VIEWS) {
    test(`the ${view} view shows only its own kind`, async ({ page }) => {
      await page.goto('/admin/activity');
      await page.getByRole('group', { name: 'view' }).getByRole('button', { name: view, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`view=${view}$`));
      await expect(item(page, shown[0])).toBeVisible();
      expect(await seededOnScreen(page)).toEqual(NEWEST_FIRST.filter((m) => shown.includes(m)));
      for (const marker of NEWEST_FIRST.filter((m) => !shown.includes(m))) {
        await expect(item(page, marker), `${view} hides ${marker}`).toHaveCount(0);
      }
      expect(await badges(page)).toEqual(kinds);
    });
  }

  test('a host-reported refusal names the person and the machine', async ({ page }) => {
    await page.goto('/admin/activity?view=refused');
    const row = item(page, HOST_MACHINE);
    await expect(row).toBeVisible();
    await expect(row).toContainText(`${ADMIN} was refused: input not permitted on ${HOST_MACHINE}`);
    await expect(row).toContainText(`${SITE_A} · reported by owlette · swoop host`);

    await row.getByRole('button').click();
    await expect(row.locator('dt:text-is("viewer") + dd')).toHaveText(ADMIN);
    await expect(row.locator('dt:text-is("machine") + dd')).toHaveText(HOST_MACHINE);
    await expect(row.locator('dt:text-is("target") + dd')).toHaveText(`swoop session sid-${SUFFIX}`);

    await row.getByRole('button', { name: 'everything from this actor' }).click();
    await expect(page).toHaveURL(/user=admin-uid$/);
  });

  test('the user filter narrows the list to that person', async ({ page }) => {
    await page.goto('/admin/activity');
    await expect(item(page, SECOND_FACTOR)).toBeVisible();

    await pick(page, 'user', ADMIN);
    await expect(page).toHaveURL(/user=admin-uid$/);
    await expect(item(page, PLATFORM)).toHaveCount(0);
    await expect.poll(() => seededOnScreen(page)).toEqual([HIGH, CHANGE, DENY, SECOND_FACTOR]);

    await pick(page, 'user', 'anyone');
    await expect(page).toHaveURL(/\/admin\/activity$/);
    await expect(item(page, PLATFORM)).toBeVisible();
  });

  test('the site filter narrows the list to that site', async ({ page }) => {
    await page.goto('/admin/activity');
    await expect(item(page, SECOND_FACTOR)).toBeVisible();

    await pick(page, 'site', SITE_A);
    await expect(page).toHaveURL(/site=site-A$/);
    await expect(item(page, PLATFORM)).toHaveCount(0);
    await expect.poll(() => seededOnScreen(page)).toEqual([DIGEST, CHANGE, DENY]);

    await pick(page, 'site', 'every site');
    await expect(page).toHaveURL(/\/admin\/activity$/);
    await expect(item(page, PLATFORM)).toBeVisible();
  });

  test('an opened row shows its record and its shortcuts set the filters', async ({ page }) => {
    await page.goto('/admin/activity');

    const row = item(page, CHANGE);
    await row.getByRole('button').click();
    await expect(row.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
    await expect(row.getByText('user_mutated:promoted')).toBeVisible();
    await expect(row.getByText('/api/e2e')).toBeVisible();

    await row.getByRole('button', { name: 'everything from this actor' }).click();
    await expect(page).toHaveURL(/user=admin-uid$/);
    await expect(page.getByRole('combobox', { name: 'user' })).toHaveText(ADMIN);
    await expect(item(page, PLATFORM)).toHaveCount(0);

    await item(page, CHANGE).getByRole('button').click();
    await item(page, CHANGE).getByRole('button', { name: 'everything on this site' }).click();
    await expect(page).toHaveURL(/user=admin-uid&site=site-A$/);
    await expect(page.getByRole('combobox', { name: 'site' })).toHaveText(SITE_A);
    await expect.poll(() => seededOnScreen(page)).toEqual([CHANGE, DENY]);

    await page.goto('/admin/activity');
    const finding = item(page, HIGH);
    await finding.getByRole('button').click();
    await expect(finding.getByText('attempts', { exact: true })).toBeVisible();
    await expect(finding.getByText('severity', { exact: true })).toBeVisible();
    await expect(finding.getByText('not emailed yet')).toBeVisible();
    await expect(finding.getByRole('button', { name: 'everything on this site' })).toHaveCount(0);
  });

  test('the date range narrows the list and stays in the url', async ({ page }) => {
    await page.goto('/admin/activity');
    await expect(item(page, CHANGE)).toBeVisible();

    await page.getByRole('combobox', { name: 'date range' }).click();
    await page.getByRole('option', { name: 'custom range', exact: true }).click();
    await expect(page).toHaveURL(/range=custom$/);
    // each day is a navigation: let it land before the next, as a person picking two days does
    for (const end of ['from', 'to']) {
      await page.getByLabel(end, { exact: true }).fill(OLD_DAY);
      await page.getByLabel(end, { exact: true }).press('Enter');
      await expect(page).toHaveURL(new RegExp(`${end}=${OLD_DAY}`));
    }
    await expect(page).toHaveURL(new RegExp(`range=custom&from=${OLD_DAY}&to=${OLD_DAY}$`));
    await expect(item(page, OLD)).toBeVisible();
    await expect(item(page, CHANGE)).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('combobox', { name: 'date range' })).toHaveText('custom range');
    await expect(item(page, OLD)).toBeVisible();

    await page.getByRole('combobox', { name: 'date range' }).click();
    await page.getByRole('option', { name: 'last 24 hours', exact: true }).click();
    await expect(page).toHaveURL(/range=last_24h$/);
    await expect(item(page, CHANGE)).toBeVisible();
    await expect(item(page, OLD)).toHaveCount(0);
  });

  test('load more appears past a page and adds the rest', async ({ page }) => {
    await page.goto(`/admin/activity?view=changes&site=${FILL_SITE}`);
    const rows = feed(page).getByRole('listitem');
    await expect(rows).toHaveCount(50);

    await page.getByRole('button', { name: 'load more' }).click();
    await expect(rows).toHaveCount(FILL_COUNT);
    await expect(page.getByRole('button', { name: 'load more' })).toHaveCount(0);
  });
});

test.describe('the page at a phone width', () => {
  test.use({ ...roleState('superadmin'), viewport: { width: 390, height: 844 } });

  test('fits the viewport, closed and with a row opened', async ({ page }) => {
    await page.goto('/admin/activity');
    await expect(item(page, SECOND_FACTOR)).toBeVisible();
    await assertNoHorizontalOverflow(page);

    const views = page.getByRole('group', { name: 'view' }).getByRole('button');
    for (const button of await views.all()) await expectFullyWithinViewport(page, button, 'a view button');
    await expectFullyWithinViewport(page, page.getByRole('combobox', { name: 'user' }), 'the user filter');
    await expectFullyWithinViewport(page, page.getByRole('combobox', { name: 'site' }), 'the site filter');
    await expectFullyWithinViewport(page, page.getByRole('combobox', { name: 'date range' }), 'the date range');
    await expectFullyWithinViewport(page, page.getByRole('button', { name: 'refresh activity' }), 'refresh');

    const row = item(page, CHANGE);
    await row.getByRole('button').click();
    await expectFullyWithinViewport(page, row.getByRole('button', { name: 'everything from this actor' }), 'the actor shortcut');
    await expectFullyWithinViewport(page, row.getByRole('button', { name: 'everything on this site' }), 'the site shortcut');
    await assertNoHorizontalOverflow(page);

    await page.goto('/admin/activity?range=custom');
    await expectFullyWithinViewport(page, page.getByLabel('from', { exact: true }), 'the from day');
    await expectFullyWithinViewport(page, page.getByLabel('to', { exact: true }), 'the to day');
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('the page, as a site admin', () => {
  test.use(roleState('admin'));

  test('/admin/activity redirects away', async ({ page }) => {
    await page.goto('/admin/activity');
    await expect(page).not.toHaveURL(/\/admin\/activity$/, { timeout: 10_000 });
  });
});

test.describe('with an API key', () => {
  let userKey: MintedApiKey | undefined;
  let issueKey: MintedApiKey | undefined;

  test.beforeAll(async () => {
    [userKey, issueKey] = await Promise.all([
      mintApiKey({ name: 'e2e-activity-read', scopes: [{ resource: 'user', id: '*', permissions: ['read'] }] }),
      mintApiKey({ name: 'e2e-activity-no-scope', scopes: [{ resource: 'issue', id: '*', permissions: ['read'] }] }),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([userKey, issueKey].flatMap((key) => (key ? [revokeApiKey(key)] : [])));
  });

  test('user=*:read lists the feed, one view at a time', async ({ request }) => {
    const res = await request.get('/api/admin/activity?view=flagged&page_size=100', {
      headers: authHeaders(userKey!, false),
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { rows: { id: string; kind: string; severity?: string }[]; next_page_token: string };
    expect(body.rows.every((r) => r.kind === 'flagged')).toBe(true);
    expect(body.rows.map((r) => r.id)).toEqual(
      expect.arrayContaining([`finding:${FINDING_HIGH}`, `finding:${FINDING_DIGEST}`]),
    );
    expect(body.next_page_token).toBe('');
  });

  test('a key without the scope is refused', async ({ request }) => {
    const res = await request.get('/api/admin/activity', { headers: authHeaders(issueKey!, false) });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('scope_insufficient');
  });
});

test.describe('the detection path, through the cron route', () => {
  test.use(roleState('superadmin'));

  const BURST_USER = 'member-uid';
  const BURST_EMAIL = 'member@e2e.test';
  const BURST = `5 failed sign-in or second-factor attempts for ${BURST_EMAIL} within 15 minutes.`;

  test('five failed second factors become one high finding, once', async ({ page, request }) => {
    const db = getAdminDb();
    const entries = db.collection('global').doc('audit_log').collection('entries');
    const findings = db.collection('global').doc('activity_watch').collection('findings');
    const state = db.collection('global').doc('activity_watch');
    const hadState = (await state.get()).exists;
    const before = new Set((await findings.get()).docs.map((d) => d.id));

    // minutes old, so past the 30 seconds the route leaves for the next scan
    for (let i = 0; i < 5; i++) {
      const ref = entries.doc(`act-burst-${SUFFIX}-${i}`);
      seeded.push(ref);
      await ref.set({
        correlationId: `corr-burst-${SUFFIX}-${i}`,
        actor: { type: 'user', userId: BURST_USER, role: 'member' },
        capability: 'AUTH_SECOND_FACTOR',
        target: { kind: 'user', id: BURST_USER },
        outcome: 'deny',
        denyReason: 'invalid_code',
        metadata: { event: 'second_factor_failed', method: 'totp' },
        timestamp: Timestamp.fromMillis(Date.now() - (2 + i) * 60 * 1000),
      });
    }

    const call = () => request.get('/api/cron/activity-watch', { headers: { 'x-cron-secret': E2E_CRON_SECRET } });
    const first = await call();
    expect(first.status(), await first.text()).toBe(200);
    const firstBody = (await first.json()) as { ok: boolean; findingsCreated: number; emailsSent: number };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.findingsCreated).toBeGreaterThanOrEqual(1);
    expect(firstBody.emailsSent).toBe(0);

    const created = (await findings.get()).docs.filter((d) => !before.has(d.id));
    created.forEach((d) => seeded.push(d.ref));
    if (!hadState) seeded.push(state);

    const burst = created.filter((d) => d.get('rule') === 'second_factor_burst' && d.get('subject.userId') === BURST_USER);
    expect(burst).toHaveLength(1);
    expect(burst[0].data()).toMatchObject({
      severity: 'high',
      title: 'second factor burst',
      summary: BURST,
      facts: [
        { label: 'user', value: BURST_EMAIL },
        { label: 'failures', value: '5' },
      ],
      emailedAt: null,
    });

    const second = await call();
    expect(second.status(), await second.text()).toBe(200);
    expect((await second.json()).findingsCreated).toBe(0);
    const burstDocs = (await findings.where('rule', '==', 'second_factor_burst').get()).docs.filter(
      (d) => d.get('subject.userId') === BURST_USER,
    );
    expect(burstDocs).toHaveLength(1);

    await page.goto('/admin/activity?view=flagged');
    const row = item(page, `for ${BURST_EMAIL} within 15 minutes`);
    await expect(row).toContainText('flagged · high');
    await row.getByRole('button').click();
    await expect(row.getByText('failures', { exact: true })).toBeVisible();
    await expect(row.locator('dt:has-text("failures") + dd')).toHaveText('5');
  });
});
