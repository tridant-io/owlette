/**
 * which second factors a screen may ask for: the ones the account holds that
 * can run where the screen is. every screen that asks for one (/verify-2fa,
 * swoop's step-up and its browser page, account settings) takes its answer
 * from here, so none offers an authenticator code to a passkey-only account,
 * or a passkey to one without, or a passkey prompt where it cannot run
 * (inside owlette swoop, ADR 0012, or an in-app browser).
 *
 * a backup code is not a factor of its own: setup issues a sheet with the first
 * factor of either kind, any factor issues a new one, and the server takes one
 * from any enrolled account. so it is offered beside whatever the account
 * holds, never in its place, and only while one is left. a record from before
 * the count existed has none, reads as unknown, and is offered a code rather
 * than risk leaving no way in; its next try or new sheet writes the count.
 */

// type-only: mfaFactors.server.ts is Admin-SDK code that must never reach the client bundle
import type { MfaFactorInventory } from '@/lib/mfaFactors.server';
import type { InAppBrowserInfo } from '@/lib/inAppBrowser';

export interface SecondFactorChoices {
  /** the 6-digit code from an authenticator app. */
  authenticatorCode: boolean;
  /** a passkey prompt on this page. */
  passkey: boolean;
  /** a backup code. */
  backupCode: boolean;
  /** the account holds a passkey this page cannot prompt for. */
  passkeyElsewhere: boolean;
}

/**
 * what a gate that is already challenging offers when the inventory reads
 * empty: a legacy or unreadable user document on an account the server says is
 * enrolled. every way in, rather than a page with none.
 */
export const ANY_FACTOR: Readonly<MfaFactorInventory> = Object.freeze({ totp: true, passkeys: 1 });

/** whether the account holds a second factor at all; backup codes are recovery material, not one. */
export function holdsSecondFactor(factors: MfaFactorInventory): boolean {
  return factors.totp || factors.passkeys > 0;
}

/** `passkeyPrompt` is `usePasskeyPrompt()`: null until the client has checked, which offers no passkey yet. */
export function secondFactorChoices(
  factors: MfaFactorInventory,
  passkeyPrompt: boolean | null,
): SecondFactorChoices {
  const hasPasskey = factors.passkeys > 0;
  return {
    authenticatorCode: factors.totp,
    passkey: hasPasskey && passkeyPrompt === true,
    backupCode: holdsSecondFactor(factors) && factors.backupCodes !== 0,
    passkeyElsewhere: hasPasskey && passkeyPrompt === false,
  };
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * the inventory off a user document, as the browser reads it. a malformed
 * value reads as no factors rather than satisfying a "has a passkey" check; a
 * backup-code count the record does not have yet is left unknown, not zero.
 */
export function mfaFactorsFromUserDoc(userData: Record<string, unknown>): MfaFactorInventory {
  const raw = userData.mfaFactors;
  if (typeof raw !== 'object' || raw === null) return { totp: false, passkeys: 0 };
  const { totp, passkeys, backupCodes } = raw as Record<string, unknown>;
  return {
    totp: totp === true,
    passkeys: isCount(passkeys) && passkeys > 0 ? passkeys : 0,
    ...(isCount(backupCodes) ? { backupCodes } : {}),
  };
}

/**
 * why a passkey the account holds cannot run here, and the way to use it. its
 * wording follows /setup-2fa's, which says the same of creating one.
 */
export function passkeyElsewhereHint(where: { viewerApp: boolean; inApp: InAppBrowserInfo }): string {
  if (where.viewerApp) {
    return 'passkeys cannot be used inside owlette swoop — sign in with your browser to use yours.';
  }
  if (where.inApp.isInApp) {
    return `passkeys cannot be used inside ${where.inApp.appName ?? 'this app'}'s in-app browser — open owlette in your browser to use yours.`;
  }
  return 'this browser cannot use passkeys — open owlette in another browser to use yours.';
}
