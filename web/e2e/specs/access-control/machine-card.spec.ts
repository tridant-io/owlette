/**
 * Access-control — machine card / row: per-machine write actions are hidden
 * from any viewer failing `isSiteAdmin(siteId)`. Automates the "dashboard —
 * site access + machine panel" rows of
 * dev/active/permission-model-split/manual-smoke-checklist.md.
 *
 * Three gated surfaces:
 *   1. MachineContextMenu — restart/shutdown/cancel/revoke-token/remove.
 *   2. MachineStatusPill — countdown is clickable only when
 *      `isSiteAdmin && onCancel && remaining > 5`; members get a text pill.
 *   3. MachineCardView's amber "restart pending" banner — members see the
 *      banner without approve/dismiss.
 *
 * Four machines seeded on site-A cover the states: baseline (no restart),
 * rebooting (scheduledAt 120s out, above the 5s cancel lockout), pending
 * (rebootPending.active, card view only), and offline-pending (the same
 * flag on a machine whose heartbeat has aged out).
 */

import { test, expect, type Page, type Locator } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

const SITE_ID = 'site-A';
const BASELINE_MACHINE_ID = 'e2e-machine-baseline';
const REBOOTING_MACHINE_ID = 'e2e-machine-rebooting';
const PENDING_MACHINE_ID = 'e2e-machine-pending';
// not '...-pending-offline': cardFor filters on hasText, so an id that CONTAINS
// another seeded id matches two cards and trips strict mode.
const OFFLINE_PENDING_MACHINE_ID = 'e2e-machine-offline-pending';

test.beforeAll(async () => {
  // Seeds coexist so one dashboard render exposes all four states.
  await seedMachine(SITE_ID, BASELINE_MACHINE_ID);
  await seedMachine(SITE_ID, REBOOTING_MACHINE_ID, { rebootingInSec: 120 });
  await seedMachine(SITE_ID, PENDING_MACHINE_ID, { rebootPending: true });
  // 600s > the 300s window useFirestore derives `online` from. seedMachine
  // writes `online: true` regardless; the hook ignores it, which is the
  // whole point -- a killed agent leaves the stored flag stuck true.
  await seedMachine(SITE_ID, OFFLINE_PENDING_MACHINE_ID, {
    rebootPending: true,
    heartbeatOffsetSec: 600,
  });
});

/**
 * Scope to a machine's card in the default (card) view. hasText on the raw
 * machineId is unambiguous only because our seeded IDs share no substrings.
 */
async function cardFor(page: Page, machineId: string): Promise<Locator> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: machineId });
  await expect(card).toBeVisible();
  return card;
}

/** Scope to a machine's row in list view; the hostname cell holds the raw id. */
async function rowFor(page: Page, machineId: string): Promise<Locator> {
  await page.goto('/dashboard');
  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: machineId });
  await expect(row).toBeVisible();
  return row;
}

/**
 * Open a card/row's ⋮ menu and return the popover. DropdownMenuContent portals
 * out of the card, so it must be reached by role, not as a descendant.
 */
async function openContextMenu(page: Page, scope: Locator): Promise<Locator> {
  await scope.getByTestId('machine-context-menu-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('machine card — member on site-A', () => {
  test.use(roleState('member'));

  test('context menu hides reboot + shutdown items on a healthy machine', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-reboot')).toHaveCount(0);
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toHaveCount(0);
  });

  test('context menu hides the remove-machine item', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-remove')).toHaveCount(0);
    // Revoke-token is also an admin action — hidden by the same gate.
    await expect(menu.getByTestId('machine-context-menu-revoke-token')).toHaveCount(0);
  });

  test('cancel-countdown pill during active reboot is read-only (no click handler)', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);

    // Admin gets a <button data-testid="machine-status-cancel-pill">; members
    // get a testid-less <Badge>. Count 0 is the contract.
    await expect(card.getByTestId('machine-status-cancel-pill')).toHaveCount(0);

    // The pill is still rendered; assert on its accessible name (role=img
    // aria-label) so this is not just an assertion about a missing element.
    await expect(card.getByRole('img', { name: /restarting/i })).toBeVisible();
  });

  test('context menu hides cancel-restart item during active restart', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-cancel-reboot')).toHaveCount(0);
  });

  test('amber restart-pending banner hides the approve/dismiss buttons', async ({ page }) => {
    const card = await cardFor(page, PENDING_MACHINE_ID);

    // Banner itself is visible (members can see the reason); the gated
    // controls are approve + dismiss.
    await expect(card).toContainText(/restart pending/i);
    await expect(card.getByTestId('reboot-pending-approve')).toHaveCount(0);
    await expect(card.getByTestId('reboot-pending-dismiss')).toHaveCount(0);
  });

  test('list view: context menu hides reboot/shutdown/remove items', async ({ page }) => {
    const row = await rowFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, row);

    await expect(menu.getByTestId('machine-context-menu-reboot')).toHaveCount(0);
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toHaveCount(0);
    await expect(menu.getByTestId('machine-context-menu-remove')).toHaveCount(0);
  });
});

test.describe('machine card — admin on site-A', () => {
  test.use(roleState('admin'));

  test('context menu shows reboot + shutdown items on a healthy machine', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toBeVisible();
  });

  test('context menu shows the remove-machine item', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-remove')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-revoke-token')).toBeVisible();
  });

  test('site admin can actually revoke a machine token (route accepts the call)', async ({ page }) => {
    // The menu item is gated on isSiteAdmin, so the route must accept a site
    // admin. Rendering alone is not the contract — before AGENT_TOKEN_REVOKE
    // this endpoint 403'd every admin who clicked it. The call runs inside the
    // page (same bare cookie-authenticated fetch MachineContextMenu makes):
    // Playwright's request context drops the Secure session cookie on http
    // loopback, so page.request would 401 regardless of the capability.
    await page.goto('/dashboard');
    const status = await page.evaluate(
      async ({ siteId, machineId }) => {
        const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/agent-tokens/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ machineId, latestOnly: true }),
        });
        return res.status;
      },
      { siteId: SITE_ID, machineId: BASELINE_MACHINE_ID },
    );
    expect(status).toBe(200);
  });

  test('cancel-countdown pill during active reboot is clickable', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);

    // Visibility + tagName together pin the role contract: only the clickable
    // variant is a <button> carrying the testid.
    const pill = card.getByTestId('machine-status-cancel-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('type', 'button');
  });

  test('context menu shows cancel-reboot item during active reboot', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-cancel-reboot')).toBeVisible();
  });

  test('amber restart-pending banner shows approve + dismiss buttons', async ({ page }) => {
    const card = await cardFor(page, PENDING_MACHINE_ID);

    await expect(card).toContainText(/restart pending/i);
    await expect(card.getByTestId('reboot-pending-approve')).toBeVisible();
    await expect(card.getByTestId('reboot-pending-dismiss')).toBeVisible();
  });

  test('offline machine keeps the banner and dismiss, but drops approve', async ({ page }) => {
    const card = await cardFor(page, OFFLINE_PENDING_MACHINE_ID);

    // Still shown -- the flag is real state the operator wants to see -- but
    // approve is gone because the command path 409s `machine_offline`.
    await expect(card).toContainText(/restart pending/i);
    await expect(card).toContainText(/machine offline, cannot restart/i);
    await expect(card.getByTestId('reboot-pending-approve')).toHaveCount(0);
    await expect(card.getByTestId('reboot-pending-dismiss')).toBeVisible();
  });

  test('dismiss clears the flag on an offline machine', async ({ page }) => {
    // The regression: dismissal used to queue an agent command and nothing
    // else, so a machine that never came back could not be dismissed at all.
    // Clicking is the contract, not the route -- the banner must go away.
    const card = await cardFor(page, OFFLINE_PENDING_MACHINE_ID);
    await card.getByTestId('reboot-pending-dismiss').click();

    await expect(card.getByTestId('reboot-pending-banner')).toHaveCount(0);
  });
});

test.describe('machine card — superadmin', () => {
  test.use(roleState('superadmin'));

  test('context menu shows reboot + shutdown + remove items', async ({ page }) => {
    const card = await cardFor(page, BASELINE_MACHINE_ID);
    const menu = await openContextMenu(page, card);

    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-remove')).toBeVisible();
  });

  test('cancel-countdown pill during active reboot is clickable', async ({ page }) => {
    const card = await cardFor(page, REBOOTING_MACHINE_ID);
    const pill = card.getByTestId('machine-status-cancel-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('type', 'button');
  });

  test('amber reboot-pending banner shows approve + dismiss buttons', async ({ page }) => {
    const card = await cardFor(page, PENDING_MACHINE_ID);

    await expect(card.getByTestId('reboot-pending-approve')).toBeVisible();
    await expect(card.getByTestId('reboot-pending-dismiss')).toBeVisible();
  });
});
