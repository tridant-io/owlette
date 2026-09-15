/**
 * POST /api/hoot/autonomous — internal endpoint the alert route calls after it
 * has verified the agent's identity. Runs an autonomous `generateText()` tool
 * loop to diagnose a crashed / failed-to-start process, then escalates if
 * unresolved.
 *
 * Auth is the hoot internal shared secret (`CORTEX_INTERNAL_SECRET`), NOT a
 * user session. Responds `accepted` before the investigation runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateText, stepCountIs, tool, jsonSchema } from 'ai';
import { withAdvisor } from '@/lib/hoot/advisor';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { createModel, buildAutonomousSystemPrompt } from '@/lib/llm';
import { getToolsByTier, EXISTING_COMMAND_MAPPINGS, type McpToolDefinition } from '@/lib/mcp-tools';
import {
  resolveLlmConfig,
  resolveSiteKeyOwner,
  isMachineOnline,
  isHootEnabled,
  executeServerSideTool,
  SERVER_SIDE_TOOLS,
  type BuildExecutableToolsOptions,
} from '@/lib/hoot-utils.server';
import {
  dispatchToolCallAsSystem,
  dispatchExistingCommandAsSystem,
} from '@/lib/hoot/dispatch.server';
import { escalate } from '@/lib/hoot-escalation.server';
import { emitSecurityBoundaryMetric } from '@/lib/securityBoundaryMetrics.server';
import { hootInternalSecret } from '@/lib/hootInternalSecret';
import { sanitizeForLog } from '@/lib/logSanitize';

const MAX_STEPS = 15;
const MAX_CONCURRENT_SESSIONS = 3;
const DEFAULT_COOLDOWN_MINUTES = 15;

interface AutonomousRequest {
  siteId: string;
  machineId: string;
  machineName: string;
  eventType: 'process_crash' | 'process_start_failed';
  processName: string;
  errorMessage: string;
  agentVersion?: string;
  nonce?: string;
}

interface HootSettings {
  autonomousEnabled?: boolean;
  directive?: string;
  maxTier?: number;
  maxEventsPerHour?: number;
  cooldownMinutes?: number;
  escalationEmail?: boolean;
}

function emitHootEventMetric(
  name: 'cortex_events_incoming_total' | 'cortex_events_processed_total',
  params: {
    siteId: string;
    machineId: string;
    eventId?: string;
    status?: string;
    eventType?: string;
    durationMs?: number;
  },
): void {
  emitSecurityBoundaryMetric(name, 1, {
    labels: {
      site: params.siteId,
      status: params.status,
      eventType: params.eventType,
    },
    fields: {
      machineId: params.machineId,
      eventId: params.eventId,
      durationMs: params.durationMs,
    },
  });
}

/**
 * Tools an unattended investigator must never call: authoring a talon or
 * flipping its enabled state is standing fleet policy that outlives the
 * incident, so it stays a human decision regardless of tier. Read-only talon
 * tools are deliberately NOT excluded. Matched by name, not registry presence.
 */
const AUTONOMOUS_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'create_talon',
  'set_talon_enabled',
]);

/**
 * Executable tools for autonomous mode (single machine, no streaming). Agent
 * dispatches go through `invokeAsSystem` so the cortex_autonomous audit rows
 * and system rate-limit bucket are honored. `SERVER_SIDE_TOOLS` have no
 * handler in agent/src/mcp_tools.py and run here under the same identity.
 *
 * Kept separate from the shared `buildExecutableTools` because of the `tool()`
 * import mismatch between generateText and streamText.
 */
function buildAutonomousTools(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  chatId: string,
  eventId: string,
  toolDefs: McpToolDefinition[]
) {
  const dispatchCtx = { db, siteId, machineId, chatId, eventId };
  // No chatId/userId — an autonomous run has no session, so server-side
  // mutations audit as `system:cortex_autonomous`.
  const serverSideOptions: BuildExecutableToolsOptions = { systemActor: 'cortex_autonomous' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  for (const def of toolDefs) {
    const toolName = def.name;
    if (AUTONOMOUS_EXCLUDED_TOOLS.has(toolName)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools[toolName] = tool<any, any, any>({
      description: def.description,
      inputSchema: jsonSchema(def.parameters as Record<string, unknown>),
      execute: async (params) => {
        if (SERVER_SIDE_TOOLS.has(toolName)) {
          return executeServerSideTool(
            db,
            siteId,
            [machineId],
            toolName,
            params as Record<string, unknown>,
            serverSideOptions,
          );
        }
        const existingCmd = EXISTING_COMMAND_MAPPINGS[toolName];
        if (existingCmd) {
          return dispatchExistingCommandAsSystem(
            dispatchCtx,
            existingCmd,
            params as Record<string, unknown>,
          );
        }
        return dispatchToolCallAsSystem(dispatchCtx, toolName, params as Record<string, unknown>);
      },
    });
  }

  return tools;
}

export async function POST(request: NextRequest) {
  try {
    const secret = request.headers.get('x-cortex-secret');
    const expectedSecret = hootInternalSecret();
    if (!expectedSecret || secret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json() as AutonomousRequest;
    const { siteId, machineId, machineName, eventType, processName, errorMessage, agentVersion, nonce } = body;

    if (!siteId || !machineId || !processName || !eventType) {
      return NextResponse.json(
        { error: 'Missing required fields: siteId, machineId, processName, eventType' },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    const hootSettingsDoc = await db.doc(`sites/${siteId}/settings/cortex`).get();
    const settings = (hootSettingsDoc.data() ?? {}) as HootSettings;

    if (!settings.autonomousEnabled) {
      return NextResponse.json({ accepted: false, reason: 'autonomous_disabled' });
    }

    // Dedup on machine+process within the cooldown window, and on nonce when
    // supplied (replay protection).
    const cooldownMs = (settings.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60 * 1000;
    const cutoffTime = Timestamp.fromMillis(Date.now() - cooldownMs);

    const recentEvents = await db
      .collection(`sites/${siteId}/cortex-events`)
      .where('machineId', '==', machineId)
      .where('processName', '==', processName)
      .where('timestamp', '>', cutoffTime)
      .limit(1)
      .get();

    if (!recentEvents.empty) {
      const existingEvent = recentEvents.docs[0].data();
      console.log(`[hoot/autonomous] Dedup: skipping ${sanitizeForLog(machineId)}:${sanitizeForLog(processName)} (existing event ${existingEvent.status})`);
      return NextResponse.json({ accepted: false, reason: 'cooldown_active' });
    }

    if (nonce) {
      const nonceRef = db.doc(`sites/${siteId}/cortex-nonces/${nonce}`);
      const nonceDoc = await nonceRef.get();
      if (nonceDoc.exists) {
        console.log(`[hoot/autonomous] Nonce replay blocked: ${sanitizeForLog(nonce)}`);
        return NextResponse.json({ accepted: false, reason: 'duplicate_nonce' });
      }
      // No TTL and no pruner: cortex-nonces docs are write-once and stay.
      await nonceRef.set({ machineId, processName, timestamp: FieldValue.serverTimestamp() });
    }

    // Max concurrent sessions per site.
    const lockRef = db.doc(`sites/${siteId}/cortex-state/lock`);
    const canProceed = await db.runTransaction(async (tx) => {
      const lockDoc = await tx.get(lockRef);
      const active = lockDoc.data()?.activeSessions ?? 0;
      if (active >= MAX_CONCURRENT_SESSIONS) return false;
      tx.set(lockRef, {
        activeSessions: active + 1,
        lastUpdated: Timestamp.now(),
      }, { merge: true });
      return true;
    });

    if (!canProceed) {
      console.warn(`[hoot/autonomous] Concurrency limit reached for site ${sanitizeForLog(siteId)}`);
      return NextResponse.json({ accepted: false, reason: 'concurrency_limit' });
    }

    const eventId = `evt_${Date.now()}_${machineId.replace(/[^a-zA-Z0-9-_]/g, '')}`;
    const chatId = `auto_${Date.now()}_${machineId.replace(/[^a-zA-Z0-9-_]/g, '')}`;
    const eventRef = db.doc(`sites/${siteId}/cortex-events/${eventId}`);

    await eventRef.set({
      machineId,
      machineName,
      processName,
      eventType,
      errorMessage: errorMessage || '',
      timestamp: Timestamp.now(),
      chatId,
      status: 'investigating',
      summary: '',
      actions: [],
    });
    emitHootEventMetric('cortex_events_incoming_total', {
      siteId,
      machineId,
      eventId,
      status: 'investigating',
      eventType,
    });

    console.log(`[hoot/autonomous] Accepted: ${sanitizeForLog(eventId)} — ${sanitizeForLog(processName)} ${sanitizeForLog(eventType)} on ${sanitizeForLog(machineName)}`);

    // Fire and forget — the response goes back before this finishes.
    runAutonomousInvestigation(db, {
      siteId, machineId, machineName, eventType, processName,
      errorMessage: errorMessage || '', agentVersion: agentVersion || '',
      eventId, chatId, settings,
    }).catch(err => {
      console.error(`[hoot/autonomous] Investigation failed for ${sanitizeForLog(eventId)}:`, err);
    });

    return NextResponse.json({ accepted: true, eventId, chatId });

  } catch (error: unknown) {
    return apiError(error, 'hoot/autonomous');
  }
}

interface InvestigationParams {
  siteId: string;
  machineId: string;
  machineName: string;
  eventType: string;
  processName: string;
  errorMessage: string;
  agentVersion: string;
  eventId: string;
  chatId: string;
  settings: HootSettings;
}

async function runAutonomousInvestigation(
  db: FirebaseFirestore.Firestore,
  params: InvestigationParams
): Promise<void> {
  const {
    siteId, machineId, machineName, eventType, processName,
    errorMessage, eventId, chatId, settings,
  } = params;

  const eventRef = db.doc(`sites/${siteId}/cortex-events/${eventId}`);
  const lockRef = db.doc(`sites/${siteId}/cortex-state/lock`);
  const startTime = Date.now();

  try {
    const online = await isMachineOnline(db, siteId, machineId);
    if (!online) {
      await eventRef.update({
        status: 'escalated',
        summary: 'Machine offline — cannot investigate remotely',
        resolvedAt: Timestamp.now(),
        durationMs: Date.now() - startTime,
      });

      if (settings.escalationEmail !== false) {
        await escalate(
          siteId, eventId, machineName, processName,
          `Machine "${machineName}" is offline. Process "${processName}" ${eventType === 'process_start_failed' ? 'failed to start' : 'crashed'} but hoot cannot reach the machine to investigate.\n\nError: ${errorMessage}`
        );
      }

      console.log(`[hoot/autonomous] ${sanitizeForLog(eventId)}: escalated (machine offline)`);
      emitHootEventMetric('cortex_events_processed_total', {
        siteId,
        machineId,
        eventId,
        status: 'escalated',
        eventType,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Per-machine Hoot kill switch: skip the investigation but still escalate.
    const hootEnabled = await isHootEnabled(db, siteId, machineId);
    if (!hootEnabled) {
      await eventRef.update({
        status: 'escalated',
        summary: 'Hoot disabled on this machine — autonomous investigation skipped',
        resolvedAt: Timestamp.now(),
        durationMs: Date.now() - startTime,
      });

      if (settings.escalationEmail !== false) {
        await escalate(
          siteId, eventId, machineName, processName,
          `hoot is disabled on "${machineName}". Process "${processName}" ${eventType === 'process_start_failed' ? 'failed to start' : 'crashed'} but autonomous investigation was skipped because the kill switch is engaged.\n\nError: ${errorMessage}`
        );
      }

      console.log(`[hoot/autonomous] ${sanitizeForLog(eventId)}: escalated (hoot disabled)`);
      emitHootEventMetric('cortex_events_processed_total', {
        siteId,
        machineId,
        eventId,
        status: 'escalated',
        eventType,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // No shared site key exists and a machine-triggered run has no author, so
    // it spends the SITE OWNER's key — the one uid durable for the site's life.
    const llmConfig = await resolveLlmConfig(db, await resolveSiteKeyOwner(db, siteId));

    const maxTier = settings.maxTier ?? 2;
    const toolDefs = getToolsByTier(maxTier as 1 | 2 | 3);
    const tools = buildAutonomousTools(db, siteId, machineId, chatId, eventId, toolDefs);

    const eventLabel = eventType === 'process_start_failed' ? 'failed to start' : 'crashed';
    const eventContext = [
      `Process "${processName}" ${eventLabel} on machine "${machineName}".`,
      errorMessage ? `Error details: ${errorMessage}` : '',
    ].filter(Boolean).join('\n');

    const systemPrompt = buildAutonomousSystemPrompt(
      machineName,
      settings.directive || '',
      eventContext
    );

    const model = createModel(llmConfig);
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: eventContext }],
      // Plus the Opus 5 advisor, capped per reply, when this model may consult it.
      ...withAdvisor(llmConfig, tools),
      stopWhen: stepCountIs(MAX_STEPS),
    });

    const finalText = result.text || '';

    const needsEscalation = finalText.includes('ESCALATION NEEDED');
    const status = needsEscalation ? 'escalated' : 'resolved';

    const summaryMatch = finalText.match(/OUTCOME:\s*(.+)/i);
    const summary = summaryMatch?.[1]?.trim()
      || (needsEscalation ? 'Escalated — hoot could not resolve the issue' : 'Issue investigated and addressed');

    const actions = result.steps?.flatMap(step =>
      (step.toolCalls || []).map(tc => ({
        tool: tc.toolName,
        params: 'input' in tc ? (tc.input ?? {}) : {},
        timestamp: Timestamp.now(),
      }))
    ) || [];

    await eventRef.update({
      status,
      summary,
      actions,
      resolvedAt: Timestamp.now(),
      durationMs: Date.now() - startTime,
    });

    // Full message exchange, for review in the Hoot UI.
    const chatMessages = result.response?.messages || [];
    await db.doc(`chats/${chatId}`).set({
      source: 'autonomous',
      eventId,
      siteId,
      targetType: 'machine',
      targetMachineId: machineId,
      machineName,
      title: `Auto: ${processName} ${eventLabel}`,
      autonomousSummary: summary,
      messages: JSON.parse(JSON.stringify(chatMessages)),
      createdAt: Timestamp.fromMillis(startTime),
      updatedAt: Timestamp.now(),
    });

    if (needsEscalation && settings.escalationEmail !== false) {
      await escalate(siteId, eventId, machineName, processName, finalText);
    }

    console.log(`[hoot/autonomous] ${sanitizeForLog(eventId)}: ${status} in ${Date.now() - startTime}ms (${actions.length} tool calls)`);
    emitHootEventMetric('cortex_events_processed_total', {
      siteId,
      machineId,
      eventId,
      status,
      eventType,
      durationMs: Date.now() - startTime,
    });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[hoot/autonomous] ${sanitizeForLog(eventId)} error:`, err);

    await eventRef.update({
      status: 'failed',
      summary: `Investigation error: ${errMsg}`,
      resolvedAt: Timestamp.now(),
      durationMs: Date.now() - startTime,
    }).catch(() => {});
    emitHootEventMetric('cortex_events_processed_total', {
      siteId,
      machineId,
      eventId,
      status: 'failed',
      eventType,
      durationMs: Date.now() - startTime,
    });

  } finally {
    // Always release the session slot; one retry before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await db.runTransaction(async (tx) => {
          const lockDoc = await tx.get(lockRef);
          const active = lockDoc.data()?.activeSessions ?? 1;
          tx.set(lockRef, {
            activeSessions: Math.max(0, active - 1),
            lastUpdated: Timestamp.now(),
          }, { merge: true });
        });
        break; // Success
      } catch (err) {
        if (attempt === 0) {
          console.warn(`[hoot/autonomous] Lock release failed for ${sanitizeForLog(eventId)}, retrying...`, err);
        } else {
          console.error(`[hoot/autonomous] Lock release failed permanently for ${sanitizeForLog(eventId)} — counter may be stale:`, err);
        }
      }
    }
  }
}
