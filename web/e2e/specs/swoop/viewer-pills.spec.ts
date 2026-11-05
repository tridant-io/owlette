/**
 * swoop's bar names who is in the session, against the emulators and the fake
 * host in `e2e/helpers/swoopHost.ts`: alone, the admin sees their own pill;
 * with a member in too, each sees a pill for both, their own marked, and
 * hovering the other's shows the site admin that person's email and the member
 * only their name.
 *
 * the admin's window is tall enough for the bar on top, where it has to stay
 * one 48 px row; the member's is 16:9, where `auto` puts the bar down the left
 * side and the pills stack in its column, and then phone-narrow, where they
 * fold into one button. `storageState` is emptied and each page signs in
 * itself, as in `session.spec.ts`: the admin asks for control, and a second
 * factor passed at sign-in moments ago is the step-up for it.
 *
 * a pill lights while its viewer moves the pointer: the admin's own from the
 * admin's own mouse, which lights a click too, and the admin's on the member's
 * list from a `vpos`, which the fake host sends only when a spec tells it to.
 *
 * a pill opens a menu too, and the site admin's menu for the member has a kick.
 * the machine has one streamer for the session and no way to drop one viewer,
 * so the kick ends it for both: the member's page stops and says a site admin
 * removed them, and the admin's comes back on its own, into a session with no
 * one else in it.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { grantMembership, seedMachine, seedSite, type TestUser } from '../../helpers/seed';
import { FakeSwoopHost } from '../../helpers/swoopHost';

authenticator.options = { step: 30, window: 1 };
test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(120_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-pills-${SUFFIX}`;
const MACHINE_ID = `mach-pills-${SUFFIX}`;

let admin: TestUser;
let adminSecret = '';
let member: TestUser;

/** signs in, through the second factor when `secret` is given, and lands on the dashboard. */
async function signIn(page: Page, user: TestUser, secret?: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  if (secret) {
    await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 20_000 });
    // a code about to roll over could land after it has
    if (authenticator.timeRemaining() <= 5) await page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
    await page.getByPlaceholder('000000').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: /^verify$/i }).click();
  }
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: `Pills ${SUFFIX}`, owner: 'someone-else', timezone: 'UTC' });
  await seedMachine(SITE_ID, MACHINE_ID, { displayName: `pills box ${SUFFIX}` });
  await getAdminDb()
    .doc(`sites/${SITE_ID}/settings/swoop`)
    .set({ enabled: true, membersMayWatch: true, indicator: 'banner' }, { merge: true });

  admin = await seedDedicatedUser({ ...dedicatedUser('member', `pills-admin-${SUFFIX}`), displayName: 'Ada Lovelace' });
  adminSecret = authenticator.generateSecret();
  await getAdminDb()
    .collection('users')
    .doc(admin.uid)
    .set(
      { mfaEnrolled: true, requiresMfaSetup: false, mfaSecret: adminSecret, mfaFactors: { totp: true, passkeys: 0 } },
      { merge: true },
    );
  await grantMembership(SITE_ID, admin.uid, 'admin');

  member = await seedDedicatedUser({ ...dedicatedUser('member', `pills-member-${SUFFIX}`), displayName: 'Bob Watcher' });
  await getAdminDb()
    .collection('users')
    .doc(member.uid)
    .set({ mfaEnrolled: false, requiresMfaSetup: false, mfaFactors: { totp: false, passkeys: 0 } }, { merge: true });
  await grantMembership(SITE_ID, member.uid, 'member');
});

test('two people on one machine each see both on the bar, and only the admin is shown an email', async ({
  page,
  browser,
}) => {
  const host = await FakeSwoopHost.start({ browser, viewer: page, siteId: SITE_ID, machineId: MACHINE_ID });
  const otherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const other = await otherContext.newPage();
    await host.addViewer(other);
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, admin, adminSecret);
    await signIn(other, member);

    const adminBar = page.getByTestId('session-bar');
    const memberBar = other.getByTestId('session-bar');
    const pills = (p: Page) => p.getByTestId('session-bar').getByRole('list', { name: 'in this session' }).getByRole('button');
    /** the people each token the host checked names, as `uid ctl`. */
    const checked = () => [...new Set(host.leases.map((lease) => `${lease.uid} ${lease.ctl}`))].sort();
    // a page that has not attached to its channel yet misses a roster, and the streamer sends one on every change
    const publish = (expected: () => Promise<void>) =>
      expect(async () => {
        await host.roster();
        await expected();
      }).toPass({ timeout: 20_000 });

    // alone in the session, the admin's own pill is the one on the bar
    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    await expect.poll(checked, { timeout: 45_000 }).toEqual([`${admin.uid} true`]);
    await publish(() => expect(pills(page)).toHaveText(['Ada L. (you)'], { timeout: 2_000 }));

    await other.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    await expect.poll(checked, { timeout: 45_000 }).toEqual([`${admin.uid} true`, `${member.uid} false`].sort());
    await publish(async () => {
      await expect(pills(page)).toHaveCount(2, { timeout: 2_000 });
      await expect(pills(other)).toHaveCount(2, { timeout: 2_000 });
    });

    // first name and last initial, their own marked, a watcher said to be one
    await expect(adminBar.getByRole('button', { name: 'Ada L. (you)', exact: true })).toBeVisible();
    await expect(adminBar.getByRole('button', { name: 'Bob W., view only', exact: true })).toBeVisible();
    await expect(memberBar.getByRole('button', { name: 'Bob W. (you), view only', exact: true })).toBeVisible();
    await expect(memberBar.getByRole('button', { name: 'Ada L.', exact: true })).toBeVisible();

    // on top the bar is still one row; down the side the pills stack in its column
    expect((await adminBar.boundingBox())?.height).toBe(48);
    const column = (await memberBar.boundingBox())!;
    expect(column.width).toBe(44);
    const [first, second] = [(await pills(other).nth(0).boundingBox())!, (await pills(other).nth(1).boundingBox())!];
    for (const pill of [first, second]) {
      expect(pill.x).toBeGreaterThanOrEqual(column.x);
      expect(pill.x + pill.width).toBeLessThanOrEqual(column.x + column.width);
    }
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    await test.info().attach('admin bar', { body: await page.screenshot(), contentType: 'image/png' });
    await test.info().attach('member bar', { body: await other.screenshot(), contentType: 'image/png' });
    // a picture, not an assertion: class names cannot show which way the pointer and the eye face in a turned pill
    const sideIcons = test.info().outputPath('pills-side-icon', 'left-bar.png');
    await memberBar.screenshot({ path: sideIcons, animations: 'disabled' });
    await test.info().attach('pills on a left bar', { path: sideIcons, contentType: 'image/png' });

    // the admin is shown the member's email beside their name
    await adminBar.getByRole('button', { name: 'Bob W., view only', exact: true }).hover();
    const adminTip = page.getByRole('tooltip');
    await expect(adminTip).toContainText('Bob Watcher');
    await expect(adminTip).toContainText(member.email);
    await test.info().attach('admin tooltip', { body: await page.screenshot(), contentType: 'image/png' });

    // the member is shown the admin's name and no email
    await memberBar.getByRole('button', { name: 'Ada L.', exact: true }).hover();
    const memberTip = other.getByRole('tooltip');
    await expect(memberTip).toContainText('Ada Lovelace');
    await expect(memberTip).not.toContainText('@');
    await test.info().attach('member tooltip', { body: await other.screenshot(), contentType: 'image/png' });

    // a pill is a tab stop, focused as quietly as a button is (DESIGN.md, keyboard focus)
    await page.mouse.move(640, 600);
    await adminBar.getByRole('link', { name: 'back to dashboard' }).focus();
    await page.keyboard.press('Tab');
    await expect(pills(page).first()).toBeFocused();
    // the back link's tooltip and the hovered one fade out first, leaving the focused pill's
    await expect(page.getByRole('tooltip')).toHaveCount(1);
    const barTop = { x: 0, y: 0, width: 640, height: 120 };
    await test.info().attach('focused pill, dark', { body: await page.screenshot({ clip: barTop }), contentType: 'image/png' });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await test.info().attach('focused pill, light', { body: await page.screenshot({ clip: barTop }), contentType: 'image/png' });

    // phone-narrow, the pills fold into one button with the count, and the row keeps everything on it
    await other.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await memberBar.boundingBox())?.height).toBe(48);
    const people = memberBar.getByRole('button', { name: '2 in this session', exact: true });
    await expect(people).toBeVisible();
    expect((await people.boundingBox())?.width).toBe(32);
    const menu = (await memberBar.getByRole('button', { name: 'session controls' }).boundingBox())!;
    expect(menu.x + menu.width).toBeLessThanOrEqual(390);
    await people.click();
    const list = other.getByRole('dialog').getByRole('list', { name: 'in this session' });
    await expect(list).toContainText('Ada Lovelace');
    await expect(list).toContainText('Bob Watcher (you)');
    await expect(list).not.toContainText('@');
    await test.info().attach('member on a phone', { body: await other.screenshot(), contentType: 'image/png' });

    // a light lasts 400 ms after the last move, so each try moves again, and the picture kept is
    // one the light was on for from before it was taken until after
    const whileLit = async (label: string, snap: () => Promise<Buffer>, act: () => Promise<void>, light: Locator) => {
      let shot: Buffer = Buffer.alloc(0);
      await expect(async () => {
        await act();
        await expect(light).toBeVisible({ timeout: 200 });
        shot = await snap();
        expect(await light.isVisible()).toBe(true);
      }).toPass({ timeout: 15_000 });
      await test.info().attach(label, { body: shot, contentType: 'image/png' });
    };
    const adminTop = () => page.screenshot({ clip: barTop });
    // over the picture, below the bar
    let x = 600;
    const adminMoves = async () => {
      await page.mouse.move((x += 3), 420);
    };
    const adminClicks = async () => {
      await page.mouse.down();
      await page.mouse.up();
    };
    const moving = adminBar.getByRole('button', { name: 'Ada L. (you), moving', exact: true });
    const clicking = adminBar.getByRole('button', { name: 'Ada L. (you), clicking', exact: true });
    // the focused pill's tooltip would cover the others in the pictures
    await pills(page).first().blur();
    // the admin's page is still in the light theme from the focus step
    await whileLit('your pill while you move, light', adminTop, adminMoves, moving);
    await whileLit('your pill while you click, light', adminTop, adminClicks, clicking);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await whileLit('your pill while you move, dark', adminTop, adminMoves, moving);
    await whileLit('your pill while you click, dark', adminTop, adminClicks, clicking);

    // the streamer sends the others a `vpos` for each move it takes from a controller
    const viewerOf = (user: TestUser) => host.leases.filter((lease) => lease.uid === user.uid).at(-1)!.viewer;
    const vpos = () => JSON.stringify({ t: 'vpos', viewer: viewerOf(admin), x: 0.5, y: 0.5, tsUs: Date.now() * 1000 });
    const adminPoints = () => host.cursor(viewerOf(member), vpos());
    const adminLit = list.getByRole('img', { name: 'moving' });
    await whileLit("the admin moving, on the member's phone", () => other.screenshot(), adminPoints, adminLit);

    expect(host.problems).toEqual([]);
  } finally {
    await otherContext.close();
    await host.stop();
  }
});

test("the admin kicks the member from their pill's menu, who is told so, and the admin comes back on their own", async ({
  page,
  browser,
}) => {
  const host = await FakeSwoopHost.start({ browser, viewer: page, siteId: SITE_ID, machineId: MACHINE_ID });
  const otherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const other = await otherContext.newPage();
    await host.addViewer(other);
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page, admin, adminSecret);
    await signIn(other, member);

    const adminBar = page.getByTestId('session-bar');
    const memberBar = other.getByTestId('session-bar');
    const pills = (p: Page) => p.getByTestId('session-bar').getByRole('list', { name: 'in this session' }).getByRole('button');
    const checked = () => [...new Set(host.leases.map((lease) => `${lease.uid} ${lease.ctl}`))].sort();
    const leasesOf = (user: TestUser) => host.leases.filter((lease) => lease.uid === user.uid);
    const publish = (expected: () => Promise<void>) =>
      expect(async () => {
        await host.roster();
        await expected();
      }).toPass({ timeout: 20_000 });

    await page.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    await expect.poll(checked, { timeout: 45_000 }).toEqual([`${admin.uid} true`]);
    await publish(() => expect(pills(page)).toHaveText(['Ada L. (you)'], { timeout: 2_000 }));

    await other.goto(`/swoop/${SITE_ID}/${MACHINE_ID}`);
    await expect.poll(checked, { timeout: 45_000 }).toEqual([`${admin.uid} true`, `${member.uid} false`].sort());
    await publish(async () => {
      await expect(pills(page)).toHaveCount(2, { timeout: 2_000 });
      await expect(pills(other)).toHaveCount(2, { timeout: 2_000 });
    });

    await adminBar.getByRole('button', { name: 'Bob W., view only', exact: true }).click();
    const menu = page.getByTestId('viewer-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Bob Watcher');
    await expect(menu).toContainText(member.email);
    const kick = menu.getByRole('button', { name: 'kick', exact: true });
    await expect(kick).toBeVisible();
    await test.info().attach('admin pill menu', { body: await page.screenshot(), contentType: 'image/png' });

    await kick.click();
    const confirm = page.getByRole('dialog', { name: 'kick Bob Watcher?' });
    await expect(confirm).toBeVisible();
    await test.info().attach('kick dialog', { body: await page.screenshot(), contentType: 'image/png' });
    const kickedSid = leasesOf(member).at(-1)!.sid;
    const before = leasesOf(admin).length;
    const kicked = page.waitForResponse((r) => r.url().endsWith('/kick') && r.request().method() === 'POST');
    await confirm.getByRole('button', { name: 'kick', exact: true }).click();
    const reply = await kicked;
    expect(reply.status(), await reply.text()).toBe(200);

    // the record names the member: their page stops rather than coming back, and reconnecting is theirs to choose
    await expect(other.getByText('a site admin removed you from this session.')).toBeVisible({ timeout: 20_000 });
    await expect(memberBar.getByTestId('session-badge')).toHaveText('disconnected');
    await expect(memberBar.getByRole('button', { name: 'reconnect' })).toBeVisible();
    await test.info().attach('member kicked', { body: await other.screenshot(), contentType: 'image/png' });

    // the kick cut the admin off too, and their page starts a session of its own
    await expect.poll(() => leasesOf(admin).length, { timeout: 45_000 }).toBeGreaterThan(before);
    // a new session's streamer has checked its own viewers alone, but the fake host's roster
    // names every lease it ever checked: the kicked session's go first
    const back = leasesOf(admin).at(-1)!.sid;
    const current = host.leases.filter((lease) => lease.sid === back);
    host.leases.splice(0, host.leases.length, ...current);
    await publish(() => expect(pills(page)).toHaveText(['Ada L. (you)'], { timeout: 2_000 }));

    const killed = await getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}/swoop_sessions/${kickedSid}`).get();
    const record = killed.data() ?? {};
    expect([record.state, record.endReason, record.endedFor]).toEqual(['ended', 'kicked', member.uid]);
  } finally {
    await otherContext.close();
    await host.stop();
  }
});
