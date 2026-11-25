/**
 * GET and PUT /api/admin/activity/settings — whether the activity emails go out and
 * to whom. Returns `{ enabled, recipients }`: the addresses mail goes to, which start
 * as the configured address until a list is saved.
 *
 * GET: superadmin session, or a `user=*:read` api key (as the feed beside it).
 * PUT `{ enabled: boolean, recipients: string[] }`: a platform mutation like the
 * email config and kill switch (GLOBAL_SETTINGS_WRITE, `user=*:admin` key), audited
 * by the wrapper. At most 10 addresses.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { MAX_RECIPIENTS, normaliseRecipients } from '@/lib/activity/emailRecipients';
import { readActivityEmailSettings, writeActivityEmailSettings } from '@/lib/activity/emailSettings.server';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '@/app/api/_shared';

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'user', 'read');
    if (!auth.ok) return auth.response;

    const settings = await readActivityEmailSettings(getAdminDb());
    return applyAuthDeprecations(NextResponse.json(settings), auth.scopeCheck);
  } catch (err) {
    return problemFromError(err, 'admin/activity/settings:GET');
  }
}

export const PUT = authorizedPlatformHandler({
  capability: 'GLOBAL_SETTINGS_WRITE',
})(async (request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problemValidation('request body is not valid json');
  }
  if (!body || typeof body !== 'object') return problemValidation('request body must be a json object');
  const { enabled, recipients } = body as Record<string, unknown>;

  if (typeof enabled !== 'boolean') {
    return problemValidation('enabled must be a boolean', { enabled: ['must be boolean'] });
  }
  const clean = normaliseRecipients(recipients);
  if (!clean.ok) {
    const errors = [
      ...clean.invalid.map((entry) => `not an email address: ${entry}`),
      ...(clean.tooMany ? [`at most ${MAX_RECIPIENTS} addresses`] : []),
    ];
    return problemValidation('invalid recipients', { recipients: errors });
  }

  const db = getAdminDb();
  const settings = { enabled, recipients: clean.recipients };
  await writeActivityEmailSettings(db, settings);
  return NextResponse.json(settings);
});
