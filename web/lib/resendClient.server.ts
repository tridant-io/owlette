/**
 * Shared Resend email client and environment constants for server-side use.
 * Import from here instead of re-initializing in each route.
 */

import { Resend } from 'resend';

let resend: Resend | null = null;

export function getResend(): Resend | null {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

export const isProduction =
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

/**
 * Trusted base URL for links that carry an oobCode (password reset, email
 * verification). Deliberately NOT from the Host header: host injection there
 * would carry a valid oobCode to an attacker's domain (account takeover).
 * Server env only.
 */
export function trustedBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app')
  );
}

// Friendly display name shown in recipients' inboxes (the part before the address).
// External-facing, so the product name keeps its normal casing.
const FROM_NAME = 'Owlette';

const RESEND_FROM_ADDRESS = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

// Resend accepts an RFC 5322 "Name <addr>" string. If the configured value already
// carries a display name, respect it verbatim; otherwise prepend the friendly name.
export const FROM_EMAIL = RESEND_FROM_ADDRESS.includes('<')
  ? RESEND_FROM_ADDRESS
  : `${FROM_NAME} <${RESEND_FROM_ADDRESS}>`;
export const ENV_LABEL = isProduction ? 'PRODUCTION' : 'DEVELOPMENT';
