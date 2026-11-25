# Submit issue with a full log zip — Plan
**Created**: 2026-10-13 | **Status**: Active | **Branch**: `feat/issue-logs` (worktree `../Owlette-issue-logs-wt`, cut from origin/dev 4c57f93f)

Origin: a macOS tester had to type an admin password to copy the logs folder, zip it and share it, and asked for a one-click export or "send to support".

## Summary

Rename the desktop app's "submit bug report" to **submit issue**, and add an opt-in **attach logs** checkbox. When ticked, the agent zips the machine-wide `logs/` tree plus the desktop app's own log, uploads the zip through a presigned PUT to a dedicated Cloudflare R2 bucket that expires objects after 30 days, and links it from the `bug_reports` record. Only superadmins (Tridant staff) can open it, through an audited route that redirects to a 15-minute presigned GET. No dashboard "download logs" button (privacy), and no local "export logs" menu item (it would need a new privileged verb of its own).

## Approach

### Data flow
1. **Dialog** (`desktop/src/components/ReportIssueDialog.tsx`) sends `{category, description, attachLogs}` through `runAgent('report-issue')`.
   - Windows: the desktop app spawns `python configure_site.py --report-issue <payload>` as the console user, unelevated.
   - macOS/Linux: the request seam (`desktop/src-tauri/src/seam.rs`, `Verb::ReportIssue`) hands it to the root daemon, which runs the same CLI as root.
2. **Agent** `run_report_issue` (`agent/src/configure_site.py`): when `attachLogs` is set, `log_bundle.build_log_zip()` writes a zip to a 0600 temp file, then:
   - `POST {web}/api/sites/{siteId}/machines/{machineId}/issue-logs/upload-url` with body `{size}` and the machine's bearer token → `{uploadUrl, key, expiresIn}`;
   - `PUT uploadUrl` streaming the file (`Content-Length` signed), using `screenshot_capture.upload_to_signed_url`'s retry semantics: 3 attempts, 4xx fails fast, 5xx and network errors retry;
   - `POST /api/bug-report` with `logsKey`.
   - Any failure in zip, URL or PUT → the report is still sent, with `\n\nlogs could not be attached: <reason>` added to the description. The temp zip is always deleted.
3. **`POST /api/bug-report`** (`web/app/api/bug-report/route.ts`):
   - agent tokens are recognised by `decoded.role === 'agent'` plus `site_id`/`machine_id` claims (not the UA string), and the record stores `siteId` and `machineId`;
   - `logsKey` is accepted only from an agent token, only under `issues/{site_id}/{machine_id}/`, and only if a HEAD finds the object;
   - the record stores `logs: {key, size, expiresAt}`;
   - the alert email adds a link to `/api/admin/issues/{id}/logs`.
4. **`GET /api/admin/issues/{id}/logs`** — superadmin only, with an audit row on every access → 302 to a 15-minute presigned GET with `Content-Disposition: attachment; filename="owlette-logs-<hostname>-<date>.zip"`. Returns 410 when `expiresAt` has passed or the object is gone.

### What goes in the zip (`log_bundle.py`)
- **Machine-wide:** every regular file under `shared_utils.get_data_path('logs')`, recursively (including `swoop/` and `roost_scrub_reports/`).
  - Walk with `os.scandir(follow_symlinks=False)`; skip symlinks and anything that is not a regular file.
  - Never read outside `logs/`: the data root holds `.tokens.enc` and `config/`.
- **Desktop app log:** `owlette-desktop.log*`.
  - Windows: `%LOCALAPPDATA%\app.owlette.desktop\logs\`, read as the running user.
  - macOS: `~<console user>/Library/Logs/app.owlette.desktop/`.
  - Linux: `~<console user>/.local/share/app.owlette.desktop/logs/`.
  - On POSIX, running as root: resolve the console user with the existing helper, open each file with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, `fstat`, and require a regular file with `st_uid == console uid` and `st_nlink == 1`. This is the pattern at `configure_site.py:1370-1385`. Refuse anything else and list it in the manifest.
- **Limits:**
  - skip files with mtime older than 14 days;
  - read newest first until 300 MB uncompressed is reached;
  - `ZIP_DEFLATED`, level 6;
  - stop adding once the compressed size would pass 50 MB;
  - anything skipped is listed in the manifest with the reason.
- **`manifest.txt`** at the zip root: agent version, OS, hostname, UTC time, and each included file with its size and mtime, then the skipped files with their reasons.
- **Never log the zip's contents.** Log only its size and file count.

### Storage
- Buckets: `owlette-dev-issue-logs` and `owlette-prod-issue-logs` on the same R2 account endpoint as roost (`R2_S3_ENDPOINT`, path style). ADR 0003 says customer firewalls allow the roost R2 endpoint by name, and a new bucket on that endpoint adds no new host.
- Lifecycle: delete objects 30 days after upload, set by `scripts/provision-r2.mjs` through the Cloudflare API (`/r2/buckets/{name}/lifecycle`).
- Its own R2 token, scoped to those two buckets: env vars `ISSUE_LOGS_R2_ACCESS_KEY_ID` and `ISSUE_LOGS_R2_SECRET_ACCESS_KEY`. This follows the installer token's precedent.
- `web/lib/issueLogsStorage.server.ts` is modelled on `installerStorage.server.ts`:
  - its own S3Client with `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` (without these, the presigned PUT fails);
  - bucket chosen by `currentEnv()` from `r2Client.server.ts`;
  - an `OWLETTE_E2E==='1'` stub.

### Key decisions
1. **"attach logs" is unticked by default.** A pre-ticked box is not valid consent under GDPR (Planet49). The copy states what is included, that it is kept 30 days, and that only Owlette support sees it.
2. **Kept 30 days**, enforced by an R2 lifecycle rule, with `expiresAt` on the record so the route can answer 410.
3. **The email link is the only way in.** No staff page lists issues yet; `bug_reports` has no UI today.
4. **The owner signs off the privacy-policy wording** (`web/app/privacy/page.tsx`: the retention row and the Cloudflare subprocessor row) before merge.
5. **Internal identifiers keep their names:** the `bug_reports` collection, the `report_issue` verb, the `--report-issue` CLI, `ReportIssueDialog`. Renaming them breaks agents in the field for no user gain. Only user-visible copy says "issue".
6. **Upload first, then the report** (two calls, no finalize state machine). An uploaded zip whose report never arrives just expires.
7. **The `ReportIssue` seam budget goes from 180 s to 600 s.** On macOS/Linux the desktop app waits for the daemon's terminal event, and a 10 MB zip on a 1 Mbps uplink takes about 80 s.

## Waves (detail in tasks.md)

- **Wave 1** (parallel, disjoint files):
  - 1.1 `log_bundle.py` + tests
  - 1.2 the R2 storage helper, provisioning, env manifest and runbook
  - 1.3 the "submit issue" rename
  - 1.4 carrying `attachLogs` through the seam: Rust + the agent's request check + budget
- **Wave 2** (parallel):
  - 2.1 the web API: upload-url route, bug-report changes, admin logs route, tests + e2e
  - 2.2 the agent attach flow in `run_report_issue`
  - 2.3 the desktop dialog checkbox
- **Wave 3:** 3.1 docs, privacy draft and changelog; 3.2 `/verify` + `/preflight`
- **Wave 4:** 4.1 owner sitting: provision, env, deploy to dev, real-machine proof on a Mac and a Windows box

## Risks
- **Root reads the user's home on POSIX.** A planted symlink or hard link could pull `.tokens.enc` or `/etc/shadow` into a zip sent off the box. Mitigated by O_NOFOLLOW + owner uid + nlink, with tests that plant each.
- **Personal data in logs:** hostnames, usernames, file paths, process names, and hoot prompt text in `cortex.log`. Mitigated by opt-in, explicit copy, 30-day expiry, superadmin-only access and audited downloads.
- **Version skew:**
  - a new agent against a web build without the route gets 404 on upload-url → the report goes without logs, with the reason;
  - an old agent against the new web is unchanged (`logsKey` is optional);
  - the desktop app and agent ship together in one installer.
- **Windows file locks:** Python logging and Rust std open log files with share-read, so the user process can read them. Test against a live `service.log`.
- **e2e must not reach real R2:** the stub in the storage helper.
- **Rate limits are per machine, not per IP:** a site's machines share one NAT IP.
- **`auditMutationCoverage.test.ts`:** the new routes must audit or be listed with a reason (the list "may only shrink").

## Success Criteria
- On a real Mac (the tester's case) and a Windows box: submit issue with "attach logs" ticked → no password prompt; the alert email links to a zip a superadmin can download; it contains `service.log`, the swoop logs, the desktop log and `manifest.txt`, and nothing from outside `logs/` except the desktop log.
- A site member or admin (non-superadmin) gets 403 on the logs route; an expired zip gets 410.
- With the box unticked, behaviour is unchanged apart from the new copy and siteId/machineId on the record.
- Agent pytest, desktop vitest + cargo test, web Jest, rules tests and the Playwright e2e suite are all green; `/preflight` passes.
- The R2 lifecycle rule is visible on both buckets.
