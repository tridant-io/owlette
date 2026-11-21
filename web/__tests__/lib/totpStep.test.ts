/** @jest-environment node */

import { authenticator } from 'otplib';
import { totpStep } from '@/lib/totp';

describe('totpStep', () => {
  const secret = authenticator.generateSecret();
  const at = (offsetMs: number) => authenticator.clone({ epoch: Date.now() + offsetMs }).generate(secret);

  it('names the step a code belongs to, within the one-step window either side', () => {
    const now = Math.floor(Date.now() / 30_000);
    const step = totpStep(at(0), secret);
    // a step boundary can fall between generating and checking
    expect([now, now + 1]).toContain(step);
    expect(totpStep(at(-30_000), secret)).toBe(step! - 1);
    expect(totpStep(at(30_000), secret)).toBe(step! + 1);
  });

  it('is null for a wrong code or one outside the window', () => {
    expect(totpStep(at(-120_000), secret)).toBeNull();
    expect(totpStep('not-a-code', secret)).toBeNull();
  });
});
