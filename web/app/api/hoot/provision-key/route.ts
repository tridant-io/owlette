/**
 * POST /api/hoot/provision-key — provision the LLM API key to a machine's local Hoot.
 * Writes a Firestore command the service picks up, encrypts with SecureStorage (Fernet)
 * and stores in config.json.
 *
 * A 4.2.0 agent's command carries `key_id`. The key waits encrypted in the
 * machine's server-only `hoot_key_handoffs/{key_id}` until the agent fetches it
 * with its own token from `/api/agent/hoot/key`. An older agent's command
 * carries the key as `api_key`.
 *
 * Body: `{ siteId, machineId, apiKey (raw LLM key), provider: 'anthropic' | 'openai' }`.
 * Auth: MACHINE_EXEC_COMMAND on the machine — the same bar the first-party command
 * route holds, because this IS a command dispatch. It previously required only site
 * ACCESS, and after the per-site-roles migration `member` means read-only, so a
 * read-only member could queue a command making any machine on the site overwrite
 * its stored LLM credential. `firestore.rules` reserves `commands/pending` to the
 * service account and the machine's own agent, so this route is the boundary.
 * A machine outside the caller's machine scope answers 404 'machine not found or
 * no access' before that check (ADR 0016).
 *
 * Audits `site_mutated` / `llm_key.provision` (machine-targeted, matching
 * `machine.remove` / `agent_token.revoke`) the moment the command is queued —
 * that write is the mutation, whatever the subsequent poll returns. The key is
 * never recorded; only the provider and the command id.
 */

import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyUserSiteAccess } from '@/lib/hoot-utils.server';
import { Capability, hasCapability, siteStanding, type Actor } from '@/lib/capabilities';
import { scopeCovers } from '@/lib/machineAccess';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import { encryptApiKey } from '@/lib/llm-encryption.server';
import { requireEntitlement } from '@/lib/plan.server';
import { HOOT_KEY_FETCH_MIN_AGENT_VERSION, compareVersions } from '@/lib/versionUtils';
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
    if (!scopeCovers(access.standing.machineIds, machineId)) {
      return NextResponse.json({ error: 'machine not found or no access' }, { status: 404 });
    }
    const actor: Actor = {
      type: 'user',
      userId,
      role: access.role === 'superadmin' || access.role === 'admin' ? access.role : 'member',
      // Per-site standing decides; the global role beside it grants nothing.
      ...siteStanding([[siteId, access.standing]]),
    };
    if (!hasCapability(actor, Capability.MACHINE_EXEC_COMMAND, siteId, machineId)) {
      return NextResponse.json(
        { error: 'capability not granted' },
        { status: 403 },
      );
    }

    const planRefusal = await requireEntitlement(siteId, 'owlette.hoot');
    if (planRefusal) return planRefusal;

    const commandId = `provision_cortex_key_${Date.now()}`;
    const machineRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    const pendingRef = machineRef.collection('commands').doc('pending');

    // a version check, not a wait for the fleet floor: an agent older than 4.2.0
    // reads the key only from the command, so it keeps getting it there, and
    // every newer one is off that path now. an unknown version fetches.
    const machineDoc = await machineRef.get();
    const legacyAgent =
      (compareVersions(machineDoc.data()?.agent_version, HOOT_KEY_FETCH_MIN_AGENT_VERSION) ?? 0) < 0;
    const keyRef = legacyAgent
      ? null
      : machineRef.collection('hoot_key_handoffs').doc(randomUUID());
    if (keyRef) {
      await keyRef.set({
        apiKeyEncrypted: encryptApiKey(apiKey),
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    await pendingRef.set(
      {
        [commandId]: {
          type: 'provision_cortex_key',
          ...(keyRef ? { key_id: keyRef.id } : { api_key: apiKey }),
          provider: provider || 'anthropic',
          timestamp: FieldValue.serverTimestamp(),
          status: 'pending',
        },
      },
      { merge: true },
    );

    // the fetch deletes the key; this covers one that was never fetched
    const dropKey = async () => {
      try {
        await keyRef?.delete();
      } catch {
        // best effort
      }
    };

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
    const completedRef = machineRef.collection('commands').doc('completed');

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
        await dropKey();

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
    await dropKey();

    return NextResponse.json(
      { error: 'Key provisioning timed out — machine may be offline' },
      { status: 504 },
    );
  } catch (error: unknown) {
    return apiError(error, 'hoot/provision-key');
  }
}, { strategy: 'user', identifier: 'user', getUserId: getUserIdFromSession });
