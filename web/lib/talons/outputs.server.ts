/**
 * Talon output executors — one per output type.
 *
 * Executors return a {@link TalonRunOutput} instead of throwing: a talon with an
 * email and a webhook must still deliver the webhook when mail is down, so a
 * failure is a recorded result, not control flow. The engine records each entry
 * individually and never aborts the remaining outputs.
 *
 * `sent` = the side effect happened. `skipped` = deliberately not attempted
 * (benign; does not fail the run). `failed` = attempted and did not land; fails
 * the run, and ten consecutive failed runs auto-disable the talon. A gate must
 * NEVER report `sent` — an operator has to tell "suppressed by the billing
 * cutoff" from "the email went out" using the run record alone.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { generateUnsubscribeToken } from '@/app/api/unsubscribe/route';
import { getSiteAlertRecipients, recipientWantsMachine } from '@/lib/adminUtils.server';
import {
  ExecuteMachineCommandError,
} from '@/lib/actions/executeMachineCommand.server';
import {
  EMAIL_COLORS,
  emailDataTable,
  emailTimestamp,
  escapeHtml,
  safeEmailSubject,
  wrapEmailLayout,
} from '@/lib/emailTemplates.server';
import { dispatchAndAwait } from '@/lib/jobs/talonRunner.server';
import logger from '@/lib/logger';
import { ENV_LABEL, FROM_EMAIL, getResend, isProduction } from '@/lib/resendClient.server';
import { detectPlatform, formatForPlatform, type WebhookPayload } from '@/lib/webhookSender.server';
import { signPayload } from '@/lib/webhookSignature';
import { validateWebhookUrl } from '@/lib/webhookUrl';
import { runHootOutput } from './hootOutput.server';
import type { StoredTalon } from './store.server';
import type {
  TalonCommandOutput,
  TalonHootOutput,
  TalonOutput,
  TalonRunCondition,
  TalonRunOutput,
  TalonWebhookOutput,
} from './types';

/** Wire event name for the talon webhook payload. */
export const TALON_WEBHOOK_EVENT = 'talon.fired';

/** Matches the subscription fan-out in `webhookSender.server.ts`. */
const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Everything an output executor needs about its run. Assembled once per run by
 * the engine; executors never read the talon document.
 */
export interface TalonOutputContext {
  db: Firestore;
  siteId: string;
  /** `"name (siteId)"` — what recipients see in the email body. */
  siteLabel: string;
  /** Bare site name, for the webhook payload's `site.name`. */
  siteName: string;
  /**
   * The talon being executed. Carried whole for the `cortex` output, which
   * re-resolves `createdBy`'s site access at fire time rather than trusting the
   * privileges the talon was authored with.
   */
  talon: StoredTalon;
  talonId: string;
  talonName: string;
  /** Human-readable, lowercase trigger description, e.g. `cpu_percent > 90`. */
  triggerSummary: string;
  runId: string;
  correlationId: string;
  /** Set on machine-scoped runs (a `visual_check` condition, or a machine-specific trigger). */
  machineId?: string;
  machineName?: string;
  /**
   * Machines a `command` output acts on: one entry for a machine-scoped run, the
   * talon's scope (or the whole site) for a site-level run.
   */
  targetMachineIds: string[];
  /** The condition outcome, when the talon had a condition. */
  condition?: TalonRunCondition;
  /** Absolute origin for unsubscribe links (no trailing slash). */
  baseUrl: string;
  now: Date;
}

/** Resolve the public origin the same way `wrapEmailLayout` does. */
export function resolveBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app')
  );
}

/** Run one output and describe what happened. Never throws. */
export async function executeTalonOutput(
  ctx: TalonOutputContext,
  output: TalonOutput,
): Promise<TalonRunOutput> {
  try {
    switch (output.type) {
      case 'email':
        return await executeEmailOutput(ctx);
      case 'webhook':
        return await executeWebhookOutput(ctx, output);
      case 'command':
        return await executeCommandOutput(ctx, output);
      case 'cortex':
        return await executeHootOutput(ctx, output);
    }
  } catch (error) {
    // Belt and braces: an executor that throws anyway must still produce a
    // recorded result, or one bad output would abort the whole run.
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Talon output ${output.type} threw: ${message}`, {
      context: 'talons/outputs',
      data: { siteId: ctx.siteId, talonId: ctx.talonId, runId: ctx.runId },
    });
    return { type: output.type, status: 'failed', detail: 'output_threw', error: message };
  }
}

async function executeEmailOutput(ctx: TalonOutputContext): Promise<TalonRunOutput> {
  const resend = getResend();
  if (resend === null) {
    // No RESEND_API_KEY here. Reporting `sent` would tell an operator their alert
    // went out when nothing was ever handed to a transport.
    return { type: 'email', status: 'skipped', detail: 'email_transport_unconfigured' };
  }

  const recipients = await getSiteAlertRecipients(ctx.siteId, 'talonAlerts');
  if (recipients.length === 0) {
    return { type: 'email', status: 'skipped', detail: 'no_recipients' };
  }

  const subject = safeEmailSubject(
    ctx.machineName
      ? `talon fired: ${ctx.talonName} — ${ctx.machineName}`
      : `talon fired: ${ctx.talonName}`,
  );

  let sent = 0;
  let muted = 0;
  const failures: string[] = [];

  for (const recipient of recipients) {
    // A machine-scoped run honors per-recipient machine mutes and machine scope.
    // A site-level run has no single machine to mute against, so mutes do not
    // apply to it, but a scoped member holds nothing site-wide and gets no email.
    if (ctx.machineId) {
      if (!recipientWantsMachine(recipient, ctx.machineId)) {
        muted += 1;
        continue;
      }
    } else if ((recipient.machineIds ?? null) !== null) {
      continue;
    }

    try {
      const unsubscribeUrl =
        recipient.userId !== 'fallback'
          ? `${ctx.baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(recipient.userId)}`
          : undefined;

      const result = await resend.emails.send({
        from: FROM_EMAIL,
        to: [recipient.email],
        ...(recipient.ccEmails.length > 0 ? { cc: recipient.ccEmails } : {}),
        subject,
        html: buildTalonEmail(ctx, unsubscribeUrl),
      });

      // Resend reports delivery refusals in-band rather than by throwing.
      if (result.error) {
        failures.push(`${recipient.email}: ${result.error.message ?? 'resend error'}`);
      } else {
        sent += 1;
      }
    } catch (error) {
      failures.push(
        `${recipient.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (sent > 0) {
    return {
      type: 'email',
      status: 'sent',
      detail: `delivered to ${sent} recipient(s)`,
      ...(failures.length > 0 ? { error: failures.join('; ') } : {}),
    };
  }
  if (failures.length > 0) {
    return { type: 'email', status: 'failed', detail: 'send_failed', error: failures.join('; ') };
  }
  if (muted > 0) {
    return { type: 'email', status: 'skipped', detail: 'all_recipients_muted' };
  }
  return { type: 'email', status: 'skipped', detail: 'no_recipients' };
}

/** Lowercase-first-person alert body, matching the rest of the alert emails. */
function buildTalonEmail(ctx: TalonOutputContext, unsubscribeUrl?: string): string {
  const condition = ctx.condition;
  const accent = condition?.verdict === 'fail' ? EMAIL_COLORS.amber : EMAIL_COLORS.cyan;

  const rows: { label: string; value: string; highlight?: string }[] = [
    { label: 'site', value: ctx.siteLabel },
    ...(ctx.machineName ? [{ label: 'machine', value: ctx.machineName }] : []),
    { label: 'talon', value: ctx.talonName },
    { label: 'trigger', value: ctx.triggerSummary },
  ];

  if (condition) {
    rows.push({ label: 'check', value: condition.verdict, highlight: accent });
    if (condition.reason) rows.push({ label: 'what we saw', value: condition.reason });
    if (typeof condition.confidence === 'number') {
      rows.push({ label: 'confidence', value: `${Math.round(condition.confidence * 100)}%` });
    }
  }

  rows.push({ label: 'time', value: emailTimestamp(ctx.now) });
  rows.push({ label: 'environment', value: ENV_LABEL });

  // The capture url is a short-lived signed link, embedded because this email is
  // sent seconds after the capture. The durable reference is the storage path on
  // the run doc, not this.
  const screenshotHtml = condition?.screenshotUrl
    ? `<p style="margin:20px 0 6px;color:${EMAIL_COLORS.muted};font-size:13px;">what the display looked like:</p>
       <a href="${escapeHtml(condition.screenshotUrl)}"><img src="${escapeHtml(condition.screenshotUrl)}" alt="screenshot" width="536" style="display:block;width:100%;max-width:536px;border-radius:6px;border:1px solid ${EMAIL_COLORS.border};"></a>
       <p style="margin:6px 0 0;color:${EMAIL_COLORS.border};font-size:11px;">this image link expires in about an hour.</p>`
    : '';

  const content = `
    <h2 style="color:${accent};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">talon fired: ${escapeHtml(ctx.talonName)}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">one of your talons ran and its outputs were triggered.</p>
    ${emailDataTable(rows)}
    ${screenshotHtml}
    <p style="margin:20px 0 0;color:${EMAIL_COLORS.muted};font-size:13px;">open the dashboard to review this talon's run history.</p>
  `;

  return wrapEmailLayout(content, {
    unsubscribeUrl,
    preheader: `${ctx.talonName}: ${ctx.triggerSummary}`,
  });
}

async function executeWebhookOutput(
  ctx: TalonOutputContext,
  output: TalonWebhookOutput,
): Promise<TalonRunOutput> {
  // Re-validate at SEND time. The store already ran this check when the talon
  // was authored, but DNS can be repointed at an internal address afterwards —
  // that TOCTOU window is exactly what this second pass closes. Do not relax it.
  const urlCheck = await validateWebhookUrl(output.url);
  if (!urlCheck.ok) {
    return {
      type: 'webhook',
      status: 'failed',
      detail: 'invalid_webhook_url',
      error: urlCheck.detail ?? urlCheck.reason,
    };
  }

  const secretSnap = await ctx.db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('talon_secrets')
    .doc(ctx.talonId)
    .get();
  const secret = secretSnap.data()?.secret as string | undefined;
  if (!secret) {
    return {
      type: 'webhook',
      status: 'failed',
      detail: 'signing_secret_missing',
      error: `no signing secret is stored for talon ${ctx.talonId}`,
    };
  }

  const payload: WebhookPayload = {
    event: TALON_WEBHOOK_EVENT,
    timestamp: ctx.now.toISOString(),
    site: { id: ctx.siteId, name: ctx.siteName },
    data: {
      talon: { id: ctx.talonId, name: ctx.talonName },
      run: { id: ctx.runId, correlationId: ctx.correlationId },
      trigger: { summary: ctx.triggerSummary },
      ...(ctx.machineId
        ? { machine: { id: ctx.machineId, name: ctx.machineName ?? ctx.machineId } }
        : {}),
      ...(ctx.condition ? { condition: ctx.condition } : {}),
      // `extractFields` in webhookSender reads this for the Slack/Discord body.
      details: ctx.condition?.reason ?? ctx.triggerSummary,
    },
  };

  const body = formatForPlatform(detectPlatform(urlCheck.url), payload);

  try {
    const response = await fetch(urlCheck.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'owlette-Talons/1.0',
        // Signed unconditionally. Slack and Discord ignore the header; a
        // generic receiver verifies it with `verifySignature`.
        'Roost-Signature': signPayload(body, secret, ctx.now.getTime()),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    return response.ok
      ? { type: 'webhook', status: 'sent', httpStatus: response.status }
      : {
          type: 'webhook',
          status: 'failed',
          detail: 'delivery_rejected',
          httpStatus: response.status,
          error: `endpoint returned ${response.status}`,
        };
  } catch (error) {
    // Network error or the 5s abort — there is no http status to record.
    return {
      type: 'webhook',
      status: 'failed',
      detail: 'delivery_error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Per-machine outcome, folded into the single recorded output entry below. */
interface CommandAttempt {
  status: TalonRunOutput['status'];
  detail: string;
  error?: string;
}

async function executeCommandOutput(
  ctx: TalonOutputContext,
  output: TalonCommandOutput,
): Promise<TalonRunOutput> {
  if (ctx.targetMachineIds.length === 0) {
    return { type: 'command', status: 'skipped', detail: 'no_target_machine' };
  }

  const payload: Record<string, unknown> = {};
  if (output.processId) payload.process_id = output.processId;
  if (output.processName) payload.process_name = output.processName;

  const attempts: CommandAttempt[] = [];
  for (const machineId of ctx.targetMachineIds) {
    // Sequential on purpose: the agent throttles same-type commands to one per 5s
    // per machine, so a parallel fan-out over a repeated machine rate-limits itself.
    attempts.push(await runCommandOnMachine(ctx, machineId, output.commandType, payload));
  }

  return foldCommandAttempts(attempts);
}

async function runCommandOnMachine(
  ctx: TalonOutputContext,
  machineId: string,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<CommandAttempt> {
  let outcome;
  try {
    outcome = await dispatchAndAwait(ctx.db, {
      siteId: ctx.siteId,
      machineId,
      type: commandType,
      payload,
      correlationId: ctx.correlationId,
    });
  } catch (error) {
    if (error instanceof ExecuteMachineCommandError && error.status === 409) {
      // The machine went down between scope resolution and dispatch. Benign:
      // there is nothing wrong with the talon.
      return { status: 'skipped', detail: 'machine_offline' };
    }
    return {
      status: 'failed',
      detail: 'dispatch_failed',
      error: `${machineId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (outcome.status === 'timeout') {
    return {
      status: 'failed',
      detail: 'command_timeout',
      error: `${machineId}: the machine did not report a result in time`,
    };
  }

  const entry = outcome.entry;
  const resultText =
    typeof entry.result === 'string'
      ? entry.result
      : typeof entry.error === 'string'
        ? entry.error
        : '';

  // The agent's own per-type throttle (`{cmd_type}:{process}`, 5s window — see
  // owlette_service.py `handle_firebase_command`). Not a talon fault: the command
  // was refused before it ran, so the next run can just try again.
  if (resultText.startsWith('Error: rate limited')) {
    return { status: 'skipped', detail: 'agent_rate_limited' };
  }
  if (entry.status === 'failed' || entry.status === 'cancelled' || resultText.startsWith('Error:')) {
    return {
      status: 'failed',
      detail: 'command_failed',
      error: `${machineId}: ${resultText || 'the agent reported a failure'}`,
    };
  }

  return { status: 'sent', detail: machineId };
}

/**
 * One output entry from N per-machine attempts. Precedence `failed` > `sent` >
 * `skipped`: reaching three of four machines still needs the fourth looked at.
 */
function foldCommandAttempts(attempts: CommandAttempt[]): TalonRunOutput {
  const failed = attempts.filter((a) => a.status === 'failed');
  const sent = attempts.filter((a) => a.status === 'sent');
  const skipped = attempts.filter((a) => a.status === 'skipped');

  if (failed.length > 0) {
    return {
      type: 'command',
      status: 'failed',
      detail: failed[0].detail,
      error: failed
        .map((a) => a.error)
        .filter((message): message is string => typeof message === 'string')
        .join('; '),
    };
  }
  if (sent.length > 0) {
    return {
      type: 'command',
      status: 'sent',
      detail:
        skipped.length > 0
          ? `ran on ${sent.length} machine(s), skipped ${skipped.length}`
          : `ran on ${sent.length} machine(s)`,
    };
  }

  const reasons = new Set(skipped.map((a) => a.detail));
  return {
    type: 'command',
    status: 'skipped',
    detail: reasons.size === 1 ? [...reasons][0] : 'no_machine_accepted_the_command',
  };
}

/**
 * Hand the directive to a headless assistant turn. `detail` is the chat the turn
 * runs in — the engine lifts it onto the run document so the run list can link
 * straight to the conversation.
 *
 * `sent` means DISPATCHED, not finished: the runner is detached and outlives this
 * call by design (see `hootOutput.server.ts`).
 */
async function executeHootOutput(
  ctx: TalonOutputContext,
  output: TalonHootOutput,
): Promise<TalonRunOutput> {
  const result = await runHootOutput(ctx.db, {
    siteId: ctx.siteId,
    talon: ctx.talon,
    runId: ctx.runId,
    correlationId: ctx.correlationId,
    directive: output.directive,
    // Only forwarded when set, so the runner's default path is byte-identical
    // to what every talon authored before the opt-in existed.
    ...(output.allowActions ? { allowActions: true } : {}),
    triggerSummary: ctx.triggerSummary,
    ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
    ...(ctx.machineName ? { machineName: ctx.machineName } : {}),
    ...(ctx.condition ? { condition: ctx.condition } : {}),
  });

  if (result.status === 'sent') {
    return {
      type: 'cortex',
      status: 'sent',
      detail: result.chatId,
      // Present only when the kill switch thinned a site-wide fan-out, so a
      // partial delivery is readable on the run instead of looking complete.
      ...(result.skippedMachineIds ? { skippedMachineIds: result.skippedMachineIds } : {}),
    };
  }
  // Nothing was attempted and nothing is wrong with the talon — the machine is
  // offline, hoot is switched off on it, or (site-wide) nothing in the site is
  // online or every online machine has hoot switched off. Same class as the
  // command output's `machine_offline` skip, so it must not reach the
  // auto-disable counter.
  if (result.status === 'skipped') {
    return { type: 'cortex', status: 'skipped', detail: result.detail };
  }
  return {
    type: 'cortex',
    status: 'failed',
    detail: result.detail,
    ...(result.error ? { error: result.error } : {}),
    // Only an unrecoverable author problem sets this; the engine lifts it
    // onto the run and switches the talon off without waiting for ten.
    ...(result.disabledReason ? { disabledReason: result.disabledReason } : {}),
  };
}
