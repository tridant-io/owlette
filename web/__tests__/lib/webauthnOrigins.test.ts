/** @jest-environment node */

/** Each deployment accepts a passkey ceremony from its own origin only. */

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: jest.fn() }));

const env = process.env as Record<string, string | undefined>;
const saved = { ...env };

afterEach(() => {
  for (const key of ['NODE_ENV', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN', 'OWLETTE_E2E', 'WEBAUTHN_ORIGINS']) {
    env[key] = saved[key];
    if (saved[key] === undefined) delete env[key];
  }
});

function originsWith(vars: Record<string, string | undefined>): string[] {
  Object.assign(env, vars);
  let origins: string[] = [];
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    origins = require('@/lib/webauthn.server').getExpectedOrigins();
  });
  return origins;
}

describe('getExpectedOrigins', () => {
  it('is owlette.app alone on the production deployment', () => {
    expect(
      originsWith({ NODE_ENV: 'production', NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'owlette-prod-90a12.firebaseapp.com' }),
    ).toEqual(['https://owlette.app']);
  });

  it('is dev.owlette.app alone on the dev deployment', () => {
    expect(
      originsWith({ NODE_ENV: 'production', NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'owlette-dev-3838a.firebaseapp.com' }),
    ).toEqual(['https://dev.owlette.app']);
  });

  it('is localhost in development', () => {
    expect(originsWith({ NODE_ENV: 'development' })).toEqual(['http://localhost:3000']);
  });

  it('still takes the e2e override first', () => {
    expect(
      originsWith({ NODE_ENV: 'production', OWLETTE_E2E: '1', WEBAUTHN_ORIGINS: 'http://127.0.0.1:3100' }),
    ).toEqual(['http://127.0.0.1:3100']);
  });
});
