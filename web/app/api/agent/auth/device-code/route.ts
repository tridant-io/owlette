import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { generatePairPhrase } from '@/lib/pairPhrases';
import { apiError } from '@/lib/apiErrorResponse';
import { publicOrigin } from '@/lib/publicOrigin.server';
import { DEVICE_CODE_WRAP_VERSION } from '@/lib/deviceCodeCrypto';
import { getSessionFromRequest } from '@/lib/sessionManager.server';
import { sanitizeMachineId } from '@/lib/pairingPlan.server';
import logger from '@/lib/logger';

/**
 * POST /api/agent/auth/device-code — mint a pairing phrase + device code for
 * agent registration; the agent shows the phrase and polls for authorization.
 *
 * Body: `{ machineId?, version? }` (both optional for pre-authorized codes).
 * `machineId` is stored trimmed; one that cannot be a machine doc id is 400.
 * Returns `pairPhrase` (3 words), `deviceCode` (opaque, 64 bytes base64url),
 * `verificationUri`, `pairingUrl` (phrase pre-filled), `expiresIn` (600s) and
 * `interval` (min poll seconds).
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { version } = body;

    const machine = sanitizeMachineId(body.machineId);
    if (!machine.ok) {
      return NextResponse.json({ error: 'Invalid machineId' }, { status: 400 });
    }
    const { machineId } = machine;

    // Retry on phrase collision.
    const adminDb = getAdminDb();
    let pairPhrase: string;
    let attempts = 0;

    do {
      pairPhrase = generatePairPhrase();
      const existing = await adminDb.collection('device_codes').doc(pairPhrase).get();
      if (!existing.exists) break;
      attempts++;
    } while (attempts < 5);

    if (attempts >= 5) {
      return NextResponse.json(
        { error: 'Failed to generate unique pairing phrase. Please try again.' },
        { status: 500 }
      );
    }

    // Opaque polling secret — never shown to the user.
    const crypto = await import('crypto');
    const deviceCode = crypto.randomBytes(64).toString('base64url');
    const deviceCodeHash = crypto.createHash('sha256').update(deviceCode).digest('hex');

    // An authenticated session means the dashboard "Generate Code" path, where
    // the browser discards the deviceCode right after authorize. Anonymous
    // callers are installers, which hold it in memory and can be sent an
    // encrypted credential blob.
    let isDashboardOrigin = false;
    try {
      const session = await getSessionFromRequest(request);
      if (session.userId && session.expiresAt && Date.now() < session.expiresAt) {
        isDashboardOrigin = true;
      }
    } catch {
      // No session = anonymous installer call; treat as interactive.
      isDashboardOrigin = false;
    }

    const baseUrl = publicOrigin(request);

    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)); // 10 minutes

    // The stored `deviceCode` is the polling secret, not a credential: persisted
    // only so authorize can derive the HKDF key without the dashboard user ever
    // holding it, and wiped by the authorize transaction as soon as it encrypts
    // the bundle. Pre-authorised codes deliberately do NOT persist it (nothing
    // can send it back), so authorize falls through to the plaintext path — and
    // /poll allows phrase-based redemption only for those documents.
    const docPayload: Record<string, unknown> = {
      deviceCodeHash,
      wrapVersion: DEVICE_CODE_WRAP_VERSION,
      machineId: machineId || null,
      version: version || null,
      status: 'pending', // pending → authorized → (deleted on poll or expiry)
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      // Populated by authorize:
      siteId: null,
      authorizedBy: null,
      authorizedAt: null,
      // Encrypted bundle (HKDF-AES-256-GCM, lib/deviceCodeCrypto.ts); set by
      // authorize for the interactive flow, null for pre-authorised codes.
      encryptedCredentials: null,
      // Legacy plaintext fields, only for the pre-authorised silent-install flow
      // where no client holds the HKDF key.
      accessToken: null,
      refreshToken: null,
    };

    if (isDashboardOrigin) {
      docPayload.preauthorizedIntent = true;
    } else {
      // Interactive flow only — wiped once authorize encrypts the bundle.
      docPayload.deviceCode = deviceCode;
    }

    await adminDb.collection('device_codes').doc(pairPhrase).set(docPayload);

    // the phrase stays out, as in authorize: until it expires it can still be authorized.
    logger.info(`Device code created: machine=${machineId || 'pre-auth'}`);

    return NextResponse.json({
      pairPhrase,
      deviceCode,
      verificationUri: `${baseUrl}/add`,
      pairingUrl: `${baseUrl}/add?code=${encodeURIComponent(pairPhrase)}`,
      expiresIn: 600, // 10 minutes
      interval: 5, // poll every 5 seconds
    });
  } catch (error: unknown) {
    return apiError(error, 'agent/auth/device-code');
  }
}, {
  strategy: 'tokenExchange',
  identifier: 'ip',
});
