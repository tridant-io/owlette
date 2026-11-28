/**
 * the site picker (components/SitePicker.tsx) the admin pages and owlette swoop
 * pick their site with: a combobox named "site" that opens a list named
 * "sites", where each site is a button named after it and then, once counted,
 * its machines ("Site A 2 machines").
 */

import { expect, type Page } from '@playwright/test';

export const sitePickerTrigger = (page: Page) => page.getByRole('combobox', { name: 'site', exact: true });

export const sitePickerList = (page: Page) => page.getByRole('dialog', { name: 'sites', exact: true });

/** a site's row in the open list, whether or not its count has landed */
export function sitePickerRow(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sitePickerList(page).getByRole('button', { name: new RegExp(`^${escaped}( \\d+ machines?)?$`) });
}

export async function pickSite(page: Page, name: string): Promise<void> {
  await sitePickerTrigger(page).click();
  await sitePickerRow(page, name).click();
  await expect(sitePickerTrigger(page)).toContainText(name);
}
