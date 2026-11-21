/**
 * The signed-in pages link the public release notes from the update owlette
 * dialog and from the download menu, in a new tab so a dialog and its machine
 * selection stay put.
 */

import { test, expect } from '@playwright/test';
import type { DocumentData } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { seedInstallerLatest } from '../../helpers/coverageSeed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-update-target';
// above seedMachine's agent_version 2.9.0, so the machine is outdated
const LATEST = '9.9.9';

const latestRef = () => getAdminDb().collection('installer_metadata').doc('latest');
let saved: DocumentData | undefined;

test.beforeEach(async () => {
  saved = (await latestRef().get()).data();
  await seedMachine(SITE_ID, MACHINE_ID, { monitorCount: 0 });
  await seedInstallerLatest(undefined, undefined, LATEST);
});

// a semver latest would put the update button on every later spec's pages
test.afterEach(async () => {
  const db = getAdminDb();
  await db.collection('installer_metadata').doc('data').collection('versions').doc(LATEST).delete();
  await (saved ? latestRef().set(saved) : latestRef().delete());
  await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete();
});

test('the update dialog links the release notes in a new tab', async ({ page }) => {
  await page.goto('/deployments');
  await page.getByRole('button', { name: /^update owlette/ }).click();

  const dialog = page.getByRole('dialog', { name: 'update owlette agents' });
  await expect(dialog).toContainText(`update selected machines to owlette v${LATEST}`);
  const notes = dialog.getByRole('link', { name: 'release notes' });
  await expect(notes).toHaveAttribute('href', '/docs/changelog');
  await expect(notes).toHaveAttribute('target', '_blank');
});

test('the download menu ends with the release notes', async ({ page }) => {
  await page.goto('/deployments');
  await page.getByRole('button', { name: 'choose installer platform' }).click();

  const notes = page.getByRole('menu').getByRole('menuitem').last();
  await expect(notes).toHaveText('release notes');
  await expect(notes).toHaveAttribute('href', '/docs/changelog');
  await expect(notes).toHaveAttribute('target', '_blank');
});
