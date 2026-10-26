/**
 * LLM provider abstraction (Vercel AI SDK) for anthropic + openai.
 * Server-side ONLY — never import from a client component.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { type LanguageModel } from 'ai';
import { resolveModelId, type LlmProvider } from '@/lib/llmModels';
import { isValidMachineId, type ResolvedTargets } from '@/lib/hoot/target';
import { isValidTimezone } from '@/lib/timeUtils';

export type { LlmProvider };

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
}

export function createModel(config: LlmConfig): LanguageModel {
  const model = resolveModelId(config.provider, config.model);

  switch (config.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: config.apiKey });
      return anthropic(model);
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey: config.apiKey });
      return openai(model);
    }
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

/**
 * System prompts for hoot chat. `buildSystemPrompt` serves the public
 * conversations API, whose two modes are one machine or the whole site;
 * `buildHootSystemPrompt` serves the dashboard turn, which targets a set and
 * states it per turn. Local Hoot on the agent uses its own CLAUDE.md
 * constitution via Agent SDK, not either of these.
 */
export interface ProcessSummary {
  name: string;
  launch_mode: string;
  exe_path: string;
  file_path?: string;
  cwd?: string;
}

/**
 * whose clock a turn reads local time on: one machine's, or the site's for a
 * fan-out, whose machines may sit in other zones.
 */
export interface PromptLocalTime {
  scope: 'machine' | 'site';
  /** the stored IANA id, unchecked; anything `Intl` rejects reads as UTC. */
  timeZone?: string;
}

/** "Sunday 2026-10-25 14:03" on `timeZone`'s wall clock. */
function formatWallClock(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/**
 * active hours and talon schedules are wall-clock times, so hoot needs the local
 * time to reason about them. the zone comes off a machine or site doc, so only a
 * zone `Intl` accepts is ever written into the prompt.
 */
function localTimeLine(localTime: PromptLocalTime, now: Date): string {
  const zone = localTime.timeZone;
  const valid = typeof zone === 'string' && zone.length > 0 && isValidTimezone(zone);
  const label = localTime.scope === 'machine' ? 'Machine local time' : 'Site local time';
  const shown = valid ? zone : `UTC; no valid ${localTime.scope} timezone on record`;
  const fanOutNote =
    localTime.scope === 'site' ? " Each machine's active hours run on its own clock." : '';
  return `${label}: ${formatWallClock(now, valid ? zone : 'UTC')} (${shown}).${fanOutNote}`;
}

const ACTIVE_HOURS_RULE_HEADING = 'CHECK ACTIVE HOURS AND TALONS FIRST';

/**
 * an agent that enforces active hours refuses the dedicated tools inside them;
 * on the shell route this text is the only check. every tool, parameter and
 * value it names is pinned against mcp-tools.ts by llm.test.ts. `attended` is
 * false for autonomous hoot, which nobody approves, so it is never offered the
 * override.
 */
function activeHoursRule(attended: boolean): string {
  const report = attended ? 'tell the operator' : 'say in your summary';
  const override = attended
    ? 'Set override_active_hours only when the operator explicitly asked to act inside active hours and gave a reason.'
    : 'You cannot override active hours.';
  const askHours = attended ? " (ask for the hours if you don't know them)" : '';
  const noRestarts = attended
    ? 'the operator wants no update restarts at all, after telling them'
    : 'your directive asks for no update restarts at all, and say';
  return `Before reboot_machine, shutdown_machine, deploy_software or kill_process, or a shell command that does the same, call manage_windows_update with action get_status (on Windows) and list_talons, then ${report} whether the machine is inside its active hours and whether a talon will act on it soon. A machine whose agent enforces active hours refuses reboots, shutdowns and deployments inside them: there, prefer reboot_machine with when: "after_active_hours", and never use a shell command to get around a refusal. On any other machine they are not held or refused for active hours, and after_active_hours is not available. ${override} To stop Windows restarting the machine on its own, call manage_windows_update with action limit_auto_restart${askHours}, then get_status, and report what changed, that Windows can still restart outside active hours, and any deadline that remains. Use disable_auto_install only when ${noRestarts} that security updates will then wait for a person. Never say a setting changed unless a tool result shows it.`;
}

/** a turn's machines, and those whose agent enforces active hours (`capabilities.activeHoursGuard`). */
export interface PromptActiveHoursGuard {
  machineIds: readonly string[];
  guardedIds: readonly string[];
}

const UNGUARDED_CONSEQUENCE =
  'reboots, shutdowns and deployments are not held or refused for active hours, and after_active_hours is not available';

function singleMachineGuardLine(guarded: boolean): string {
  return guarded
    ? "This machine's agent enforces active hours."
    : `This machine's agent does not enforce active hours (owlette older than 4.1.21, or not Windows): its ${UNGUARDED_CONSEQUENCE}.`;
}

/** which of the rule's two cases applies to each of this turn's machines; a fan-out names the unguarded ones. */
function activeHoursGuardLine({ machineIds, guardedIds }: PromptActiveHoursGuard): string {
  const total = machineIds.length;
  const unguarded = machineIds.filter((id) => !guardedIds.includes(id));
  if (total === 1) return singleMachineGuardLine(unguarded.length === 0);
  if (unguarded.length === 0) return `All ${total} machines enforce active hours.`;
  if (unguarded.length === total) return `None of the ${total} machines enforce active hours: their ${UNGUARDED_CONSEQUENCE}.`;
  const named = promptSafeIds(unguarded);
  const others = named.length > 0 ? `The others (${formatPromptIds(named)})` : 'The others';
  return `${total - unguarded.length} of ${total} machines enforce active hours. ${others} do not: their ${UNGUARDED_CONSEQUENCE}.`;
}

/**
 * The rules every hoot prompt carries, shared by `buildSystemPrompt` and the
 * per-turn builder below so the two can never drift apart. Rebuilt per call: it
 * stamps the current time.
 */
function buildCoreRules(localTime?: PromptLocalTime): string {
  const now = new Date();
  const currentTime = now.toISOString();
  const localTimeContext = localTime ? `\n${localTimeLine(localTime, now)}` : '';
  return `RULE #1 — NEVER HALLUCINATE: Every claim about hardware specs, system state, processes, memory, disk, GPU, software versions, or any measurable fact MUST come from a tool call you made in THIS conversation. If you haven't called a tool, you don't know. Say "let me check" and call the appropriate tool. A wrong answer is worse than no answer — operators make real decisions based on what you report. NEVER fill in numbers from memory or assumptions.

RULE #2 — DON'T GIVE UP ON "Unknown" VALUES: If a tool returns "Unknown", "N/A", null, or an empty value for a field the operator cares about (CPU model, GPU name, OS version, disk info, etc.), don't just report it as unknown. Try alternate approaches: call a different tool that might expose the same info, run a shell command (e.g. \`wmic\`, \`systeminfo\`, \`Get-CimInstance\`, \`nvidia-smi\`), read a relevant file, or check registry/config. Only report a value as unavailable after you've genuinely tried to retrieve it another way. Briefly note what you tried so the operator knows it wasn't just a shallow lookup.

RULE #3 — NEVER PROMISE TO KEEP WATCHING: A turn ends when you stop writing. You cannot poll, wait, or "check back in a few minutes" on your own, and \`execute_script\` timeouts are capped at 3300 seconds (55 minutes) — anything still running at the cap is killed. For work that may outlast that cap, launch it detached, return immediately, and schedule a follow-up:
1. Start it in the background with output redirected to a log file, e.g. \`Start-Process powershell -ArgumentList '-NoProfile','-File','C:\\ProgramData\\Owlette\\tmp\\install.ps1' -RedirectStandardOutput 'C:\\ProgramData\\Owlette\\tmp\\install.log' -RedirectStandardError 'C:\\ProgramData\\Owlette\\tmp\\install.err' -WindowStyle Hidden\`, then confirm it started (the returned PID, or a get_process_list check).
2. Call \`schedule_followup\` with either \`delay_minutes\` or \`at\`, plus a \`note\` telling your future self exactly what to check — the log path, the process name, what "done" looks like. The note is the only context that carries into that turn.
3. If what you are waiting on is a tool call you just dispatched, pass its agent command id as \`watch_command_id\`: the follow-up then fires as soon as that command completes instead of waiting out the clock.
Use \`cancel_followup\` with the follow-up's id when it is no longer needed (the work finished early, or the operator changed direction). Always prefer scheduling a follow-up over telling the operator you will monitor something — you won't be running.

WHEN A FOLLOW-UP WAKES YOU: the turn opens with a \`[scheduled follow-up]\` message carrying your own note. Say so in your first sentence ("following up on the driver install —"), then report what you actually found. Nobody typed that message, and an unlabelled reply reads as a non sequitur hours after the fact.

RULE #4 — ${ACTIVE_HOURS_RULE_HEADING}: ${activeHoursRule(true)}

TIME CONTEXT
Current time: ${currentTime}${localTimeContext}
When reporting events, logs, or timestamps, always contextualize them relative to the current time (e.g. "2 hours ago", "3 days ago", "last month"). Recent events (within the last 24 hours) are far more urgent than old ones. Prioritize your analysis accordingly — an error from 2 months ago is historical context, an error from 10 minutes ago needs immediate attention.`;
}

/** The configured-process listing. Single-machine turns only — a fan-out has no one machine's config. */
function buildProcessContext(processes?: ProcessSummary[]): string {
  if (!processes || processes.length === 0) return '';
  const lines = processes.map((p) => {
    const parts = [`  - ${p.name} (${p.launch_mode}): ${p.exe_path}`];
    if (p.file_path) parts.push(`    file: ${p.file_path}`);
    if (p.cwd) parts.push(`    cwd: ${p.cwd}`);
    return parts.join('\n');
  });
  return `\n\nCONFIGURED PROCESSES:\n${lines.join('\n')}\n\nThis is the static configuration — use get_process_list to check live runtime status (running/stopped, PIDs).`;
}

/** How a fan-out turn must present its aggregated per-machine results. */
const FAN_OUT_RESULT_RULES = `Each tool call result will contain a "machines" array with per-machine results, each tagged with its machine name. When presenting results from multiple machines, use clear formatting — tables, headers, or bullet points organized by machine name. Highlight any differences or anomalies between machines.

If a tool returns an error for specific machines, report which machines succeeded and which failed.`;

/** `machineRef` is what the model should call the target: a quoted id, or "a machine's name". */
function languageRule(machineRef: string): string {
  return `LANGUAGE: You manage remote machines, not the operator's personal computer. Always refer to "the machine", "the computer", or ${machineRef} — never say "your screen", "your desktop", or "your files".`;
}

const FORMATTING_RULES = `FORMATTING: Your responses are rendered with full Markdown support. Use proper Markdown syntax: tables with | delimiters and separator rows, **bold**, ## headers, \`code blocks\`, and bullet lists. Never use plain-text column alignment — always use Markdown tables.`;

/**
 * The product names are lowercase everywhere in the UI this text is rendered
 * into, and a model writing English will otherwise capitalize them at the start
 * of a sentence — which is exactly where "owlette" kept appearing.
 */
const BRAND_NAME_RULES = `NAMES: "owlette" and "hoot" are lowercase brand names — never capitalize them, not even at the start of a sentence or in a header. Machine ids and site names keep the exact casing they are given to you in.`;

const HOOT_IDENTITY = `You are hoot, owlette's AI assistant for managing media servers, digital signage, kiosks, and interactive installations.`;

export function buildSystemPrompt(
  machineName: string,
  siteMode: boolean,
  processes: ProcessSummary[] | undefined,
  localTime: PromptLocalTime | undefined,
  activeHoursGuard: PromptActiveHoursGuard,
): string {
  const coreRules = buildCoreRules(localTime);
  const guardLine = `\n\n${activeHoursGuardLine(activeHoursGuard)}`;

  if (siteMode) {
    return `${HOOT_IDENTITY} You operate in site-wide mode — your tool calls will be sent to ALL online machines in the site simultaneously and results will be aggregated.

${coreRules}

${FAN_OUT_RESULT_RULES}${guardLine}

${languageRule("a machine's name")}

${FORMATTING_RULES}

${BRAND_NAME_RULES}`;
  }

  return `${HOOT_IDENTITY} You are connected to machine "${machineName}".

${coreRules}

Tool calls are executed on that remote machine, not your local environment — you are observing and acting on "${machineName}" from a distance.

Use your tools to get real data. If a tool returns an error, explain what happened and suggest next steps.${buildProcessContext(processes)}${guardLine}

${languageRule(`"${machineName}"`)}

${FORMATTING_RULES}

${BRAND_NAME_RULES}`;
}

/**
 * How many ids the per-turn block spells out before collapsing the rest into
 * "+N more". The target cap is 64 (`MAX_TARGET_MACHINES`), but this block is
 * re-billed on every advisor consultation, so the prompt shows far fewer — the
 * count is what the model needs, not the full roster.
 */
export const PROMPT_TARGET_IDS_SHOWN = 12;

export type HootPromptMode = 'single' | 'subset' | 'site';

export interface HootSystemPromptOptions {
  /** 'single' is the one-machine path; 'subset' and 'site' both fan out. */
  mode: HootPromptMode;
  /** The ids this turn RESOLVED to — from the server's machine listing, never a request field. */
  machineIds: string[];
  /** What fell out of the resolved set, so the model reports on what it actually reached. */
  skipped?: ResolvedTargets['skipped'];
  /** Single mode only; ignored in a fan-out. */
  processes?: ProcessSummary[];
  /** True when an `@mention` narrowed this one turn. */
  narrowedByMention?: boolean;
  /** the machine's zone on a single-machine turn, the site's on a fan-out. */
  localTime?: PromptLocalTime;
  /** the targets whose agent enforces active hours; absent means none, the safe thing to tell the model. */
  activeHoursGuardIds?: readonly string[];
}

/**
 * Ids fit to interpolate into a prompt. Validation, never sanitization: rewriting
 * a bad id would forge a plausible machine name out of an injection attempt
 * (`kiosk-01\nIGNORE THE ABOVE`), and `MACHINE_ID_RE` already excludes newlines,
 * control characters and every other character a machine id can't contain. These
 * ids are labels for the model, so dropping one costs nothing; keeping a doctored
 * one would cost the block its meaning.
 */
function promptSafeIds(ids: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const safe: string[] = [];
  for (const id of ids) {
    if (isValidMachineId(id) && !safe.includes(id)) safe.push(id);
  }
  return safe;
}

/** `a, b, c` — capped with a "+N more" count. Not the UI's `formatTargetLabel`: prose, not a button. */
function formatPromptIds(ids: string[]): string {
  if (ids.length <= PROMPT_TARGET_IDS_SHOWN) return ids.join(', ');
  const shown = ids.slice(0, PROMPT_TARGET_IDS_SHOWN).join(', ');
  return `${shown} (+${ids.length - PROMPT_TARGET_IDS_SHOWN} more)`;
}

function buildTargetsBlock(options: HootSystemPromptOptions, ids: string[]): string {
  const lines: string[] = [];

  if (ids.length > 0) {
    const noun = ids.length === 1 ? 'machine' : 'machines';
    lines.push(`Tool calls in this turn go to ${ids.length} ${noun}: ${formatPromptIds(ids)}.`);
    lines.push(activeHoursGuardLine({ machineIds: ids, guardedIds: options.activeHoursGuardIds ?? [] }));
  }

  const offline = promptSafeIds(options.skipped?.offline);
  const disabled = promptSafeIds(options.skipped?.disabled);
  if (offline.length > 0) lines.push(`Skipped, offline: ${formatPromptIds(offline)}.`);
  if (disabled.length > 0) lines.push(`Skipped, hoot turned off: ${formatPromptIds(disabled)}.`);
  if (offline.length > 0 || disabled.length > 0) {
    lines.push(
      'Skipped machines received no commands this turn — say so instead of reporting on them.',
    );
  }

  if (options.narrowedByMention === true) {
    lines.push(
      "An @mention narrowed this turn to the machines above. The chat's own selection is unchanged, and the next turn goes back to it.",
    );
  }

  if (lines.length === 0) return '';
  return `TARGETS FOR THIS TURN\n${lines.join('\n')}`;
}

/**
 * The per-turn hoot prompt. A turn now targets a SET, which changes with every
 * message, so the machines it reached are stated in a `TARGETS FOR THIS TURN`
 * block inside the top-level `system` string — Sonnet 5 rejects system messages
 * mid-conversation, so there is nowhere else to put per-turn context.
 *
 * `buildSystemPrompt` stays as it is for the public conversations API
 * (`hootStream.server.ts`), which has no per-turn target to describe.
 */
export function buildHootSystemPrompt(options: HootSystemPromptOptions): string {
  const ids = promptSafeIds(options.machineIds);

  // Every mode's opening promises a target — single names the machine three times,
  // and both fan-out openings point forward at the targets block, which only gets
  // written once an id survives validation. Nothing valid left means the caller
  // resolved an empty or malformed set, so fail the turn here instead of shipping
  // a prompt whose stated blast radius is a dangling reference.
  if (ids.length === 0) {
    throw new Error('buildHootSystemPrompt: a turn needs at least one valid machine id');
  }

  const coreRules = buildCoreRules(options.localTime);
  const targets = buildTargetsBlock(options, ids);

  if (options.mode === 'single') {
    // Single mode IS "exactly one machine" (`effectiveFanOut`), and the prompt
    // names it in three places. A set here is a caller bug that would tell the
    // model one machine while the turn dispatched to several — fail the turn
    // instead of shipping a prompt that lies about its blast radius.
    if (ids.length > 1) {
      throw new Error('buildHootSystemPrompt: single mode needs exactly one valid machine id');
    }
    const machineId = ids[0];
    return joinSections([
      `${HOOT_IDENTITY} You are connected to machine "${machineId}".`,
      coreRules,
      `Tool calls are executed on that remote machine, not your local environment — you are observing and acting on "${machineId}" from a distance.`,
      `Use your tools to get real data. If a tool returns an error, explain what happened and suggest next steps.${buildProcessContext(options.processes)}`,
      targets,
      languageRule(`"${machineId}"`),
      FORMATTING_RULES,
      BRAND_NAME_RULES,
    ]);
  }

  const opening =
    options.mode === 'site'
      ? 'You operate in site-wide mode — your tool calls will be sent to ALL online machines in the site simultaneously and results will be aggregated.'
      : 'You operate in multi-machine mode — your tool calls will be sent simultaneously to the chosen set of machines named at the end of these instructions, and results will be aggregated. They do NOT reach every machine in the site.';

  return joinSections([
    `${HOOT_IDENTITY} ${opening}`,
    coreRules,
    FAN_OUT_RESULT_RULES,
    targets,
    languageRule("a machine's name"),
    FORMATTING_RULES,
    BRAND_NAME_RULES,
  ]);
}

/** Blank line between sections, dropping the empty ones (no targets, no processes). */
function joinSections(sections: string[]): string {
  return sections.filter((section) => section.length > 0).join('\n\n');
}

const CHEAPEST_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4.1-nano',
};

/** Cheap/fast model for lightweight tasks (categorization, tagging). */
export function createCheapModel(config: LlmConfig): LanguageModel {
  const model = CHEAPEST_MODELS[config.provider];
  switch (config.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: config.apiKey });
      return anthropic(model);
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey: config.apiKey });
      return openai(model);
    }
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

export const DEFAULT_AUTONOMOUS_DIRECTIVE =
  'Keep all configured processes running and machines operational. When a process crashes, check agent logs and system event logs for errors, restart the process. If a restart fails twice, escalate to site admins.';

/**
 * Autonomous-Hoot system prompt. Server-side fallback only — when local Hoot
 * is online it builds its own prompt from its CLAUDE.md constitution.
 */
export function buildAutonomousSystemPrompt(
  machineName: string,
  directive: string,
  eventContext: string,
  machineTimeZone?: string,
  activeHoursGuard: boolean = false,
): string {
  return `You are hoot, owlette's AI assistant, operating in AUTONOMOUS mode. You have been triggered by a system alert — no human initiated this conversation. You specialize in managing interactive and immersive media installations (TouchDesigner, Unreal Engine, Unity, digital signage, media walls, kiosks).

YOUR DIRECTIVE: ${directive || DEFAULT_AUTONOMOUS_DIRECTIVE}

CURRENT EVENT:
${eventContext}

You are connected to machine "${machineName}". Your job is to investigate the issue using your tools, attempt remediation, and report your findings.
${localTimeLine({ scope: 'machine', timeZone: machineTimeZone }, new Date())}
${singleMachineGuardLine(activeHoursGuard)}

RULES:
1. NEVER HALLUCINATE — every claim about system state, specs, or metrics MUST come from a tool call. If you haven't checked, you don't know. A wrong answer is worse than no answer.
2. DON'T GIVE UP ON "Unknown" VALUES — if a tool returns "Unknown", "N/A", null, or empty for a field that matters, try alternate tools, shell commands (\`wmic\`, \`systeminfo\`, \`Get-CimInstance\`, \`nvidia-smi\`), or file/registry reads before reporting it as unavailable.
3. INVESTIGATE FIRST — always check agent logs and process status before taking action.
4. RESTART LIMIT — do not restart the same process more than 2 times in this session.
5. ESCALATE — if you cannot resolve the issue after investigation and restart attempts, say "ESCALATION NEEDED" and explain why.
6. BE EFFICIENT — minimize unnecessary tool calls, focus on the specific issue.
7. ALWAYS SUMMARIZE — end your response with a structured summary:
   - ISSUE: what happened
   - INVESTIGATION: what you found
   - ACTION: what you did
   - OUTCOME: resolved / escalated / needs attention
8. VISUAL VERIFICATION — after restarting a display or media process, capture a screenshot to verify visual recovery. Report what you see. Skip for non-display services.
9. ${ACTIVE_HOURS_RULE_HEADING} — ${activeHoursRule(false)}

${BRAND_NAME_RULES}`;
}
