/**
 * Visual-check condition: capture a screenshot from the machine and have a
 * vision model judge it against the operator's expectation. `fail` fires the
 * talon's outputs, `pass` short-circuits the run.
 *
 * Two invariants:
 *   - The verdict comes from `generateObject` + zod, never parsed out of prose —
 *     a rambling model yields `verdict_error`, not a regex misreading "fail".
 *   - Persist the storage PATH, not the signed url: urls expire in ~1h (objects
 *     at 30d), so a stored url is dead by review time. The url is returned only
 *     to embed the image in the alert email sent seconds later.
 *
 * The agent rate-limits `capture_screenshot` to one per 5s per machine
 * (COMMAND_RATE_LIMIT_SECONDS), so concurrent checks against one machine return
 * `Error: rate limited` — the engine runs machine-scoped runs in sequence.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { generateObject } from 'ai';
import { z } from 'zod';
import { ExecuteMachineCommandError } from '@/lib/actions/executeMachineCommand.server';
import { dispatchAndAwait } from '@/lib/jobs/talonRunner.server';
import { createModel } from '@/lib/llm';
import logger from '@/lib/logger';
import { isMachineScreenshotPath, issueScreenshotReadUrl } from '@/lib/screenshotStorage.server';
import {
  TalonAuthorError,
  resolveTalonAuthor,
  resolveTalonAuthorLlmConfig,
} from './author.server';
import type { StoredTalon } from './store.server';
import type { TalonDisabledReason, TalonVisualCheckCondition } from './types';

/**
 * Poll budget for the capture — wider than the shared 30s command timeout: the
 * agent must enter the interactive session, grab the framebuffer, get a signed
 * url and PUT the bytes to GCS before writing a result.
 */
export const VISUAL_CHECK_CAPTURE_TIMEOUT_MS = 45_000;

/** The condition fields this evaluator reads — a full `TalonVisualCheckCondition` is assignable. */
export type VisualCheckSpec = Pick<TalonVisualCheckCondition, 'expectation' | 'monitor'>;

export type TalonVisualCheckErrorCode =
  | 'capture_failed'
  | 'machine_offline'
  | 'no_interactive_session'
  | 'verdict_error'
  | 'author_unavailable';

/**
 * No verdict could be produced — distinct from a `fail` verdict, which IS an
 * answer. The engine maps `machine_offline`/`no_interactive_session` to a
 * skipped run and `capture_failed`/`verdict_error` to a failed one.
 * `author_unavailable` (the key behind the check is gone) always carries a
 * `disabledReason` and switches the talon off rather than failing repeatedly.
 */
export class TalonVisualCheckError extends Error {
  readonly code: TalonVisualCheckErrorCode;
  /** Set only on `author_unavailable` — the reason stamped on the talon. */
  readonly disabledReason?: TalonDisabledReason;

  constructor(
    code: TalonVisualCheckErrorCode,
    message: string,
    disabledReason?: TalonDisabledReason,
  ) {
    super(message);
    this.name = 'TalonVisualCheckError';
    this.code = code;
    if (disabledReason) this.disabledReason = disabledReason;
  }
}

export interface VisualCheckResult {
  verdict: 'pass' | 'fail';
  /** Model confidence in its own verdict, 0–1. */
  confidence: number;
  /** One-line justification, shown on the run and in the alert email. */
  reason: string;
  /** GCS object path — the durable reference. */
  screenshotPath?: string;
  /** Signed read url, ~1h TTL: embed now, never persist as a link. */
  screenshotUrl?: string;
}

export const visualCheckVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  /**
   * Deliberately unbounded IN THE SCHEMA: `.min(0).max(1)` renders as JSON Schema
   * `minimum`/`maximum`, which Google's structured-output dialect rejects on a
   * number — that failed EVERY visual check on a Gemini key with `verdict_error`.
   * {@link clampConfidence} enforces the bound after the call instead. Any
   * constraint added here must be checked against Google's subset.
   */
  confidence: z.number(),
  reason: z.string(),
});

/**
 * The [0,1] bound the schema can't carry. 87 (a percentage), a negative or NaN is
 * pulled back into range; an unusable value reads as no confidence, not total.
 */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 1 && value <= 100) return Math.min(1, value / 100);
  return Math.min(1, Math.max(0, value));
}

const VISUAL_CHECK_SYSTEM_PROMPT = `You are a strict visual inspector for unattended video-wall, kiosk, and digital-signage installations. You are shown one screenshot of a remote machine's display and one operator expectation describing what that display should look like right now.

Decide whether the screenshot satisfies the expectation.

- Judge only what is visible. Do not assume anything about the machine that the image does not show.
- Treat obvious failure states as failing the expectation even when the operator did not enumerate them: a black or blank screen, the Windows desktop or taskbar where content should be, an error dialog, a crash report, a frozen loading indicator, a stretched or letterboxed image where content should be full-bleed, or a projector/display "no signal" card.
- If the image is too dark, too small, or too ambiguous to tell, return "fail" with LOW confidence and say plainly what you could not determine. A false alarm an operator can dismiss is far cheaper than a dead wall nobody was told about.
- "confidence" is your confidence in the verdict you returned, not the probability that things are fine.
- "reason" is one short sentence an on-call operator can read on a phone. Describe what you actually see.`;

// capture

/**
 * The `capture_screenshot` success payload as `machine_commands.py` writes it
 * (`_handle_capture_screenshot`) — NOT the `{message, url, base64}` shape the
 * MCP tool route returns.
 */
interface CaptureResult {
  storage_path?: string;
  url?: string;
  size_kb?: number;
  monitor?: number;
  monitor_count?: number;
}

/** "no interactive session" is the one capture failure that isn't our fault. */
function captureErrorCodeFor(message: string): TalonVisualCheckErrorCode {
  return /no interactive/i.test(message) ? 'no_interactive_session' : 'capture_failed';
}

function throwCaptureError(message: string): never {
  throw new TalonVisualCheckError(captureErrorCodeFor(message), message);
}

/**
 * Normalize the agent's terminal completed-entry into the capture payload, or
 * throw the typed error the entry describes.
 */
function readCaptureResult(entry: Record<string, unknown>): CaptureResult {
  if (entry.status === 'failed' || entry.status === 'cancelled') {
    throwCaptureError(
      typeof entry.error === 'string' && entry.error.length > 0
        ? entry.error
        : `screenshot capture ${String(entry.status)}`,
    );
  }

  let result: unknown = entry.result;
  // Agent writes a dict on success, an `Error: ...` string on failure; some
  // versions stringify the dict, so JSON is accepted too.
  if (typeof result === 'string') {
    if (result.startsWith('Error:')) throwCaptureError(result);
    try {
      result = JSON.parse(result);
    } catch {
      throwCaptureError(`screenshot capture returned an unreadable result: ${result}`);
    }
  }

  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throwCaptureError('screenshot capture returned no result payload');
  }

  return result as CaptureResult;
}

// evaluation

/**
 * The author's own vision model, re-resolved every run: there is no shared site
 * key (see `resolveLlmConfig`), so the check spends the talon author's key and
 * only while they still have site access — same module as the hoot output so the
 * two AI paths can't drift on who may run unattended work.
 */
async function resolveAuthorModel(db: Firestore, siteId: string, talon: StoredTalon) {
  try {
    const author = await resolveTalonAuthor(db, siteId, talon);
    return createModel(await resolveTalonAuthorLlmConfig(db, author.userId));
  } catch (error) {
    if (error instanceof TalonAuthorError) {
      throw new TalonVisualCheckError('author_unavailable', error.message, error.reason);
    }
    // Transient (failed read, missing site) — stays on the failure counter.
    throw new TalonVisualCheckError(
      'verdict_error',
      `could not resolve who this talon runs as: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Capture the machine's display and judge it against `condition.expectation`.
 * `talon.createdBy` is the key that pays for the verdict, re-checked each run.
 * @throws {TalonVisualCheckError} when no verdict could be produced.
 */
export async function evaluateVisualCheck(
  db: Firestore,
  siteId: string,
  machineId: string,
  talon: StoredTalon,
  condition: VisualCheckSpec,
  correlationId: string,
): Promise<VisualCheckResult> {
  // Resolved BEFORE the capture: an unpayable check shouldn't cost the machine a
  // 45s screenshot round trip.
  const model = await resolveAuthorModel(db, siteId, talon);

  const capture = await captureScreenshot(db, siteId, machineId, condition, correlationId);

  // signed here from this machine's path: the capture's own url is the
  // dashboard's route, which a model provider cannot open
  const storagePath = capture.storage_path;
  const signed = isMachineScreenshotPath(storagePath, siteId, machineId)
    ? await issueScreenshotReadUrl(storagePath)
    : null;
  if (!signed) {
    throw new TalonVisualCheckError(
      'capture_failed',
      "screenshot capture returned no path to this machine's screenshot",
    );
  }

  let verdict: z.infer<typeof visualCheckVerdictSchema>;
  try {
    const generated = await generateObject({
      model,
      schema: visualCheckVerdictSchema,
      system: VISUAL_CHECK_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Operator expectation for this display:\n\n${condition.expectation}`,
            },
            { type: 'image', image: new URL(signed.url) },
          ],
        },
      ],
    });
    verdict = generated.object;
  } catch (error) {
    throw new TalonVisualCheckError(
      'verdict_error',
      `the vision model did not return a usable verdict: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const confidence = clampConfidence(verdict.confidence);

  logger.info(
    `Talon visual check on ${machineId}: ${verdict.verdict} (${confidence})`,
    { context: 'talons/visualCheck', data: { siteId, machineId, correlationId } },
  );

  return {
    verdict: verdict.verdict,
    confidence,
    reason: verdict.reason,
    screenshotPath: storagePath,
    screenshotUrl: signed.url,
  };
}

async function captureScreenshot(
  db: Firestore,
  siteId: string,
  machineId: string,
  condition: VisualCheckSpec,
  correlationId: string,
): Promise<CaptureResult> {
  let outcome;
  try {
    outcome = await dispatchAndAwait(
      db,
      {
        siteId,
        machineId,
        type: 'capture_screenshot',
        // 0 (the default) = all monitors combined, 1 = primary, and so on.
        payload: { monitor: condition.monitor ?? 0 },
        correlationId,
      },
      { timeoutMs: VISUAL_CHECK_CAPTURE_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof ExecuteMachineCommandError && error.status === 409) {
      throw new TalonVisualCheckError('machine_offline', error.detail);
    }
    throw new TalonVisualCheckError(
      'capture_failed',
      `could not queue the screenshot capture: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (outcome.status === 'timeout') {
    throw new TalonVisualCheckError(
      'capture_failed',
      `the machine did not return a screenshot within ${Math.round(
        VISUAL_CHECK_CAPTURE_TIMEOUT_MS / 1000,
      )} seconds`,
    );
  }

  return readCaptureResult(outcome.entry);
}
