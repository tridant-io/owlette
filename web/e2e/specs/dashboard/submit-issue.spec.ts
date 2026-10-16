/**
 * Dashboard — the submit issue dialog with screenshots and a video, from the
 * header's help menu through `POST /api/issue-attachments/upload-url`, each
 * browser PUT and `POST /api/bug-report`, to the superadmin's issue page and
 * its per-file downloads (`GET /api/admin/issues/{id}/files/{n}`).
 *
 * Storage runs on the issue-logs OWLETTE_E2E stub: the presigned PUT is the
 * same-origin sink `/api/issue-attachments/e2e-put`, which records each file's
 * size in `e2eIssueFiles` for the route's HEAD, and a download redirects to
 * `issue-logs.e2e.invalid`, so nothing reaches R2.
 *
 * `page.request` drops the HttpOnly+Secure `__session` cookie on plain http
 * (see access-control/admin-api-403), so the role's cookies are sent by hand;
 * that keeps the 302 readable instead of followed to a host that does not exist.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const FIRST_LINE = `the lobby wall flickers after lunch ${SUFFIX}`;
const DESCRIPTION = `${FIRST_LINE}\nit comes back on its own a minute later.`;
const DAY = 24 * 60 * 60 * 1000;

// a 1x1 png, and a few kb standing in for an mp4: the dialog and the sink check the type, not the codec
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.concat([Buffer.from('000000186674797069736f6d', 'hex'), crypto.randomBytes(4096)]);

interface StoredFile {
  key: string;
  kind: string;
  size: number;
  ext: string;
}

let issue: { id: string; number: number; files: StoredFile[] } | undefined;

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  if (!issue) return;
  const db = getAdminDb();
  const audits = await db.collection('global/audit_log/entries').where('metadata.issueId', '==', issue.id).get();
  await Promise.all([
    db.doc(`bug_reports/${issue.id}`).delete(),
    ...issue.files.map((f) => db.doc(`e2eIssueFiles/${encodeURIComponent(f.key)}`).delete()),
    ...audits.docs.map((d) => d.ref.delete()),
  ]);
});

async function sessionCookie(page: Page): Promise<string> {
  return (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
}

async function pasteImage(page: Page, target: ReturnType<Page['getByRole']>) {
  await target.evaluate((el, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
}

test.describe('as a member', () => {
  test.use(roleState('member'));

  test('files an issue with no title, two screenshots and a video', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'help' }).click();
    await page.getByRole('menu').getByRole('menuitem').filter({ hasNotText: 'docs' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('title')).toHaveCount(0);
    await expect(dialog.getByRole('textbox')).toHaveCount(1);

    // category spans the form, like the desktop app's. layout widths, read together:
    // a bounding box reads the dialog's open animation mid-zoom
    const description = dialog.getByRole('textbox', { name: 'description' });
    await expect(dialog.getByRole('combobox', { name: 'category' })).toBeVisible();
    const [categoryWidth, textWidth] = await dialog.evaluate(() =>
      ['bug-category', 'bug-description'].map((id) => (document.getElementById(id) as HTMLElement).offsetWidth),
    );
    expect(categoryWidth).toBeGreaterThan(0);
    expect(categoryWidth).toBe(textWidth);

    const input = dialog.getByTestId('report-attachment-input');
    await input.setInputFiles([
      { name: 'lobby.png', mimeType: 'image/png', buffer: PNG },
      { name: 'flicker.mp4', mimeType: 'video/mp4', buffer: MP4 },
    ]);
    await pasteImage(page, description);
    await expect(dialog.getByTestId('report-screenshot')).toHaveCount(2);
    await expect(dialog.getByTestId('report-video')).toHaveCount(1);
    await expect(dialog.getByTestId('report-attachment-limit')).toHaveText('0.1 of 100 MB used');

    await input.setInputFiles({ name: 'loop.gif', mimeType: 'image/gif', buffer: PNG });
    await expect(dialog.getByTestId('report-attachment-notice')).toHaveText('loop.gif: only png, jpeg or webp images');
    await expect(dialog.getByTestId('report-screenshot')).toHaveCount(2);

    await dialog.getByRole('button', { name: 'remove screenshot' }).first().click();
    await expect(dialog.getByTestId('report-screenshot')).toHaveCount(1);
    await expect(dialog.getByTestId('report-video')).toHaveCount(1);

    await description.fill(DESCRIPTION);
    await dialog.getByRole('button', { name: 'submit' }).click();
    const toast = page.getByText(/^issue #\d+ submitted — thank you!$/);
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toBeHidden();
    const number = Number(/#(\d+)/.exec((await toast.textContent()) ?? '')![1]);

    const db = getAdminDb();
    const snap = await db.collection('bug_reports').where('number', '==', number).get();
    expect(snap.size).toBe(1);
    const doc = snap.docs[0];
    const stored = doc.data();
    issue = { id: doc.id, number, files: stored.files ?? [] };

    expect(stored).toMatchObject({
      source: 'web',
      category: 'bug',
      title: FIRST_LINE,
      description: DESCRIPTION,
      userId: 'member-uid',
    });
    expect(stored.logs).toBeUndefined();
    // the video, then the pasted screenshot: the file-picked one was removed
    expect(stored.files).toEqual([
      { key: expect.stringMatching(/^issues\/web\/member-uid\/[0-9a-f-]{36}\.mp4$/), kind: 'video', size: MP4.length, ext: 'mp4' },
      { key: expect.stringMatching(/^issues\/web\/member-uid\/[0-9a-f-]{36}\.png$/), kind: 'screenshot', size: PNG.length, ext: 'png' },
    ]);
    const recorded = await Promise.all(
      issue.files.map(async (f) => (await db.doc(`e2eIssueFiles/${encodeURIComponent(f.key)}`).get()).get('size')),
    );
    expect(recorded).toEqual(issue.files.map((f) => f.size));
    const expires = stored.filesExpireAt.toMillis() - Date.now();
    expect(expires).toBeGreaterThan(29 * DAY);
    expect(expires).toBeLessThanOrEqual(30 * DAY);
  });
});

test.describe('as a superadmin', () => {
  test.use(roleState('superadmin'));

  test('the issue page lists each file, and each download redirects and is audited', async ({ page }) => {
    expect(issue, 'the member test filed the issue').toBeDefined();
    const { id, number, files } = issue!;

    await page.goto(`/admin/issues/${number}`);
    await expect(page.getByRole('heading', { level: 1, name: FIRST_LINE })).toBeVisible({ timeout: 15_000 });
    const links = [
      { name: 'download video 1', index: 1 },
      { name: 'download screenshot 1', index: 2 },
    ];
    for (const { name, index } of links) {
      await expect(page.getByRole('link', { name })).toHaveAttribute('href', `/api/admin/issues/${number}/files/${index}`);
    }
    await expect(page.getByRole('link', { name: 'download attachments' })).toHaveCount(0);

    const cookie = await sessionCookie(page);
    for (const { index } of links) {
      const file = files[index - 1];
      const res = await page.request.get(`/api/admin/issues/${number}/files/${index}`, {
        headers: { cookie },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(302);
      expect(res.headers()['cache-control']).toBe('no-store');
      const location = new URL(res.headers().location);
      expect(location.host).toBe('issue-logs.e2e.invalid');
      expect(location.pathname).toBe(`/${file.key}`);
      expect(location.searchParams.get('filename')).toBe(`owlette-issue-${number}-${index}.${file.ext}`);
    }

    const audits = await getAdminDb().collection('global/audit_log/entries').where('metadata.issueId', '==', id).get();
    const rows = audits.docs.map((d) => d.data()).filter((d) => d.metadata?.action === 'issue_file_download');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor: { type: 'user', userId: 'super-uid', role: 'superadmin' },
        target: { kind: 'issue', id },
        outcome: 'allow',
      });
    }
    expect(rows.map((r) => r.metadata.file).sort()).toEqual([1, 2]);
  });
});
