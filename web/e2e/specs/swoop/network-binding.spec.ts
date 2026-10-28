/**
 * swoop — control is tied to the networks a user verified, with the binding
 * enforced.
 *
 * runs against the second e2e server, the one with
 * `SWOOP_NETWORK_BINDING=enforce` (playwright.config.ts); the suite's own server
 * only logs. the browser plays cloudflare: `context.setExtraHTTPHeaders` adds
 * the edge's shared secret and an asn to every request, and dropping them is a
 * request that did not come through the edge. the step-ups use backup codes, so
 * no ceremony waits out a totp period.
 */

import crypto from 'crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';
import { ageSignInCeremony } from '../../helpers/signInCeremony';
import { E2E_ENFORCE_PORT, edgeHeaders } from '../../helpers/edgeNetwork';

authenticator.options = { step: 30, window: 1 };
test.use({
  storageState: { cookies: [], origins: [] },
  baseURL: `http://127.0.0.1:${E2E_ENFORCE_PORT}`,
});
test.setTimeout(120_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-netbind-${SUFFIX}`;
const MACHINE_ID = `mach-netbind-${SUFFIX}`;
const SESSIONS = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/swoop/sessions`;
const HOME = '64500';
const AWAY = '64501';
const BACKUP_CODES = ['NETBIND01', 'NETBIND02', 'NETBIND03'];

let operator: TestUser;
let operatorSecret = '';

const isMint = (r: { url(): string; request(): { method(): string } }) =>
  r.url().endsWith(SESSIONS) && r.request().method() === 'POST';

/** a fresh tab on the viewer: no continuity from an earlier one, so the window and the network decide. */
async function openViewer(context: BrowserContext): Promise<{ page: Page; status: number; proof: boolean }> {
  const page = await context.newPage();
  const minted = page.waitForResponse(isMint, { timeout: 45_000 });
  await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
  const response = await minted;
  return {
    page,
    status: response.status(),
    proof: Object.prototype.hasOwnProperty.call(response.request().postDataJSON() ?? {}, 'mfaProof'),
  };
}

async function stepUpWithBackupCode(page: Page, code: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/confirm it.s you/i, { timeout: 20_000 });
  const granted = page.waitForResponse((r) => isMint(r) && r.status() === 201, { timeout: 45_000 });
  await dialog.getByRole('checkbox', { name: /use a backup code instead/i }).click();
  await dialog.getByPlaceholder('backup code').fill(code);
  await dialog.getByRole('button', { name: /^confirm$/i }).click();
  expect(((await (await granted).json()) as { data: { ctl: boolean } }).data.ctl).toBe(true);
  await expect(dialog).toBeHidden();
}

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: `Netbind ${SUFFIX}`, owner: 'someone-else', timezone: 'UTC' });
  await seedMachine(SITE_ID, MACHINE_ID, { displayName: `netbind box ${SUFFIX}` });
  await getAdminDb()
    .doc(`sites/${SITE_ID}/settings/swoop`)
    .set({ enabled: true, excludedMachineIds: [], membersMayWatch: true, indicator: 'banner' });

  operator = await seedDedicatedUser(dedicatedUser('member', `netbind-${SUFFIX}`));
  operatorSecret = authenticator.generateSecret();
  await getAdminDb()
    .collection('users')
    .doc(operator.uid)
    .set(
      {
        mfaEnrolled: true,
        requiresMfaSetup: false,
        mfaSecret: operatorSecret,
        mfaFactors: { totp: true, passkeys: 0 },
        backupCodes: BACKUP_CODES.map((code) => crypto.createHash('sha256').update(code).digest('hex')),
      },
      { merge: true },
    );
  await grantMembership(SITE_ID, operator.uid, 'admin');
});

test('control asks once per network: a verified one passes, another or none asks again', async ({ page, context }) => {
  // signing in from home verifies home; dated back so it does not stand in for the step-up
  await context.setExtraHTTPHeaders(edgeHeaders(HOME));
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(operator.email);
  await page.getByLabel(/password/i).first().fill(operator.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  let code = authenticator.generate(operatorSecret);
  if (authenticator.timeRemaining() <= 5) {
    await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
    code = authenticator.generate(operatorSecret);
  }
  await page.getByPlaceholder('000000').fill(code);
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await ageSignInCeremony(page);
  const home = await getAdminDb().doc(`users/${operator.uid}/verified_networks/asn:${HOME}`).get();
  expect(home.data()).toMatchObject({ asn: HOME, label: `AS${HOME}` });

  // no window on this machine yet: one step-up opens it
  const first = await openViewer(context);
  expect(first.status).toBe(401);
  await stepUpWithBackupCode(first.page, BACKUP_CODES[0]);
  await first.page.close();

  // the same network: control, no second prompt
  const again = await openViewer(context);
  expect([again.status, again.proof]).toEqual([201, false]);
  await expect(again.page.getByRole('dialog')).toHaveCount(0);
  await again.page.close();

  // another network asks, the open window notwithstanding, and passing verifies it
  await context.setExtraHTTPHeaders(edgeHeaders(AWAY));
  const away = await openViewer(context);
  expect(away.status).toBe(401);
  await stepUpWithBackupCode(away.page, BACKUP_CODES[1]);
  await away.page.close();
  const awayAgain = await openViewer(context);
  expect([awayAgain.status, awayAgain.proof]).toEqual([201, false]);
  await awayAgain.page.close();

  // a request the edge did not vouch for is never a verified network
  await context.setExtraHTTPHeaders({});
  const unknown = await openViewer(context);
  expect(unknown.status).toBe(401);
  await expect(unknown.page.getByRole('dialog')).toContainText(/confirm it.s you/i, { timeout: 20_000 });

  // every control decision is on the trail with the network it came from
  const rows = await getAdminDb()
    .collection(`sites/${SITE_ID}/audit_log`)
    .where('metadata.event', '==', 'step_up_network_check')
    .get();
  const keys = rows.docs.map((d) => d.data().metadata?.key as string);
  expect(new Set(keys)).toEqual(new Set([`asn:${HOME}`, `asn:${AWAY}`, 'unknown']));
});
