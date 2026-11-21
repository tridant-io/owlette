/**
 * swoop — typing over a link that loses packets, through the fake host in
 * `e2e/helpers/swoopHost.ts`.
 *
 * a relay between the two drops a share of what the viewer sends (devtools'
 * own packet loss never reaches webrtc), the viewer types a sentence, and the
 * host's `swoop-input` messages, in the order they arrived, must spell it:
 * that order is the one a real host injects them in.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';
import { FakeSwoopHost, presentedPicture } from '../../helpers/swoopHost';

authenticator.options = { step: 30, window: 1 };
test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(120_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-swoop-keys-${SUFFIX}`;
const MACHINE_ID = `mach-swoop-keys-${SUFFIX}`;
/** letters and spaces only, so no shift goes with them. */
const TYPED =
  'while im typing this message over swoop right now you can see that certain characters get missed even though i am typing every single one in';
/** a share of the viewer's packets far worse than a real poor link, so a lost key is certain. */
const PACKET_LOSS = 0.2;

let operator: TestUser;
let operatorSecret = '';

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: `Swoop keys ${SUFFIX}`, owner: 'someone-else', timezone: 'UTC' });
  await seedMachine(SITE_ID, MACHINE_ID, { displayName: `keys box ${SUFFIX}` });
  await getAdminDb().doc(`sites/${SITE_ID}/settings/swoop`).set({ enabled: true }, { merge: true });
  operator = await seedDedicatedUser(dedicatedUser('member', `swoop-keys-${SUFFIX}`));
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

/** signs in with a second factor just passed, which is itself the step-up control needs. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(operator.email);
  await page.getByLabel(/password/i).first().fill(operator.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
  if (authenticator.timeRemaining() <= 5) await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
  await page.getByPlaceholder('000000').fill(authenticator.generate(operatorSecret));
  await page.getByRole('button', { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

/** what the host's keyboard typed: each key down, in the order it arrived, as a us layout spells it. */
function typedOnHost(host: FakeSwoopHost): string {
  return host.inputs
    .filter((m) => m.t === 'k' && m.down)
    .map((m) => {
      const code = String(m.code);
      if (code === 'Space') return ' ';
      return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : `[${code}]`;
    })
    .join('');
}

test('every key typed over a link that loses packets reaches the host, in the order it was typed', async ({
  page,
  browser,
}) => {
  const host = await FakeSwoopHost.start({ browser, viewer: page, siteId: SITE_ID, machineId: MACHINE_ID, lossy: true });
  const link = host.link!;
  try {
    await signIn(page);
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    await expect(page.getByRole('button', { name: /end session/i })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await presentedPicture(page)).playing, { timeout: 30_000 }).toBe(true);
    await expect(page.getByText(/view only/i)).toHaveCount(0);

    host.inputs.length = 0;
    link.loss = PACKET_LOSS;
    await page.keyboard.type(TYPED, { delay: 20 });
    await expect.poll(() => typedOnHost(host), { timeout: 15_000 }).toBe(TYPED);
    // the link really lost what the viewer sent, or a pass here proves nothing
    expect(link.dropped).toBeGreaterThan(0);
  } finally {
    await host.stop();
  }
});
