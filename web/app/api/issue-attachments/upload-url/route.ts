/**
 * POST /api/issue-attachments/upload-url
 *
 * Called by the dashboard's submit issue dialog before it posts the issue:
 * returns a 30-minute presigned PUT per screenshot or video, and the keys the
 * dialog then names as `files` in `POST /api/bug-report`. Each file goes
 * straight to R2 and never proxies through Next.js.
 *
 * Body: `{files: [{size, contentType}]}`, held to the desktop app's limits.
 * content-length and content-type are signed into each url, so R2 refuses a
 * body of any other size or type.
 * 200: `{files: [{key, uploadUrl}], expiresIn}`, in request order.
 *
 * Session only: agents send their attachments as one zip through their
 * machine's own issue-logs route. Rate limited per user.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ApiAuthError, requireSession } from '@/lib/apiAuth.server';
import { problemFromError, problemUnauthorized, problemValidation } from '@/lib/apiErrors';
import {
  ISSUE_LOGS_UPLOAD_TTL_SECONDS,
  presignIssueLogsUpload,
  webIssueFileKey,
} from '@/lib/issueLogsStorage.server';
import {
  ISSUE_FILE_TYPES,
  ISSUE_MAX_SCREENSHOTS,
  ISSUE_MAX_VIDEOS,
  issueFileExt,
  issueFileKind,
  issueFileLimitRefusal,
  issueFileTypeRefusal,
  type IssueFileExt,
} from '@/lib/issues';
import { checkRateLimit, webIssueUploadRateLimit } from '@/lib/rateLimit';
import { applyRateLimitCounters, rateLimitedResponse } from '@/lib/withRateLimit';

const MAX_FILES = ISSUE_MAX_SCREENSHOTS + ISSUE_MAX_VIDEOS;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    let userId: string;
    try {
      userId = await requireSession(request);
    } catch (err) {
      if (err instanceof ApiAuthError) return problemUnauthorized(err.message);
      throw err;
    }

    const rateLimitKey = `web_issue_upload:${userId}`;
    const rateResult = await checkRateLimit(webIssueUploadRateLimit, rateLimitKey);
    if (!rateResult.success) {
      console.warn(`[issue-attachments/upload-url] rate limited: ${rateLimitKey}`);
      return rateLimitedResponse(rateResult, 'endpoint-rate');
    }

    let body: { files?: unknown };
    try {
      body = (await request.json()) as { files?: unknown };
    } catch {
      return problemValidation('request body is not valid json');
    }

    const entries = body?.files;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_FILES) {
      return problemValidation(`files must list 1 to ${MAX_FILES} files`, {
        'body.files': [`array of 1..${MAX_FILES} {size, contentType}`],
      });
    }

    const files: { size: number; ext: IssueFileExt }[] = [];
    for (const [i, entry] of entries.entries()) {
      const { size, contentType } = (entry ?? {}) as { size?: unknown; contentType?: unknown };
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
        return problemValidation('size must be a whole number of bytes, at least 1', {
          [`body.files[${i}].size`]: ['integer, at least 1'],
        });
      }
      const ext = typeof contentType === 'string' ? issueFileExt(contentType) : null;
      if (!ext) {
        return problemValidation(issueFileTypeRefusal(typeof contentType === 'string' ? contentType : ''), {
          [`body.files[${i}].contentType`]: [Object.values(ISSUE_FILE_TYPES).join(', ')],
        });
      }
      files.push({ size, ext });
    }

    const refusal = issueFileLimitRefusal(files.map(({ size, ext }) => ({ kind: issueFileKind(ext), size })));
    if (refusal) return problemValidation(refusal);

    const signed = await Promise.all(
      files.map(async ({ size, ext }) => {
        const key = webIssueFileKey(userId, ext);
        return { key, uploadUrl: await presignIssueLogsUpload(key, size, ISSUE_FILE_TYPES[ext]) };
      }),
    );

    return applyRateLimitCounters(
      NextResponse.json({ files: signed, expiresIn: ISSUE_LOGS_UPLOAD_TTL_SECONDS }),
      rateResult,
    );
  } catch (err) {
    return problemFromError(err, 'issue-attachments/upload-url:POST');
  }
}
