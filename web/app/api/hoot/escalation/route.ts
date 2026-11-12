/**
 * POST /api/hoot/escalation
 *
 * Picks up escalation flags from Firestore cortex-events and sends escalation emails
 * via Resend. Called periodically by cron or triggered by the alert route; GET does the
 * same for cron-style polling.
 *
 * Auth: internal only (CORTEX_INTERNAL_SECRET).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { escalate } from '@/lib/hoot-escalation.server';
import { hootInternalSecret, hootInternalSecretMatches } from '@/lib/hootInternalSecret';
import { cronSecretMatches } from '@/lib/secretMatches.server';

/** Process pending escalations for all sites. */
async function processEscalations(): Promise<{ processed: number; errors: number }> {
  const db = getAdminDb();
  let processed = 0;
  let errors = 0;

  const sitesSnapshot = await db.collection('sites').get();

  for (const siteDoc of sitesSnapshot.docs) {
    const siteId = siteDoc.id;

    try {
      const pendingEvents = await db
        .collection('sites')
        .doc(siteId)
        .collection('cortex-events')
        .where('escalationPending', '==', true)
        .limit(10)
        .get();

      for (const eventDoc of pendingEvents.docs) {
        const data = eventDoc.data();
        try {
          const sent = await escalate(
            siteId,
            eventDoc.id,
            data.machineName || data.machineId || 'Unknown',
            data.processName || 'Unknown',
            data.summary || 'No summary available',
          );

          // Clear the flag regardless of email success
          await eventDoc.ref.update({
            escalationPending: false,
            escalationSent: sent,
            escalationProcessedAt: FieldValue.serverTimestamp(),
          });

          if (sent) {
            processed++;
          }
        } catch (err) {
          console.error(`[hoot/escalation] Failed to process event ${eventDoc.id}:`, err);
          errors++;
        }
      }
    } catch (err) {
      console.error(`[hoot/escalation] Failed to query events for site ${siteId}:`, err);
      errors++;
    }
  }

  return { processed, errors };
}

export async function POST(request: NextRequest) {
  if (!hootInternalSecret()) {
    return NextResponse.json(
      { error: 'Escalation endpoint not configured' },
      { status: 503 },
    );
  }

  if (!hootInternalSecretMatches(request.headers.get('x-cortex-secret'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await processEscalations();
  return NextResponse.json({ success: true, ...result });
}

/** GET for cron-style polling; protected by CRON_SECRET. */
export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: 'Escalation endpoint not configured' },
      { status: 503 },
    );
  }

  if (!cronSecretMatches(request.headers.get('authorization')?.replace('Bearer ', ''))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await processEscalations();
  return NextResponse.json({ success: true, ...result });
}
