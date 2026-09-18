/**
 * Time-travel — fresh heartbeat renders the online dot. Baseline for E3.x's
 * staleness transitions.
 *
 * useMachines' 30s setInterval (`useFirestore.ts:854-880`) re-evaluates `online`
 * as `machine.online === true && heartbeatAge < 300`; a freshly seeded
 * heartbeat satisfies both.
 *
 * No `page.clock` — this case needs no time-travel. The fixture shape is kept
 * identical to E3.2 (stale) and E3.3 (recovery) so a shared-setup regression
 * surfaces uniformly.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-heartbeat-fresh';

test('fresh heartbeat renders the green online dot', async ({ page }) => {
  // heartbeatOffsetSec=0 (default) → lastHeartbeat = nowSec, so heartbeatAge=0
  // passes the <300s check; seedMachine also sets online=true, satisfying the
  // dual-condition gate at useFirestore.ts:869.
  await seedMachine(SITE_ID, MACHINE_ID);

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();

  // MachineStatusPill's idle branch renders a green dot labelled "online", or a
  // Badge reading exactly "offline". Scope to the card so the header's "N/M
  // online" stats copy doesn't match.
  await expect(card.getByRole('img', { name: 'online' })).toBeVisible();
  await expect(card.getByText('offline', { exact: true })).toHaveCount(0);
});
