/**
 * GET /api/sites/{siteId}/machines/{machineId}/screenshots/image?path=screenshots/{siteId}/{machineId}/{name}
 *
 * The url every screenshot record carries (`screenshotImageUrl`): redirects to
 * a fresh 1-hour signed read url, so the dashboard's `<img>` loads a private
 * object on the viewer's own session and a stored link outlives any one
 * signature. The path must be one of this machine's screenshots.
 *
 * Auth: `machine=<id>:read` (api key) or site membership, as on the command poll.
 * A superadmin who holds no member row on the site is refused: 403.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemForbidden, problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  requireMachineAuthAndScope,
} from '../../../../../../_shared';
import {
  isMachineScreenshotPath,
  issueScreenshotReadUrl,
  SCREENS_MEMBERS_ONLY,
} from '@/lib/screenshotStorage.server';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;

    const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'read');
    if (!auth.ok) return auth.response;
    if (!auth.seesScreens) return problemForbidden(SCREENS_MEMBERS_ONLY);

    const storagePath = request.nextUrl.searchParams.get('path');
    const signed = isMachineScreenshotPath(storagePath, siteId, machineId)
      ? await issueScreenshotReadUrl(storagePath)
      : null;
    if (!signed) {
      return problemValidation("path must name one of this machine's screenshots", {
        'query.path': ['must be screenshots/{siteId}/{machineId}/{name} for this url'],
      });
    }

    const response = NextResponse.redirect(signed.url, 302);
    response.headers.set('Cache-Control', 'private, no-store');
    return applyAuthDeprecations(response, auth.scopeCheck);
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/screenshots/image:GET',
    );
  }
}
