import { test, expect } from '@playwright/test';
import { seedCliDeviceCode } from '../../helpers/coverageSeed';

test.use({ storageState: { cookies: [], origins: [] } });

test('version and OpenAPI endpoints return public contract data', async ({ request }) => {
  const version = await request.get('/api/version');
  expect(version.ok()).toBe(true);
  const versionBody = await version.json();
  expect(versionBody.current).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(Array.isArray(versionBody.supported)).toBe(true);

  const openapi = await request.get('/api/openapi');
  expect(openapi.ok()).toBe(true);
  const spec = await openapi.json();
  expect(spec.openapi).toMatch(/^3\./);
  expect(spec.info.title).toMatch(/owlette/i);
});

test('whoami unauthenticated uses RFC7807 problem+json', async ({ request }) => {
  const response = await request.get('/api/whoami');
  expect(response.status()).toBe(401);
  expect(response.headers()['content-type']).toContain('application/problem+json');
  const body = await response.json();
  expect(body).toMatchObject({
    type: 'https://owlette.app/problems/unauthorized',
    title: 'unauthorized',
    status: 401,
    code: 'unauthorized',
  });
  expect(body.requestId).toEqual(expect.any(String));
});

test('DMCA endpoint validates required complainant email and accepts complete notices', async ({ request }) => {
  const invalid = await request.post('/api/legal/dmca', {
    data: {
      complainant: { name: 'No Email' },
    },
  });
  expect(invalid.status()).toBe(400);
  expect(invalid.headers()['content-type']).toContain('application/problem+json');
  const invalidBody = await invalid.json();
  expect(invalidBody.errors['complainant.email']).toEqual(['required']);

  const valid = await request.post('/api/legal/dmca', {
    data: {
      signature: 'E2E Copyright Owner',
      copyrightedWork: 'E2E copyrighted installation',
      identifiedMaterial: 'https://owlette.test/e2e/material',
      complainant: {
        name: 'E2E Copyright Owner',
        email: 'owner-api@example.test',
        address: '123 E2E Street',
      },
      goodFaithBelief: true,
      accuracyAndPerjuryAttestation: true,
    },
  });
  expect(valid.status()).toBe(202);
  const validBody = await valid.json();
  expect(validBody.acknowledged).toBe(true);
  expect(validBody.elementsComplete).toBe(true);
});

test('unsubscribe API validates missing and invalid tokens', async ({ request }) => {
  const missing = await request.get('/api/unsubscribe');
  expect(missing.status()).toBe(400);
  expect(await missing.json()).toMatchObject({ error: 'Missing token' });

  const invalid = await request.get('/api/unsubscribe?token=not-valid');
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: 'Invalid or expired token' });

  const missingPost = await request.post('/api/unsubscribe', { data: {} });
  expect(missingPost.status()).toBe(400);
  expect(await missingPost.json()).toMatchObject({ error: 'Missing token' });

  const invalidPost = await request.post('/api/unsubscribe', { data: { token: 'not-valid' } });
  expect(invalidPost.status()).toBe(400);
  expect(await invalidPost.json()).toMatchObject({ error: 'Invalid or expired token' });
});

test('CLI device-code API creates, validates, and reports pending polling state', async ({ request }) => {
  const create = await request.post('/api/cli/device-code');
  expect(create.ok()).toBe(true);
  const body = await create.json();
  expect(body.pairPhrase).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  expect(body.deviceCode).toEqual(expect.any(String));
  expect(body.pairingUrl).toContain('/cli/authorize?code=');

  const missing = await request.post('/api/cli/device-code/poll', { data: {} });
  expect(missing.status()).toBe(400);
  expect(await missing.json()).toMatchObject({ error: 'missing required field: deviceCode' });

  const deviceCode = await seedCliDeviceCode('api-contract-code', 'api-contract-device-code');
  const pending = await request.post('/api/cli/device-code/poll', {
    data: { deviceCode },
  });
  expect(pending.status()).toBe(202);
  expect(await pending.json()).toEqual({ status: 'pending' });
});
