/**
 * Scene — episode 2, "day zero: sign up, 2fa, and your first site".
 *
 * The only scene in the series that drives REAL flows instead of a seeded
 * scenario: `seedScreenshotFixtures` has no scenario for the auth pages or a
 * zero-site dashboard, and a faked registration would be exactly the thing this
 * episode is teaching. So it registers a throwaway account, enrolls a real
 * passkey through a CDP virtual authenticator, claims real backup codes, and
 * creates a real site.
 *
 * Rendered VO (voiceover/out/02-day-zero/, ffprobe):
 *   b01 22.9s · b02 22.5s · b03 20.3s · b04 27.6s · b05 19.9s
 *   b06 21.2s · b07 20.2s · b08 31.2s · b09 26.9s
 *   b01–b07, b09 are cut from the 2026-08-31 continuous take; b08 alone is a
 *   2026-09-06 per-beat re-render (`generate.py --only-beat b08`, wave 3b) —
 *   see the b08 block for why, and expect its read to sit ~13% slower than its
 *   neighbours', which is what a cold single-beat render costs.
 *
 * ── THREE PRECONDITIONS ─────────────────────────────────────────────────────
 *
 * 1. WEBAUTHN ENV. Without `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` the server's
 *    `getRpId()` falls through to 'owlette.app' and no loopback ceremony can
 *    verify (lib/webauthn.server.ts:27-43 — the override is gated on
 *    OWLETTE_E2E=1, which the videos config also sets). `npm run videos` is now
 *    self-contained: `playwright.videos.config.ts` defaults both keys
 *    (localhost / http://localhost:3100), writes them onto the runner's
 *    `process.env` AND passes them through `webServer.env`, matching
 *    `playwright.config.ts:147-148`. Exporting them by hand still wins — the
 *    config only fills in what the shell left unset.
 *
 *    The guard below is kept as a safety net: if that block is ever dropped or a
 *    scene is run under a config without it, this fails fast instead of dying
 *    mid-take on an unverifiable ceremony.
 *
 * 2. `localhost`, NOT `127.0.0.1`. An IP literal is not a valid RP ID, so every
 *    navigation here uses WEBAUTHN_BASE_URL. See helpers/webauthn.ts.
 *
 * 3. NOT-CAPTURABLE BEATS, called out rather than faked:
 *    - b02's bot-check widget: ON CAMERA and auto-passing. The e2e build bakes
 *      Cloudflare's always-pass TEST sitekey (scripts/e2e-build.mjs:33), so the
 *      widget renders, solves itself a beat after load, and only then enables
 *      "create account" — the scene waits for that instead of racing it.
 *    - b02's "continue with google". A real Google popup is out of scope for an
 *      emulator run; the button is framed, never clicked.
 *    - b04's "windows hello prompt". The virtual authenticator answers UV with
 *      no OS dialog by design (`enableUI: false`), so there is no prompt on
 *      screen. That half-second is a native screen-capture insert.
 *    Everything else b09 needs IS shot here: its tail (the getting-started card
 *    advancing to "step 1: download owlette agent" right after the site is
 *    created) and its /admin/users half, filmed as a FOURTH identity — the scene
 *    signs out and back in as the seeded superadmin for the reset-2FA row menu
 *    and its confirm dialog. Episode 14 b02 holds the same menu item on camera
 *    if that take is cleaner to cut.
 *
 * Run:  cd web && npm run videos -- --grep "episode 2"
 * Out:  dev/video-tutorials/footage/web/02-day-zero.mp4
 */

import crypto from 'crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { COMMON_TIMEZONES } from '@/lib/timeUtils';
import { getAdminDb } from '../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../helpers/coverageSeed';
import { TEST_USERS, type TestUser } from '../helpers/seed';
import { WEBAUTHN_BASE_URL, addVirtualAuthenticator } from '../helpers/webauthn';
import {
  recordScene,
  VIDEO_OUT_DIR,
  openForCapture,
  narrate,
  slowPush,
  highlight,
  centerInView,
  clickWithCursor,
  typewrite,
} from './video-helpers';

authenticator.options = { step: 30, window: 1 };

// Three sign-ins, a registration and a site creation do not fit the config's
// 5-minute default; the VO alone is 3m33s.
test.setTimeout(12 * 60_000);

/** Absolute URL on the WebAuthn origin. See precondition 2 in the file header. */
const url = (p: string): string => `${WEBAUTHN_BASE_URL}${p}`;

/**
 * `recordScene` takes a storageState PATH, and this scene needs an anonymous
 * context — so hand it an empty state file rather than a role fixture.
 */
async function emptyStorageStatePath(): Promise<string> {
  await mkdir(VIDEO_OUT_DIR, { recursive: true });
  const file = path.join(VIDEO_OUT_DIR, '02-day-zero.storage-state.json');
  await writeFile(file, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
  return file;
}

/**
 * Password user with TOTP already enrolled, for b06's code screen. `mfaSecret`
 * uses the legacy plaintext shape (no `:`) that `mfaProof.server` and
 * verify-login still accept — the only option that does not drag the
 * server-side encryption module into a capture scene. Mirrors
 * `specs/mfa/passkey-factor.spec.ts:106-120`.
 */
async function seedTotpUser(suffix: string): Promise<{ user: TestUser; secret: string }> {
  const user = await seedDedicatedUser(dedicatedUser('member', suffix));
  const secret = authenticator.generateSecret();
  await getAdminDb().collection('users').doc(user.uid).set(
    {
      mfaEnrolled: true,
      requiresMfaSetup: false,
      mfaSecret: secret,
      mfaFactors: { totp: true, passkeys: 0 },
      backupCodes: [crypto.createHash('sha256').update('ABCDEF12').digest('hex')],
    },
    { merge: true },
  );
  return { user, secret };
}

async function signOut(page: Page): Promise<void> {
  await clickWithCursor(page, page.getByTestId('user-menu-trigger'));
  await clickWithCursor(page, page.getByRole('menuitem', { name: /sign out/i }));
  await expect(page).toHaveURL(/\/(login)?$/, { timeout: 20_000 });
}

async function signInWithPassword(page: Page, email: string, password: string): Promise<void> {
  await page.goto(url('/login'), { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
}

test('episode 2 — day zero: sign up, 2fa, and your first site', async ({ browser }) => {
  if (!process.env.WEBAUTHN_RP_ID || !process.env.WEBAUTHN_ORIGINS) {
    throw new Error(
      'episode 2 needs WEBAUTHN_RP_ID + WEBAUTHN_ORIGINS — playwright.videos.config.ts sets ' +
      'both (localhost / http://localhost:3100) for `npm run videos`, so reaching this means ' +
      'the scene is running under a config without that block. Without them the server signs ' +
      'ceremonies for owlette.app and the passkey beats cannot complete. See the precondition ' +
      'block at the top of 02-day-zero.video.ts.',
    );
  }

  const stamp = Date.now();
  const newAccount = {
    email: `day-zero-${stamp}@e2e.test`,
    password: 'day-zero-capture-password',
    firstName: 'Sam',
    lastName: 'Okonkwo',
  };
  const { user: totpUser, secret: totpSecret } = await seedTotpUser(`day-zero-totp-${stamp}`);
  const storageState = await emptyStorageStatePath();

  await recordScene(
    browser,
    '02-day-zero',
    { baseURL: WEBAUTHN_BASE_URL, storageState },
    async (page) => {
      // The virtual authenticator answers registration and assertion with no OS
      // prompt. Attach BEFORE the first ceremony; it survives navigations.
      const virtual = await addVirtualAuthenticator(page);
      // /login opens a passive conditional-UI ceremony on mount, and an
      // automatic-presence authenticator answers it unprompted — which would
      // sign us in before "continue with passkey" is ever clicked, deleting the
      // button b04 films. Stubbing the availability probe is the whole fix; the
      // real navigator.credentials.get() still runs. (passkey-factor.spec.ts:57)
      await page.addInitScript(() => {
        const pkc = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential as
          | { isConditionalMediationAvailable?: () => Promise<boolean> }
          | undefined;
        if (pkc) {
          pkc.isConditionalMediationAvailable = () => Promise.resolve(false);
        }
      });

      try {
        // ── [b02] signing up (~21.9s) ────────────────────────────────────────
        await openForCapture(page, '/register');
        // [b01] cold open (2026-08-31 rewrite): a clean hold on the sign-up
        // page, where a new account actually begins. The old cold open
        // bounced /dashboard -> /setup-2fa, which showed the setup screen
        // before b02 ever reached the sign-up form - rosco flagged it.
        await narrate(page, 'b01 the sign-up page, held', 5.7);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 48, seconds: 4.0 });
        await narrate(page, 'b01 the sign-up page, held - close', 5.3);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b01 the sign-up page, held - settle', 1.0);

        // Google first — framed, never clicked (see precondition 3).
        const googleButton = page.getByRole('button', { name: /continue with google/i });
        await centerInView(page, googleButton);
        await highlight(page, googleButton, 2200);
        await narrate(page, 'b02 google path framed', 5);

        // The form is PROGRESSIVE: name and password only mount once the email
        // field is focused, so email must be filled first or every other
        // locator times out.
        await typewrite(page, page.getByLabel(/^email$/i), newAccount.email, 40);
        await typewrite(page, page.getByLabel(/first name/i), newAccount.firstName, 55);
        await typewrite(page, page.getByLabel(/last name/i), newAccount.lastName, 55);
        await typewrite(page, page.getByLabel(/^password$/i), newAccount.password, 35);
        await typewrite(page, page.getByLabel(/confirm password/i), newAccount.password, 35);
        await clickWithCursor(page, page.getByLabel(/i agree to the/i).first());
        await narrate(page, 'b02 form filled', 8);

        const createAccountBtn = page.getByRole('button', { name: /^create account$/i });
        // Submit stays disabled until the always-pass Turnstile test widget
        // (baked in by scripts/e2e-build.mjs) issues its token — wait, don't race.
        await expect(createAccountBtn).toBeEnabled({ timeout: 20_000 });
        await clickWithCursor(page, createAccountBtn);
        // Session-cookie timing can bounce through /login first; both URLs prove
        // the mandatory-2FA gate fired.
        await expect(page).toHaveURL(/\/setup-2fa|\/login\?redirect=%2Fsetup-2fa/, {
          timeout: 30_000,
        });
        await narrate(page, 'b02 lands on setup, not the dashboard', 8);


        // ── [b03] passkey or authenticator (~24.5s) ──────────────────────────
        await expect(page.getByText(/choose your second factor/i)).toBeVisible();
        const passkeyCard = page.getByRole('button', { name: /passkey/i }).first();
        const authenticatorCard = page.getByRole('button', { name: /authenticator app/i }).first();
        await centerInView(page, passkeyCard);
        await highlight(page, passkeyCard, 3000);
        await narrate(page, 'b03 passkey card', 12);
        await centerInView(page, authenticatorCard);
        await highlight(page, authenticatorCard, 3000);
        await narrate(page, 'b03 authenticator card', 3.9);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 42, seconds: 4.0 });
        await narrate(page, 'b03 authenticator card - close', 1.1);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b03 authenticator card - settle', 1.0);

        // ── [b04a] enroll the passkey (~27.1s, first half) ───────────────────
        await clickWithCursor(page, passkeyCard);
        await narrate(page, 'b04 passkey step', 5);
        await clickWithCursor(page, page.getByRole('button', { name: /^create passkey$/i }));
        // No OS prompt renders — see precondition 3.
        await expect(page.getByText(/passkey added/i)).toBeVisible({ timeout: 30_000 });
        await narrate(page, 'b04 passkey added', 12);

        // ── [b05] backup codes (~18.2s) ──────────────────────────────────────
        // The passkey path demands a second UV step-up before any code renders
        // (setup-2fa/page.tsx:589-598); the button flips to "waiting for your
        // device..." while it runs. Never click its sibling "skip for now" on
        // camera — that exits with no codes issued.
        await clickWithCursor(page, page.getByRole('button', { name: /get backup codes/i }));
        await expect(page.getByText(/save backup codes/i)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/these codes will only be shown once/i)).toBeVisible();
        await narrate(page, 'b05 ten codes + the once-only warning', 12);
        await clickWithCursor(page, page.getByRole('button', { name: /copy all codes/i }));
        await narrate(page, 'b05 copy all', 6);

        await clickWithCursor(page, page.getByRole('button', { name: /continue to dashboard/i }));
        await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

        // ── [b07] your first site (~20.2s) ───────────────────────────────────
        // This account owns no sites, so the dashboard renders the getting-
        // started card at step 1. That empty state exists only here.
        await page.waitForTimeout(1200);
        const createFirstSite = page.getByRole('button', { name: /create your first site/i });
        await expect(createFirstSite).toBeVisible({ timeout: 20_000 });
        await highlight(page, createFirstSite, 2400);
        await narrate(page, 'b07 getting-started step 1', 6);
        await clickWithCursor(page, createFirstSite);

        const siteDialog = page.getByRole('dialog');
        await expect(siteDialog).toBeVisible();
        // The id auto-generates from the name and re-checks availability, so
        // type the name and let the green tick land before confirming.
        await typewrite(page, siteDialog.locator('#site-name'), 'NYC Office', 60);
        await page.waitForTimeout(1200);
        // NOT `#site-id`: that input only mounts after "customize site ID" is
        // clicked (CreateSiteDialog.tsx:234-247), and waiting on an element that
        // never attaches kills the scene at the 15s action timeout. This beat is
        // about the id the dialog GENERATES, so frame the always-visible preview
        // row — the "site ID:" label, the font-mono value and its availability
        // tick share one flex line (:210-213).
        const siteIdPreview = siteDialog.getByText('site ID:', { exact: true }).locator('..');
        await highlight(page, siteIdPreview, 2400);
        await narrate(page, 'b07 name + generated id', 4.5);
        // The dialog also carries the site's CLOCK now (wave 3b,
        // CreateSiteDialog.tsx:299-343): the browser's timezone, read-only with
        // "change timezone" under it, written with `schedulesFollowSiteTime:
        // true`. b08 is entirely about that value, so it has to be on camera
        // here — and inside b07's 20.2s, since the conform trims what runs past
        // the narration. Frame the read-only value row (the testid span's flex
        // parent: label, value, "(from your browser)"), not the collapsed
        // disclosure below it.
        const timezoneRow = siteDialog.getByTestId('create-site-timezone').locator('..');
        await centerInView(page, timezoneRow);
        await highlight(page, timezoneRow, 2600);
        await narrate(page, 'b07 the clock the dialog detected', 3);
        await clickWithCursor(page, siteDialog.getByRole('button', { name: /^create site$/i }));
        await expect(siteDialog).not.toBeVisible({ timeout: 20_000 });
        await narrate(page, 'b07 site created', 7);

        // [b09 TAIL] the getting-started card re-renders into the install step.
        // The /admin/users half of b09 is lifted from episode 14 — see
        // precondition 3.
        await expect(
          page.getByText('download owlette agent', { exact: false }).first(),
        ).toBeVisible({ timeout: 20_000 });
        await narrate(page, 'b09 tail — card advances to the download step', 10);

        // ── [b08] the site's clock (~31.2s) ──────────────────────────────────
        // the other half of b07's dialog: the clock it set is already on the
        // site (wave 3b: the create dialog writes the browser's timezone with
        // `schedulesFollowSiteTime: true`), and site settings is where it is
        // changed, not where it is first set. nothing is edited on camera: the
        // picker opens and closes with nothing picked.
        await clickWithCursor(page, page.getByTestId('site-switcher-trigger'));
        await clickWithCursor(page, page.getByRole('menuitem', { name: /site settings/i }));
        // no ?section=, so the page opens on general, where the timezone lives
        await expect(page).toHaveURL(/\/admin\/sites\/[^/?#]+$/, { timeout: 20_000 });
        await expect(page.getByRole('heading', { level: 1, name: 'NYC Office' })).toBeVisible();
        // the zone the create dialog detected, read back off the browser rather
        // than hardcoded so the scene stays portable. the field shows it the way
        // TimezoneSelect labels its trigger: a common zone by its label, any
        // other by its city. if the create dialog ever stops writing the
        // timezone, the field reads UTC and this fails here instead of
        // shipping a lie.
        const siteZone = await page.evaluate(
          () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        const shownZone =
          COMMON_TIMEZONES.find((tz) => tz.value === siteZone)?.label ??
          siteZone.slice(siteZone.lastIndexOf('/') + 1).replace(/_/g, ' ');
        const timezoneField = page.getByRole('combobox', { name: 'timezone', exact: true });
        await expect(timezoneField).toContainText(shownZone);
        await centerInView(page, timezoneField);
        await highlight(page, timezoneField, 2600);
        await narrate(page, 'b08 the row already carries the detected clock', 6);
        // no pencil any more: the field that shows the clock is where it changes
        await highlight(page, timezoneField, 2400);
        await narrate(page, 'b08 the pencil is where it changes', 4);
        await clickWithCursor(page, timezoneField);
        const timezoneSearch = page.getByRole('textbox', { name: 'search timezones' });
        await expect(timezoneSearch).toBeVisible();
        await narrate(page, 'b08 timezone picker open', 6.5);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 50, seconds: 4.0 });
        await narrate(page, 'b08 timezone picker open - close', 5.5);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b08 timezone picker open - settle', 1.0);
        // escape closes the picker with nothing picked. the admin pages carry no
        // page header, so signOut() needs the dashboard's user menu
        await page.keyboard.press('Escape');
        await expect(timezoneSearch).toBeHidden();
        await expect(timezoneField).toContainText(shownZone);
        await page.goto(url('/dashboard'), { waitUntil: 'domcontentloaded' });

        // ── [b04b] what sign-in becomes — SEPARATE TAKE (~27.1s, second half) ─
        // Leaving "passkey added" is one-way, so this can only be filmed after
        // b05 has claimed its codes.
        await signOut(page);
        await page.goto(url('/login'), { waitUntil: 'domcontentloaded' });
        const passkeySignIn = page.getByRole('button', { name: /continue with passkey/i });
        await centerInView(page, passkeySignIn);
        await highlight(page, passkeySignIn, 2400);
        await clickWithCursor(page, passkeySignIn);
        // One ceremony clears identity AND the second factor — no /verify-2fa.
        await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
        await narrate(page, 'b04 sign-in — straight to the dashboard', 10);

        // ── [b06] trust this device (~18.4s) ─────────────────────────────────
        // The authenticator path, on its own seeded account: a password sign-in
        // is challenged at /verify-2fa, where the trust checkbox lives.
        await signOut(page);
        await signInWithPassword(page, totpUser.email, totpUser.password);
        await expect(page).toHaveURL(/\/verify-2fa/, { timeout: 30_000 });

        // Never hand a code that is about to roll over to a form we then dwell on.
        const secondsLeft = authenticator.timeRemaining();
        if (secondsLeft <= 8) {
          await page.waitForTimeout((secondsLeft + 1) * 1000);
        }
        await typewrite(page, page.getByPlaceholder('000000'), authenticator.generate(totpSecret), 90);
        const trustCheckbox = page.getByLabel(/trust this device for 30 days/i);
        await centerInView(page, trustCheckbox);
        await highlight(page, trustCheckbox, 2400);
        await narrate(page, 'b06 trust checkbox', 10);
        await clickWithCursor(page, trustCheckbox);
        await clickWithCursor(page, page.getByRole('button', { name: /^verify$/i }));
        await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
        await narrate(page, 'b06 verified with the device trusted', 9);

        // ── [b09] locked out (~26.7s) — the seeded superadmin's view ─────────
        // Baseline users are seeded with MFA pre-satisfied, so this password
        // sign-in lands on the dashboard with no challenge in the way.
        await signOut(page);
        await signInWithPassword(
          page,
          TEST_USERS.superadmin.email,
          TEST_USERS.superadmin.password,
        );
        await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
        await openForCapture(page, '/admin/users');
        const targetRow = page.getByRole('row').filter({ hasText: totpUser.email });
        await centerInView(page, targetRow);
        // MoreVertical is the last button in the row; it carries no testid.
        await clickWithCursor(page, targetRow.getByRole('button').last());
        const resetItem = page.getByRole('menuitem', { name: /reset 2FA/i });
        await expect(resetItem).toBeVisible();
        await highlight(page, resetItem, 2600);
        await narrate(page, 'b09 reset 2FA in the row menu', 12);
        await clickWithCursor(page, resetItem);
        const confirmDialog = page.getByRole('dialog');
        await expect(confirmDialog).toBeVisible();
        await narrate(page, 'b09 confirm dialog — never confirmed on camera', 4.5);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 45, seconds: 4.0 });
        await narrate(page, 'b09 confirm dialog — never confirmed on camera - close', 2.5);
        await slowPush(page, { scale: 1.0, seconds: 3.0 });
        await narrate(page, 'b09 confirm dialog — never confirmed on camera - settle', 1.0);
        await page.keyboard.press('Escape');
      } finally {
        // A leaked authenticator would answer the next scene's ceremonies.
        await virtual.remove().catch(() => undefined);
      }
    },
  );
});
