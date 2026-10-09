/**
 * POST /api/users/bootstrap — server-mediated, audit-logged creation of
 * `users/{uid}` on first sign-in, replacing the client-side setDoc in
 * `web/contexts/AuthContext.tsx`.
 *
 * NOT `authorizedPlatformHandler`: it demands `actor.role === 'superadmin'`, and a
 * user with no firestore doc narrows to 'member', so no new user could ever
 * bootstrap. No capability fits either — the target is the caller's own
 * nonexistent record. Uses `requireSessionOrIdToken` directly, like
 * `/api/webhooks/user-created`.
 *
 * Idempotent: a second call returns `alreadyExists: true` — including one that
 * carries no Turnstile token, because the challenge gates creation of the doc,
 * not the endpoint (see `onWillCreate` below).
 *
 * Body is `{ displayName?, timezone? }`. uid comes from the bearer/session and
 * email from `getUser(uid).email` — NEVER the body, so a caller can neither
 * bootstrap someone else nor persist a falsified email (issue #22).
 *
 * Creating the doc for an unverified password account also sends the email
 * verification link. A failed send never fails the bootstrap: the banner's
 * resend (`/api/auth/verify-email`) is the way back.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAdminAuth } from '@/lib/firebase-admin';
import {
  ApiAuthError,
  requireSessionOrIdToken,
} from '@/lib/apiAuth.server';
import type { UserRecord } from 'firebase-admin/auth';
import {
  problemForbidden,
  problemFromError,
  problemUnauthorized,
  problemValidation,
} from '@/lib/apiErrors';
import { TURNSTILE_TOKEN_FIELD, verifyTurnstileToken } from '@/lib/turnstile.server';
import { withIdempotency } from '@/lib/idempotency';
import { withRateLimit } from '@/lib/withRateLimit';
import { bootstrapUser } from '@/lib/actions/bootstrapUser.server';
import { isDisposableEmailDomain } from '@/lib/disposableEmailDomains';
import { needsEmailVerification, sendVerificationEmail } from '@/lib/emailVerification.server';
import { readAndParseJsonBody } from '../../_shared';

interface BootstrapBody {
  // No `email`: the authoritative address comes from the Firebase Auth record
  // (issue #22). A body-supplied one is ignored.
  displayName?: unknown;
  timezone?: unknown;
  /** Turnstile token from the register form; absent on the listener path. */
  [TURNSTILE_TOKEN_FIELD]?: unknown;
}

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_DISPLAY_NAME = 200;

async function handleBootstrap(request: NextRequest): Promise<NextResponse> {
  try {
    let userId: string;
    try {
      userId = await requireSessionOrIdToken(request);
    } catch (err) {
      if (err instanceof ApiAuthError) return problemUnauthorized(err.message);
      throw err;
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      { userId, environment: 'unknown' },
      parsed.raw,
      async () => {
        const body = parsed.body as BootstrapBody;

        // bootstrapUser writes via the Admin SDK, which bypasses the
        // `email == request.auth.token.email` pin in firestore.rules — so a
        // body-supplied email could be wholly falsified (issue #22).
        let userRecord: UserRecord;
        try {
          userRecord = await getAdminAuth().getUser(userId);
        } catch (err) {
          return problemFromError(err, 'users/bootstrap:getUser');
        }
        const verifiedEmail = userRecord.email?.trim();

        // Bot gate for self-serve email signup, keyed off the VERIFIED auth
        // record's providers — never the body. The register form carries a
        // Turnstile token; the AuthContext listener path cannot (it covers Google
        // sign-in and retry after a failed bootstrap), so federated identities
        // skip the challenge and rely on the provider's own gate.
        // Inverted to FAIL CLOSED: only a positively federated-only record skips;
        // empty or absent providerData still gets challenged.
        const providers = userRecord.providerData ?? [];
        const federatedOnly =
          providers.length > 0 &&
          providers.every(provider => provider.providerId !== 'password');

        if (!verifiedEmail || !EMAIL_REGEX.test(verifiedEmail)) {
          return problemValidation(
            'no verified email is associated with this account',
            { email: ['account has no usable verified email address'] },
          );
        }
        if (isDisposableEmailDomain(verifiedEmail)) {
          return problemValidation(
            'email address uses a disallowed disposable domain',
            { email: ['disposable email domains are not permitted'] },
          );
        }
        if (
          body.displayName !== undefined &&
          (typeof body.displayName !== 'string' ||
            body.displayName.length > MAX_DISPLAY_NAME)
        ) {
          return problemValidation('displayName must be a string ≤200 chars', {
            'body.displayName': [`must be a string of ≤${MAX_DISPLAY_NAME} chars`],
          });
        }
        if (
          body.timezone !== undefined &&
          (typeof body.timezone !== 'string' || body.timezone.length > 100)
        ) {
          return problemValidation(
            'timezone must be a string IANA zone id',
            { 'body.timezone': ['must be a string IANA tz id'] },
          );
        }

        const result = await bootstrapUser(
          {
            auditActor: `user:${userId}`,
            endpoint: '/api/users/bootstrap',
            method: 'POST',
          },
          {
            uid: userId,
            email: verifiedEmail,
            displayName:
              typeof body.displayName === 'string' ? body.displayName : '',
            timezone:
              typeof body.timezone === 'string' ? body.timezone : undefined,
            // The challenge gates CREATION, not calls: it runs inside
            // bootstrapUser only when `users/{uid}` is absent. Gating the call
            // instead 403'd the listener's tokenless retry forever, so an
            // account whose first bootstrap failed had no way back (audit item 9).
            onWillCreate: federatedOnly
              ? undefined
              : () =>
                  verifyTurnstileToken(
                    request,
                    body[TURNSTILE_TOKEN_FIELD],
                    'register'
                  ),
          },
        );

        if (result.kind === 'create_denied') {
          console.warn('[users/bootstrap] turnstile rejected:', result.reason);
          return problemForbidden('challenge verification failed');
        }

        if (result.kind === 'already_exists') {
          return NextResponse.json({
            uid: userId,
            alreadyExists: true,
            createdAt: result.createdAt,
          });
        }

        if (needsEmailVerification(userRecord)) {
          try {
            await sendVerificationEmail(verifiedEmail);
          } catch (err) {
            console.error('[users/bootstrap] verification email not sent:', err);
          }
        }

        return NextResponse.json({
          uid: result.uid,
          alreadyExists: false,
          email: result.email,
          displayName: result.displayName,
          timezone: result.timezone,
          createdAt: result.createdAt,
        });
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/bootstrap:POST');
  }
}

/**
 * Per-IP signup limit (10/hr prod, 100/hr dev). Caps creation of the Firestore
 * `users/{uid}` doc only — the upstream Firebase Auth account is App Check /
 * blocking functions' problem. Honors `E2E_DISABLE_RATE_LIMIT`.
 */
export const POST = withRateLimit(handleBootstrap, {
  strategy: 'signup',
  identifier: 'ip',
});
