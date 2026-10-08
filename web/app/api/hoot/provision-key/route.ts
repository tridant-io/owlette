/**
 * POST /api/hoot/provision-key — provision the LLM API key to a machine's local Hoot.
 * Writes a Firestore command the service picks up, encrypts with SecureStorage (Fernet)
 * and stores in config.json.
 *
 * Body: `{ siteId, machineId, apiKey (raw LLM key), provider: 'anthropic' | 'openai' }`.
 * Auth: MACHINE_EXEC_COMMAND on the site — the same bar the first-party command
 * route holds, because this IS a command dispatch. It previously required only site
 * ACCESS, and after the per-site-roles migration `member` means read-only, so a
 * read-only member could queue a command making any machine on the site overwrite
 * its stored LLM credential. `firestore.rules` reserves `commands/pending` to the
 * service account and the machine's own agent, so this route is the boundary.
 *
 * Audits `site_mutated` / `llm_key.provision` (machine-targeted, matching
 * `machine.remove` / `agent_token.revoke`) the moment the command is queued —
 * that write is the mutation, whatever the subsequent poll returns. The key is
 * never recorded; only the provider and the command id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyUserSiteAccess } from '@/lib/hoot-utils.server';
import { Capability, hasCapability, type Actor } from '@/lib/capabilities';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import { requireEntitlement } from '@/lib/plan.server';
import { getUserIdFromSession, withRateLimit } from '@/lib/withRateLimit';

const COMMAND_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * The agent writes a NON-terminal `running` marker to the completed doc at the START of
 * every command (restart safety), plus progress states. Only these whitelisted statuses
 * resolve the command — treating `running` as terminal destroys restart safety and
 * returns success while provisioning is still in flight.
 */
const TERMINAL_COMMAND_STATUSES = new Set([
  'completed',
  'failed',
  'error',
  'cancelled',
]);

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requireSession(request);
    const body = await request.json();

    const { siteId, machineId, apiKey, provider } = body as {
      siteId: string;
      machineId: string;
      apiKey: string;
      provider: string;
    };

    if (!siteId || !machineId || !apiKey) {
      return NextResponse.json(
        { error: 'siteId, machineId, and apiKey are required' },
        { status: 400 },
      );
    }

    const db = getAdminDb();

    const access = await verifyUserSiteAccess(db, userId, siteId);
    const actor: Actor = {
      type: 'user',
      userId,
      role: access.role === 'superadmin' || access.role === 'admin' ? access.role : 'member',
      // Per-site standing decides; the global role beside it grants nothing.
      siteRoles: access.siteRole ? { [siteId]: access.siteRole } : {},
    };
    if (!hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, siteId)) {
      return NextResponse.json(
        { error: 'capability not granted' },
        { status: 403 },
      );
    }

    const planRefusal = await requireEntitlement(siteId, 'owlette.control');
    if (planRefusal) return planRefusal;

    const commandId = `provision_cortex_key_${Date.now()}`;
    const pendingRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('pending');

    await pendingRef.set(
      {
        [commandId]: {
          type: 'provision_cortex_key',
          api_key: apiKey,
          provider: provider || 'anthropic',
          timestamp: FieldValue.serverTimestamp(),
          status: 'pending',
        },
      },
      { merge: true },
    );

    emitMutation({
      kind: 'site_mutated',
      siteId,
      actor: `user:${userId}`,
      targetId: machineId,
      attributes: {
        verb: 'llm_key.provision',
        endpoint: '/api/hoot/provision-key',
        method: 'POST',
        siteId,
        machineId,
        provider: provider || 'anthropic',
        commandId,
      },
    });

    // Poll for completion
    const completedRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('completed');

    const startTime = Date.now();

    while (Date.now() - startTime < COMMAND_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const completedDoc = await completedRef.get();
      const cmdResult = completedDoc.data()?.[commandId];
      const status =
        cmdResult && typeof cmdResult === 'object'
          ? (cmdResult as { status?: unknown }).status
          : undefined;

      // Only a terminal status resolves the command; a `running` or progress entry means work
      // is still underway — keep polling and leave the entry in place (restart safety).
      if (typeof status === 'string' && TERMINAL_COMMAND_STATUSES.has(status)) {
        const { FieldValue } = await import('firebase-admin/firestore');
        await completedRef.update({ [commandId]: FieldValue.delete() });

        if (status === 'failed' || status === 'error') {
          return NextResponse.json(
            { error: cmdResult.error || 'Key provisioning failed' },
            { status: 500 },
          );
        }

        return NextResponse.json({ success: true });
      }
    }

    // Timeout — clean up pending command
    try {
      const { FieldValue } = await import('firebase-admin/firestore');
      await pendingRef.update({ [commandId]: FieldValue.delete() });
    } catch {
      // Best effort
    }

    return NextResponse.json(
      { error: 'Key provisioning timed out — machine may be offline' },
      { status: 504 },
    );
  } catch (error: unknown) {
    return apiError(error, 'hoot/provision-key');
  }
}, { strategy: 'user', identifier: 'user', getUserId: getUserIdFromSession });
