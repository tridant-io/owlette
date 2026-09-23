/**
 * GET    /api/sites/{siteId}/logs
 *        Cursor-paginated operational logs from `sites/{siteId}/logs`.
 *
 * DELETE /api/sites/{siteId}/logs
 *        Clear matching operational logs. Requires site admin scope and an
 *        Idempotency-Key because the delete is destructive.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '@/app/api/_shared';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  clearLogs,
  ClearLogsValidationError,
} from '@/lib/actions/clearLogs.server';
import { siteAuditActor } from '@/lib/actions/auditActor.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso, timestampToMs } from '@/lib/firestoreTime.server';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import { withIdempotency } from '@/lib/idempotency';

type RouteParams = {
  siteId: string;
} & Record<string, string | undefined>;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const VALID_LEVELS = new Set(['debug', 'info', 'warning', 'error', 'critical']);

interface DeleteBody {
  action?: unknown;
  actions?: unknown;
  machineId?: unknown;
  level?: unknown;
  since?: unknown;
  until?: unknown;
  all?: unknown;
}

interface SiteLogEntry {
  id: string;
  siteId: string;
  timestamp: string | null;
  action: string;
  level: string;
  machineId: string | null;
  machineName: string | null;
  processName: string | null;
  details: string | Record<string, unknown> | null;
  userId: string | null;
  screenshotUrl: string | null;
}

function normalizeOptionalString(
  body: DeleteBody,
  field: keyof DeleteBody,
): string | undefined | NextResponse {
  const value = body[field];
  if (value === undefined || value === null || value === 'all') return undefined;
  if (typeof value !== 'string') {
    return problemValidation(`field \`${field}\` must be a string when provided`, {
      [`body.${field}`]: ['must be a string'],
    });
  }
  return value;
}

/** A non-empty list of non-empty strings, or a 400. Used for `actions`. */
function normalizeOptionalStringArray(
  body: DeleteBody,
  field: 'actions',
): string[] | undefined | NextResponse {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    return problemValidation(
      `field \`${field}\` must be a non-empty array of non-empty strings when provided`,
      { [`body.${field}`]: ['must be a non-empty array of non-empty strings'] },
    );
  }
  return value as string[];
}

function normalizeOptionalQueryString(
  searchParams: URLSearchParams,
  field: string,
): string | undefined {
  const value = searchParams.get(field);
  if (value === null || value === '' || value === 'all') return undefined;
  return value;
}

function parseTimestampQuery(
  searchParams: URLSearchParams,
  field: 'since' | 'until',
): number | undefined | NextResponse {
  const raw = searchParams.get(field);
  if (raw === null || raw.trim() === '') return undefined;

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return problemValidation(`${field} must be unix-ms or iso8601`, {
      [`query.${field}`]: ['invalid date'],
    });
  }
  return parsed;
}

/** Parse a `since`/`until` value from a JSON body — unix-ms number or ISO 8601 string. */
function parseTimestampBody(
  body: DeleteBody,
  field: 'since' | 'until',
): number | undefined | NextResponse {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed !== '') {
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return problemValidation(`${field} must be unix-ms or iso8601`, {
    [`body.${field}`]: ['invalid date'],
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializeLogEntry(
  id: string,
  siteId: string,
  data: FirebaseFirestore.DocumentData,
): SiteLogEntry {
  const details = data.details;
  return {
    id,
    siteId,
    timestamp: timestampToIso(data.timestamp),
    action: typeof data.action === 'string' ? data.action : 'unknown',
    level: typeof data.level === 'string' ? data.level : 'info',
    machineId: typeof data.machineId === 'string' ? data.machineId : null,
    machineName: typeof data.machineName === 'string' ? data.machineName : null,
    processName: typeof data.processName === 'string' ? data.processName : null,
    details: typeof details === 'string' || isPlainObject(details) ? details : null,
    userId: typeof data.userId === 'string' ? data.userId : null,
    screenshotUrl: typeof data.screenshotUrl === 'string' ? data.screenshotUrl : null,
  };
}

function logMatches(
  log: SiteLogEntry,
  filters: {
    action?: string;
    machineId?: string;
    level?: string;
    sinceMs?: number;
    untilMs?: number;
  },
  rawTimestamp: unknown,
): boolean {
  if (filters.action !== undefined && log.action !== filters.action) return false;
  if (filters.machineId !== undefined && log.machineId !== filters.machineId) return false;
  if (filters.level !== undefined && log.level !== filters.level) return false;

  const timestampMs = timestampToMs(rawTimestamp);
  if (filters.sinceMs !== undefined && (timestampMs === null || timestampMs < filters.sinceMs)) {
    return false;
  }
  if (filters.untilMs !== undefined && (timestampMs === null || timestampMs > filters.untilMs)) {
    return false;
  }
  return true;
}

export async function GET(request: NextRequest, { params }: { params: Promise<RouteParams> }) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const searchParams = request.nextUrl.searchParams;
    const action = normalizeOptionalQueryString(searchParams, 'action');
    const machineId = normalizeOptionalQueryString(searchParams, 'machineId');
    const level = normalizeOptionalQueryString(searchParams, 'level');
    if (level !== undefined && !VALID_LEVELS.has(level)) {
      return problemValidation(
        `level must be one of: ${Array.from(VALID_LEVELS).join(', ')}`,
        { 'query.level': [`must be one of: ${Array.from(VALID_LEVELS).join(', ')}`] },
      );
    }

    const sinceMs = parseTimestampQuery(searchParams, 'since');
    if (sinceMs instanceof NextResponse) return sinceMs;
    const untilMs = parseTimestampQuery(searchParams, 'until');
    if (untilMs instanceof NextResponse) return untilMs;
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
      return problemValidation('since must be <= until', {
        'query.since': ['must be <= query.until'],
      });
    }

    const parsedPagination = parsePagination(searchParams, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const db = getAdminDb();
    const logsCol = db.collection('sites').doc(siteId).collection('logs');
    const filters = { action, machineId, level, sinceMs, untilMs };

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      batchLimit: Math.min(MAX_PAGE_SIZE + 1, Math.max(pageSize + 1, pageSize * 3 + 1)),
      fetchPage: async (cursor, limit) => {
        let query = logsCol.orderBy('timestamp', 'desc');
        if (sinceMs !== undefined) {
          query = query.where('timestamp', '>=', Timestamp.fromDate(new Date(sinceMs)));
        }
        if (untilMs !== undefined) {
          query = query.where('timestamp', '<=', Timestamp.fromDate(new Date(untilMs)));
        }
        query = query.limit(limit);
        if (cursor) {
          const cursorSnap = await logsCol.doc(cursor).get();
          if (cursorSnap.exists) query = query.startAfter(cursorSnap);
        }
        const snap = await query.get();
        return snap.docs;
      },
      include: (doc) => {
        const data = doc.data();
        const log = serializeLogEntry(doc.id, siteId, data);
        return logMatches(log, filters, data.timestamp);
      },
    });

    const logs = page.docs.map((doc) => serializeLogEntry(doc.id, siteId, doc.data()));

    return applyAuthDeprecations(
      NextResponse.json(withPaginationFields({ siteId, logs }, page.nextPageToken)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/logs:GET');
  }
}

export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: Capability.SITE_LOGS_MANAGE,
  siteIdParam: 'path',
  targetKind: 'site',
  apiKeyPermission: 'admin',
})(async (request: NextRequest, ctx) => {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as DeleteBody;

    const action = normalizeOptionalString(body, 'action');
    if (action instanceof NextResponse) return action;
    const actions = normalizeOptionalStringArray(body, 'actions');
    if (actions instanceof NextResponse) return actions;
    if (action !== undefined && actions !== undefined) {
      return problemValidation('provide either `action` or `actions`, not both', {
        'body.actions': ['omit when `action` is provided'],
      });
    }
    const machineId = normalizeOptionalString(body, 'machineId');
    if (machineId instanceof NextResponse) return machineId;
    const level = normalizeOptionalString(body, 'level');
    if (level instanceof NextResponse) return level;
    const sinceMs = parseTimestampBody(body, 'since');
    if (sinceMs instanceof NextResponse) return sinceMs;
    const untilMs = parseTimestampBody(body, 'until');
    if (untilMs instanceof NextResponse) return untilMs;
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
      return problemValidation('since must be <= until', {
        'body.since': ['must be <= body.until'],
      });
    }
    const hasFilter =
      action !== undefined ||
      actions !== undefined ||
      machineId !== undefined ||
      level !== undefined ||
      sinceMs !== undefined ||
      untilMs !== undefined;
    if (body.all !== undefined && body.all !== true) {
      return problemValidation('field `all` must be true when provided', {
        'body.all': ['must be true'],
      });
    }
    if (!hasFilter && body.all !== true) {
      return problemValidation('body.all=true is required when clearing all logs', {
        'body.all': ['must be true when no filters are provided'],
      });
    }
    if (hasFilter && body.all === true) {
      return problemValidation('body.all must be omitted when filters are provided', {
        'body.all': [
          'omit when any filter (action, actions, machineId, level, since, until) is provided',
        ],
      });
    }

    try {
      return await withIdempotency(
        request,
        {
          userId: ctx.actor.userId,
          environment: ctx.auth.keyContext?.environment ?? 'unknown',
        },
        parsed.raw,
        async () => {
          const result = await clearLogs(
            { siteId: ctx.siteId, auditActor: siteAuditActor(ctx) },
            {
              action,
              actions,
              machineId,
              level,
              sinceMs,
              untilMs,
            },
          );
          return applyAuthDeprecations(
            NextResponse.json({
              siteId: result.siteId,
              deletedCount: result.deletedCount,
              filters: result.filters,
            }),
            ctx.scopeCheck,
          );
        },
        { requireKey: true },
      );
    } catch (err) {
      if (err instanceof ClearLogsValidationError) {
        return problemValidation(err.message, { [`body.${err.field}`]: [err.message] });
      }
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/logs:DELETE');
  }
});
