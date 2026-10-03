/**
 * swoop — the keyboard menu follows the machine's system.
 *
 * a machine that reports `osFamily: 'macos'`, viewed from a browser that is not
 * a mac: the menu lists the mac's own chords, has no ctrl + alt + del, and
 * offers "ctrl acts as cmd", on by default. the emulator has no streamer, so the
 * session stays at "connecting"; the menu only needs the session and its `ctl`,
 * which the step-up grants, exactly as in `session.spec.ts`.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';

authenticator.options = { step: 30, window: 1 };
// the viewer that is not a mac: the chromium project's desktop chrome device
// reports windows in its user agent on every machine that runs the suite.
test.use({ storageState: { cookies: [], origins: [] } });
// a step-up right after a sign-in waits for the next totp period: up to 31 s.
test.setTimeout(120_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-swoop-mac-${SUFFIX}`;
const MACHINE_ID = `mach-swoop-mac-${SUFFIX}`;

let operator: TestUser;
let operatorSecret = '';

/** a code that is not the one just spent: the api refuses a replayed totp. */
async function freshTotp(page: Page, spent?: string): Promise<string> {
  let code = authenticator.generate(operatorSecret);
  if ((spent !== undefined && code === spent) || authenticator.timeRemaining() <= 5) {
    await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
    code = authenticator.generate(operatorSecret);
  }
  return code;
}

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: `Swoop mac ${SUFFIX}`, owner: 'someone-else', timezone: 'UTC' });
  await seedMachine(SITE_ID, MACHINE_ID);
  await getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}`).set({ osFamily: 'macos' }, { merge: true });
  await getAdminDb().doc(`sites/${SITE_ID}/settings/swoop`).set({ enabled: true }, { merge: true });

  operator = await seedDedicatedUser(dedicatedUser('member', `swoop-mac-operator-${SUFFIX}`));
  operatorSecret = authenticator.generateSecret();
  await getAdminDb().collection('users').doc(operator.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret: operatorSecret,
      mfaFactors: { totp: true, passkeys: 0 },
    },
    { merge: true },
  );
  await grantMembership(SITE_ID, operator.uid, 'admin');
});

test('a mac host gets the mac chords and ctrl acting as cmd, on by default', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(operator.email);
  await page.getByLabel(/password/i).first().fill(operator.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  const spent = await freshTotp(page);
  await page.getByPlaceholder('000000').fill(spent);
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/confirm it.s you/i, { timeout: 20_000 });
  const minted = page.waitForResponse(
    (r) => r.url().endsWith('/swoop/sessions') && r.request().method() === 'POST' && r.status() === 201,
    { timeout: 45_000 },
  );
  await dialog.getByPlaceholder('6-digit code').fill(await freshTotp(page, spent));
  await dialog.getByRole('button', { name: /^confirm$/i }).click();
  expect(((await (await minted).json()) as { data: { ctl: boolean } }).data.ctl).toBe(true);
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'send a key combination' }).click();
  const menu = page.getByRole('menu');
  // outside fullscreen the sticky cmd sits above the five chords: the viewer's
  // own windows keeps the super key until keyboard lock is held.
  for (const label of [
    'hold cmd for the next key',
    'cmd + tab',
    'cmd + space',
    'cmd + q',
    'cmd + ctrl + q',
    'esc',
  ]) {
    await expect(menu.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(menu.getByRole('menuitem')).toHaveCount(6);
  await expect(menu.getByText('ctrl + alt + del')).toHaveCount(0);
  // the two settings by name, shortcuts match on by default, and the legend it gives
  await expect(menu.getByRole('menuitemradio', { name: 'shortcuts match: ctrl acts as cmd' })).toBeChecked();
  await expect(menu.getByRole('menuitemradio', { name: 'keys match: ctrl is control' })).not.toBeChecked();
  await expect(menu.getByTestId('modifier-legend')).toHaveText(/ctrl\s*→\s*cmd\s*windows key\s*→\s*cmd\s*alt\s*→\s*option/);
  await expect(menu.getByTestId('super-key-note')).toContainText('the windows key');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /end session/i }).click();
});
