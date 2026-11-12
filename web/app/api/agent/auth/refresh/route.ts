/**
 * Refresh-token rotation is gated on `X-Owlette-Agent-Version` because agents
 * < 2.12.0 discard the rotated token and would lose auth ~5 min later, when the
 * supersession grace expires.
 *   2.12.0+            → rotate; response carries refreshToken
 *   older / malformed  → legacy: bump lastUsed only, no refreshToken in the
 *                        response (fail-safe: assume old agent)
 * Superseded docs stay readable for a 5-minute grace so 2.12.0+ clients can
 * retry a lost response without losing their session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { isTokenDead, isTokenSuperseded, tokenTimestampToMillis } from '@/lib/agentTokens';
import logger from '@/lib/logger';

const REFRESH_TOKEN_GRACE_MS = 5 * 60 * 1000;

/**
 * A live token this much older than now, on a machine that just refreshed, is
 * not held by anyone: every holder refreshes about hourly.
 */
const STALE_TOKEN_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_STALE_DELETES = 400;

let rotationKeyCache: Buffer | null = null;
let rotationKeyWarned = false;

/**
 * Subkey for deriving rotation successors, so the mfa key itself never keys a
 * second algorithm. null (random successors) when the mfa key is not set.
 */
function getRotationKey(crypto: typeof import('crypto')): Buffer | null {
  if (rotationKeyCache) return rotationKeyCache;
  const secret = process.env.MFA_ENCRYPTION_KEY;
  if (!secret) {
    if (!rotationKeyWarned) {
      rotationKeyWarned = true;
      logger.warn('MFA_ENCRYPTION_KEY is not set: refresh token rotation cannot derive its successors');
    }
    return null;
  }
  rotationKeyCache = Buffer.from(
    crypto.hkdfSync('sha256', secret, '', 'owlette agent refresh rotation', 32),
  );
  return rotationKeyCache;
}

const AGENT_VERSION_FORMAT = /^\d+(\.\d+){1,3}([-+][\w.-]+)?$/;

/** Minimum agent version that knows how to persist a rotated refresh token. */
const ROTATION_MIN_MAJOR = 2;
const ROTATION_MIN_MINOR = 12;

function timestampToMillis(value: unknown): number | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'number') {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'object' && 'toMillis' in value) {
    const maybeTimestamp = value as { toMillis?: () => number };
    if (typeof maybeTimestamp.toMillis === 'function') {
      return maybeTimestamp.toMillis();
    }
  }

  return undefined;
}

/**
 * Dotted-numeric semver prefix → [major, minor, patch]; suffixes like "-rc.1"
 * or "+build.123" are stripped. null when missing/malformed (callers treat that
 * as an old agent — fail-safe to no rotation).
 */
export function parseAgentVersion(
  version: string | null | undefined,
): [number, number, number] | null {
  if (!version || typeof version !== 'string') return null;
  const stripped = version.split(/[-+]/)[0];
  // Segments must be pure digits: Number.parseInt('0junk', 10) === 0 would let
  // '2.12.0junk' parse as [2,12,0] and enable rotation on an unsupported agent.
  const parts = stripped
    .split('.')
    .map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : NaN));
  if (parts.length < 2 || parts.length > 4) return null;
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return [parts[0], parts[1], parts[2] ?? 0];
}

/** Rotation gate for the supplied agent-version header; see file docstring. */
export function shouldRotateRefreshToken(
  agentVersion: string | null | undefined,
): boolean {
  const parsed = parseAgentVersion(agentVersion);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return (
    major > ROTATION_MIN_MAJOR ||
    (major === ROTATION_MIN_MAJOR && minor >= ROTATION_MIN_MINOR)
  );
}

/**
 * POST /api/agent/auth/refresh — exchange a refresh token for a fresh access
 * token (custom tokens expire after 1 hour).
 *
 * Body: { refreshToken, machineId }. Header `X-Owlette-Agent-Version` gates
 * rotation (see file docstring).
 * 200: { accessToken, expiresIn: 3600, refreshToken? (>= 2.12.0 only) }
 * 400 missing fields | 401 invalid/expired | 403 machineId mismatch |
 * 429 rate limited (20/hr/IP) | 500 server error.
 *
 * Tokens without `expiresAt` never expire — deliberate, for long-lived installs.
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { refreshToken, machineId } = body;

    if (!refreshToken || !machineId) {
      return NextResponse.json(
        { error: 'Missing required fields: refreshToken, machineId' },
        { status: 400 }
      );
    }

    // Old agents (< 2.12.0) don't persist a rotated token and would die ~5 min
    // after their first refresh, so they stay on the legacy path until they
    // auto-update.
    const agentVersionHeader = request.headers.get('x-owlette-agent-version');
    const willRotate = shouldRotateRefreshToken(agentVersionHeader);

    // Tokens are stored hashed.
    const crypto = await import('crypto');
    const refreshTokenHash = crypto.createHash('sha256')
      .update(refreshToken)
      .digest('hex');
    // Pre-generated even when unused: keeps the transaction's critical section
    // branch-free, and the crypto cost is negligible. Derived from the
    // presented token, so a repeat of it yields the same successor and a
    // machine never ends up with two. Random when the key is not configured.
    const rotationKey = getRotationKey(crypto);
    const newRefreshToken = rotationKey
      ? crypto.createHmac('sha512', rotationKey)
          .update(`agent-refresh-rotation:${refreshToken}`)
          .digest('base64url')
      : crypto.randomBytes(64).toString('base64url');
    const newRefreshTokenHash = crypto.createHash('sha256')
      .update(newRefreshToken)
      .digest('hex');

    // Validate and (when willRotate) rotate atomically — concurrent refreshes
    // must not produce inconsistent state.
    const adminDb = getAdminDb();
    const tokenRef = adminDb.collection('agent_refresh_tokens').doc(refreshTokenHash);
    const newTokenRef = adminDb.collection('agent_refresh_tokens').doc(newRefreshTokenHash);

    let siteId: string;
    let version: string;
    let agentUid: string;

    try {
      const result = await adminDb.runTransaction(async (transaction) => {
        const tokenDoc = await transaction.get(tokenRef);

        if (!tokenDoc.exists) {
          return { error: 'Invalid refresh token', status: 401 } as const;
        }

        const tokenData = tokenDoc.data();
        const now = Date.now();

        // Firestore requires ALL reads before ANY write in a transaction, so
        // read the rotation docs up front. `predecessorHash` is the back-pointer
        // written when THIS token was minted — the GC candidate.
        const predecessorHash = tokenData?.predecessorHash;
        const gcCandidateRef =
          willRotate &&
          typeof predecessorHash === 'string' &&
          predecessorHash.length > 0 &&
          predecessorHash !== refreshTokenHash &&
          predecessorHash !== newRefreshTokenHash
            ? adminDb.collection('agent_refresh_tokens').doc(predecessorHash)
            : null;
        // Only read the new-token slot when rotating.
        const newTokenDoc = willRotate ? await transaction.get(newTokenRef) : null;
        const gcCandidateDoc = gcCandidateRef ? await transaction.get(gcCandidateRef) : null;

        const alreadyRotated = Boolean(
          newTokenDoc?.exists && tokenData?.supersededBy === newRefreshTokenHash,
        );
        if (newTokenDoc && newTokenDoc.exists && !alreadyRotated) {
          throw new Error('Refresh token hash collision');
        }

        // No expiresAt → never expires (long-duration installs).
        const expiresAt = timestampToMillis(tokenData?.expiresAt);

        if (expiresAt && expiresAt < now) {
          transaction.delete(tokenRef);
          return { error: 'Refresh token expired. Please re-authenticate.', status: 401 } as const;
        }

        const retiresAt = timestampToMillis(tokenData?.retiresAt);
        const isSuperseded = isTokenSuperseded(tokenData);
        if (isSuperseded && (!retiresAt || now >= retiresAt)) {
          return { error: 'Invalid refresh token', status: 401 } as const;
        }

        // Machine-ID check: a stolen token is useless on another machine.
        if (tokenData?.machineId !== machineId) {
          console.warn(
            `Machine ID mismatch for refresh token: ` +
            `expected=${tokenData?.machineId}, got=${machineId}`
          );
          return { error: 'Machine ID mismatch. Token may be compromised.', status: 403 } as const;
        }

        const txSiteId = tokenData?.siteId as string;
        const storedVersion = tokenData?.version as string;
        const txAgentUid = tokenData?.agentUid as string;
        const txCreatedBy = tokenData?.createdBy as string;

        if (!txSiteId || !storedVersion || !txAgentUid || !txCreatedBy) {
          return { error: 'Invalid refresh token data', status: 401 } as const;
        }

        // the token carries the version it was minted with; the header is newer
        const txVersion =
          agentVersionHeader && AGENT_VERSION_FORMAT.test(agentVersionHeader) && agentVersionHeader.length <= 40
            ? agentVersionHeader
            : storedVersion;

        if (willRotate && alreadyRotated) {
          // the same token again: its successor already exists, hand it back
        } else if (willRotate) {
          const sameMachine = await transaction.get(
            adminDb.collection('agent_refresh_tokens')
              .where('siteId', '==', txSiteId)
              .where('machineId', '==', machineId),
          );

          if (!isSuperseded) {
            transaction.update(tokenRef, {
              supersededAt: FieldValue.serverTimestamp(),
              supersededBy: newRefreshTokenHash,
              retiresAt: Timestamp.fromMillis(now + REFRESH_TOKEN_GRACE_MS),
            });
          }

          transaction.set(newTokenRef, {
            siteId: txSiteId,
            machineId,
            version: txVersion,
            createdBy: txCreatedBy,
            createdAt: FieldValue.serverTimestamp(),
            lastUsed: FieldValue.serverTimestamp(),
            agentUid: txAgentUid,
            // Back-pointer for the NEXT rotation's GC, bounding the collection
            // to ~2 docs per machine instead of leaking one per hourly refresh.
            predecessorHash: refreshTokenHash,
          });

          // GC the predecessor, but ONLY if provably dead. Rotation cadence is
          // NOT assumed: agent restarts, or service + GUI sharing one
          // credential, can rotate twice inside the grace window. Reusing
          // isTokenDead (same predicate as the admin prune) guarantees we never
          // delete a token an agent could still present — that would 401 it into
          // wiping its local credentials. Idempotent if already gone.
          if (gcCandidateDoc && gcCandidateDoc.exists && isTokenDead(gcCandidateDoc.data(), now)) {
            transaction.delete(gcCandidateDoc.ref);
          }

          // keep one current token per machine: clear live ones nobody holds
          let removed = 0;
          for (const doc of sameMachine.docs) {
            if (removed >= MAX_STALE_DELETES) break;
            if (doc.ref.id === refreshTokenHash || doc.ref.id === newRefreshTokenHash) continue;
            const data = doc.data();
            const createdAt = tokenTimestampToMillis(data.createdAt);
            if (isTokenSuperseded(data) || createdAt === undefined || createdAt > now - STALE_TOKEN_AGE_MS) continue;
            transaction.delete(doc.ref);
            removed++;
          }
        } else {
          // Legacy agent: keep the same token alive, no supersession.
          transaction.update(tokenRef, {
            lastUsed: FieldValue.serverTimestamp(),
          });
        }

        return { siteId: txSiteId, version: txVersion, agentUid: txAgentUid } as const;
      });

      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }

      siteId = result.siteId;
      version = result.version;
      agentUid = result.agentUid;
    } catch (txError: unknown) {
      const message = txError instanceof Error ? txError.message : String(txError);
      logger.warn(`Refresh token transaction failed: ${message}`);
      return NextResponse.json(
        { error: 'Token refresh failed. Please try again.' },
        { status: 500 }
      );
    }

    // Outside the transaction — idempotent.
    const adminAuth = getAdminAuth();

    // Re-set claims each refresh so they survive on the user account.
    await adminAuth.setCustomUserClaims(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    const customToken = await adminAuth.createCustomToken(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    // Firestore REST needs an ID token, so exchange the custom token for one.
    const firebaseApiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    if (!firebaseApiKey) {
      throw new Error('Firebase API key not configured');
    }

    const authResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      }
    );

    if (!authResponse.ok) {
      const errorData = await authResponse.json();
      throw new Error(`Failed to exchange custom token: ${errorData.error?.message || 'Unknown error'}`);
    }

    const authData = await authResponse.json();
    const idToken = authData.idToken;

    logger.info(
      `Token refreshed: site=${siteId}, machine=${machineId}, ` +
        `rotated=${willRotate}, agentVersion=${agentVersionHeader ?? 'unknown'}`,
    );

    return NextResponse.json(
      {
        accessToken: idToken,
        expiresIn: 3600, // 1 hour in seconds
        // Only >= 2.12.0 agents persist it; legacy keeps its original token.
        ...(willRotate ? { refreshToken: newRefreshToken } : {}),
      },
      { status: 200 }
    );

  } catch (error: unknown) {
    console.error('Error refreshing token:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}, {
  strategy: 'tokenRefresh',
  identifier: 'ip',
});
