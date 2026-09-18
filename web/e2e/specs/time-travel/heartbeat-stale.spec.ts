/**
 * Time-travel — a stale heartbeat flips the pill to offline. useMachines' 30s
 * setInterval re-evaluates `online` as `online === true && heartbeatAge <
 * OFFLINE_HEARTBEAT_AGE_SEC` (300s, matched to the cron's OFFLINE_THRESHOLD_MS).
 *
 * Clock rules, learned the hard way:
 *   - Install the clock BEFORE goto, or the 30s interval isn't faked.
 *   - Anchor on real `Date.now()`; a fixed-past anchor breaks Firebase Auth's
 *     onAuthStateChanged timing and the dashboard stalls on "buffering…".
 *   - No pauseAt — it would skip multiple interval iterations in one step.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-heartbeat-stale';

test('heartbeat age exceeding 300s flips the machine pill to offline', async ({ page }) => {
  const realNow = Date.now();
  await page.clock.install({ time: realNow });

  // heartbeatOffsetSec 0 => lastHeartbeat at real "now", which the fake-clock
  // anchor matches, so the baseline is the green "online" dot.
  await seedMachine(SITE_ID, MACHINE_ID);

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await expect(card.getByRole('img', { name: 'online' })).toBeVisible();

  // 330s clears the 300s threshold and fires the interval ~11 times, so at
  // least one tick sees heartbeatAge >= 300.
  await page.clock.fastForward(330_000);

  await expect(card.getByText('offline', { exact: true })).toBeVisible();
  await expect(card.getByRole('img', { name: 'online' })).toHaveCount(0);
});
