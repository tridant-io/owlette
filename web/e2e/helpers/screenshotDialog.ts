/**
 * a machine with one stored screenshot, so its screenshot dialog opens on that capture
 * instead of sending a new one, and the steps that open the dialog from its card.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from './emulator';
import { seedMachine } from './seed';
import { stubScreenshotCapture } from './stubAgent';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function machineRef(siteId: string, machineId: string) {
  return getAdminDb().collection('sites').doc(siteId).collection('machines').doc(machineId);
}

export async function seedScreenshotMachine(siteId: string, machineId: string, shotId: string): Promise<void> {
  await seedMachine(siteId, machineId);
  await stubScreenshotCapture(siteId, machineId, PNG_1X1);
  await machineRef(siteId, machineId).collection('screenshots').doc(shotId).set({
    url: PNG_1X1,
    timestamp: Timestamp.now(),
    sizeKB: 128,
  });
}

export async function removeScreenshotMachine(siteId: string, machineId: string, shotId: string): Promise<void> {
  await machineRef(siteId, machineId).collection('screenshots').doc(shotId).delete();
  await machineRef(siteId, machineId).delete();
}

/** from the dashboard, through the machine card's menu */
export async function openScreenshotDialog(page: Page, machineId: string): Promise<Locator> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: machineId });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'screenshot' }).click();

  const dialog = page.getByRole('dialog', { name: new RegExp(`screenshot — ${machineId}`) });
  await expect(dialog).toBeVisible();
  return dialog;
}
