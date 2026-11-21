/**
 * hoot streaming dispatcher for the PUBLIC conversations API:
 * `/api/hoot/conversations/{conversationId}`, its `/api/chat/{conversationId}`
 * twin and the `/api/cortex/conversations/{conversationId}` re-export. All of
 * them pass the `onAssistantText` tap that persists the final assistant message.
 *
 * The dashboard's `/api/hoot` no longer comes through here — it runs async turns
 * through `lib/hoot/turnRunner.server.ts` — so a change made in this file lands
 * on the documented public contract and nothing else.
 *
 * Three mutually exclusive paths:
 *   - site mode (`SITE_TARGET_ID`): server-side llm + fan-out tools, over the
 *     machines that are online AND have the hoot kill switch on (D-A), within
 *     the caller's machine scope
 *   - single machine, local hoot + site-admin caller, on an agent whose local hoot
 *     can't change a launch: the agent runs the llm and streams via firestore onSnapshot
 *   - single machine, fallback: server-side llm + tool relay
 *
 * None of them has an approval card a caller can answer, so a launch change is
 * refused on the server-side paths (`launchChangeApprovable` stays off).
 */

import { streamText, stepCountIs, type ModelMessage, type UIMessageChunk } from 'ai';
import { withAdvisor } from '@/lib/hoot/advisor';
import { SITE_TARGET_ID } from '@/lib/hoot/target';
import { FieldValue } from 'firebase-admin/firestore';
import { createModel, buildSystemPrompt, type ProcessSummary } from '@/lib/llm';
import { getToolsByTier, type ToolTier } from '@/lib/mcp-tools';
import { getSiteTimezone } from '@/lib/talons/store.server';
import { scopeCovers } from '@/lib/machineAccess';
import { compareVersions, LOCAL_HOOT_LAUNCH_GATE_MIN_AGENT_VERSION } from '@/lib/versionUtils';
import {
  resolveLlmConfig,
  verifyUserSiteAccess,
  resolveHootMaxTier,
  isMachineOnline,
  isHootEnabled,
  getMachineSummary,
  listSiteMachines,
  getHootRequireTier3Approval,
  buildExecutableTools,
  type SiteMachineSummary,
} from '@/lib/hoot-utils.server';

// Re-exported, not redefined: both conversation routes import the sentinel from
// here, and `lib/hoot/target.ts` holds the one definition in `web/`.
export { SITE_TARGET_ID };

const HEARTBEAT_STALE_MS = 30_000;
const LOCAL_HOOT_TIMEOUT_MS = 60_000;

/** This surface's chatId is a `chat_conversations` id, but the follow-up sweep
 *  resolves `chats/{chatId}` — a follow-up scheduled from here could never fire
 *  (it fails closed at fire time as `chat_deleted`). Withhold the tools rather
 *  than let the model make a promise the sweep silently breaks. */
const UNSUPPORTED_TOOLS = new Set(['schedule_followup', 'cancel_followup']);

export function conversationsToolDefs(maxToolTier: ToolTier) {
  return getToolsByTier(maxToolTier).filter((def) => !UNSUPPORTED_TOOLS.has(def.name));
}

export interface HootStreamRequest {
  db: FirebaseFirestore.Firestore;
  userId: string;
  siteId: string;
  /** Set to `SITE_TARGET_ID` for site-wide mode. */
  machineId: string;
  machineName: string;
  messages: ModelMessage[];
  chatId: string;
  /** Public-API cap: api-key callers are held at tier 1 so a chat-scoped key
   *  can't inherit the owner's admin role and run destructive tools. */
  maxToolTier?: ToolTier;
  /** Called once with hoot's reply text when the turn finished: on the server-side
   *  paths after a `finish` frame with no `error` frame, awaited before the response
   *  closes; on local hoot when the agent marks the reply complete, as it closes.
   *  Never called for an error, an empty reply, a turn that could not start, a
   *  local-hoot timeout, or a client that hung up before the whole reply was
   *  queued. Throwing is safe: errors are logged, never surfaced to the client. */
  onAssistantText?: (text: string) => Promise<void> | void;
}

export type HootStreamResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; error: string };

/**
 * Returns either a streaming `Response` for the route to return, or a structured
 * error the route shapes into its own envelope (problem+json vs plain `{error}`).
 */
export async function runHootStream(
  req: HootStreamRequest,
): Promise<HootStreamResult> {
  const { db, userId, siteId, machineId, machineName, messages, chatId } = req;

  const isSiteMode = machineId === SITE_TARGET_ID;
  const access = await verifyUserSiteAccess(db, userId, siteId);
  const maxToolTier = req.maxToolTier ?? resolveHootMaxTier(access);
  const machineScope = access.standing.machineIds;

  if (isSiteMode) {
    // a scoped caller's site is the machines in their scope
    const machines = await listSiteMachines(db, siteId, machineScope);
    const online = machines.filter((machine) => machine.online);
    if (online.length === 0) {
      return {
        ok: false,
        status: 503,
        error: 'no machines are currently online in this site.',
      };
    }

    // The per-machine kill switch reaches site mode too (D-A): a machine with
    // hoot switched off receives nothing here, exactly as on the single-machine
    // path below. Offline is classified first, so a machine that is both keeps
    // its 503 and the "turn hoot back on" fix stays visible when it is the only
    // thing in the way.
    const dispatchMachines = online.filter((machine) => machine.hootEnabled);
    if (dispatchMachines.length === 0) {
      return {
        ok: false,
        status: 423,
        error:
          'hoot is disabled on every online machine in this site. re-enable it from the hoot header to deliver tool calls.',
      };
    }

    return {
      ok: true,
      response: handleSiteWideMode(
        db,
        userId,
        siteId,
        messages,
        chatId,
        maxToolTier,
        dispatchMachines,
        access.role,
        machineScope,
        req.onAssistantText,
      ),
    };
  }

  if (!machineId) {
    return { ok: false, status: 400, error: 'machineId is required for single-machine mode' };
  }

  // before any machine read, so a scoped caller never learns whether a machine
  // outside their scope exists or is online
  if (!scopeCovers(machineScope, machineId)) {
    return { ok: false, status: 404, error: 'machine not found or no access' };
  }

  const online = await isMachineOnline(db, siteId, machineId);
  if (!online) {
    return {
      ok: false,
      status: 503,
      error: `machine "${machineName || machineId}" appears to be offline.`,
    };
  }

  const hootEnabled = await isHootEnabled(db, siteId, machineId);
  if (!hootEnabled) {
    return {
      ok: false,
      status: 423,
      error: `hoot is disabled on "${machineName || machineId}". re-enable it from the hoot header to deliver tool calls.`,
    };
  }

  // Both conditions force the server-side path, because the local path runs tools
  // inside the agent where the web server can gate nothing: non-admins would
  // escape the tier-1 cap, and tier-3 approval would escape `needsApproval`.
  const localPathAllowed =
    access.isSiteAdmin &&
    maxToolTier >= 3 &&
    !(await getHootRequireTier3Approval(db, siteId));
  const hootLocal = localPathAllowed
    ? await isHootLocal(db, siteId, machineId)
    : false;

  if (hootLocal) {
    return {
      ok: true,
      response: handleLocalHoot(db, siteId, machineId, machineName, messages, chatId, req.onAssistantText),
    };
  }

  return {
    ok: true,
    response: handleServerSideLLM(
      db,
      userId,
      siteId,
      machineId,
      machineName,
      messages,
      chatId,
      maxToolTier,
      access.role,
      machineScope,
      req.onAssistantText,
    ),
  };
}

async function isHootLocal(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
): Promise<boolean> {
  try {
    const machineDoc = await db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();

    if (!machineDoc.exists) return false;

    const data = machineDoc.data();
    // A fielded agent's local hoot can still set a launch mode with nobody to ask,
    // so it gets no conversation from here: the turn runs on the server, gated.
    if (data?.capabilities?.localHootLaunchGate !== 1) return false;
    const version = typeof data.agent_version === 'string' ? data.agent_version : null;
    if ((compareVersions(version, LOCAL_HOOT_LAUNCH_GATE_MIN_AGENT_VERSION) ?? -1) < 0) return false;

    // Wire field keeps the legacy `cortex` spelling — the agent writes it.
    const hootStatus = data?.cortexStatus;
    if (!hootStatus?.online) return false;

    const lastHeartbeat = hootStatus.lastHeartbeat;
    if (!lastHeartbeat) return false;

    const heartbeatTime = lastHeartbeat.toDate
      ? lastHeartbeat.toDate().getTime()
      : new Date(lastHeartbeat).getTime();

    return Date.now() - heartbeatTime < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

async function fetchProcessSummaries(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
): Promise<ProcessSummary[]> {
  try {
    const configDoc = await db
      .collection('config')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .get();

    if (!configDoc.exists) return [];

    const data = configDoc.data();
    const processes = data?.processes;
    if (!Array.isArray(processes)) return [];

    return processes.map((p: Record<string, unknown>) => ({
      name: (p.name as string) || 'Unknown',
      launch_mode: (p.launch_mode as string) || (p.autolaunch ? 'always' : 'off'),
      exe_path: (p.exe_path as string) || (p.path as string) || '',
      ...(p.file_path ? { file_path: p.file_path as string } : {}),
      ...(p.cwd ? { cwd: p.cwd as string } : {}),
    }));
  } catch {
    return [];
  }
}

function handleLocalHoot(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  machineName: string,
  messages: ModelMessage[],
  chatId: string,
  onAssistantText?: (text: string) => Promise<void> | void,
): Response {
  const activeChatRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('cortex')
    .doc('active-chat');

  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const msgContent = (lastUserMsg as { content?: unknown })?.content;

  let userText = '';
  const images: Array<{ url: string; mediaType: string }> = [];

  if (typeof msgContent === 'string') {
    userText = msgContent;
  } else if (Array.isArray(msgContent)) {
    for (const block of msgContent) {
      if (block.type === 'text') userText += block.text || '';
      if (block.type === 'image' && block.image) {
        images.push({ url: String(block.image), mediaType: block.mediaType || 'image/jpeg' });
      }
    }
  }

  const serializedMessages = messages.map((m) => {
    const c = (m as { content?: unknown }).content;
    if (typeof c === 'string') return { role: m.role, content: c };
    if (Array.isArray(c)) {
      const text = c
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text || '')
        .join('');
      return { role: m.role, content: text };
    }
    return { role: m.role, content: '' };
  });

  // Unawaited so the stream can start enqueuing; a failure just means the agent
  // never picks the message up and the timeout error surfaces.
  activeChatRef
    .set(
      {
        pendingMessage: userText,
        chatId,
        machineName: machineName || machineId,
        messages: serializedMessages,
        ...(images.length > 0 ? { images } : {}),
        status: 'pending',
        response: { content: '', complete: false, parts: [] },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: false },
    )
    .catch((err) => {
      console.warn('[hootStream] failed to seed pending message:', err);
    });

  const encoder = new TextEncoder();
  let lastContent = '';
  let unsubscribe: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      timeoutId = setTimeout(() => {
        controller.enqueue(encoder.encode(`3:"hoot response timed out"\n`));
        controller.close();
        unsubscribe?.();
      }, LOCAL_HOOT_TIMEOUT_MS);

      unsubscribe = activeChatRef.onSnapshot(
        (snapshot) => {
          const data = snapshot.data();
          if (!data) return;

          const response = data.response;
          if (!response) return;

          const content: string = response.content || '';
          const complete: boolean = response.complete || false;
          const status: string = data.status;

          // the agent writes an error as complete, with its message as the content:
          // answer it as an error before either branch below takes it for hoot's reply
          if (status === 'error') {
            controller.enqueue(
              encoder.encode(`3:${JSON.stringify(content || 'hoot error')}\n`),
            );
            if (timeoutId) clearTimeout(timeoutId);
            unsubscribe?.();
            controller.close();
            return;
          }

          if (content.length > lastContent.length) {
            const delta = content.slice(lastContent.length);
            controller.enqueue(encoder.encode(`0:${JSON.stringify(delta)}\n`));
            lastContent = content;
          }

          if (complete) {
            controller.enqueue(
              encoder.encode(`d:${JSON.stringify({ finishReason: 'stop' })}\n`),
            );
            if (timeoutId) clearTimeout(timeoutId);
            unsubscribe?.();
            controller.close();
            void fireAssistantTap(onAssistantText, lastContent);
          }
        },
        (error) => {
          console.error('hoot onSnapshot error:', error);
          controller.enqueue(
            encoder.encode(`3:${JSON.stringify(error.message || 'stream error')}\n`),
          );
          controller.close();
          if (timeoutId) clearTimeout(timeoutId);
        },
      );
    },

    cancel() {
      unsubscribe?.();
      if (timeoutId) clearTimeout(timeoutId);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1',
    },
  });
}

function handleServerSideLLM(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  machineId: string,
  machineName: string,
  messages: ModelMessage[],
  chatId: string,
  maxToolTier: ToolTier,
  userRole: string | null,
  machineScope: readonly string[] | null,
  onAssistantText?: (text: string) => Promise<void> | void,
): Response {
  return wrapWithAssistantTap(
    runServerSideLLM(db, userId, siteId, machineId, machineName, messages, chatId, maxToolTier, userRole, machineScope),
    onAssistantText,
  );
}

async function runServerSideLLM(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  machineId: string,
  machineName: string,
  messages: ModelMessage[],
  chatId: string,
  maxToolTier: ToolTier,
  userRole: string | null,
  machineScope: readonly string[] | null,
): Promise<Response> {
  const [llmConfig, processes, requireTier3Approval, machine] = await Promise.all([
    resolveLlmConfig(db, userId),
    fetchProcessSummaries(db, siteId, machineId),
    getHootRequireTier3Approval(db, siteId),
    // a failed read is no reason to fail the turn: utc, and a machine that holds nothing.
    getMachineSummary(db, siteId, machineId).catch(() => null),
  ]);
  const activeHoursGuardIds = machine?.activeHoursGuard === true ? [machineId] : [];

  const toolDefs = conversationsToolDefs(maxToolTier);
  const executableTools = buildExecutableTools(
    db,
    siteId,
    machineId,
    chatId,
    toolDefs,
    false,
    [],
    { userId, userRole, machineScope, requireTier3Approval, activeHoursGuardIds },
  );

  const model = createModel(llmConfig);

  const result = streamText({
    model,
    system: buildSystemPrompt(
      machineName || machineId,
      false,
      processes,
      { scope: 'machine', timeZone: machine?.timezone },
      { machineIds: [machineId], guardedIds: activeHoursGuardIds },
    ),
    messages,
    // Plus the Opus 5 advisor, capped per reply, when this model may consult it.
    ...withAdvisor(llmConfig, executableTools),
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}

function handleSiteWideMode(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  messages: ModelMessage[],
  chatId: string,
  maxToolTier: ToolTier,
  dispatchMachines: SiteMachineSummary[],
  userRole: string | null,
  machineScope: readonly string[] | null,
  onAssistantText?: (text: string) => Promise<void> | void,
): Response {
  return wrapWithAssistantTap(
    runSiteWideMode(db, userId, siteId, messages, chatId, maxToolTier, dispatchMachines, userRole, machineScope),
    onAssistantText,
  );
}

async function runSiteWideMode(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteId: string,
  messages: ModelMessage[],
  chatId: string,
  maxToolTier: ToolTier,
  /** Online AND hoot-enabled — the kill switch is applied before we get here. */
  dispatchMachines: SiteMachineSummary[],
  userRole: string | null,
  machineScope: readonly string[] | null,
): Promise<Response> {
  const [llmConfig, requireTier3Approval, siteTimeZone] = await Promise.all([
    resolveLlmConfig(db, userId),
    getHootRequireTier3Approval(db, siteId),
    getSiteTimezone(db, siteId),
  ]);
  const machineIds = dispatchMachines.map((machine) => machine.id);
  const activeHoursGuardIds = dispatchMachines
    .filter((machine) => machine.activeHoursGuard)
    .map((machine) => machine.id);
  const toolDefs = conversationsToolDefs(maxToolTier);
  const executableTools = buildExecutableTools(
    db,
    siteId,
    SITE_TARGET_ID,
    chatId,
    toolDefs,
    true,
    machineIds,
    { userId, userRole, machineScope, requireTier3Approval, activeHoursGuardIds },
  );

  const model = createModel(llmConfig);

  const result = streamText({
    model,
    system: buildSystemPrompt(
      '',
      true,
      undefined,
      { scope: 'site', timeZone: siteTimeZone },
      { machineIds, guardedIds: activeHoursGuardIds },
    ),
    messages,
    // Plus the Opus 5 advisor, capped per reply, when this model may consult it.
    ...withAdvisor(llmConfig, executableTools),
    stopWhen: stepCountIs(10),
  });

  return result.toUIMessageStreamResponse();
}

/**
 * Tee a streaming Response: forward bytes to the client while reading the reply's
 * text for `onAssistantText`. A Promise upstream (server-side LLM) resolves lazily
 * inside the teed stream so the caller still gets a synchronous Response.
 */
function wrapWithAssistantTap(
  upstreamPromise: Response | Promise<Response>,
  onAssistantText?: (text: string) => Promise<void> | void,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      let upstream: Response;
      try {
        upstream = await upstreamPromise;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'hoot error';
        controller.enqueue(new TextEncoder().encode(`3:${JSON.stringify(msg)}\n`));
        controller.close();
        return;
      }

      const reader = upstream.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const reply = onAssistantText ? replyTextReader() : null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            // throws once the client has hung up, before `push` sees these bytes, so
            // a reply is saved only when every byte of it was queued for the client
            controller.enqueue(value);
            reply?.push(value);
          }
        }
        // saved before the close, so the reply is stored by the time the response ends
        if (reply) await fireAssistantTap(onAssistantText, reply.text());
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1',
    },
  });
}

/**
 * The reply's text, read out of the AI SDK UI message stream the server-side
 * paths return: one `data: {json}` frame per line. Each `text-start` opens a
 * part, as in the dashboard's own message, and the parts are joined the way the
 * dashboard's copy button joins them; tool calls and reasoning are not text.
 *
 * The text counts only when the turn reached `finish` with no `error` frame.
 * The SDK still sends `finish` after an error, and a half reply stored as hoot's
 * answer would reach the model on the next turn as if it were whole.
 */
function replyTextReader() {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  const partById = new Map<string, number>();
  let pendingLine = '';
  let finished = false;
  let failed = false;

  function readFrame(line: string): void {
    if (!line.startsWith('data: ')) return;
    const data = line.slice('data: '.length);
    if (data === '[DONE]') return;
    let frame: UIMessageChunk;
    try {
      frame = JSON.parse(data);
    } catch {
      // a frame that cannot be read may have carried text
      failed = true;
      return;
    }
    switch (frame.type) {
      case 'text-start':
        partById.set(frame.id, parts.push('') - 1);
        break;
      case 'text-delta': {
        const index = partById.get(frame.id);
        if (index !== undefined) parts[index] += frame.delta;
        break;
      }
      case 'error':
        failed = true;
        break;
      case 'finish':
        finished = true;
        break;
    }
  }

  return {
    push(bytes: Uint8Array): void {
      // a frame, or a multi-byte character, can arrive cut across two chunks
      pendingLine += decoder.decode(bytes, { stream: true });
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) readFrame(line);
    },
    text(): string {
      return finished && !failed ? parts.join('\n\n').trim() : '';
    },
  };
}

async function fireAssistantTap(
  onAssistantText: ((text: string) => Promise<void> | void) | undefined,
  text: string,
): Promise<void> {
  if (!onAssistantText || !text) return;
  try {
    await onAssistantText(text);
  } catch (err) {
    console.warn('[hootStream] onAssistantText tap failed:', err);
  }
}
