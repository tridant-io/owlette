/**
 * the one answer every second-factor screen takes: only what the account
 * holds, only where it can run, and a backup code beside any factor.
 */

import {
  holdsSecondFactor,
  mfaFactorsFromUserDoc,
  passkeyElsewhereHint,
  secondFactorChoices,
} from '@/lib/secondFactors';

describe('holdsSecondFactor', () => {
  it.each([
    [{ totp: true, passkeys: 0 }, true],
    [{ totp: false, passkeys: 2 }, true],
    // backup codes are recovery material, not a factor
    [{ totp: false, passkeys: 0, backupCodes: 5 }, false],
    [{ totp: false, passkeys: 0 }, false],
  ])('%j → %s', (factors, holds) => {
    expect(holdsSecondFactor(factors)).toBe(holds);
  });
});

describe('mfaFactorsFromUserDoc', () => {
  it.each([
    [{ mfaFactors: { totp: true, passkeys: 2, backupCodes: 3 } }, { totp: true, passkeys: 2, backupCodes: 3 }],
    // a record from before the count existed: unknown, not zero
    [{ mfaFactors: { totp: false, passkeys: 1 } }, { totp: false, passkeys: 1 }],
    [{ mfaFactors: { totp: true, passkeys: 0, backupCodes: -1 } }, { totp: true, passkeys: 0 }],
    [{ mfaFactors: { totp: true, passkeys: 0, backupCodes: 1.5 } }, { totp: true, passkeys: 0 }],
    // malformed reads as no factors rather than satisfying a "has a passkey" check
    [{ mfaFactors: { totp: 'yes', passkeys: '2' } }, { totp: false, passkeys: 0 }],
    [{}, { totp: false, passkeys: 0 }],
  ])('%j reads as %j', (doc, expected) => {
    expect(mfaFactorsFromUserDoc(doc)).toEqual(expected);
  });
});

describe('secondFactorChoices', () => {
  it.each([
    // factors, passkey prompt here, expected
    [{ totp: true, passkeys: 0 }, true, { authenticatorCode: true, passkey: false, backupCode: true, passkeyElsewhere: false }],
    [{ totp: false, passkeys: 1 }, true, { authenticatorCode: false, passkey: true, backupCode: true, passkeyElsewhere: false }],
    [{ totp: true, passkeys: 2 }, true, { authenticatorCode: true, passkey: true, backupCode: true, passkeyElsewhere: false }],
    [{ totp: false, passkeys: 1 }, false, { authenticatorCode: false, passkey: false, backupCode: true, passkeyElsewhere: true }],
    [{ totp: true, passkeys: 1 }, false, { authenticatorCode: true, passkey: false, backupCode: true, passkeyElsewhere: true }],
    // not checked yet: no passkey offered, and none said to be elsewhere
    [{ totp: false, passkeys: 1 }, null, { authenticatorCode: false, passkey: false, backupCode: true, passkeyElsewhere: false }],
    [{ totp: false, passkeys: 0 }, true, { authenticatorCode: false, passkey: false, backupCode: false, passkeyElsewhere: false }],
    // a backup code only while the account has one left; a record with no count yet offers it
    [{ totp: false, passkeys: 1, backupCodes: 0 }, true, { authenticatorCode: false, passkey: true, backupCode: false, passkeyElsewhere: false }],
    [{ totp: true, passkeys: 0, backupCodes: 0 }, true, { authenticatorCode: true, passkey: false, backupCode: false, passkeyElsewhere: false }],
    [{ totp: false, passkeys: 1, backupCodes: 4 }, false, { authenticatorCode: false, passkey: false, backupCode: true, passkeyElsewhere: true }],
  ])('%j with a prompt of %s', (factors, prompt, expected) => {
    expect(secondFactorChoices(factors, prompt)).toEqual(expected);
  });
});

describe('passkeyElsewhereHint', () => {
  it('inside owlette swoop, says to sign in with the browser', () => {
    expect(passkeyElsewhereHint({ viewerApp: true, inApp: { isInApp: false } })).toBe(
      'passkeys cannot be used inside owlette swoop — sign in with your browser to use yours.',
    );
  });

  it("inside another app's browser, names the app and says to open owlette in the browser", () => {
    expect(passkeyElsewhereHint({ viewerApp: false, inApp: { isInApp: true, appName: 'LinkedIn' } })).toBe(
      "passkeys cannot be used inside LinkedIn's in-app browser — open owlette in your browser to use yours.",
    );
  });

  it('in a browser with no passkey support, says to use another', () => {
    expect(passkeyElsewhereHint({ viewerApp: false, inApp: { isInApp: false } })).toBe(
      'this browser cannot use passkeys — open owlette in another browser to use yours.',
    );
  });
});
