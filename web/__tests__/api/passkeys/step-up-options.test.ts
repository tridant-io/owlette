/** @jest-environment node */

/**
 * `/api/passkeys/step-up/options`: the second-factor ceremony at sign-in and
 * before a swoop control session.
 *
 * The request names this account's own credentials and nothing about how to
 * reach them. Chrome on Android routes the ceremony by the stored transports:
 * a passkey saved through 1Password's desktop extension came back with hints
 * that do not say "this device", so the phone offered only another device,
 * usb or nfc, and never asked 1Password — while the same passkey worked on the
 * desktop, where the extension answers the page itself.
 */

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiAuthError,
    requireSession: async () => 'uid-1',
    assertActiveUser: async () => undefined,
  };
});

jest.mock('@/lib/webauthn.server', () => ({
  getRpId: () => 'owlette.app',
  getUserPasskeys: async () => [
    { credentialId: 'cred-1password', transports: ['hybrid'] },
    { credentialId: 'cred-windows', transports: ['internal'] },
  ],
  storeChallenge: async () => undefined,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/passkeys/step-up/options/route';

describe('POST /api/passkeys/step-up/options', () => {
  it("names this account's passkeys and leaves how to reach them to the device", async () => {
    const res = await POST(new NextRequest('http://localhost/api/passkeys/step-up/options', { method: 'POST' }));
    expect(res.status).toBe(200);
    const { options } = (await res.json()) as {
      options: { allowCredentials: Array<{ id: string; transports?: string[] }>; userVerification: string };
    };

    expect(options.allowCredentials.map((c) => c.id)).toEqual(['cred-1password', 'cred-windows']);
    for (const credential of options.allowCredentials) {
      expect(credential.transports).toBeUndefined();
    }
    expect(options.userVerification).toBe('required');
  });
});
