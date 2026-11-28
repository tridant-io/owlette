import { test, expect, type Locator } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedLogEvents } from '../../helpers/coverageSeed';
import { seedMachine } from '../../helpers/seed';
import { attachPicture } from '../../helpers/picture';
import { expectSweepAtRest, expectSweepSize, sweepState, sweptContrast } from '../../helpers/sweep';

// Guards the button hover standard — hover once went dead on the logs toolbar
// when buttons overrode the shared style with a near-invisible `hover:bg-muted`.
// The sweep is asserted as geometry (see helpers/sweep.ts), without colour literals.
test.describe('button hover states', () => {
  test.use(roleState('admin'));

  test('outline toolbar buttons sweep their hover fill in on hover', async ({ page }) => {
    await seedLogEvents('site-A');
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();

    const buttons = [
      page.getByRole('button', { name: /search logs/i }),
      page.getByRole('button', { name: /show filters/i }),
    ];

    for (const button of buttons) {
      await expect(button).toBeVisible();
      await expectSweepAtRest(button, 'the toolbar button');

      await button.hover();
      await expectSweepSize(button, '100% 100%', 'sweep should cover the button on hover');

      // reset so the next button measures from its true resting state
      await page.mouse.move(0, 0);
      await expectSweepSize(button, '0% 100%', 'sweep should leave the button');
    }
  });
});

// a site's machine list: restart (row) and remove (row-destructive) sit in one
// cluster, so they hover alike: the same muted fill under the sweep, a glyph in
// the accent or the bright danger step. the report keeps pictures, dark and light
test.describe('row buttons hover alike', () => {
  test.use(roleState('admin'));

  const SITE_ID = 'site-A';
  const MACHINE_ID = 'e2e-row-buttons';

  test.beforeAll(() => seedMachine(SITE_ID, MACHINE_ID));
  test.afterAll(() => getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete());

  async function hovered(button: Locator, what: string) {
    await expectSweepAtRest(button, what);
    await button.hover();
    await expectSweepSize(button, '100% 100%', `${what} should sweep in`);
    return sweepState(button);
  }

  for (const scheme of ['dark', 'light'] as const) {
    test(`restart and remove share the muted fill under the sweep, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/admin/sites/${SITE_ID}?section=machines`);
      const restart = page.getByRole('button', { name: `restart ${MACHINE_ID}`, exact: true });
      const remove = page.getByRole('button', { name: `remove ${MACHINE_ID}`, exact: true });
      await expect(remove).toBeVisible();
      const cluster = remove.locator('xpath=..');

      const restartHover = await hovered(restart, 'restart');
      await attachPicture(page, cluster, `row buttons, restart hovered, ${scheme}`);
      const removeHover = await hovered(remove, 'remove');
      expect(removeHover.color, 'remove takes the same fill as restart').toBe(restartHover.color);
      // a glyph, so the 3:1 of a graphic; danger-bright clears 4.5 here anyway
      await expect.poll(() => sweptContrast(remove), { message: 'the red glyph reads on the sweep' }).toBeGreaterThanOrEqual(3);
      await attachPicture(page, cluster, `row buttons, remove hovered, ${scheme}`);
    });
  }
});

// the admin side menu sweeps as every other control does: a row on hover and on
// keyboard focus, with no flat fill under it. the open page keeps its cyan tint
// and does not sweep, since cyan ink on the swept tint misses aa by day
test.describe('admin side menu hover', () => {
  test.use(roleState('superadmin'));

  for (const scheme of ['dark', 'light'] as const) {
    test(`a row sweeps on hover and keyboard focus, the open page does not, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/admin/sites');
      const aside = page.locator('#admin-sidebar');
      const active = aside.getByRole('link', { name: 'sites', exact: true });
      const row = aside.getByRole('link', { name: 'installers', exact: true });
      await expect(active).toHaveAttribute('aria-current', 'page');
      await page.mouse.move(1000, 700);

      const rest = await expectSweepAtRest(row, 'the side menu row');
      await row.hover();
      await expectSweepSize(row, '100% 100%', 'the row sweeps in on hover');
      expect((await sweepState(row)).color, 'no flat fill under the sweep').toBe(rest.color);
      await attachPicture(page, aside, `admin side menu, row hovered, ${scheme}`);

      await page.mouse.move(1000, 700);
      await expectSweepSize(row, '0% 100%', 'the row sweeps out');
      await active.focus();
      await page.keyboard.press('Tab');
      await expect(row).toBeFocused();
      await expectSweepSize(row, '100% 100%', 'the row sweeps in on keyboard focus');

      await active.hover();
      expect((await sweepState(active)).image, 'the open page carries no sweep').toBe('none');
    });
  }
});
