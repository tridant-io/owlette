import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertUserHasSiteCapability, requireSession } from '@/lib/apiAuth.server';
import { Capability } from '@/lib/capabilities';
import { normalizePairPhrase } from '@/lib/pairPhrases';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import {
  DEVICE_CODE_WRAP_VERSION,
  encryptDeviceCodeCredentials,
} from '@/lib/deviceCodeCrypto';
import logger from '@/lib/logger';
import {
  ensureAgentAuthUser,
  machineLimitRefusal,
  machineOnSite,
  sanitizeMachineId,
} from '@/lib/pairingPlan.server';

/**
 * POST /api/agent/auth/device-code/authorize
 *
 * User authorizes a device code from the dashboard or /add; mints Firebase tokens and
 * stores them for the agent to poll.
 *
 * Body: `{ pairPhrase: string ("silver-compass-drift"), siteId: string,
 * preview?: true, replaceMachineId?: string, replaceAnyMachine?: true }`
 * - `preview` answers `{ machineId: string | null, existing: boolean }` and changes
 *   nothing, so the page can show which machine it is about to authorize.
 * - `replaceMachineId` names the machine already on the site that this pairing may
 *   reinstall. An interactive code for such a machine needs it; a generated code
 *   stores it, and its deferred mint refuses any other machine already on the site.
 * - `replaceAnyMachine`, for a generated code only, lets its deferred mint pair any
 *   machine already on the site. An admin's deliberate choice, off unless sent, and
 *   not combinable with `replaceMachineId`. It never confirms an interactive code.
 *
 * 200: `{ success: true, machineId: string | null }`
 * 400 bad fields/phrase · 401 unauthenticated · 402 machine limit (the code is marked
 * `refused`, so the agent's poll gets the same message) · 403 no site access · 404
 * unknown or expired phrase · 409 already authorized, or `{ error, code:
 * 'machine_exists', machineId }` when the machine is already on the site and the
 * body does not name it (the code stays pending).
 *
 * Audits `site_mutated` / `machine.pair` once the transaction commits. The siteId is
 * always known here; the machineId is not — a pre-authorized ("generate code") doc
 * binds it later, at poll time, so the row records `deferred: true` and no machineId
 * rather than inventing one. The pairing phrase is a bearer credential and never
 * appears in the audit attributes.
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { pairPhrase: rawPhrase, siteId } = body;
    const preview = body.preview === true;

    if (!rawPhrase || !siteId) {
      return NextResponse.json(
        { error: 'Missing required fields: pairPhrase, siteId' },
        { status: 400 }
      );
    }

    const pairPhrase = normalizePairPhrase(rawPhrase);
    if (!pairPhrase) {
      return NextResponse.json(
        { error: 'Invalid pairing phrase format' },
        { status: 400 }
      );
    }

    const replace = sanitizeMachineId(body.replaceMachineId);
    if (!replace.ok) {
      return NextResponse.json({ error: 'invalid machine name' }, { status: 400 });
    }
    const replaceMachineId = replace.machineId;
    const replaceAnyMachine = body.replaceAnyMachine === true;
    if (replaceAnyMachine && replaceMachineId) {
      return NextResponse.json(
        { error: 'name one machine to reinstall, or allow any, not both' },
        { status: 400 }
      );
    }

    const userId = await requireSession(request);
    // MACHINE_ENROLL, not bare membership: issuing a device-code pairing mints an agent
    // identity plus a refresh token that never expires, and revoking one is
    // site-admin (AGENT_TOKEN_REVOKE). Issue and revoke have to sit at the same
    // bar, or a read-only member can create credentials it cannot take back.
    const { siteData } = await assertUserHasSiteCapability(userId, siteId, Capability.MACHINE_ENROLL);

    // Transactional lookup+authorize, so two concurrent requests can't both read 'pending'
    // and authorize the same device code.
    const adminDb = getAdminDb();
    const docRef = adminDb.collection('device_codes').doc(pairPhrase);

    // the plan check calls tridant, which a transaction must not wait on: read the
    // machine the code names first, check it here, and let the transaction apply it.
    const pending = await docRef.get();
    const pendingData = pending.exists ? pending.data() : undefined;
    const checkedMachineId =
      pendingData?.status === 'pending' && pendingData.preauthorizedIntent !== true
        ? (pendingData.machineId as string | undefined)
        : undefined;
    const refusal = checkedMachineId
      ? await machineLimitRefusal(siteId, checkedMachineId, siteData)
      : null;

    const result = await adminDb.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);

      if (!doc.exists) {
        return { error: 'Pairing phrase not found. It may have expired.', status: 404 } as const;
      }

      const data = doc.data()!;

      const expiresAt = data.expiresAt?.toMillis?.() || data.expiresAt?.getTime?.() || 0;
      if (Date.now() > expiresAt) {
        transaction.delete(docRef);
        return { error: 'Pairing phrase has expired. Please generate a new one on the target machine.', status: 404 } as const;
      }

      if (data.status !== 'pending') {
        return { error: 'This pairing phrase has already been used.', status: 409 } as const;
      }

      if (preview) {
        const machineId = typeof data.machineId === 'string' ? data.machineId : null;
        const existing = machineId ? await machineOnSite(transaction, siteId, machineId) : false;
        return { preview: { machineId, existing } } as const;
      }

      // Pre-authorized (dashboard "generate code") doc: the target hostname is
      // unknown here. Record ONLY the admin-authorized site; the agent token is
      // minted at poll time, bound to the real machineId the agent supplies.
      if (data.preauthorizedIntent === true) {
        transaction.update(docRef, {
          status: 'authorized',
          siteId,
          authorizedBy: userId,
          authorizedAt: FieldValue.serverTimestamp(),
          deferTokenMint: true,
          ...(replaceMachineId ? { replaceMachineId } : {}),
          ...(replaceAnyMachine ? { replaceAnyMachine } : {}),
        });
        return { success: true, machineId: null, deferred: true } as const;
      }

      const supportsEncryption =
        data.wrapVersion === DEVICE_CODE_WRAP_VERSION &&
        typeof data.deviceCode === 'string' &&
        data.deviceCode.length > 0;

      if (!supportsEncryption) {
        return { error: 'Invalid device code state for authorization.', status: 400 } as const;
      }

      const machineId = data.machineId;
      if (!machineId) {
        return { error: 'Invalid device code state for authorization.', status: 400 } as const;
      }

      const existingMachine = await machineOnSite(transaction, siteId, machineId);
      if (existingMachine && replaceMachineId !== machineId) {
        return {
          error: `${machineId} is already on this site. confirm to replace it.`,
          code: 'machine_exists',
          machineId: machineId as string,
          status: 409,
        } as const;
      }

      if (refusal && machineId === checkedMachineId) {
        transaction.update(docRef, { status: 'refused', refusedReason: refusal });
        return { error: refusal, status: 402 } as const;
      }

      // Unique agent user ID (same pattern as the exchange endpoint)
      const agentUid = `agent_${siteId}_${machineId}`.replace(/[^a-zA-Z0-9_]/g, '_');

      const adminAuth = getAdminAuth();
      await ensureAgentAuthUser(adminAuth, agentUid);
      const customToken = await adminAuth.createCustomToken(agentUid, {
        role: 'agent',
        site_id: siteId,
        machine_id: machineId,
        version: data.version || 'unknown',
      });

      // Exchange custom token for ID token via Firebase Auth REST API
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

      // Custom claims must be set before the second token exchange.
      await adminAuth.setCustomUserClaims(agentUid, {
        role: 'agent',
        site_id: siteId,
        machine_id: machineId,
        version: data.version || 'unknown',
      });

      // Re-mint and exchange again so the ID token carries the claims.
      const customTokenWithClaims = await adminAuth.createCustomToken(agentUid, {
        role: 'agent',
        site_id: siteId,
        machine_id: machineId,
        version: data.version || 'unknown',
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
      const finalIdToken = refreshAuthData.idToken;

      const crypto = await import('crypto');
      const refreshToken = crypto.randomBytes(64).toString('base64url');
      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      // Store the refresh token (same schema as the exchange endpoint); writes to other docs
      // inside the transaction are atomic.
      const refreshTokenRef = adminDb.collection('agent_refresh_tokens').doc(refreshTokenHash);
      transaction.set(refreshTokenRef, {
        siteId,
        machineId,
        version: data.version || 'unknown',
        createdBy: userId,
        createdAt: FieldValue.serverTimestamp(),
        lastUsed: FieldValue.serverTimestamp(),
        agentUid,
      });

      const credentialBundle = {
        accessToken: finalIdToken,
        refreshToken,
        expiresIn: 3600,
        siteId,
      };

      const encryptedCredentials = encryptDeviceCodeCredentials(
        credentialBundle,
        data.deviceCode,
        pairPhrase,
      );
      transaction.update(docRef, {
        status: 'authorized',
        siteId,
        authorizedBy: userId,
        authorizedAt: FieldValue.serverTimestamp(),
        encryptedCredentials,
        wrapVersion: DEVICE_CODE_WRAP_VERSION,
        // Wipe deviceCode and legacy plaintext fields so the doc at rest holds no credentials.
        deviceCode: FieldValue.delete(),
        accessToken: FieldValue.delete(),
        refreshToken: FieldValue.delete(),
      });

      logger.info(
        // The phrase stays out of the log line: until it expires it is redeemable
        // for agent credentials, so logging it would hand log readers a live credential.
        `Device code authorized: site=${siteId}, machine=${machineId}, ` +
          `by=${userId}, wrap=${DEVICE_CODE_WRAP_VERSION}`,
      );

      return { success: true, machineId: data.machineId || null, deferred: false, existingMachine } as const;
    });

    if ('error' in result) {
      return NextResponse.json(
        'code' in result
          ? { error: result.error, code: result.code, machineId: result.machineId }
          : { error: result.error },
        { status: result.status }
      );
    }

    if ('preview' in result) {
      return NextResponse.json(result.preview);
    }

    // After the commit, never inside it: the transaction body can be retried, and
    // an emit from a retried-then-discarded attempt would be a phantom row.
    emitMutation({
      kind: 'site_mutated',
      siteId,
      actor: `user:${userId}`,
      targetId: result.machineId ?? siteId,
      attributes: {
        verb: 'machine.pair',
        endpoint: '/api/agent/auth/device-code/authorize',
        method: 'POST',
        siteId,
        // Both absent on the pre-authorized path — the agent supplies the machine at
        // poll time, and the poll's own row records them.
        ...(result.machineId ? { machineId: result.machineId } : {}),
        deferredTokenMint: result.deferred,
        ...('existingMachine' in result ? { existingMachine: result.existingMachine } : {}),
      },
    });

    return NextResponse.json({
      success: true,
      machineId: result.machineId,
    });
  } catch (error: unknown) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return apiError(error, 'agent/auth/device-code/authorize');
  }
}, {
  strategy: 'tokenExchange',
  identifier: 'ip',
});
