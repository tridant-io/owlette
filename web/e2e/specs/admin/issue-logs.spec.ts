/**
 * Admin — the logs zip attached to an issue, through the link the alert email
 * carries (`GET /api/admin/issues/{id}/logs`), and through a superadmin's API
 * key with the `issue=*:read` scope, by the issue number.
 *
 * The issue is written straight through the Admin SDK in the shape
 * `POST /api/bug-report` stores. Storage runs on the issue-logs OWLETTE_E2E
 * stub: a HEAD of any `issues/` key finds an object, and the presigned url
 * points at `issue-logs.e2e.invalid`, so nothing reaches R2.
 *
 * `page.request` drops the HttpOnly+Secure `__session` cookie on plain http
 * (see access-control/admin-api-403), so the role's cookies are sent by hand;
 * that keeps the 302 readable instead of followed to a host that does not exist.
 */

import crypto from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { test, expect, type Page } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const ISSUE_ID = `issue-logs-${SUFFIX}`;
// nine digits, so it cannot collide with a small number another spec seeds
const NUMBER = 100_000_000 + crypto.randomInt(899_999_999);
const KEY = `issues/site-A/mach-issue-${SUFFIX}/${crypto.randomUUID()}.zip`;
const LOGS_URL = `/api/admin/issues/${ISSUE_ID}/logs`;

test.beforeAll(async () => {
  await getAdminDb().doc(`bug_reports/${ISSUE_ID}`).set({
    source: 'agent',
    category: 'bug',
    title: 'the service stopped',
    description: 'it stopped after the update',
    status: 'new',
    number: NUMBER,
    siteId: 'site-A',
    machineId: `mach-issue-${SUFFIX}`,
    pageUrl: 'agent://KIOSK-01',
    logs: { key: KEY, size: 1024, expiresAt: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
});

test.afterAll(async () => {
  const db = getAdminDb();
  await db.doc(`bug_reports/${ISSUE_ID}`).delete();
  const audits = await Promise.all([
    db.collection('global/audit_log/entries').where('metadata.issueId', '==', ISSUE_ID).get(),
    db.collection('sites/site-A/audit_log').where('metadata.issueId', '==', ISSUE_ID).get(),
  ]);
  await Promise.all(audits.flatMap((snap) => snap.docs.map((d) => d.ref.delete())));
});

async function openLogs(page: Page) {
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  return page.request.get(LOGS_URL, { headers: { cookie }, maxRedirects: 0 });
}

test.describe('as a superadmin', () => {
  test.use(roleState('superadmin'));

  test('the email link redirects to the download and leaves an audit row for us and one for the site', async ({ page }) => {
    const res = await openLogs(page);

    expect(res.status()).toBe(302);
    expect(res.headers()['cache-control']).toBe('no-store');
    const day = new Date().toISOString().slice(0, 10);
    const location = new URL(res.headers().location);
    expect(location.host).toBe('issue-logs.e2e.invalid');
    expect(location.pathname).toBe(`/${KEY}`);
    expect(location.searchParams.get('filename')).toBe(`owlette-issue-KIOSK-01-${day}.zip`);

    const audits = await getAdminDb()
      .collection('global/audit_log/entries')
      .where('metadata.issueId', '==', ISSUE_ID)
      .get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0].data()).toMatchObject({
      actor: { type: 'user', userId: 'super-uid', role: 'superadmin' },
      outcome: 'allow',
    });

    const siteAudits = await getAdminDb()
      .collection('sites/site-A/audit_log')
      .where('metadata.issueId', '==', ISSUE_ID)
      .get();
    expect(siteAudits.size).toBe(1);
    expect(siteAudits.docs[0].data()).toMatchObject({
      correlationId: audits.docs[0].data().correlationId,
      actor: { type: 'system', name: 'owlette_support' },
      target: { kind: 'machine', id: `mach-issue-${SUFFIX}` },
      outcome: 'allow',
      metadata: { action: 'issue_logs_download', machineName: 'KIOSK-01' },
    });
  });
});

test.describe('as a site admin', () => {
  test.use(roleState('admin'));

  test('the same link is refused', async ({ page }) => {
    const res = await openLogs(page);
    expect(res.status()).toBe(403);
  });
});

test.describe('with an API key', () => {
  let issueKey: MintedApiKey | undefined;
  let userKey: MintedApiKey | undefined;

  test.beforeAll(async () => {
    // issue is superadmin-only, so both keys belong to the seeded superadmin (the helper's default)
    issueKey = await mintApiKey({
      name: 'e2e-issue-read',
      scopes: [{ resource: 'issue', id: '*', permissions: ['read'] }],
    });
    userKey = await mintApiKey({
      name: 'e2e-user-admin',
      scopes: [{ resource: 'user', id: '*', permissions: ['admin'] }],
    });
  });

  test.afterAll(async () => {
    await Promise.all([issueKey, userKey].flatMap((key) => (key ? [revokeApiKey(key)] : [])));
  });

  test('issue=*:read downloads by the issue number, audited under the doc id', async ({ request }) => {
    const res = await request.get(`/api/admin/issues/${NUMBER}/logs`, {
      headers: authHeaders(issueKey!, false),
      maxRedirects: 0,
    });

    expect(res.status()).toBe(302);
    expect(new URL(res.headers().location).pathname).toBe(`/${KEY}`);

    const audits = await getAdminDb()
      .collection('global/audit_log/entries')
      .where('metadata.issueId', '==', ISSUE_ID)
      .get();
    const keyRows = audits.docs.filter((d) => d.data().actor?.apiKeyId === issueKey!.keyId);
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0].data()).toMatchObject({
      actor: { type: 'user', userId: 'super-uid', role: 'superadmin' },
      outcome: 'allow',
    });
  });

  test('user=*:admin alone is refused', async ({ request }) => {
    const res = await request.get(`/api/admin/issues/${NUMBER}/logs`, {
      headers: authHeaders(userKey!, false),
      maxRedirects: 0,
    });

    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('scope_insufficient');
  });
});
