/**
 * Sites — what each PER-SITE role is offered, end to end (wave 6.5).
 *
 * The suite was a role monoculture: most specs run `roleState('superadmin')`,
 * and superadmin returns true from `hasCapability` before the site is ever
 * considered. That is why two access regressions reached production — neither
 * was reachable by any test in the suite.
 *
 * These run as the two roles that actually have boundaries. `owner` is a global
 * `member` who owns a site, which is what every self-serve customer is
 * (`bootstrapUser.server.ts` creates them as `member`, and `POST /api/sites` has
 * no capability gate). `admin` administers a site it does not own.
 *
 * The line between them is exactly one capability: SITE_DELETE sits on the owner
 * row of `SiteRoleCapabilityMatrix` and nowhere else. Renaming is
 * SITE_MEMBER_MANAGE, which both hold. So an owner sees both controls, a site
 * admin sees only edit, and a plain member sees neither — the last of which is
 * covered by `delete-site-owner.spec.ts`. The site's swoop and keep screens
 * awake switches live in the edit panel, so a member is offered neither; that
 * is asserted here.
 *
 * NON-DESTRUCTIVE by design: these assert what is OFFERED. Actually deleting a
 * site is covered by `delete-site-owner.spec.ts` against a site it seeds itself,
 * so nothing here can strip a baseline site out from under a later spec.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { grantMembership, revokeMembership, TEST_USERS } from '../../helpers/seed';
import { getAdminDb } from '../../helpers/emulator';
import { FieldValue } from 'firebase-admin/firestore';

/** Owned by the `owner` fixture in the baseline. */
const OWNED_SITE_ID = 'site-C';
const OWNED_SITE_NAME = 'Site C (Owned)';

async function openManageSitesDialog(page: Page) {
  await page.goto('/dashboard');
  await page.getByTestId('site-switcher-trigger').click();
  await page.getByRole('menuitem', { name: /manage sites/i }).click();
  const dialog = page.getByRole('dialog', { name: /manage sites/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('per-site role — owner', () => {
  test.use(roleState('owner'));

  test('an owner is offered both edit and delete on the site they own', async ({ page }) => {
    const dialog = await openManageSitesDialog(page);

    await expect(dialog.getByRole('button', { name: `edit ${OWNED_SITE_NAME}` })).toBeVisible();
    await expect(dialog.getByRole('button', { name: `delete ${OWNED_SITE_NAME}` })).toBeVisible();
  });

  test('the owner reaches the site despite a global role of member', async ({ page }) => {
    // The membership row is the entire grant. If this ever fails while the row
    // exists, something has started consulting the global role again.
    expect(TEST_USERS.owner.role).toBe('member');

    const dialog = await openManageSitesDialog(page);
    await expect(dialog.getByText(OWNED_SITE_NAME)).toBeVisible();
  });
});

test.describe('membership ALONE grants access', () => {
  test.use(roleState('owner'));

  const OWNER_UID = TEST_USERS.owner.uid;

  // Strip the legacy `users/{uid}.sites[]` entry, leaving ONLY the member row.
  // Restored afterwards so later specs see the baseline they expect.
  test.beforeAll(async () => {
    await getAdminDb()
      .collection('users')
      .doc(OWNER_UID)
      .update({ sites: FieldValue.arrayRemove(OWNED_SITE_ID) });
  });

  test.afterAll(async () => {
    await getAdminDb()
      .collection('users')
      .doc(OWNER_UID)
      .update({ sites: FieldValue.arrayUnion(OWNED_SITE_ID) });
  });

  test('the site is still reachable with no legacy sites[] entry at all', async ({ page }) => {
    // THE test wave 6.1 needs before it strips that field, and the one thing the
    // suite could not previously say. Every other fixture writes BOTH the member
    // row and the legacy array, so the suite is satisfied by the array alone —
    // it would stay green even if the collectionGroup listener broke outright,
    // and would only fail in production, after the strip, for every user at once.
    //
    // With the array entry gone, the only thing that can put this site on screen
    // is `useSiteMemberships`' collectionGroup query resolving the member row.
    const dialog = await openManageSitesDialog(page);

    await expect(dialog.getByText(OWNED_SITE_NAME)).toBeVisible();
    await expect(dialog.getByRole('button', { name: `delete ${OWNED_SITE_NAME}` })).toBeVisible();
  });
});

test.describe('per-site role — site admin', () => {
  test.use(roleState('admin'));

  const ADMIN_UID = TEST_USERS.admin.uid;

  // The admin fixture does not hold site-C in the baseline. Borrow it, then hand
  // it back: a grant left behind makes site auto-selection prefer it for every
  // later spec, which is the contamination `releaseFixtureSite` exists for.
  test.beforeAll(async () => {
    await grantMembership(OWNED_SITE_ID, ADMIN_UID, 'admin');
  });

  test.afterAll(async () => {
    await revokeMembership(OWNED_SITE_ID, ADMIN_UID);
  });

  test('a site admin is offered edit but NOT delete', async ({ page }) => {
    const dialog = await openManageSitesDialog(page);

    // Renaming is SITE_MEMBER_MANAGE, which a site admin holds.
    await expect(dialog.getByRole('button', { name: `edit ${OWNED_SITE_NAME}` })).toBeVisible();
    // Destroying the site is not. This is the one capability separating the two
    // rows, and the reason SITE_DELETE is absent from SITE_ADMIN_CAPABILITIES.
    await expect(
      dialog.getByRole('button', { name: `delete ${OWNED_SITE_NAME}` })
    ).toHaveCount(0);
  });

  test('the same holds on every site it administers, not just the borrowed one', async ({
    page,
  }) => {
    // site-A is this fixture's own baseline site, owned by someone else. If the
    // delete gate were keyed on anything but ownership, the two sites would
    // disagree — which is what makes this worth asserting twice.
    const dialog = await openManageSitesDialog(page);

    await expect(dialog.getByRole('button', { name: 'edit Site A (Assigned)' })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'delete Site A (Assigned)' })
    ).toHaveCount(0);
  });
});

test.describe('per-site role — member', () => {
  // read-only: the shared member fixture only looks, so its auth state is untouched.
  test.use(roleState('member'));

  const ASSIGNED_SITE_NAME = 'Site A (Assigned)';

  test('a member is offered neither site switch', async ({ page }) => {
    const dialog = await openManageSitesDialog(page);

    // no pencil, so no edit panel for the switches to live in.
    const machinesToggle = dialog.getByRole('button', { name: `machines on ${ASSIGNED_SITE_NAME}` });
    await expect(machinesToggle).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: `edit ${ASSIGNED_SITE_NAME}` })
    ).toHaveCount(0);

    // the machines panel is where the swoop switch used to sit; it holds no switch now.
    await machinesToggle.click();
    await expect(machinesToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.getByText('loading machines…')).toHaveCount(0);

    await expect(dialog.getByRole('switch', { name: 'swoop', exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole('switch', { name: 'keep screens awake', exact: true })
    ).toHaveCount(0);
  });
});
