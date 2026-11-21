/**
 * GET  /api/sites/{siteId}/deployments
 *      -> cursor-paginated list of installer deployments for a site.
 *
 * POST /api/sites/{siteId}/deployments
 *      -> create a deployment and fan out install_software commands.
 *
 * Thin HTTP shim: the mutation lives in
 * `web/lib/actions/createDeployment.server.ts`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  applyAuthDeprecations,
  auditActorIdentifier,
  readAndParseJsonBody,
} from '../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  nextPageTokenFromDocs,
  parsePagination,
} from '@/lib/pagination';
import {
  createDeployment,
  type CreateDeploymentInput,
  type CreateDeploymentResult,
} from '@/lib/actions/createDeployment.server';

type RouteParams = { siteId: string };

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

// GET - list deployments

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  // Opted in: enforced through the inner _shared gate until now, so without
  // this, removing that gate would drop the 400 on an unsupported
  // Roost-Version.
  roostVersioned: true,
  targetKind: 'deployment',
  apiKeyPermission: 'read',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId } = await routeContext.params;

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const db = getAdminDb();
    const deploymentsCol = db
      .collection('sites')
      .doc(siteId)
      .collection('deployments');

    let query = deploymentsCol.orderBy('createdAt', 'desc').limit(pageSize + 1);
    if (pageToken) {
      const cursorSnap = await deploymentsCol.doc(pageToken).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const nextPageToken = nextPageTokenFromDocs(snap.docs, pageSize);

    const items = docs.map((d) => serializeDeployment(d.id, d.data() ?? {}));

    return applyAuthDeprecations(
      NextResponse.json({ items, next_page_token: nextPageToken }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments:GET');
  }
});

// POST - create deployment

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  // Opted in: enforced through the inner _shared gate until now, so without
  // this, removing that gate would drop the 400 on an unsupported
  // Roost-Version.
  roostVersioned: true,
  targetKind: 'deployment',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId } = await routeContext.params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CreateDeploymentInput;


    return withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const result = await createDeployment(body, {
          siteId,
          createdBy: ctx.actor.userId,
          actorIdentifier: auditActorIdentifier(ctx.auth),
          correlationId: ctx.correlationId,
        });

        if (!result.ok) {
          return createDeploymentErrorToResponse(result);
        }

        return applyAuthDeprecations(
          NextResponse.json(
            {
              deploymentId: result.deploymentId,
              siteId: result.siteId,
              status: result.status,
              targets: result.targets,
            },
            { status: 201 },
          ),
          ctx.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments:POST');
  }
});

// helpers


function createDeploymentErrorToResponse(
  result: Extract<CreateDeploymentResult, { ok: false }>,
): NextResponse {
  if (result.code === 'over_quota') {
    return problem({
      type: ProblemType.PayloadTooLarge,
      title: 'over quota',
      status: 413,
      detail: result.message,
      code: 'over_quota',
      quota: result.details,
    });
  }

  return problemValidation(result.message, validationErrorsFor(result));
}

function validationErrorsFor(
  result: Extract<CreateDeploymentResult, { ok: false }>,
): Record<string, string[]> {
  switch (result.code) {
    case 'invalid_name':
      return { 'body.name': ['required non-empty string'] };
    case 'invalid_installer_name':
      return { 'body.installer_name': ['required non-empty string'] };
    case 'invalid_installer_url':
      return {
        'body.installer_url': [
          result.message === 'installer_url must be a valid URL'
            ? 'invalid url'
            : 'required non-empty string',
        ],
      };
    case 'installer_url_not_https':
      return { 'body.installer_url': ['must be https://'] };
    case 'invalid_silent_flags':
      return { 'body.silent_flags': ['required string'] };
    case 'invalid_verify_path':
      return { 'body.verify_path': ['must be a string'] };
    case 'invalid_close_processes':
      return { 'body.close_processes': ['must be a non-empty string array when provided'] };
    case 'invalid_suppress_projects':
      return { 'body.suppress_projects': ['must be a non-empty string array when provided'] };
    case 'invalid_sha256_checksum':
      return { 'body.sha256_checksum': ['must be 64-char hex'] };
    case 'invalid_machines':
      return {
        'body.machines': [
          result.message === 'machines must not be empty'
            ? 'must be non-empty'
            : 'must be string[]',
        ],
      };
    case 'invalid_active_hours_override':
      return { 'body.active_hours_override': [result.message] };
    default:
      return { body: [result.message] };
  }
}

function serializeDeployment(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : 'Unnamed Deployment',
    installer_name: typeof data.installer_name === 'string' ? data.installer_name : '',
    installer_url: typeof data.installer_url === 'string' ? data.installer_url : '',
    silent_flags: typeof data.silent_flags === 'string' ? data.silent_flags : '',
    verify_path: typeof data.verify_path === 'string' ? data.verify_path : null,
    sha256_checksum: typeof data.sha256_checksum === 'string' ? data.sha256_checksum : null,
    parallel_install: data.parallel_install === true,
    targets: Array.isArray(data.targets) ? data.targets : [],
    status: typeof data.status === 'string' ? data.status : 'pending',
    createdAt: timestampToIso(data.createdAt),
    completedAt: timestampToIso(data.completedAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}
