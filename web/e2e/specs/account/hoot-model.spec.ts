/**
 * Account — hoot's model can change without the api key being typed again.
 *
 * The key is stored encrypted at `users/{uid}/settings/llm` and the model is a
 * separate field on the same doc: "save model" writes the model alone (PATCH
 * /api/settings/llm-key) and leaves the key exactly as it was. The seeded key is
 * not a real one, so the model list is the built-in fallback.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';

test.use(roleState('member'));

const MEMBER = TEST_USERS.member;
const llmDoc = () => getAdminDb().collection('users').doc(MEMBER.uid).collection('settings').doc('llm');
const STORED_KEY = 'e2e-ciphertext-not-a-key';

test.beforeEach(async () => {
  await llmDoc().set({ provider: 'anthropic', apiKeyEncrypted: STORED_KEY, model: 'claude-sonnet-5' });
});

test.afterEach(async () => {
  await llmDoc().delete();
});

test('a stored key keeps working when only the model changes', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await page.getByRole('button', { name: /^hoot$/i }).first().click();

  // nothing changed yet, and no key typed: nothing to save
  const save = page.getByRole('button', { name: /^save model$/i });
  await expect(save).toBeDisabled();

  await page.locator('#llmModel').click();
  await page.getByRole('option', { name: 'Claude Haiku 4.5' }).click();
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page.getByText('Model saved', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();

  const stored = (await llmDoc().get()).data();
  expect(stored?.model).toBe('claude-haiku-4-5');
  expect(stored?.apiKeyEncrypted).toBe(STORED_KEY);
  expect(stored?.provider).toBe('anthropic');
});
