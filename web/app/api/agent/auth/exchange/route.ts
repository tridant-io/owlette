import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import logger from '@/lib/logger';
import { machineLimitRefusal, stampPairedAt } from '@/lib/pairingPlan.server';

/**
 * POST /api/agent/auth/exchange — first step of agent pairing: trade the
 * installer's one-time registration code for tokens.
 *
 * In:  `{registrationCode, machineId, version}`
 * Out: `{accessToken (1h ID token), refreshToken (no expiry, admin-revocable),
 *       expiresIn, siteId}`; 401 on an invalid/used/expired code; 402 `{error}`
 *       when the site's plan has no machine slot (the code is left unused).
 *
 * Rate limited against brute-forcing registration codes.
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { registrationCode, machineId, version } = body;

    if (!registrationCode || !machineId || !version) {
      return NextResponse.json(
        { error: 'Missing required fields: registrationCode, machineId, version' },
        { status: 400 }
      );
    }

    // Two-phase: validate, mint, THEN mark used — so a Firebase Auth outage
    // doesn't burn the code.
    const adminDb = getAdminDb();
    const tokenRef = adminDb.collection('agent_tokens').doc(registrationCode);

    // Phase 1: read-only validation.
    const tokenDoc = await tokenRef.get();

    if (!tokenDoc.exists) {
      return NextResponse.json({ error: 'Invalid registration code' }, { status: 401 });
    }

    const tokenData = tokenDoc.data();

    if (tokenData?.used) {
      return NextResponse.json({ error: 'Registration code already used' }, { status: 401 });
    }

    const now = Date.now();
    const expiresAt = tokenData?.expiresAt?.toMillis();

    if (!expiresAt || expiresAt < now) {
      return NextResponse.json({ error: 'Registration code expired' }, { status: 401 });
    }

    const siteId = tokenData?.siteId as string;
    const createdBy = tokenData?.createdBy as string;

    if (!siteId || !createdBy) {
      return NextResponse.json({ error: 'Invalid registration code data' }, { status: 401 });
    }

    const refusal = await machineLimitRefusal(siteId, machineId);
    if (refusal) {
      return NextResponse.json({ error: refusal }, { status: 402 });
    }

    const agentUid = `agent_${siteId}_${machineId}`.replace(/[^a-zA-Z0-9_]/g, '_');

    const adminAuth = getAdminAuth();
    const customToken = await adminAuth.createCustomToken(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    // Firestore REST needs an ID token, so trade the custom token for one.
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

    // Body unused: the second exchange below returns the token with claims.
    authResponse.body?.cancel();

    // Custom-token claims are NOT persisted to the account, so set them here or
    // future ID tokens fail the Firestore rules.
    await adminAuth.setCustomUserClaims(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    // Claims only appear after a fresh exchange, so mint and trade a new token.
    const customTokenWithClaims = await adminAuth.createCustomToken(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    const refreshAuthResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: customTokenWithClaims, returnSecureToken: true }),
      }
    );

    if (!refreshAuthResponse.ok) {
      const errorData = await refreshAuthResponse.json();
      throw new Error(`Failed to refresh token with claims: ${errorData.error?.message || 'Unknown error'}`);
    }

    const refreshAuthData = await refreshAuthResponse.json();
    const finalIdToken = refreshAuthData.idToken; // carries the custom claims

    const crypto = await import('crypto');
    const refreshToken = crypto.randomBytes(64).toString('base64url');

    // Stored hashed so a DB compromise doesn't yield usable tokens.
    const refreshTokenHash = crypto.createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    // No expiresAt on purpose: installs run for years; revocation is manual.
    await adminDb.collection('agent_refresh_tokens').doc(refreshTokenHash).set({
      siteId,
      machineId,
      version,
      createdBy,
      createdAt: FieldValue.serverTimestamp(),
      lastUsed: FieldValue.serverTimestamp(),
      agentUid,
    });

    // Phase 2: claim the code in a txn — two requests can both clear Phase 1.
    try {
      await adminDb.runTransaction(async (transaction) => {
        const freshDoc = await transaction.get(tokenRef);
        if (freshDoc.data()?.used) {
          throw new Error('Registration code already used');
        }
        transaction.update(tokenRef, {
          used: true,
          usedAt: FieldValue.serverTimestamp(),
          machineId,
          agentUid,
        });
      });
    } catch (txError: unknown) {
      // Lost the race after minting; agent re-pairs with a new code.
      const message = txError instanceof Error ? txError.message : String(txError);
      logger.warn(`Registration code claim race: ${message}`);
      return NextResponse.json({ error: 'Registration code already used' }, { status: 401 });
    }

    await stampPairedAt(siteId, machineId);

    logger.info(`Agent token exchanged: site=${siteId}, machine=${machineId}, uid=${agentUid}`);

    return NextResponse.json(
      {
        accessToken: finalIdToken,
        refreshToken,
        expiresIn: 3600,
        siteId,
      },
      { status: 200 }
    );

  } catch (error: unknown) {
    console.error('Error exchanging registration code:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}, {
  strategy: 'tokenExchange',
  identifier: 'ip',
});
