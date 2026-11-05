# Web submit issue: attachments, no title — Plan
**Created**: 2026-10-16 | **Status**: Active | **Branch**: `feat/web-issue-attachments` (worktree `../Owlette-webissue-wt`, from origin/dev; push with `origin feat/web-issue-attachments:feat/web-issue-attachments`)

## Summary
The owner, 2026-10-16: the dashboard's submit issue dialog matches the desktop app's: "category and description and attachments -- no title required. of course, no 'attach logs' ... just remove title, add attachments. keep everything else the same -- make category full width too, like it is on desktop app."

The browser cannot use the agent's machine-scoped zip upload. So each file goes straight from the browser to the private issue bucket through a presigned PUT, and the issue records the uploaded files. Superadmins download each file from the issue page and the API. The limits match the desktop: up to 10 screenshots (PNG, JPEG or WebP, 8 MB each) and any number of videos (MP4, MOV or WebM, up to 20), 100 MB in total. Images can also be pasted.

## Approach
- **Storage (`web/lib/issueLogsStorage.server.ts`):**
  - `presignIssueLogsUpload` takes a content type; the zip keeps `application/zip`.
  - New `webIssueFileKey(uid, ext)` returns `issues/web/{uid}/{uuid}.{ext}`.
  - Same bucket, same 30-day lifecycle, same token.
  - Under `OWLETTE_E2E` the presign returns a same-origin sink route (`/api/issue-attachments/e2e-put`), modelled on `web/app/api/chunks/e2e-put`, so a real browser PUT works in e2e.
- **CORS:** `scripts/provision-r2.mjs` adds both issue-logs buckets to the CORS set: PUT/GET/HEAD from the dev, prod and localhost origins. The script must be re-run per environment; that is an owner step, because the classifier refused the run before. The CSP already allows `*.r2.cloudflarestorage.com`.
- **`POST /api/issue-attachments/upload-url`:**
  - Session only; internal, not in OpenAPI.
  - Exempt from the audit scan because it mints signed URLs and writes nothing.
  - Rate-limited per uid.
  - One batch call with `{files: [{size, contentType}]}`, validated against the limits, returns `{files: [{key, uploadUrl}], expiresIn}`.
- **`POST /api/bug-report`:**
  - The title becomes optional. When absent, it is derived from the first non-empty line of the user's text (`parseIssueDescription(...).text`), cut to 120 characters. The same rule replaces the agent's placeholder title `agent feedback`, so desktop issues stop all reading the same.
  - A session user may send `files: string[]`. Each key must be under `issues/web/{their uid}/` and match the strict pattern. The route HEADs each one for its size, never trusting the client, and enforces the counts and the 100 MB total.
  - The issue stores `files: [{key, kind, size, ext}]` and `filesExpireAt` (+30 days).
  - The email's attachment line counts them, with logs false.
- **Read side:**
  - `serializeIssue` adds `attachments.files: [{index, kind, size}]`, never keys. `available`, `size` and `expiresAt` cover web files when there is no zip.
  - New `GET /api/admin/issues/{id}/files/{n}` (`issue=*:read`) does a blocking global audit row (target issue) and a 302 to a presigned download named `owlette-issue-{number}-{n}.{ext}`.
  - Documented in OpenAPI.
  - The issue page lists each file with its own download.
  - The triage skill fetches `/files/{n}` the same safe way, without `-L`.
- **Dialog (`web/components/ReportBugDialog.tsx`):**
  - The title field is removed.
  - Category becomes `w-full`.
  - A new `web/components/IssueAttachments.tsx` mirrors the desktop component: the same copy, 64 px tiles, a film tile for videos, remove buttons, "add screenshots or video", the limit text and a notice for refusals.
  - It uses a hidden file input (`accept` for the six types) plus paste; a paste carrying `text/plain` stays with the textarea.
  - Submit flow:
    1. request URLs;
    2. PUT each file, showing "uploading attachments (N%)" inline;
    3. POST the issue with the keys.

    A failed upload leaves the dialog open with the error.
  - Everything else (copy, rotating titles, description limit, toasts) stays as it is.

## Waves
1. Storage (contentType, web key, e2e sink, shared limits in `web/lib/issues.ts`) and the CORS script, in parallel.
2. The upload-url route, the bug-report route and the read side (serializer, files route, OpenAPI), in parallel.
3. The dialog and attachments component; the issue page file list, the skill, the docs and the changelog.
4. e2e (dialog submit with a screenshot and a video, issue page download), the full checks, screenshots, `/verify`, the PR.

## Risks
- **CORS not applied:** browser uploads fail on dev until the owner re-runs provision-r2. The dialog must show a clear error, never a silent half-send.
- **Orphaned uploads:** a user who uploads and then cancels leaves objects behind. The bucket's 30-day lifecycle deletes them.
- **Content type:** the presign signs `content-type`, so the browser must send exactly the type it asked for. File types come from `File.type`, and anything not on the list is refused client-side and again server-side.

## Success Criteria
- On dev.owlette.app, a signed-in user submits an issue from the dashboard with no title, two screenshots (one pasted) and a video.
- The issue gets #N, with a derived title, and the email counts the attachments.
- On the issue page the superadmin downloads each file, and every download is audited.
- The API key with the issue scope lists `attachments.files` and downloads `/files/{n}`.
- The desktop flow is unchanged.
- jest, lint, tsc, `validate:api`, the e2e suite and `check-claude-hooks` all pass.
