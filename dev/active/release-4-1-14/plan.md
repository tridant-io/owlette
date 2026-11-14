# 4.1.14 — Plan
**Created**: 2026-10-14 | **Status**: Active | **Branch**: `feat/issue-dialog-progress` (worktree `../Owlette-4114-wt`, cut from origin/docs/issue-logs-env = dev + PR #375)

The owner asked for this release to go out tonight (2026-10-14), coordinated with the swoop session (owlette-ac [0639dc]). That session owns PR #376 (fix/swoop-gap-count) and the swoop files; this session owns everything below and drives the release.

## Summary
Follow-ups from the first real use of issue logs on A4D (4.1.13):
- the submit issue dialog looked frozen while sending;
- the reason a log attach failed was saved nowhere on Windows;
- issue emails share ADMIN_EMAIL_* with the other admin mail;
- the owner wants the app menu reordered.

## Approach
1. **Dialog progress** (desktop). `runAgent` already passes `onEvent` to `startAgentRun`, and the agent already emits status lines (collecting system info and recent logs → zipping logs → uploading logs → submitting). The dialog gets a lucide `Loader2` spinning in the submit button and a live, muted line with the current step. No protocol change.
2. **App menu order** (desktop), as the owner gave it:
   - swoop
   - docs, submit issue, config, logs
   - appearance, start on login, restart service, reload window
   - leave site / join site, last and in a section of its own
3. **Attach failure logged** (agent). The `--report-issue` mode writes its log lines to `logs/report_issue.log` (rotating, small) on every OS, so a failed attach can be diagnosed from the machine.
4. **ISSUE_EMAIL** (web). An optional env var for where issue alerts go; unset falls back to `ADMIN_EMAIL_*`, so nothing changes until it is set. It goes in the manifest, `web/.env.example` and the env docs.

## Release
- Cut `release/4.1.14` locally from origin/dev, then merge this branch (it carries #375) and origin/fix/swoop-gap-count (#376).
- Bump with sync-versions, and write the changelog: mine plus #376's PR-body text.
- Build the exe here, the pkg on the MBA (LaunchAgent job) and the deb on the kiosk.
- Upload to dev with `--set-latest`, verify each sha256, then merge #375, the feature PR, #376 and the release PR, and tag `v4.1.14`.

## Not in scope / owed by the owner
- The `ISSUE_LOGS_R2_*` keys: still not provided, so attach logs keeps falling back.
- The privacy-wording sign-off.
- Updating B4A or A4D: a remote action the owner has not approved.
