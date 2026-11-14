/**
 * POST /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}/stall
 *
 * One viewer's report that its picture froze while the session stayed up
 * (`lib/swoop/video/stall.ts`). The page recovers on its own; this only writes
 * one structured log line, so a stall in the field leaves evidence without the
 * operator having to open devtools. Nothing reaches the machine and nothing is
 * stored.
 *
 * The body is an allow-list, refused whole on any field outside it: the
 * browser's stats carry candidate addresses and ids that have no business in a
 * log, so the page picks the counters and the server holds it to them.
 */

import { NextResponse } from 'next/server';
import { problem, problemFromError, problemNotFound, problemValidation, ProblemType } from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '@/app/api/_shared';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import logger from '@/lib/logger';
import { checkRateLimit, swoopStallReportRateLimit } from '@/lib/rateLimit';
import { applyRateLimitCounters, rateLimitedResponse } from '@/lib/withRateLimit';
import { evaluateSwoopAccess } from '@/lib/swoop/policy.server';
import { getSwoopSession } from '@/lib/swoop/sessionStore.server';
import {
  INBOUND_VIDEO_COUNTERS,
  INBOUND_VIDEO_STRING_MAX,
  STALL_ACTIONS,
  STALL_KINDS,
  type InboundVideoStats,
  type SwoopStallReport,
} from '@/lib/swoop/video/stall';
import {
  apiKeyRefusal,
  decisionProblem,
  isValidSid,
  swoopGate,
  type SwoopRouteParams,
} from '../../../_shared';

/** a full report with both snapshots is under 1.5 KB. */
const MAX_BODY_BYTES = 4096;
/** no counter or duration in a report comes near this; anything past it is not one. */
const MAX_NUMBER = 1e12;

const REPORT_FIELDS: ReadonlySet<string> = new Set<keyof SwoopStallReport>([
  'viewerId',
  'kind',
  'action',
  'codec',
  'stalledMs',
  'hostFrames',
  'before',
  'after',
]);
const STATS_COUNTERS: ReadonlySet<string> = new Set(INBOUND_VIDEO_COUNTERS);
const CODECS: ReadonlySet<unknown> = new Set(['h264', 'hevc', 'av1', null]);
const MIME_TYPE = /^video\/[A-Za-z0-9.+-]{1,32}$/;
// printable ascii only: it lands in a log line.
const DECODER_NAME = new RegExp(`^[\\x20-\\x7e]{1,${INBOUND_VIDEO_STRING_MAX}}$`);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_NUMBER;

const isCount = (value: unknown): value is number => isNumber(value) && value >= 0;

/** the stats spec lets `packetsLost` go negative: duplicates count against it. */
const SIGNED_COUNTERS: ReadonlySet<string> = new Set(['packetsLost']);

/** the snapshot as the page took it, or the field it fails on. */
function parseStats(value: unknown): { ok: true; stats: InboundVideoStats | null } | { ok: false; field: string } {
  if (value === null || value === undefined) return { ok: true, stats: null };
  if (!isPlainObject(value)) return { ok: false, field: '' };
  for (const [field, entry] of Object.entries(value)) {
    const valid = STATS_COUNTERS.has(field)
      ? SIGNED_COUNTERS.has(field)
        ? isNumber(entry)
        : isCount(entry)
      : field === 'decoderImplementation'
        ? typeof entry === 'string' && DECODER_NAME.test(entry)
        : field === 'codecMimeType' && typeof entry === 'string' && MIME_TYPE.test(entry);
    if (!valid) return { ok: false, field };
  }
  return { ok: true, stats: value as InboundVideoStats };
}

function parseReport(body: unknown): { ok: true; report: SwoopStallReport } | { ok: false; response: NextResponse } {
  const refuse = (field: string, expected: string) => ({
    ok: false as const,
    response: problemValidation(`field \`${field}\` is not valid in a stall report`, { [field]: [expected] }),
  });
  if (!isPlainObject(body)) return refuse('body', 'a json object');
  for (const field of Object.keys(body)) {
    if (!REPORT_FIELDS.has(field)) return refuse(field, 'not an allowed field');
  }
  if (!isValidSid(body.viewerId)) return refuse('viewerId', 'the viewer id the session was created with');
  if (!(STALL_KINDS as readonly unknown[]).includes(body.kind)) return refuse('kind', STALL_KINDS.join(', '));
  if (!(STALL_ACTIONS as readonly unknown[]).includes(body.action)) return refuse('action', STALL_ACTIONS.join(', '));
  if (!CODECS.has(body.codec ?? null)) return refuse('codec', 'h264, hevc, av1 or null');
  if (!isCount(body.stalledMs)) return refuse('stalledMs', 'milliseconds');
  if (!isCount(body.hostFrames) || !Number.isInteger(body.hostFrames)) return refuse('hostFrames', 'a whole frame count');
  const before = parseStats(body.before);
  if (!before.ok) return refuse(before.field ? `before.${before.field}` : 'before', 'an allowed inbound-rtp counter');
  const after = parseStats(body.after);
  if (!after.ok) return refuse(after.field ? `after.${after.field}` : 'after', 'an allowed inbound-rtp counter');
  return {
    ok: true,
    report: {
      viewerId: body.viewerId,
      kind: body.kind as SwoopStallReport['kind'],
      action: body.action as SwoopStallReport['action'],
      codec: (body.codec ?? null) as SwoopStallReport['codec'],
      stalledMs: body.stalledMs,
      hostFrames: body.hostFrames,
      before: before.stats,
      after: after.stats,
    },
  };
}

const tooLarge = (): NextResponse =>
  problem({
    type: ProblemType.PayloadTooLarge,
    title: 'payload too large',
    status: 413,
    detail: `a stall report is at most ${MAX_BODY_BYTES} bytes.`,
  });

const stallHandler: SiteRouteHandler<SwoopRouteParams> = async (request, ctx, { params }) => {
  try {
    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) return keyRefusal;

    const { machineId, sessionId } = await params;
    const siteId = ctx.siteId;
    if (!isValidSid(sessionId)) return problemValidation('invalid session id');

    // the declared length refuses a large body before it is read; the read
    // itself catches one sent without a length.
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    if (Buffer.byteLength(parsed.raw, 'utf8') > MAX_BODY_BYTES) return tooLarge();
    const read = parseReport(parsed.body);
    if (!read.ok) return read.response;
    const { report } = read;

    const gate = await swoopGate({ ctx, machineId, intent: 'view' });
    const decision = evaluateSwoopAccess({ ...gate, stepUpOpen: false });
    if (!decision.ok) return decisionProblem(decision);

    // A viewer row that is not the caller's answers exactly as a missing one,
    // as on the lease route: whose viewers a session holds is not the caller's
    // business.
    const session = await getSwoopSession(siteId, machineId, sessionId);
    if (!session || session.state === 'ended') return problemNotFound('session not found');
    const viewer = session.viewers.find((v) => v.viewerId === report.viewerId);
    if (!viewer || viewer.uid !== ctx.actor.userId) return problemNotFound('session not found');

    // Per session, after the viewer check: only the session's own viewer
    // spends its budget.
    const rateResult = await checkRateLimit(
      swoopStallReportRateLimit,
      `swoop_stall:${siteId}:${machineId}:${sessionId}`,
    );
    if (!rateResult.success) return rateLimitedResponse(rateResult, 'endpoint-rate');

    logger.warn('[swoop/stall] a viewer picture froze while the session stayed up', {
      context: 'swoop/stall',
      data: { siteId, machineId, sid: sessionId, ...report },
    });

    return applyRateLimitCounters(
      applyAuthDeprecations(new NextResponse(null, { status: 204 }), ctx.scopeCheck),
      rateResult,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/stall:POST');
  }
};

// The watch bar, as on the lease route: any viewer may report its own picture.
export const POST = authorizedSiteHandler<SwoopRouteParams>({
  capability: Capability.MACHINE_REMOTE_VIEW,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: {
    resource: 'machine',
    idParam: 'machineId',
    permission: 'write',
  },
})(stallHandler);
