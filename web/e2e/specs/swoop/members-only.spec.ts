/**
 * a site's screens are for its members, swoop's picture included (adr 0021).
 * super-uid holds every capability on every site and no member row on this one:
 * asking to watch a machine is refused, with no session written: the site gate
 * answers members_only, which the viewer takes as final. a member of the same
 * site is let in. the menu side is MachineContextMenu.test.tsx.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { grantMembership, releaseFixtureSite, seedMachine, seedSite } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-swoop-members-${SUFFIX}`;
const MACHINE_ID = `mach-swoop-members-${SUFFIX}`;
const SESSIONS = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/swoop/sessions`;
const FP = `sha-256 ${Array.from({ length: 32 }, (_, i) => ((i * 7) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':')}`;
const CLIENT_CAPS = { codecs: ['h264'], hardware: [], playoutDelay: true, webCodecsHevc: false };

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: `Swoop members ${SUFFIX}`, owner: 'someone-else', timezone: 'UTC' });
  await seedMachine(SITE_ID, MACHINE_ID);
  await getAdminDb()
    .doc(`sites/${SITE_ID}/machines/${MACHINE_ID}`)
    .set({ capabilities: { swoop: 1 } }, { merge: true });
  await getAdminDb()
    .doc(`sites/${SITE_ID}/settings/swoop`)
    .set({ enabled: true, membersMayWatch: true, excludedMachineIds: [] }, { merge: true });
  await grantMembership(SITE_ID, 'member-uid', 'member');
});

test.afterAll(async () => {
  await getAdminDb().doc(`sites/${SITE_ID}/settings/swoop`).delete();
  await releaseFixtureSite(SITE_ID, 'member-uid');
});

/** a watch request from inside the page, on its own session, as the viewer makes it */
async function askToWatch(page: Page): Promise<{ status: number; body: Record<string, unknown> }> {
  await page.goto('/dashboard');
  return page.evaluate(
    async ([url, fp, clientCaps]) => {
      const res = await fetch(url as string, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ control: false, fp, clientCaps }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    [SESSIONS, FP, CLIENT_CAPS] as const,
  );
}

const sessionDocs = async () =>
  (await getAdminDb().collection(`sites/${SITE_ID}/machines/${MACHINE_ID}/swoop_sessions`).get()).size;

test.describe('a superadmin who is not a member of the site', () => {
  test.use(roleState('superadmin'));

  test('is refused swoop watch, and no session is written', async ({ page }) => {
    const before = await sessionDocs();

    const res = await askToWatch(page);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('members_only');
    expect(await sessionDocs()).toBe(before);
  });
});

test.describe('a member of the site', () => {
  test.use(roleState('member'));

  test('is let in to watch', async ({ page }) => {
    const res = await askToWatch(page);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
