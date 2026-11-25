// run with `npm run test:scripts` (node's own test runner; no jest here, the
// script is plain esm outside the web workspace).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vercelAddArgs } from '../sync-env.mjs';

test('a value travels on stdin: the command line carries no value at all', () => {
  assert.deepEqual(vercelAddArgs('API_KEY', 'owk_secret', true, 'production'), [
    'env', 'add', 'API_KEY', 'production', '--force', '--sensitive',
  ]);
});

test('an empty value goes as an explicit quoted --value, or vercel refuses it', () => {
  assert.deepEqual(vercelAddArgs('SWOOP_JWT_KID_PREVIOUS', '', false, 'production'), [
    'env', 'add', 'SWOOP_JWT_KID_PREVIOUS', 'production', '--force', '--no-sensitive', '--value', '""',
  ]);
});

test('sensitivity is the manifest class, not the value', () => {
  assert.ok(vercelAddArgs('K', '', true, 'production').includes('--sensitive'));
  assert.ok(vercelAddArgs('K', 'v', false, 'production').includes('--no-sensitive'));
});
