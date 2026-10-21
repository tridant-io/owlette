# Submit issue with a full log zip — Context
**Last updated**: 2026-10-13

Worktree: `C:\Users\admin\Documents\Git-restored\Owlette-issue-logs-wt`, branch `feat/issue-logs` (no upstream; push with an explicit `origin feat/issue-logs:feat/issue-logs` refspec). The main checkout belongs to other sessions (swoop smear, 4.1.12 build). Do not work there.

## Key Files

**Create**
- `agent/src/log_bundle.py`, `agent/tests/unit/test_log_bundle.py`
- `web/lib/issueLogsStorage.server.ts`, `web/__tests__/lib/issueLogsStorage.test.ts`
- `web/app/api/sites/[siteId]/machines/[machineId]/issue-logs/upload-url/route.ts`
- `web/app/api/admin/issues/[id]/logs/route.ts`
- `web/__tests__/api/{issueLogsUploadUrl,bugReport,adminIssueLogs}.test.ts`, `web/e2e/issue-logs.spec.ts`

**Modify**
- **Agent:** `agent/src/configure_site.py` (`run_report_issue` / `submit_report` `:838-943`, `_accept_request` `:1353-1415`), `agent/tests/unit/test_configure_site_headless.py`.
- **Desktop:** `desktop/src-tauri/src/seam.rs` (`:11-12`, `:66`, `:78`, tests `:449`, `:565`), `desktop/src/components/ReportIssueDialog.tsx` + test, `desktop/src/components/AppMenu.tsx` + test, `desktop/src/lib/agentCli.ts`.
- **Web:** `web/app/api/bug-report/route.ts`, `web/lib/rateLimit.ts`, `web/components/ReportBugDialog.tsx`, `web/__tests__/api/auditMutationCoverage.test.ts`, `web/scripts/validate-openapi.ts`, `web/app/privacy/page.tsx`.
- **Infra:** `scripts/provision-r2.mjs`, `scripts/env-manifest.json`, `web/__tests__/infra/envManifest.test.ts`, `docs/runbooks/manual-infrastructure.md`.
- **Docs:** `GLOSSARY.md`, `docs/changelog.md`, `web/content/docs/**` (troubleshooting, data model, agent index/configuration, architecture, changelog), and the e2e video/screenshot specs and video-tutorial scripts that show the old copy.

**Reference (read, don't change)**
- `web/lib/installerStorage.server.ts`: the template for the R2 helper (checksum flags).
- `web/lib/r2Client.server.ts`: `currentEnv()` and the e2e stub pattern.
- The screenshot upload-url route and `agent/src/screenshot_capture.py:194-340`: the agent's upload → PUT pattern.
- `web/app/api/_shared.ts:558` (`requireMachineAuthAndScope`), `web/app/api/agent/swoop/_shared.ts` (agent-only gate), `web/lib/apiAuth.server.ts:145` (`requireAdmin` = superadmin).
- ADR 0003: agents dial out only, to named hosts; the roost R2 endpoint is already on the customer allowlist.

## Decisions
1. **Unticked by default.** A pre-ticked box is not valid consent under GDPR.
2. **Kept 30 days,** enforced by an R2 lifecycle rule, with `expiresAt` on the record so the route can answer 410.
3. **The email link is the only way in** for now; there is no staff issues page.
4. **The owner signs off the privacy-policy wording** before merge.
5. **No local "export logs" item, and no dashboard "download logs".**
6. **Internal names stay** (`bug_reports`, `report_issue`, `--report-issue`, `ReportIssueDialog`); only user-visible copy says "issue". Renaming them would break agents in the field.
7. **Dedicated buckets `owlette-{dev,prod}-issue-logs` with their own scoped token,** on the same account endpoint, so no new customer firewall host.
8. **Upload first, then report;** if the upload fails, the report is still sent, with the reason.
9. **On POSIX, root reads the desktop log only through O_NOFOLLOW + owner uid + nlink == 1.**
10. **The `ReportIssue` seam budget goes from 180 s to 600 s.**
11. **The bug-report route identifies agents by token claims, not the User-Agent header,** and stores siteId and machineId.

## Next Steps
1. Run Wave 1 (Tasks 1.1–1.4) in parallel; their file sets are disjoint.
2. The worktree needs its own `npm ci` in `web/` (and `desktop/`) before tests. Turbopack rejects a junctioned node_modules.
3. The agent venv: reuse the main checkout's `agent/.venv` Python to run pytest from the worktree, or bootstrap one there.
