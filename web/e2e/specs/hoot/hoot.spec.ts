import { test, expect, type Locator, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { grantMembership, revokeMembership, TEST_USERS } from '../../helpers/seed';
import {
  clearHootFixture,
  hootMachinesChatId,
  seedHootFixture,
  setLastSite,
  HOOT_FIXTURE_MACHINE_ID,
  HOOT_FIXTURE_OFFLINE_MACHINE_ID,
} from '../../helpers/coverageSeed';

const SITE_ID = 'site-A';
/** The seeded chat whose target is the legacy single machine. */
const LEGACY_CHAT_ID = `e2e-cortex-user-${TEST_USERS.admin.uid}`;
/** A row in the target picker, matched from the start of its id. */
const machineRow = (machineId: string) => new RegExp(`^${machineId}`, 'i');

/**
 * A row's checkbox column — the half that TOGGLES that machine within the ticked
 * set. Clicking the row anywhere else selects ONLY that machine, so a test that
 * means to add one to the set has to hit this, exactly as a user does.
 */
const checkboxOf = (row: Locator): Locator => row.locator('[data-checkbox-box]');

/**
 * Leave exactly one machine ticked, from whatever the picker started on, and
 * close the menu again.
 *
 * A row has two targets: its checkbox column toggles that machine within the
 * set, its NAME selects only it. Playwright clicks an element's centre, which
 * lands on the name, so ONE click gets there and needs no starting state — which
 * matters, because the ticked set persists as the user's site preference the
 * moment it changes, so the picker does not open on "all machines" a second
 * time (not on a CI retry, and not in a later test on the same account).
 *
 * Opening is conditional because selecting does NOT close the menu (picking a
 * set takes several clicks, so `onSelect` preventDefaults) — a second
 * unconditional click on the trigger would toggle an already-open menu shut.
 */
async function aimAtOnly(page: Page, machine: RegExp): Promise<void> {
  const row = page.getByRole('menuitemcheckbox', { name: machine });
  if (!(await row.isVisible())) {
    await page.getByLabel(/hoot target/i).click();
    await expect(row).toBeVisible();
  }
  await row.click();
  await page.keyboard.press('Escape');
  await expect(row).toBeHidden();
}

test.describe('hoot key guard', () => {
  test.use(roleState('member'));

  test('shows the no-key overlay and account-settings path', async ({ page }) => {
    await clearHootFixture(TEST_USERS.member.uid);
    await page.goto('/hoot');
    await expect(page.getByText(/hoot requires an LLM API key/i)).toBeVisible();
    await page.getByRole('button', { name: /open account settings/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});

test.describe('hoot conversations and controls', () => {
  test.use(roleState('admin'));

  test.beforeEach(async () => {
    await seedHootFixture({ userId: TEST_USERS.admin.uid });
  });

  test('loads, searches, renames, and deletes seeded conversations', async ({ page }) => {
    await page.goto('/hoot');
    await expect(page.getByText('Deployment triage')).toBeVisible();
    await expect(page.getByText('Nightly auto investigation')).toBeVisible();

    await page.getByText('Deployment triage').click();
    await expect(page.getByText(/installer exited with a retryable warning/i)).toBeVisible();
    await expect(page.getByText(/checkLogs/i)).toBeVisible();

    await page.getByRole('button', { name: /search conversations/i }).click();
    await page.getByPlaceholder(/search/i).fill('auto');
    await expect(page.getByText('Nightly auto investigation')).toBeVisible();
    await expect(page.getByText('Deployment triage')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByText('Deployment triage').hover();
    await page.getByRole('button', { name: /rename Deployment triage/i }).click();
    await page.locator('input').last().fill('Deployment RCA');
    await page.getByRole('button', { name: /save rename Deployment triage/i }).click();
    await expect(page.getByText('Deployment RCA')).toBeVisible();

    await page.getByText('Deployment RCA').hover();
    await page.getByRole('button', { name: /delete Deployment RCA/i }).click();
    await page.getByRole('button', { name: /confirm delete Deployment RCA/i }).click();
    await expect(page.getByText('Deployment RCA')).toHaveCount(0);
  });

  test('names the page and keeps a reply log for screen readers', async ({ page }) => {
    await page.goto('/hoot');
    await expect(page.getByLabel('chat message')).toBeVisible();

    await expect(page.getByRole('heading', { level: 1, name: 'hoot' })).toBeAttached();
    // replies are read out from here once a turn ends, never token by token.
    await expect(page.getByRole('log', { name: 'hoot replies' })).toBeAttached();
  });

  test('narrows the target to one machine and surfaces offline warnings', async ({ page }) => {
    await page.goto('/hoot');
    const target = page.getByLabel(/hoot target/i);
    await expect(target).toBeVisible();

    // One machine is what the per-machine controls — the power toggle, the
    // single-machine offline copy — render for, and a row's NAME is the way to
    // ask for exactly one.
    await aimAtOnly(page, /^e2e-cortex-machine/i);
    await expect(page.getByText(/hoot active/i)).toBeVisible();

    await aimAtOnly(page, /^e2e-cortex-offline/i);
    await expect(page.getByText(/machine is offline/i)).toBeVisible();
  });

  test('ticking another machine re-aims the open conversation instead of starting one', async ({
    page,
  }) => {
    await page.goto('/hoot');
    await page.getByText('Deployment triage').click();
    await expect(page).toHaveURL(new RegExp(`/hoot/${LEGACY_CHAT_ID}$`));
    await expect(page.getByText(/installer exited with a retryable warning/i)).toBeVisible();

    // The header adopts the conversation's own target, so the picker opens on
    // the one machine this legacy chat stored — not on the site preference.
    const target = page.getByLabel(/hoot target/i);
    await expect(target).toContainText(HOOT_FIXTURE_MACHINE_ID);

    await target.click();
    const offlineRow = page.getByRole('menuitemcheckbox', {
      name: machineRow(HOOT_FIXTURE_OFFLINE_MACHINE_ID),
    });
    await expect(offlineRow).toHaveAttribute('aria-checked', 'false');
    // The checkbox column, so this ADDS to the chat's set — clicking the row's
    // name would select only this machine and drop the one the chat came with.
    await checkboxOf(offlineRow).click();
    // The tick itself, read off the row rather than off the trigger's label: a
    // selection that ends up covering every machine in the site collapses back
    // to the dynamic "all machines" (`normalizeSelection`), and site-A's machine
    // count is whatever the specs before this one seeded. Ticked is ticked in
    // both worlds; the label is not.
    await expect(offlineRow).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    // THE property: re-aiming continues the conversation. Before multi-machine
    // targeting, changing the target was only possible by abandoning the chat.
    await expect(page).toHaveURL(new RegExp(`/hoot/${LEGACY_CHAT_ID}$`));
    await expect(page.getByText(/installer exited with a retryable warning/i)).toBeVisible();
  });

  test('a send carries the ticked target and the typed @machine', async ({ page }) => {
    // The turn never reaches a model: the route is stubbed, and this spec is
    // about the REQUEST. A refusal body is the cheapest valid response — the
    // composer's error banner is the only visible consequence.
    await page.route('**/api/hoot', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'LLM unavailable in e2e' }),
      });
    });

    await page.goto('/hoot');
    const target = page.getByLabel(/hoot target/i);
    await aimAtOnly(page, machineRow(HOOT_FIXTURE_MACHINE_ID));
    await expect(target).toContainText(HOOT_FIXTURE_MACHINE_ID);

    // `@` names a machine OUTSIDE the ticked set: a mention narrows one turn,
    // and the server keeps only the ids its own parse of this same message
    // agrees with (D-I). Filling in one go leaves the caret past the id, so the
    // completion list is closed by the time send is clicked.
    await page
      .getByLabel('chat message')
      .fill(`check @${HOOT_FIXTURE_OFFLINE_MACHINE_ID} for disk space`);

    const sent = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === '/api/hoot',
    );
    // Pending until awaited below: a click that throws first must not leave it
    // to reject unhandled.
    sent.catch(() => undefined);
    await page.getByRole('button', { name: /send message/i }).click();
    const body = (await sent).postDataJSON() as {
      siteId?: unknown;
      machineId?: unknown;
      target?: { machineIds?: unknown; mentions?: unknown };
    };

    expect(body.siteId).toBe(SITE_ID);
    // toEqual on the whole object, so a `target` that lost `machineIds`
    // altogether fails here rather than reading downstream as "all machines".
    expect(body.target).toEqual({
      machineIds: [HOOT_FIXTURE_MACHINE_ID],
      mentions: [HOOT_FIXTURE_OFFLINE_MACHINE_ID],
    });
    // Deploy skew: an instance still on the old route reads this field only, and
    // it must never widen to the site sentinel.
    expect(body.machineId).toBe(HOOT_FIXTURE_MACHINE_ID);
  });

  test('an approval card names the machines its own turn ran on', async ({ page }) => {
    await page.goto(`/hoot/${hootMachinesChatId(TEST_USERS.admin.uid)}`);

    // The header adopts the CHAT's target, so both of its machines are ticked.
    // Read off the rows, not the trigger's label: on a site holding nothing but
    // these two, a set covering every machine collapses back to the dynamic
    // "all machines" (`normalizeSelection`) and the label changes with it. Both
    // rows are ticked either way.
    const target = page.getByLabel(/hoot target/i);
    await target.click();
    for (const machineId of [HOOT_FIXTURE_MACHINE_ID, HOOT_FIXTURE_OFFLINE_MACHINE_ID]) {
      await expect(
        page.getByRole('menuitemcheckbox', { name: machineRow(machineId) }),
      ).toHaveAttribute('aria-checked', 'true');
    }
    await page.keyboard.press('Escape');

    // ...while the pending approval belongs to a turn a mention narrowed to one
    // of them. Scoped to the ToolCallCard root (`my-2 rounded-lg border
    // overflow-hidden`) so the user message that typed the mention can't satisfy
    // the assertion.
    const approvalCard = page
      .locator('div.rounded-lg.border.overflow-hidden')
      .filter({ hasText: 'hoot wants to run the privileged' })
      .first();
    await expect(approvalCard).toContainText(`on ${HOOT_FIXTURE_MACHINE_ID}`);
    await expect(approvalCard).not.toContainText(HOOT_FIXTURE_OFFLINE_MACHINE_ID);
    await expect(approvalCard.getByRole('button', { name: /^approve$/i })).toBeVisible();
    await expect(approvalCard.getByRole('button', { name: /^deny$/i })).toBeVisible();
  });

  test('resizes the conversation sidebar and remembers the width and the collapsed state', async ({ page }) => {
    await page.goto('/hoot');

    const panel = page.getByTestId('hoot-conversation-panel');
    const handle = page.getByRole('separator', { name: /resize conversation list/i });
    const toggle = page.getByRole('button', { name: /hoot sidebar$/ });
    const hideSidebar = page.getByRole('button', { name: 'hide hoot sidebar' });
    const showSidebar = page.getByRole('button', { name: 'show hoot sidebar' });

    // Both prefs live on one per-user doc that outlives the page, so normalise
    // rather than assume the default — a retry would otherwise inherit the
    // previous attempt's state. Probing first would race the hydrating read
    // (which lands after the markup, carrying whatever the last attempt stored);
    // toggling first settles it, because a pref the user has set wins over that
    // read for the rest of the session.
    await toggle.click();
    await expect(async () => {
      if (await showSidebar.isVisible()) await toggle.click();
      await expect(handle).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await handle.dblclick();
    await expect(panel).toHaveCSS('width', '300px');

    // Drag the right edge 120px wider.
    const grip = await handle.boundingBox();
    if (!grip) throw new Error('resize handle has no bounding box');

    const startX = Math.round(grip.x + grip.width / 2);

    // Grab from the gutter beside the panel, never from inside it: on the panel's
    // inner edge the strip would cover the conversation list's scrollbar and take
    // the thumb's clicks.
    const panelBox = await panel.boundingBox();
    if (!panelBox) throw new Error('conversation panel has no bounding box');
    expect(startX).toBeGreaterThan(panelBox.x + panelBox.width);

    const y = Math.round(grip.y + grip.height / 2);
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 120, y, { steps: 8 });
    await page.mouse.up();

    await expect(panel).toHaveCSS('width', '420px');
    await expect(handle).toHaveAttribute('aria-valuenow', '420');

    // The pref write is debounced 400ms past the drag; reload once it has landed.
    await page.waitForTimeout(1_000);
    await page.reload();
    await expect(panel).toHaveCSS('width', '420px');

    // Collapsed state rides the same doc and survives a reload too — with no
    // edge to grab while the column is folded away.
    await hideSidebar.click();
    await expect(panel).toHaveCSS('width', '0px');
    await expect(handle).toHaveCount(0);

    await page.waitForTimeout(1_000);
    await page.reload();
    await expect(panel).toHaveCSS('width', '0px');
    await expect(handle).toHaveCount(0);

    // Leave the shared prefs doc as we found it for the specs that follow.
    await showSidebar.click();
    await expect(handle).toBeVisible();
    await handle.dblclick();
    await expect(panel).toHaveCSS('width', '300px');
    await page.waitForTimeout(1_000);
  });

  test('shows send error state when the Hoot API rejects a message', async ({ page }) => {
    await page.route('**/api/hoot', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'LLM unavailable in e2e' }),
      });
    });

    await page.goto('/hoot');
    // By accessible name: the placeholder names the chat's current target, so
    // it moves with the picker.
    await page.getByLabel('chat message').fill('summarize the latest issue');
    await page.getByRole('button', { name: /send message/i }).click();
    await expect(page.getByText(/LLM unavailable in e2e/i)).toBeVisible();
  });
});

/**
 * The counterpart to "ticking continues the chat": a SITE change still starts a
 * fresh conversation. The open chat belongs to the old site — it has already
 * left the sidebar and cannot be sent to — so keeping it in front would only
 * invite a cross-site send (OWL-48).
 *
 * Its own describe because it needs a second site on the admin fixture, borrowed
 * for this block and handed back: a grant left behind makes site auto-selection
 * prefer it for every later spec, which is the contamination `releaseFixtureSite`
 * exists for.
 */
test.describe('hoot site change', () => {
  test.use(roleState('admin'));

  const ADMIN_UID = TEST_USERS.admin.uid;
  const OTHER_SITE_ID = 'site-B';
  const OTHER_SITE_NAME = 'Site B (Unassigned)';

  test.beforeAll(async () => {
    await grantMembership(OTHER_SITE_ID, ADMIN_UID, 'admin');
  });

  test.afterAll(async () => {
    await revokeMembership(OTHER_SITE_ID, ADMIN_UID);
    // The switch below persists the new site. Put the saved one back, or every
    // later spec opens on a site it seeded nothing into.
    await setLastSite(ADMIN_UID, SITE_ID);
  });

  test('changing site starts a new conversation', async ({ page }) => {
    await seedHootFixture({ userId: ADMIN_UID });
    // Deterministic starting site: the field outlives the run, so an earlier
    // spec (or a failed attempt at this one) would otherwise decide it.
    await setLastSite(ADMIN_UID, SITE_ID);

    await page.goto('/hoot');
    await page.getByText('Deployment triage').click();
    await expect(page).toHaveURL(new RegExp(`/hoot/${LEGACY_CHAT_ID}$`));
    await expect(page.getByText(/installer exited with a retryable warning/i)).toBeVisible();

    await page.getByTestId('site-switcher-trigger').click();
    await page.getByRole('menuitem', { name: OTHER_SITE_NAME }).click();

    // Back to the landing URL — a chat with no id yet — and the old site's
    // transcript is gone with it.
    await expect(page).toHaveURL(/\/hoot$/);
    await expect(page.getByText(/installer exited with a retryable warning/i)).toHaveCount(0);
    await expect(page.getByTestId('site-switcher-trigger')).toContainText(OTHER_SITE_NAME);
  });
});
