/**
 * Scene — episode 3, "install owlette & pair your first machine": the WEB beats.
 * Script: dev/video-tutorials/scripts/03-install-and-pair.md (FINAL).
 *
 * Episode 3 is three surfaces stitched together and this file owns one of them.
 * The installer wizard (b01, b03, b04) is native capture; everything inside the
 * owlette window (b05, b06's app half, b10) is the desktop take at
 * `../desktop-videos/03-install-and-pair.video.ts`. What is left — the browser —
 * is here: b02 (the header download button), b07 (the /add page), b08 (the
 * machine appearing) and b09 (the add-machine modal's two tabs).
 *
 * ONE take, in script order, because the four beats are one continuous operator
 * story and every transition between them is real product navigation:
 * dashboard → /add?code= → authorize → "go to dashboard" → the card lands →
 * open the add-machine modal. Output stem `03-install-and-pair`, which is the
 * third source episode 3's manifest already expects
 * (assembly/manifests/03-install-and-pair.json → sources[2]) — no
 * gen-assembly.py change is needed for the conform to find it.
 *
 * Rendered VO (assembly/manifests/03-install-and-pair.json, ffprobe of
 * voiceover/out/03-install-and-pair/):
 *   b02 18.207s · b07 17.006s · b08 20.611s · b09 22.596s
 * The conform keeps exactly `duration_s` from each beat's mark, so every beat's
 * scripted action has to FIT inside that window and the transition into the next
 * beat has to fall after it. narrate()'s enforcement hold is the floor, not the
 * plan — see the per-beat budget comments.
 *
 * ── FIXTURE ─────────────────────────────────────────────────────────────────
 * `pairing-first-machine`, NOT the script front-matter's `dashboard-mixed-states`:
 * this episode pairs a FIRST machine, and b08's "a new machine card pops in" is
 * only legible on a site that had none. The empty site also puts the real
 * getting-started card on camera for b02. Three things the scenario does not
 * carry are seeded below and torn down in `finally`:
 *
 *   - `installer_metadata/latest` — a TOP-LEVEL doc, so `deleteSiteSubtree`
 *     never touches it. `DownloadButton` hard-returns null without a version
 *     (components/DownloadButton.tsx:58-60), so b02 has literally nothing on
 *     screen if this is missing.
 *   - A SECOND site. /add auto-selects when the user has exactly one site and
 *     the authorize button is not rendered until something is picked
 *     (app/add/page.tsx:102-115, :273) — with one site there is no b07. A site
 *     this scene creates and deletes, rather than renaming the shared baseline
 *     `site-B`, so nothing has to be restored by hand.
 *   - A pending `device_codes/{phrase}` doc with `preauthorizedIntent: true`,
 *     which is what makes b07's authorize click a real 200 (see below).
 *
 * ── WHY THE PRE-AUTHORIZED BRANCH ───────────────────────────────────────────
 * `authorize/route.ts:75-84` (preauthorizedIntent) is a pure Firestore
 * transaction. Every other path through that route POSTs to
 * `https://identitytoolkit.googleapis.com` with no emulator override (:118,
 * :148) — a real outbound call that 400s on the emulator's `demo-api-key` and
 * puts a red toast on camera. So the seeded doc carries `preauthorizedIntent`
 * and no `deviceCode`, exactly as the dashboard's own "generate code" flow mints
 * it (device-code/route.ts:97-102). Consequence on screen: the success card
 * reads "the machine will appear on your dashboard shortly." rather than naming
 * the machine (add/page.tsx:205-212). That is real product copy, and it is the
 * honest one for this flow — the machine id genuinely is not known until the
 * agent polls.
 *
 * ── THE PAIRING PHRASE IS SHARED WITH THE DESKTOP TAKE ─────────────────────
 * b05/b06 film the phrase on the machine and this scene authorizes THAT phrase
 * in the browser, so the two takes must agree. Both read `DEMO_PAIR_PHRASE`
 * (e2e/desktop-screenshots/fixtures.ts), which is why this file imports it
 * rather than declaring its own.
 *
 * That constant used to be the docs' `silver-compass-drift`, which CANNOT be
 * authorized: 'compass' is not in WORD_LIST (lib/pairPhrases.ts — it survives
 * only in the doc comments at :3 and :265), so `normalizePairPhrase` returns
 * null and authorize 400s before it reaches Firestore (authorize/route.ts:37-43).
 * The example phrase the product's own placeholder and docs tell operators to
 * copy is invalid. The constant is now a real phrase; the docs/installer
 * examples still say `silver-compass-drift` and want the same correction.
 *
 * Also on camera and not fixable from this harness: `brandMeta` renders
 * "authorizing on 127.0.0.1:3100" under the /add title (add/page.tsx:229), where
 * the desktop take (shot `--server prod`) says owlette.app. And b09's command
 * carries no `/SERVER=dev` — `serverFlagFor` only emits it for the exact host
 * `dev.owlette.app` (lib/environment.ts:31-50), so a loopback capture renders
 * what PRODUCTION renders. The VO never says "/SERVER", so the command on screen
 * is correct for owlette.app; it is the SCREEN direction's parenthetical that
 * over-promises.
 *
 * Run:  cd web && npm run videos -- --grep "episode 3"
 * Out:  dev/video-tutorials/footage/web/03-install-and-pair.mp4
 */

import { createHash, randomBytes } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import {
  FIXED_NOW_MS,
  seedScreenshotFixtures,
  writeMachineMetrics,
} from '../screenshots/fixtures';
import { DEVICE_CODE_WRAP_VERSION } from '@/lib/deviceCodeCrypto';
import { DEMO_PAIR_PHRASE } from '../desktop-screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  highlight,
  centerInView,
  clickWithCursor,
  moveCursorTo,
} from './video-helpers';

// ~80s of enforced beat picture plus four page loads, an authorize round-trip
// and a device-code mint. The config's 5-minute default would cover it; the
// headroom is for the 15s waits the live-write beats are allowed.
test.setTimeout(8 * 60_000);

/**
 * The phrase the desktop take films on the machine — imported, never re-declared,
 * so the two halves of this episode can never drift apart on camera. It must be
 * three words from `lib/pairPhrases.ts`'s WORD_LIST or authorize 400s; see the
 * note in the file header.
 */
const EP03_PAIR_PHRASE = DEMO_PAIR_PHRASE;

/** Matches /VERSION and agent/VERSION, so b02's tooltip reads the real number. */
const LATEST_VERSION = '3.2.3';

/** The machine b08 pairs. Hostname-shaped, and it belongs to "main gallery". */
const MACHINE_ID = 'gallery-pc-01';

/**
 * A second site, created and destroyed by this scene, so /add cannot
 * auto-select and b07's dropdown has something to choose BETWEEN. Deliberately
 * not the shared baseline `site-B`: `specs/sites/access-defaults.spec.ts`
 * asserts both its literal name and that admin does NOT have access to it.
 */
const ANNEX_SITE_ID = 'video-ep03-atrium-annex';
const ANNEX_SITE_NAME = 'atrium annex';

const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

test('episode 3 — install owlette & pair your first machine', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('pairing-first-machine');
  const db = getAdminDb();
  const machinesRef = db.collection('sites').doc(ctx.siteId).collection('machines');
  /** Captured from b09's real mint response so `finally` can delete that doc. */
  let generatedPhrase: string | null = null;

  try {
    // Pin the dashboard to the seeded site — otherwise the two-site user's
    // auto-select is a coin flip (app/dashboard/page.tsx:687-695).
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // The latest installer, as the release flow writes it. Same shape as
    // 17-fleet-maintenance.video.ts:76-84. The URL is never fetched — b02
    // neutralizes window.open before the click, see the hazard note there.
    await db.collection('installer_metadata').doc('latest').set({
      version: LATEST_VERSION,
      download_url: `https://e2e-seed.test/installers/Owlette-Installer-v${LATEST_VERSION}.exe`,
      file_size: 118_293_504,
      checksum_sha256: 'ab'.repeat(32),
      release_date: Timestamp.fromMillis(FIXED_NOW_MS - 60 * 60 * 24 * 6 * 1000),
      release_notes: 'temperature via the signed PawnIO driver; WinRing0 retired.',
      deletedAt: null,
    });

    // The second site, plus membership so the client can actually read it
    // (firestore.rules canAccessSite → `siteId in users/{uid}.sites`).
    await db.collection('sites').doc(ANNEX_SITE_ID).set({
      name: ANNEX_SITE_NAME,
      owner: TEST_USERS.admin.uid,
      timezone: 'America/Los_Angeles',
      tier: 'pro',
      createdAt: Timestamp.fromMillis(FIXED_NOW_MS - 60 * 60 * 24 * 20 * 1000),
    });
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ sites: FieldValue.arrayUnion(ANNEX_SITE_ID) }, { merge: true });

    // The phrase b07 authorizes. `.set()` with NO merge on purpose: a previous
    // take leaves status 'authorized', and a merge would re-run into a 409
    // "already been used" (authorize/route.ts:68-70).
    //
    // `expiresAt` is checked against the SERVER's real clock (:62-66), never the
    // page's frozen one — so it must come from a real `Date.now()`. 30 minutes
    // rather than the product's 10 because a take can stall; nothing renders
    // this field, the expiry check is its only consumer.
    const deviceCodeSecret = randomBytes(64).toString('base64url');
    await db.collection('device_codes').doc(EP03_PAIR_PHRASE).set({
      deviceCodeHash: createHash('sha256').update(deviceCodeSecret).digest('hex'),
      wrapVersion: DEVICE_CODE_WRAP_VERSION,
      machineId: null,
      version: null,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
      siteId: null,
      authorizedBy: null,
      authorizedAt: null,
      encryptedCredentials: null,
      accessToken: null,
      refreshToken: null,
      preauthorizedIntent: true,
    });

    await recordScene(
      browser,
      '03-install-and-pair',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // Both copy buttons in this scene call navigator.clipboard.writeText and
        // both have a catch that paints a red "copy failed" toast — a
        // wrong-but-green take. recordScene owns the context, so the grant has
        // to be reached through page.context() from in here.
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

        // ── [b02] where the installer comes from (18.207s) ────────────────────
        // Budget: ~21s of dashboard before the /add navigation, so the conform's
        // 18.207s window can never contain the transition.
        await openForCapture(page, '/dashboard');
        await expect(page.getByText('getting started', { exact: true })).toBeVisible({
          timeout: 20_000,
        });
        await expect(page.getByTestId('machine-card')).toHaveCount(0);

        // aria-labels, so these are unique against the getting-started card's
        // own "download v3.2.3" / "copy link" buttons (dashboard/page.tsx:1179,
        // :1204), which carry text and no label.
        const downloadButton = page.getByLabel('download owlette agent');
        const copyLinkButton = page.getByLabel('copy owlette agent download link');
        // CRITICAL: while useInstallerVersion is loading, both buttons are
        // `disabled` (DownloadButton.tsx:72, :104) and button.tsx's
        // `disabled:pointer-events-none` swallows hover — an early moveCursorTo
        // opens no tooltip, and the one that eventually renders reads
        // "loading version info..." instead of the version.
        await expect(downloadButton).toBeEnabled({ timeout: 20_000 });

        // THE ONE THING THAT WOULD RUIN THIS TAKE. handleDownload calls
        // `window.open(downloadUrl, '_blank')` (DownloadButton.tsx:27). ffmpeg
        // films the raw desktop rectangle, so a '_blank' open becomes a
        // foreground tab filling the capture region with Chrome's
        // "site can't be reached" page mid-beat. Neutralized per-document with
        // page.evaluate (NOT addInitScript) so the patch dies at the next
        // navigation and cannot leak into b07-b09. Must return null and must not
        // throw — a throw routes to the error toast (:31-35). Nothing is lost on
        // camera: Chrome's download UI anchors to the toolbar, which fullscreen
        // hides, so the success toast is the only visible evidence either way.
        await page.evaluate(() => {
          window.open = () => null;
        });
        // navigator.clipboard rejects on an unfocused document.
        await page.bringToFront();

        await narrate(page, 'b02 the installer lives in the dashboard header', 3);

        // Radix default delayDuration is 700ms (no override on either provider).
        await moveCursorTo(page, downloadButton);
        await page.waitForTimeout(1100);
        // `.first()`: Radix renders the content twice — the visible copy, then a
        // VisuallyHidden clone carrying role="tooltip" for a11y
        // (@radix-ui/react-tooltip Content). DOM order puts the visible one
        // first; asserting on role would frame the 1px clone.
        await expect(
          page.getByText(`download owlette agent v${LATEST_VERSION}`).first(),
        ).toBeVisible();
        await narrate(page, 'b02 tooltip — download owlette agent v3.2.3', 4);

        // Already on target from moveCursorTo; clickWithCursor would re-glide.
        await downloadButton.click();
        await expect(page.getByText('download started')).toBeVisible();
        await narrate(page, 'b02 grab it once, reuse it on every machine', 5);

        await moveCursorTo(page, copyLinkButton);
        await page.waitForTimeout(1100);
        await expect(
          page.getByText(`copy download link for owlette agent v${LATEST_VERSION}`).first(),
        ).toBeVisible();
        await copyLinkButton.click();
        await expect(page.getByText('link copied')).toBeVisible();
        // Toasts drain in 4s of REAL time (lib/toast.ts:30 — the Date freeze does
        // not fake setTimeout), so the clicks have to land EARLY in the beat or
        // the window closes on a static header. They do; this is the tail.
        await narrate(page, 'b02 copy link — paste it into a remote session', 6);

        // ── [b07] choosing a site (17.006s) ──────────────────────────────────
        // Transition lands in b02's trimmed-off tail.
        await openForCapture(page, `/add?code=${EP03_PAIR_PHRASE}`);
        await expect(page.getByLabel(/pairing phrase/i)).toHaveValue(EP03_PAIR_PHRASE);
        // Both assertions together prove the sites fetch finished AND that two
        // sites arrived: the trigger still shows its placeholder, and the
        // authorize button only mounts once something is picked. The fetch
        // swallows unreadable sites (`catch {}`, add/page.tsx:95-97), so a rules
        // failure would degrade to a silent one-site auto-select rather than an
        // error — this is where that would surface.
        const siteSelect = page.locator('#site-select');
        await expect(siteSelect).toContainText('choose a site');
        await expect(page.getByRole('button', { name: /authorize machine/i })).toHaveCount(0);

        // Budget: authorize is clicked at ~t+14s so ~2s of the success card
        // lands inside the 17.006s window and the rest is b08's lead-in.
        await narrate(page, 'b07 the add page — the phrase came across', 3);
        await highlight(page, page.getByLabel(/pairing phrase/i), 1600);
        await narrate(page, 'b07 now pick a site', 2.5);

        await clickWithCursor(page, siteSelect);
        // SelectContent is position="popper" and portalled to document.body
        // (components/ui/select.tsx:52-60) — it is not inside the card.
        const gallery = page.getByRole('option', { name: 'main gallery', exact: true });
        await expect(gallery).toBeVisible();
        await narrate(page, 'b07 a site is just a group of machines', 3.5);
        await clickWithCursor(page, gallery);

        const authorize = page.getByRole('button', { name: /authorize machine/i });
        await expect(authorize).toBeVisible();
        // The button MOUNTS on selection, which grows the card inside a
        // vertically-centred <main> (AuthShell.tsx) and shifts the whole card up
        // ~30px. Let the layout settle or the glide lands on stale geometry.
        await page.waitForTimeout(500);
        await highlight(page, authorize, 1800);
        await narrate(page, 'b07 the authorize button lights up', 2);

        await clickWithCursor(page, authorize);
        await expect(
          page.getByRole('heading', { name: /machine authorized/i }),
        ).toBeVisible({ timeout: 20_000 });
        await narrate(page, 'b07 authorized', 4);

        // ── [b08] the machine appears (20.611s) ──────────────────────────────
        // Real product transition, not a bare goto (add/page.tsx:214-219).
        await clickWithCursor(page, page.getByRole('button', { name: /go to dashboard/i }));
        await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
        await expect(page.getByText('getting started', { exact: true })).toBeVisible({
          timeout: 20_000,
        });
        await expect(page.getByTestId('machine-card')).toHaveCount(0);
        await page.evaluate(() => window.scrollTo(0, 0));

        // Budget: ~22s, with the pop at ~5s (a real "before" frame) and the
        // metrics at ~16s, so ~4.5s of the filled card sits inside the 20.611s
        // window rather than in the trimmed tail.
        // The write MUST come after this narrate or the card lands off-camera —
        // narrate() blocks the Node side, so writes go BETWEEN narrate calls.
        await narrate(page, 'b08 back on the dashboard — nothing paired yet', 5);

        // Authorizing does NOT create the machine: `authorize/route.ts` only
        // touches device_codes + agent_refresh_tokens. The doc is created by the
        // agent's first write, `_update_presence(True)` — exactly these four
        // fields, merged (agent/src/firebase_client.py:1036-1041). Order is
        // load-bearing in the agent too (:591-593): presence first, because it
        // needs no hardware data; metrics second, after the slow WMI and sensor
        // work of the profile build. That two-step is what is staged here.
        //
        // `lastHeartbeat` is a plain number, NOT serverTimestamp: recordScene
        // freezes the page's Date at FIXED_NOW_MS, so a real server timestamp
        // would be ~4 months in the page's future and formatHeartbeatTime would
        // print a wall-clock time that disagrees with every other fixture label.
        await machinesRef.doc(MACHINE_ID).set(
          {
            online: true,
            lastHeartbeat: FIXED_NOW_SEC - 3,
            machineId: MACHINE_ID,
            siteId: ctx.siteId,
          },
          { merge: true },
        );

        const card = page.getByTestId('machine-card');
        await expect(card).toHaveCount(1, { timeout: 20_000 });
        // There is no grey→green transition to film and inventing one would be
        // fabricating UI: the agent's very first write is `online: true` with a
        // fresh heartbeat, so the pill is green the instant the card exists. The
        // honest two-phase is bare card → metrics-filled card.
        await highlight(page, card.getByText('online', { exact: true }), 2400);
        await narrate(page, 'b08 the card lands, pill already green', 5);

        // The header stat tile, now reading 1 / 1. No testid exists; this <p> is
        // the only element whose exact text is "online" (dashboard/page.tsx:890)
        // — getByText('online') would also match the pill Badge.
        const onlineStat = page.locator('p', { hasText: /^online$/ }).first().locator('..');
        await highlight(page, onlineStat, 2200);
        await narrate(page, 'b08 one of one online', 3);

        // The first metrics upload. Writes `metrics` + `hardware/profile`, which
        // is what makes the card visibly grow (MachineCardView.tsx:366 gates the
        // whole stats collapsible on `machine.metrics`). Modest first-boot
        // numbers. Deliberately NO metrics_history: a machine paired 15 seconds
        // ago has none, and empty sparklines are the honest render.
        await writeMachineMetrics(
          ctx.siteId,
          MACHINE_ID,
          { cpuPct: 14, memPct: 26, memUsedGb: 4.1, gpuPct: 9, diskPct: 31 },
          3,
        );
        // writeMachineMetrics stamps the fixture fleet's 3.0.0; a machine that
        // just installed 3.2.3 reports 3.2.3. Invisible on the card, wrong in
        // the data.
        await machinesRef.doc(MACHINE_ID).set({ agent_version: LATEST_VERSION }, { merge: true });

        // Substring, not an exact-text tile: whether the stats section renders
        // expanded ("cpu" as its own label) or collapsed ("cpu 14% | mem …")
        // follows the admin's saved `statsExpanded` preference, which an earlier
        // scene in the same serial run can have toggled. Either way the word
        // only appears once metrics exist.
        await expect(card).toContainText('cpu', { timeout: 20_000 });
        await centerInView(page, card);
        await narrate(page, 'b08 first metrics land — the tiles fill in', 6);

        // ── [b09] recap & the other two ways (22.596s) ───────────────────────
        // Opened in b08's trimmed tail so b09's window opens on an established
        // modal rather than mid-click. Unique: with machines > 0 the
        // getting-started card (and its own AddMachineButton) is gone, leaving
        // the one at dashboard/page.tsx:974.
        await clickWithCursor(page, page.getByRole('button', { name: /add machine/i }));
        const dialog = page.getByRole('dialog', { name: 'add machine' });
        await expect(dialog).toBeVisible();

        // Budget: ~24s, with the copy click at ~t+19s so its toast is fully
        // inside the 22.596s window.
        await narrate(page, 'b09 two more ways — both tabs on screen', 3.5);
        // The switcher renders on BOTH tabs (AddMachineButton.tsx:171-197), so
        // one shot covers the direction's "showing both tabs".
        await highlight(page, dialog.locator('div.grid-cols-2').first(), 2400);
        await narrate(page, 'b09 enter code — type the phrase straight in', 3.5);

        // `.first()` is MANDATORY. Once the generate tab is active, the tab
        // button (:189-196) and the primary CTA (:395) both expose the
        // accessible name "generate code" and a bare locator resolves to two
        // nodes. DOM order is stable — switcher before tab content — so
        // .first() is the tab and .last() is the CTA. (add-machine-modal.spec.ts
        // gets away with the bare locator only because it never switches tabs.)
        const generateCode = dialog.getByRole('button', { name: 'generate code', exact: true });
        await clickWithCursor(page, generateCode.first());
        await expect(
          dialog.getByText(/generate a pre-authorized pairing phrase/),
        ).toBeVisible();
        await narrate(page, 'b09 generate code — for bulk rollouts', 3.5);

        // A REAL mint + authorize round-trip against the emulator. The admin
        // session cookie is what makes it work: device-code/route.ts:53-62 sets
        // `preauthorizedIntent` only for a live session, and that flag is what
        // routes the follow-up authorize down the offline-capable branch. No
        // session ⇒ 401/400 and a red toast, which is why this asserts on
        // "code ready" with a real timeout instead of a fixed wait.
        await expect(generateCode).toHaveCount(2);
        const [mintResponse] = await Promise.all([
          page.waitForResponse(
            (res) =>
              new URL(res.url()).pathname === '/api/agent/auth/device-code' &&
              res.request().method() === 'POST',
          ),
          clickWithCursor(page, generateCode.last()),
        ]);
        generatedPhrase = ((await mintResponse.json()) as { pairPhrase?: string }).pairPhrase ?? null;
        await expect(dialog.getByText('code ready')).toBeVisible({ timeout: 20_000 });

        await highlight(
          page,
          dialog.getByRole('button', { name: 'copy pairing phrase' }).locator('..'),
          2000,
        );
        await narrate(page, 'b09 a pre-authorized phrase', 2.5);

        // Anchored ^…$ so it can only resolve to the command box itself; every
        // ancestor carries more text. Also proves the rendered command picked up
        // the seeded version — without installer_metadata the box would read
        // "Owlette-Installer-v....exe" while the CLIPBOARD got "vundefined"
        // (AddMachineButton.tsx:339 vs :345).
        const commandBox = dialog.getByText(
          new RegExp(
            `^Owlette-Installer-v${LATEST_VERSION.replace(/\./g, '\\.')}\\.exe\\s+/ADD=[a-z-]+\\s+/SILENT$`,
          ),
        );
        await expect(commandBox).toBeVisible();
        await highlight(page, commandBox, 2400);
        await narrate(page, 'b09 the silent-install command', 2.5);

        await clickWithCursor(
          page,
          dialog.getByRole('button', { name: 'copy silent install command' }),
        );
        await expect(page.getByText('Command copied to clipboard')).toBeVisible();
        // b09 must be the LAST narrate in the scene — finishTake settles only the
        // final mark and then writes the sidecar. The cursor rests on the copy
        // button inside the centred modal, nowhere near the bottom-right toaster
        // (a pointer over it pauses the drain, lib/toast.ts:118-146, and the
        // toast would sit there for the rest of the take).
        await narrate(page, 'b09 copied — expires in ten minutes', 4);
      },
    );
  } finally {
    // Everything this scene created, and nothing it did not. `ctx.cleanup()` is
    // deleteSiteSubtree(site-A) — it never touches top-level collections, and
    // leaving any of these behind would change what LATER scenes in the same
    // serial run render (workers: 1).
    await db.collection('installer_metadata').doc('latest').delete().catch(() => undefined);
    await db.collection('device_codes').doc(EP03_PAIR_PHRASE).delete().catch(() => undefined);
    if (generatedPhrase) {
      await db.collection('device_codes').doc(generatedPhrase).delete().catch(() => undefined);
    }
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ sites: FieldValue.arrayRemove(ANNEX_SITE_ID) }, { merge: true })
      .catch(() => undefined);
    await db.collection('sites').doc(ANNEX_SITE_ID).delete().catch(() => undefined);
    await ctx.cleanup();
  }
});
