/**
 * E2E-only issue file sink: the local stand-in for an R2 presigned PUT.
 *
 * `presignIssueLogsUpload` returns this route for a web issue file key under
 * OWLETTE_E2E=1 (see lib/issueLogsStorage.server.ts), so the dialog's browser
 * PUT lands here instead of at an unreachable host. Like R2 with its signed
 * headers, it refuses a body whose size or content-type differs from what was
 * presigned, then records the file for `headIssueLogs` to find.
 *
 * Hard-gated: outside OWLETTE_E2E=1 this endpoint does not exist (404), so it
 * can never become an unauthenticated write path in a real deployment.
 */
import { NextRequest, NextResponse } from 'next/server';
import { webIssueFileExt, recordIssueFileE2E } from '@/lib/issueLogsStorage.server';
import { ISSUE_FILE_TYPES } from '@/lib/issues';

export async function PUT(req: NextRequest): Promise<NextResponse> {
  if (process.env.OWLETTE_E2E !== '1') {
    return NextResponse.json({ title: 'not found' }, { status: 404 });
  }
  const params = req.nextUrl.searchParams;
  const key = params.get('key') ?? '';
  const ext = webIssueFileExt(key, key.split('/')[2] ?? '');
  if (!ext) {
    return NextResponse.json({ title: 'bad issue file key' }, { status: 400 });
  }
  const contentType = params.get('contentType');
  if (contentType !== ISSUE_FILE_TYPES[ext] || req.headers.get('content-type') !== contentType) {
    return NextResponse.json({ title: 'content-type does not match the presigned one' }, { status: 403 });
  }
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0 || String(bytes.byteLength) !== params.get('size')) {
    return NextResponse.json({ title: 'size does not match the presigned one' }, { status: 403 });
  }
  await recordIssueFileE2E(key, bytes.byteLength);
  return new NextResponse(null, { status: 200 });
}
