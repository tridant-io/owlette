# Submit issue with a full log zip — Tasks
**Progress**: 9/10 complete

Work only in the worktree `C:\Users\admin\Documents\Git-restored\Owlette-issue-logs-wt` (branch `feat/issue-logs`). Never in the main checkout: other sessions use it. Read `plan.md` first. The API contract below is fixed, so wave-2 tasks can run in parallel.

**API contract**
- `POST /api/sites/{siteId}/machines/{machineId}/issue-logs/upload-url`
  - Bearer: the agent's ID token.
  - Body: `{size: int}`, where 1 ≤ size ≤ 52428800.
  - 200: `{uploadUrl, key, expiresIn}`, with `key = issues/{siteId}/{machineId}/{uuid}.zip`.
  - Errors: 400 bad size, 401/403 not that machine's agent, 404 when the route is not deployed, 429 rate-limited.
- `POST /api/bug-report`: the existing body plus an optional `logsKey: string`.
- `GET /api/admin/issues/{id}/logs`: superadmin → 302 to the presigned GET; 403 otherwise; 404 no such report or no logs; 410 expired.

## Wave 1: foundations (parallel)

- [x] **Task 1.1: log bundle builder**
  - Files: `agent/src/log_bundle.py` (new), `agent/tests/unit/test_log_bundle.py` (new)
  - Do:
    - Write `build_log_zip(dest_path: str) -> dict`, returning `{files: int, size: int, skipped: [(name, reason)]}`. Follow plan.md "What goes in the zip" exactly.
    - Machine logs: walk `shared_utils.get_data_path('logs')` recursively with `os.scandir` and `follow_symlinks=False`; regular files only.
    - Desktop log dir per OS:
      - Windows: `os.environ['LOCALAPPDATA']`.
      - POSIX: the console user's home via `pwd` and the console-user resolver already used by `configure_site.py`. Look at `_console_user`-style helpers near `configure_site.py:1171` and `:1459`. Import that helper or move it to a shared place if it is cleanly separable; do not duplicate it.
      - When `os.geteuid() == 0`, open each desktop log with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and `fstat` it. Require `S_ISREG`, `st_uid == console uid` and `st_nlink == 1`; otherwise skip with a reason. Read from that fd.
    - Limits:
      - mtime older than 14 days → skipped;
      - newest first, stop at 300 MB uncompressed;
      - `zipfile.ZIP_DEFLATED`, compresslevel 6;
      - stop when the archive passes 50 MB, checking the dest file size after each write and finishing the current entry.
      - Put the constants at module top with a one-line lowercase why each.
    - Write `manifest.txt` last: agent version (`shared_utils`), platform, hostname, UTC timestamp, included files (relative arcname, size, mtime ISO), skipped files with reasons.
    - Arcnames: `logs/<relative path>` and `desktop/<file>`.
    - Create `dest_path` 0600 (`os.open` with mode).
    - Never log file contents; log one info line with count and size.
  - Done when:
    - pytest covers: normal tree incl. `swoop/`; symlink inside `logs/` skipped; desktop log symlink refused (POSIX; skip the test on Windows); desktop log owned by another uid refused (mock `fstat`); hard link (`nlink` 2) refused; old file skipped; uncompressed budget respected; compressed cap respected; manifest lists included and skipped files; nothing outside `logs/` and the desktop dir ever appears.
    - `agent/.venv/Scripts/python -m pytest agent/tests/unit/test_log_bundle.py` passes.

- [x] **Task 1.2: issue-logs R2 storage + provisioning**
  - Files: `web/lib/issueLogsStorage.server.ts` (new), `web/__tests__/lib/issueLogsStorage.test.ts` (new), `scripts/provision-r2.mjs`, `scripts/env-manifest.json`, `web/__tests__/infra/envManifest.test.ts`, `docs/runbooks/manual-infrastructure.md`
  - Do:
    - Model the helper on `web/lib/installerStorage.server.ts`:
      - its own `S3Client` on `R2_S3_ENDPOINT` + `ISSUE_LOGS_R2_ACCESS_KEY_ID`/`ISSUE_LOGS_R2_SECRET_ACCESS_KEY`, with `forcePathStyle`, `region: 'auto'` and `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`;
      - bucket `owlette-${currentEnv()}-issue-logs`, reusing `currentEnv` from `web/lib/r2Client.server.ts`.
    - Exports:
      - `issueLogsKey(siteId, machineId)` → `issues/{siteId}/{machineId}/{uuid}.zip`;
      - `presignIssueLogsUpload(key, size)`: `PutObjectCommand` with `ContentLength: size` and `ContentType: 'application/zip'` signed, TTL 15 min;
      - `headIssueLogs(key)` → `{size} | null`;
      - `presignIssueLogsDownload(key, filename)`: TTL 15 min, `ResponseContentDisposition` attachment;
      - `ISSUE_LOGS_MAX_BYTES = 50 * 1024 * 1024`;
      - `ISSUE_LOGS_RETENTION_DAYS = 30`.
    - Stub real R2 when `OWLETTE_E2E === '1'`, as `r2Client.server.ts:122,184` does.
    - `provision-r2.mjs`: add the two buckets and a full-replace lifecycle PUT (Cloudflare API `PUT /accounts/{id}/r2/buckets/{name}/lifecycle`, a rule deleting objects 30 days after upload), modelled on `putBucketCors`. Do not widen the existing roost token scope (`:283-287`). Print the instruction to create a separate token scoped to the two issue-logs buckets, as the installer token was done.
    - `env-manifest.json`: add `ISSUE_LOGS_R2_ACCESS_KEY_ID` and `ISSUE_LOGS_R2_SECRET_ACCESS_KEY` on railway-dev, railway-prod and vercel-prod, with notes naming the bucket scope, copying the `INSTALLER_R2_*` entries (`:86-87`). Add the matching block to `envManifest.test.ts`, like the installer-release and plan-key blocks.
    - Runbook: update the "R2 object lifecycle rules | not implemented" row (`manual-infrastructure.md:49`) to name the issue-logs rule and how to re-apply it.
  - Done when:
    - Jest covers: key shape; the presigned PUT URL carries content-length in its signed headers; the e2e stub path.
    - `npx eslint` is clean on the new and edited TS files.
    - `node scripts/sync-env.mjs check` passes its manifest self-checks (live drift is expected until the owner sets the values).
    - `npm test -- envManifest` passes.

- [x] **Task 1.3: rename "submit bug report" → "submit issue" (user-visible copy only)**
  - Files: `desktop/src/components/AppMenu.tsx`, `desktop/src/components/AppMenu.test.tsx`, `desktop/src/components/ReportIssueDialog.tsx` (title string only), `desktop/src/components/ReportIssueDialog.test.tsx` (if it asserts the title), `web/components/ReportBugDialog.tsx` (copy only), `GLOSSARY.md`, `desktop/README.md`, `web/e2e/desktop-screenshots/agent-app.spec.ts`, `web/e2e/desktop-videos/09-the-owlette-app.video.ts`, `web/e2e/desktop-videos/16-logs-and-troubleshooting.video.ts`, `web/e2e/desktop-videos/README.md`, `web/e2e/videos/16-logs-and-troubleshooting.video.ts`, `dev/video-tutorials/scripts/09-the-owlette-app.md`, `dev/video-tutorials/scripts/16-logs-and-troubleshooting.md`, `dev/video-tutorials/assembly/manifests/09-the-owlette-app.json`, `dev/video-tutorials/assembly/manifests/16-logs-and-troubleshooting.json`
  - Do:
    - Replace user-visible "submit bug report" / "bug report" copy with "submit issue" / "issue", lowercase per house style.
    - Do NOT rename identifiers, file names, the `bug_reports` collection, the `report_issue` verb, the `--report-issue` CLI or API paths.
    - Read `web/components/ReportBugDialog.tsx` and change only its visible strings so the dashboard and desktop say the same thing.
    - Add a `GLOSSARY.md` entry for **issue** (what a user files from the desktop app or dashboard to reach Owlette support), with _Avoid_: bug report, feedback, ticket. Match the format of the existing entries.
    - Leave docs pages under `web/content/docs/` to Task 3.1.
    - Run `rg -i "bug report" desktop/src web/components web/e2e dev/video-tutorials` and confirm only identifiers remain.
  - Done when:
    - `cd desktop && npx vitest run` passes.
    - eslint is clean on the edited web files.
    - The grep shows no user-visible "bug report" left in those trees.

- [x] **Task 1.4: carry `attachLogs` through the request seam**
  - Files: `desktop/src-tauri/src/seam.rs`, `agent/src/configure_site.py` (`_accept_request` only, ~`:1400-1415`), `agent/tests/unit/test_configure_site_headless.py` (seam report tests ~`:1316-1369`)
  - Do:
    - `seam.rs`: the ReportIssue request already forwards `category` and `description` from the payload. Forward `attachLogs` as a JSON bool too, and update the module doc (`:11-12`).
    - Raise the `Verb::Leave | Verb::ReportIssue` budget at `:78`: split it so `ReportIssue` gets `Duration::from_secs(600)` and `Leave` keeps 180. Add a lowercase comment: the zip upload on a slow uplink.
    - Add `ReportIssue` to the verb-spelling test (`~:565`, which currently omits it).
    - Extend the `a_report_carries_its_fields_…` test (`:449`) to assert `attachLogs`.
    - `_accept_request`: accept `attachLogs` only when it is absent or a real `bool` (reject strings and numbers like the other report fields), and pass it through in the `report` dict as `attachLogs`.
    - Keep the 8192-byte cap untouched.
    - Check whether the Windows path (`agent_cli.rs` `stage_payload`) already passes the payload through verbatim. It should; if it filters fields, add `attachLogs` there too and note that file here.
  - Done when:
    - `cd desktop/src-tauri && cargo test` passes, including the new assertions.
    - Pytest passes, with new cases: `attachLogs` true accepted and passed through; `"yes"` rejected; absent → not set.
  - Depends on: nothing (does not touch `run_report_issue`; Task 2.2 does).

## Wave 2: features (parallel)

- [x] **Task 2.1: web API — upload URL, report binding, superadmin download**
  - Files:
    - `web/app/api/sites/[siteId]/machines/[machineId]/issue-logs/upload-url/route.ts` (new)
    - `web/app/api/admin/issues/[id]/logs/route.ts` (new)
    - `web/app/api/bug-report/route.ts`
    - `web/lib/rateLimit.ts`
    - `web/__tests__/api/issueLogsUploadUrl.test.ts` (new), `web/__tests__/api/bugReport.test.ts` (new), `web/__tests__/api/adminIssueLogs.test.ts` (new)
    - `web/__tests__/api/auditMutationCoverage.test.ts`
    - `web/scripts/validate-openapi.ts` and the OpenAPI spec source it validates
    - `web/e2e/issue-logs.spec.ts` (new)
  - Do:
    - **upload-url route:** copy the shape of `web/app/api/sites/[siteId]/machines/[machineId]/screenshots/upload-url/route.ts`.
      - Auth: `requireMachineAuthAndScope` (`web/app/api/_shared.ts:558`) AND require `decoded.role === 'agent'` with matching `site_id`/`machine_id` claims. A site member's session must not pass (see `web/app/api/agent/swoop/_shared.ts` / `requireSwoopAgent`).
      - Validate `size` (integer, 1..`ISSUE_LOGS_MAX_BYTES`).
      - Add a per-machine limiter `issueLogsUploadRateLimit` in `rateLimit.ts`: 5 per hour, keyed `siteId:machineId`, following `screenshotUploadRateLimit` at `:137`.
      - Return the contract shape.
    - **bug-report route:**
      - Read the agent claims from the verified token. Set `source: 'agent'` from `role === 'agent'`, not from the `browserUA` prefix.
      - Store `siteId` and `machineId` from the claims.
      - Accept `logsKey` only from an agent token, only if it starts with `issues/{site_id}/{machine_id}/` and ends `.zip`, and only if `headIssueLogs` finds it.
      - Store `logs: {key, size, expiresAt}`, with `expiresAt` = now + `ISSUE_LOGS_RETENTION_DAYS`. If the key is invalid or missing, reject with 400; the agent falls back to sending without logs.
      - Add the staff link `{origin}/api/admin/issues/{id}/logs` to the Resend email when logs are attached.
      - Fix the stale header comment (description ≤5000 vs the 50,000 code) and the `'2.4.2'` appVersion fallback (read the real version source used elsewhere in web, or drop the fallback).
    - **admin logs route:**
      - Gate with `requireAdmin` (`web/lib/apiAuth.server.ts:145`, which enforces superadmin) or `requirePlatformAuthAndScope`; pick whichever the other `/api/admin/*` routes use.
      - Load the `bug_reports/{id}` doc via the Admin SDK: 404 if missing or no `logs`; 410 if `expiresAt` passed or the HEAD misses.
      - Emit an audit row (via the repo's audit helper; read how `authorizedPlatformHandler` / `emitMutation` record access) naming the report id and the actor.
      - 302 to `presignIssueLogsDownload` with filename `owlette-logs-<hostname>-<YYYY-MM-DD>.zip`; hostname from the stored `pageUrl` `agent://<hostname>`.
    - **Coverage, spec and tests:**
      - Classify both new routes in `auditMutationCoverage.test.ts`.
      - Add both routes to the OpenAPI spec so `validate-openapi` passes.
      - Jest:
        - upload-url: agent ok; member session 403; other machine 403; size 0 / too big 400; rate limited 429.
        - bug-report: logsKey from another machine's prefix 400; logsKey from a user session 400; valid key stored with expiresAt; siteId/machineId stored.
        - admin route: superadmin 302; admin/member 403; expired 410; audit emitted.
      - Playwright `issue-logs.spec.ts` on the emulator with the storage stub: seed a `bug_reports` doc with `logs`; a superadmin request gets the redirect; a site admin gets 403.
  - Done when:
    - `cd web && npm test` passes.
    - `npx eslint` is clean on every touched file.
    - `npx tsc --noEmit` is clean.
    - `npm run e2e -- issue-logs` passes.
  - Depends on: Task 1.2.

- [x] **Task 2.2: agent attach flow**
  - Files: `agent/src/configure_site.py` (`run_report_issue`, `submit_report`, ~`:838-943`), `agent/tests/unit/test_configure_site_headless.py` (`TestReportIssue` ~`:545-605`)
  - Do:
    - In `run_report_issue`, read `payload.get('attachLogs') is True`. When set:
      - `_emit('status', 'zipping logs')`;
      - `log_bundle.build_log_zip()` into a `tempfile.mkstemp(suffix='.zip')` path;
      - `_emit('status', 'uploading logs')`;
      - request the upload URL per the contract, using `AuthManager(...).get_valid_token()` and `siteId`/`machineId` from config as `build_report_data` already does;
      - PUT the file streamed (`open(path, 'rb')`, explicit `Content-Length`, `Content-Type: application/zip`, timeout `(30, 300)`). Reuse `screenshot_capture.upload_to_signed_url` if it can take a file object cleanly; otherwise write a small sibling with the same retry semantics, and do not duplicate the backoff constants.
      - On success, pass `logsKey` into `submit_report`.
      - On any exception, log a warning (no token, no URL query string) and append `\n\nlogs could not be attached: <short reason>` to the description.
      - Always delete the temp zip in `finally`.
    - Send `siteId` in the `submit_report` body too, so that once the web change lands the record no longer depends on the claims alone. The route trusts claims, but this keeps old/new parity readable.
    - Keep the 50,000 description cap logic.
  - Done when:
    - Pytest covers: no attachLogs → no zip/upload calls; attachLogs success → logsKey sent and temp file removed; upload-url 404 (old server) → report sent with the reason line; PUT 403 → no retry, report sent with reason; zip failure → report sent; the temp file is removed in every case.
    - The full `agent/.venv/Scripts/python -m pytest agent/tests/` is green.
  - Depends on: Task 1.1, Task 1.4.

- [x] **Task 2.3: desktop dialog consent checkbox**
  - Files: `desktop/src/components/ReportIssueDialog.tsx`, `desktop/src/components/ReportIssueDialog.test.tsx`, `desktop/src/lib/agentCli.ts` (stale comment `:8-10` only), `web/e2e/desktop-screenshots/agent-app.spec.ts`
  - Do:
    - Add an unticked-by-default "attach logs" checkbox, using the shadcn checkbox primitive already in `desktop/src/components/ui` (add none if it is missing; ask first).
    - Under it, muted helper copy, lowercase: "includes the service, swoop, hoot, pairing and installer logs from this machine plus this app's log. they can contain hostnames, user names, file paths and process names. kept 30 days, seen only by owlette support."
    - Send `attachLogs: boolean` in the `runAgent('report-issue', {payload})` payload.
    - The dialog keeps showing its busy state; the submit can now take minutes, so make sure no client-side timeout in `agentCli.ts` is shorter than 600 s. Check `runAgent`; if one exists, raise it for report-issue only.
    - Fix the stale `agentCli.ts:8-10` comment: report-issue goes through the seam off Windows since 7ce3d628.
    - Reset the checkbox on reopen like the other fields.
    - Update the screenshot spec to capture the dialog with the checkbox visible.
  - Done when:
    - vitest covers: default unticked; payload carries `attachLogs: false` by default and `true` when ticked; reset on reopen.
    - `cd desktop && npx vitest run` passes.
    - The screenshot spec passes.
    - The helper copy is lowercase and uses theme tokens only.
  - Depends on: Task 1.3, Task 1.4.

## Wave 3: docs and verification

- [x] **Task 3.1: docs, privacy draft, changelog**
  - Files: `web/content/docs/agent/troubleshooting.mdx`, `web/content/docs/reference/firestore-data-model.mdx`, `web/content/docs/agent/index.mdx`, `web/content/docs/agent/configuration.mdx`, `web/content/docs/architecture.mdx`, `web/app/privacy/page.tsx`, `docs/changelog.md`, `web/content/docs/changelog.mdx`
  - Do:
    - Rename the user-visible "bug report" copy in docs to "submit issue" / "issue".
    - troubleshooting.mdx: a section "sending logs to support" covering what the zip contains, that it is opt-in, kept 30 days and seen only by Owlette support. Fix the false claim at `~:426` that the site ID was attached (it now is, via the token claims).
    - firestore-data-model.mdx `~:700`: add `siteId`, `machineId`, `logs {key,size,expiresAt}` to the `bug_reports` row.
    - privacy/page.tsx: add the issue-logs row to the §6 retention list (`~:200-212`, 30 days) and widen the Cloudflare subprocessor description (`~:250-251`) to include diagnostic logs a user chooses to send. Mark the PR as needing owner sign-off on this wording; do not merge without it.
    - Changelog: an Unreleased "added" entry in both files, written for users.
  - Done when:
    - `cd web && npm run build` passes (mdx compiles).
    - eslint is clean on `privacy/page.tsx`.
    - The `rg -i "bug report" web/content` result is only identifiers or historical changelog entries.
  - Depends on: Wave 2.

- [x] **Task 3.2: verify**
  - Files: none new
  - Do: run `/verify` on the branch diff (standards + spec reviewers), then `/preflight` (security alerts, lint, typecheck, unit, rules, local e2e). Fix the findings. Run the full agent pytest and `cargo test` in `desktop/src-tauri`.
  - Done when: all suites are green, the review findings are resolved or explicitly answered, and the branch is ready for a PR to `dev`. Don't push until the owner says go.
  - Depends on: Task 3.1.

## Wave 4: owner sitting (one sitting, batched with tridant:wizard)

- [ ] **Task 4.1: provision, deploy, prove on real machines**
  - Do:
    - Prepare one wizard sheet with exact values:
      - run `node scripts/provision-r2.mjs` for the buckets and lifecycle;
      - create the scoped R2 token in the Cloudflare dashboard;
      - set `ISSUE_LOGS_R2_*` with `node scripts/sync-env.mjs sync` on railway-dev, railway-prod and vercel-prod;
      - sign off the privacy wording.
    - After the PR merges to dev: build a dev installer per the build-system skill; install it on a Windows box and on the MacBook (`reference_mba_access`).
    - On each: submit an issue with logs ticked; open the email link as a superadmin; unzip and check the contents against plan.md; open the link as a non-superadmin → 403.
    - Confirm the lifecycle rule via the Cloudflare API.
  - Done when: the before/after proof is captured on both machines, and the tester's flow (Mac, no admin password) works.
  - Depends on: Task 3.2.

## Log
### 2026-10-13
- Plan created, ready for execution. The owner approved it with the five recommended calls (unticked by default, 30 days, email link only, owner signs off privacy copy, no local export).
- Wave 1 done (1.1-1.4). Build check: web tsc clean, agent pytest 2278 passed / 433 skipped. Seam + log_bundle POSIX paths also run on the kiosk VM.
  - 1.1 went further: O_NOFOLLOW + nlink==1 on the whole logs/ tree (logs/swoop is group-writable); zip cap is 50*1000*1000 decimal and cuts the last entry short so it never exceeds the route's 50 MiB limit. Uses osadapter.console_user().
  - 1.2 exports issueLogsKey, presignIssueLogsUpload(key,size), headIssueLogs, presignIssueLogsDownload(key,filename), ISSUE_LOGS_MAX_BYTES, ISSUE_LOGS_RETENTION_DAYS, ISSUE_LOGS_E2E_SIZE. The PUT signs content-length;content-type;host, so the agent must send exactly size bytes with Content-Type application/zip. The helper does not cap size; the route must. sync-env check not run (it hits live CLIs).
  - 1.3 also renamed the dashboard help-menu trigger in web/components/PageHeader.tsx.
  - 1.4: no forwarding code needed; nothing daemon-side kills the report child before 600 s.
  - Owed: Windows log-rotation-during-copy check on a real machine; kiosk VM scratch dirs ~/scratch/issue-logs-1.4 and ~/log-bundle-test need the owner's ok to delete.
- Wave 2 done (2.1-2.3). Build check: agent pytest 2288 passed / 433 skipped, web tsc clean, desktop vitest 534 passed. 2.1: jest 7711 passed, validate:api ok, e2e issue-logs 2/2 on shifted ports.
  - 2.1: upload-url answers a flat {uploadUrl, key, expiresIn: 900}; the agent's {ok, data} fallback was removed. The e2e spec lives at web/e2e/specs/admin/issue-logs.spec.ts. .gitignore gained !web/app/api/admin/issues/*/logs/ because the logs/ rule hid the route. The admin route is gated by requirePlatformAuthAndScope(req,'user','admin') and writes a blocking global audit row (MACHINE_VIEW, target machine, metadata.action issue_logs_download). The email link uses trustedBaseUrl().
  - 2.2: a 400 on logsKey resends once without it; any non-200 from upload-url (incl. 429) still sends the issue.
  - 2.3: the screenshot spec is not run (it drives the installed exe); the visual check of the dialog is owed from a local build before merge.
  - Open owner calls: a site-audit row so the customer sees that support downloaded their logs; a dedicated audit target kind for issues.
- Wave 3.1 done, plus the owner-approved site audit row: the admin logs route also writes sites/{siteId}/audit_log (actor system:owlette_support; the staff uid stays only in the global row; 503 if either write fails). No dashboard view or public API lists those rows today (the audit-log API returns only hash-chained records), so the docs say "every download is audited" and do not claim the customer can see it. A site audit view is a follow-up.
  - Privacy wording drafted (§6 issue-logs row, §7 Cloudflare purpose) and awaiting owner sign-off; lastUpdated not bumped.
  - The build needs SESSION_SECRET (the worktree has no .env.local). docs-screens/agent-report-issue.png is stale until recaptured from a build with the checkbox.
  - Changelog will conflict with 4.1.12 (on fix/swoop-smear, not yet on dev).
- 3.2 done. /verify: standards found 1 medium (directory swap race in log_bundle's walk; fixed with a descriptor walk, red-on-old and green-on-new on the kiosk VM) and 4 lows (duplicated agent-claim check -> resolveAgentPrincipal; duplicated upload retry -> shared upload_to_signed_url streams files and names network errors by type; dead siteId body field removed; "feedback" copy). Spec found: admin route validated the id before auth (fixed), and the user was never told when logs failed (done event now carries logsAttached; dialog warns). The upload failure reason in the issue is now just "the upload to storage failed": storage's error reply can echo the signed request.
  - After fixes: agent 2288 passed / 434 skipped; desktop 538; web jest 7719, tsc clean, lint 0 errors (5 old warnings in untouched files); validate:api ok.
  - /preflight: security CLEAR (38 warnings incl. expired CodeQL waivers from 2026-10-12, not this change); rules skipped (untouched); e2e 533 passed, 1 failed (time-travel/heartbeat-recovery, outside this change); that spec + issue-logs rerun x3 -> 9/9 passed, so it is a flake.
  - Owed before merge: a visual check of the dialog from a local desktop build; the owner's privacy wording sign-off.
