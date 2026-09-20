# hotfix and rollback runbook
> **scope**: emergency "prod is broken" procedures. For normal releases see [production-deploy.md](production-deploy.md). For agent installer specifics see [agent-installer-release.md](agent-installer-release.md).
## triage: is this a hotfix?
A hotfix is for active production breakage, active security risk, or a defect that can become production breakage before the normal release path can respond.
Do not use this runbook to bypass review for a small cleanup, speculative refactor, or convenience change.
Do not bundle unrelated work into the emergency patch.
### signs this is a hotfix
- Customers cannot complete a core workflow.
- Agents cannot sync, heartbeat, pair, install, update, or write expected files.
- A mutating route has the wrong auth boundary.
- Signed URLs, manifests, installers, or code-execution paths are failing open or failing for everyone.
- A production deploy introduced a regression and rollback is lower risk than waiting.
- Customer data access, mutation, membership, distributions, chats, or installer integrity is at risk.
- Dashboard health, Sentry, Instatus, Railway, Firebase logs, or customer reports show active impact.
### signs this can wait
- The issue only affects local development.
- The issue is cosmetic and does not hide operational truth.
- The broken path is already disabled or inaccessible.
- The bad change has not reached production.
- The proposed fix needs product judgment more than emergency containment.
- The proposed patch touches unrelated systems.
- The fix depends on unverified assumptions about agent behavior in service context.
### severity sketch
`sev1`: production is broken now or a security boundary is actively wrong.
Examples: most customers cannot use the app, agents broadly cannot sync, a remote installer path can proceed without checksum, or live admins are locked out by a rules deploy.
Action: pick rollback, demotion, or forward-fix within minutes; verify on production, not only locally.
`sev2`: production is degraded for a significant subset, but workaround or containment exists.
Examples: onboarding is broken, a background path is failing without data loss, or CI blocks an urgent patch.
Action: confirm spread, choose revert vs forward-fix, and keep the patch narrow.
`sev3`: production issue is contained, low-risk, and not time-critical.
Examples: display regression, noisy warning, documentation confusion, or rare path with manual workaround.
Action: use the normal release path.
### eligibility questions
- What is broken in production?
- Which user, site, machine, route, artifact, or workflow is affected?
- When did it start?
- What deployed immediately before it started?
- Can revert, demotion, or previous-source redeploy stop the bleeding?
- Would forward-fix touch auth, installer execution, sync, heartbeat, update, service init, or rules?
- What production signal proves recovery?
If these answers are unknown, gather them before changing code.
## first 10 minutes
The first 10 minutes are for confirming impact, identifying the likely change, and choosing the smallest safe containment path.
Do not start broad cleanup.
Do not push to `main` directly.
Do not trigger reboot or shutdown on a local dev machine.
### check production signals
- Check Sentry for new groups, release correlation, route correlation, version correlation, site correlation, and error volume spikes.
- Check Instatus for current component state and whether customers already see degraded or down.
- Check dashboard health for online count drops, heartbeat age spikes, sync failures, installer failures, and agents unexpectedly offline.
- Check Railway deployment history for latest deploy, failed deploys, commit SHA, deploy time, and environment.
- Check Firebase logs when functions, rules, auth, storage, installer upload, or agent calls are involved.
### run smoke scripts
Run the production smoke scripts for the affected surface.
The first smoke pass should answer one question: is production broken the same way customers see?
Record the command, target environment, pass/fail, and first failing assertion or route.
Do not invent a new smoke framework during the incident.
### open the offending commit and diff
Read the likely offending diff before choosing revert.
Look for whether the commit is surgical or bundled.
Look for route auth wrappers, installer checksum behavior, sync manifests, chunk cleanup, env detection, heartbeat, service init, WMI, config reads, rules, or migration ordering.
`d404289` and `fa164af` are the warning: v2.5.0 bundled WIP, the revert removed unrelated good code, and a re-revert followed about a minute later.
### freeze the blast radius
- Stop optional deploys.
- Avoid merging unrelated PRs.
- Assign one person to patch and one person to verify.
- Preserve exact SHAs and commands in notes.
- If the bad artifact is an agent release, remember there is no force-downgrade fleet command.
## decision tree: revert / forward-fix / hotfix-on-main / mark-broken
Pick the path by surface, blast radius, and whether the bad change is isolated.
### revert
Signals favoring revert:
- The offending commit is surgical.
- Reverting removes the defect without removing unrelated good code.
- The surface redeploys automatically or can be redeployed from previous source.
- There is no paired migration or persisted state incompatibility.
Good revert surfaces:
- Web commits on `dev` or `main`.
- Docs commits on `main`.
- Small function source changes.
- Rules changes when no paired migration has occurred.
Signals against revert:
- The commit bundled WIP with good production fixes.
- Revert would disable needed security hardening.
- The agent version already auto-updated to customer machines.
- Data shape, rules, or migrations would roll back out of order.
### forward-fix
Signals favoring forward-fix:
- Already-updated agents must be repaired.
- No fleet force-downgrade exists.
- Revert removes unrelated good code.
- The fix can be smaller than the revert.
- The issue is a security boundary that must become stricter.
Forward-fix is the only certain path for already-updated agents.
Do not forward-fix by weakening a fail-closed guard.
`740d890` and `8b4c9eb` fixed SYSTEM path handling without bypassing the allowlist that correctly rejected bad paths.
### hotfix-on-main
Signals favoring hotfix-on-main:
- Production is broken.
- `dev` has too much WIP to merge wholesale.
- The fix can be isolated.
- Production deploys from `main`.
Mechanic:
- Fix on `dev`.
- Merge specifically that fix to `main`.
- Cherry-picking is supported but is not the dominant pattern.
Known gap:
- Cherry-pick / hotfix-on-main playbook not formalized.
- Branch-protection rules unknown.
- Maintainer input needed if the branch path is unclear.
### mark-broken
Signals favoring mark-broken:
- The bad artifact is an agent release.
- The bad release is latest.
- You need to stop additional machines from taking it.
- Customers already updated cannot be downgraded by command.
Agent rollback is demotion plus forward-fix.
Use `setAsLatest:false` or the current finalize call that demotes to a known-good prior version.
`min-active-versions >= 2` prevents deleting the only version.
Known gap:
- `setAsLatest:false` rollback procedure not documented.
- Agent fleet self-update kill switch undocumented.
- Roost has `sites/{siteId}.roostEnabled`; agent equivalent UNKNOWN.
## per-surface rollback recipes
Before commands, confirm current branch, target environment, bad SHA, known-good SHA, and who is watching verification.
### web (Railway)
Rollback model: revert the offending commit on `dev` or `main`, push, and Railway auto-redeploys.
Use revert when the bad commit is isolated:
```bash
git status
git checkout dev
git pull --ff-only
git revert <bad-sha>
git push origin dev
```
If production deploys from `main`:
```bash
git status
git checkout main
git pull --ff-only
git revert <bad-sha>
git push origin main
```
Use hotfix-on-main when prod is broken and `dev` has too much WIP:
```bash
git status
git checkout dev
git pull --ff-only
# make the minimal fix on dev and verify it
git checkout main
git pull --ff-only
git cherry-pick <fix-sha>
git push origin main
```
After push:
- Watch Railway deployment history until the new deployment is live.
- Run production smoke scripts.
- Confirm Sentry error rate drops.
- Check affected routes.
- For Next issues, check production build output route table for `ƒ (Dynamic)` vs static.
Historical warnings:
- `2e52fcf` showed `middleware.ts` vs `proxy.ts` framework-version landmines on Next 16.
- `70264f9` and `0476101` showed local success can fail under Railway production prerender behavior.
### cloud functions
Rollback model: redeploy previous source. Firebase CLI does not directly support per-function rollback by version.
Full functions rollback:
```bash
git status
git checkout <prev-sha> -- functions/
firebase use prod
firebase deploy --only functions
```
Single known function source rollback:
```bash
git status
git checkout <prev-sha> -- functions/<path-to-function-file>
firebase use prod
firebase deploy --only functions:<functionName>
```
If per-function targeting is uncertain, deploy all functions from known-good source:
```bash
firebase use prod
firebase deploy --only functions
```
After deploy:
- Run matching production smoke.
- Check function logs and Sentry.
- Confirm affected callable or route behavior.
Auth warning:
- Mutating routes must use `authorizedSiteHandler`.
- `requireSiteAuthAndScope` is api-key scope only.
- `12f4089`, `7e1de8f`, `fd53b7e`, and `8a67365` fixed routes using the wrong wrapper.
### firestore rules
Rollback model: restore from Firebase Console history or restore `firestore.rules` from git and deploy.
Console path:
1. Firebase Console.
2. Firestore.
3. Rules.
4. History, the clock icon.
5. Restore the known-good previous ruleset.
Git path:
```bash
git status
git checkout <prev-sha> -- firestore.rules
firebase use prod
firebase deploy --only firestore:rules
```
Migration ordering trap:
- Rule changes paired with data migrations cannot be rolled back out-of-order.
- Live admins can lose access if rules are restored before compatible data state.
- See `scripts/README.md:111-114`.
After deploy:
- Confirm live admins retain access.
- Confirm unauthorized users remain blocked.
- Run rules-sensitive smoke tests.
### storage rules
Rollback model: restore previous storage rules from console history or git, then deploy storage rules.
Console path:
1. Firebase Console.
2. Storage.
3. Rules.
4. Rules history.
5. Restore known-good previous ruleset.
Git path:
```bash
git status
git checkout <prev-sha> -- storage.rules
firebase use prod
firebase deploy --only storage
```
After deploy:
- Verify expected uploads.
- Verify expected downloads.
- Verify blocked unauthenticated access remains blocked.
- Check logs for denied requests that should now pass.
R2 warning:
- Keys still live under `project-manifests/{roostId}/{versionId}` after manifest to version rename.
- Migration was deferred.
- Do not "fix" the prefix without coordinating R2 migration.
### agent (installed customer machines)
Rollback model: no force-downgrade fleet command. Demote the bad release, then ship a higher fixed version for machines already updated.
Demote bad release:
```bash
# Use setAsLatest:false or the current finalize call that demotes to a known-good prior version.
# Exact command is currently undocumented.
```
Forward-fix:
```bash
git status
git checkout dev
git pull --ff-only
# make the minimal higher-version fix
# build and verify the installer/update path
# publish the fixed higher version through the normal agent release path
```
Hard constraints:
- `min-active-versions >= 2` prevents deleting the only version.
- Already-updated customers continue running the broken version until a higher fixed version ships.
- Service-context behavior must be tested as a real Windows service when relevant.
- Standalone process tests are not enough for WMI, COM, service threading, LocalSystem paths, heartbeat, or config races.
Agent warnings:
- Never import `firebase_admin`.
- Never log OAuth tokens.
- Never modify the firebase section of `config.json` during remote update.
- No blocking operations in the 10 second loop.
- No reconnection logic outside `ConnectionManager`.
- Never read, log, or commit `.tokens.enc`.
Installer warning:
- `9dccd12` requires `sha256_checksum` for remote installer paths.
- "Log warning and proceed" is never right on a code-execution path.
### cli npm package
Rollback model: deprecate the bad version. Unpublish only inside npm's 72 hour window. Publish the next rc or fixed version as the practical path.
Deprecate:
```bash
npm deprecate @owlette/cli@<bad-version> "<message>"
```
Unpublish only within 72 hours:
```bash
npm unpublish @owlette/cli@<bad-version>
```
After publish or deprecation:
- Confirm `npm view @owlette/cli versions`.
- Confirm the bad version shows the deprecation message.
- Confirm install resolves to the intended fixed version.
### published docs
Rollback model: revert the docs commit on `main` and push — the Railway web
deploy rebuilds and republishes `/docs`.
```bash
git status
git checkout main
git pull --ff-only
git revert <bad-docs-sha>
git push origin main
```
After push:
- Watch the Railway prod deploy.
- Confirm the published docs page reverted.
- Confirm support or customer links resolve.
## things that have gone wrong before (case studies)
Use these as pattern checks during hotfix work.
### signed URLs pointed at the wrong bucket
SHA: `a9edcd0`
What broke: signed URLs pointed at the prod bucket from the dev service. `currentEnv()` defaulted to `prod` on Railway dev because `RAILWAY_ENVIRONMENT` did not match the literal string. Bytes were in the dev bucket, signed URL was in the prod bucket, and fetches returned 404.
What fixed it: env detection stopped defaulting to `prod`; `ROOST_ENV` explicit override wins.
Lesson: never default env detection to `prod`. Default is `dev`.
### v2 sync had unsigned manifests and SYSTEM path failure
SHAs: `740d890`, `8b4c9eb`
What broke: stored `manifestUrl` was an unsigned R2 URL, so every fetch returned 400. Under LocalSystem, `os.path.expanduser('~')` resolved to `C:\Windows\System32\config\systemprofile\`; the fail-closed allowlist correctly rejected it and every write failed.
What fixed it: manifest URLs became fetchable and destination resolution accounted for SYSTEM-context semantics.
Lesson: SYSTEM-context path semantics differ from interactive-user semantics. Test agent code as a real Windows service.
### chunk cleanup broke diff downloads
SHAs: `5acd49e`, `2bce360`
What broke: cleanup invalidated the `chunks_unchanged` assumption and the downloader trusted a cache state model that was no longer true.
What fixed it: pass the full manifest chunk set and let `download_all` perform per-chunk `has_chunk()` skips.
Lesson: do not optimize based on a cache state model. Query the cache directly.
### remote installer allowed missing checksum
SHA: `9dccd12`
What broke: third-party install path logged a warning and proceeded when no `sha256_checksum` was supplied.
What fixed it: remote installer requires SHA-256 checksum.
Lesson: "log warning and proceed" is never right on a code-execution path.
### mutating routes used the wrong auth wrapper
SHAs: `12f4089`, `7e1de8f`, `fd53b7e`, `8a67365`
What broke: several mutating cloud-function and route handlers used `requireSiteAuthAndScope`, which checks api-key scope only. Any site member could mutate membership, distributions, or other users' chats.
What fixed it: mutating routes moved to `authorizedSiteHandler`, the capability plus rate-limit plus audit pipeline.
Lesson: every mutating route must use `authorizedSiteHandler`.
### persistent WMI worker failed only in service
SHA: `efd2c5f`
What broke: persistent WMI worker tested clean as a standalone process, with 631ms init and 303-310ms steady. Inside the long-running service, first query worked, then every subsequent query failed with `RPC_E_WRONG_THREAD`. Python `wmi` binds COM to the apartment that created it; `ThreadPoolExecutor.submit` re-entry broke marshalling.
What fixed it: revert persistent WMI worker; keep per-call pattern plus 5 second timeout.
Lesson: standalone-process tests of agent code are not equivalent to in-service tests.
### config race and crash offline handling
SHA: `c7f85ff`
What broke: service read stale config from disk while GUI was rewriting it.
What fixed it: pass config in-process with `get_system_metrics_with_config(config)` and add an `atexit` handler to mark the machine offline on crash.
Lesson: do not re-read config from disk in hot paths when the caller already has the intended config.
### Next build behavior differed across environments
SHAs: `2e52fcf`, `70264f9`, `0476101`
What broke: Next 16 rejected both `middleware.ts` and `proxy.ts`. A `useSearchParams` Suspense and server-component split worked locally but failed under Railway production build because prerender behavior differed.
What fixed it: framework-version behavior was corrected and production build output route behavior was checked.
Lesson: "works in dev / passes locally" is necessary, not sufficient. Check route table for `ƒ (Dynamic)` vs static.
### revert and re-revert after bundled WIP
SHAs: `d404289`, `fa164af`
What broke: v2.5.0 bundled WIP. Revert took out unrelated good code; re-revert followed about 1 minute later.
What fixed it: unrelated good code was recovered quickly.
Lesson: avoid kitchen-sink commits. Cleanup window after a bad revert is small.
### CI install drift across workflows
SHAs: `f28b2c5`, `30faa2f`, `5ddea4f`
What broke: e2e failed on cold cache because `npm ci` did not tolerate `react@19` peer-dep mismatch.
What fixed it: `--legacy-peer-deps` in every install command: Playwright workflow, openapi-validate workflow, and screenshots.
Lesson: every install command must stay aligned or one workflow drifts.
## tribal knowledge a hotfix author must know
| # | fact | hotfix consequence |
|---|------|--------------------|
| 1 | `OwletteService` has no constructor: `agent/src/owlette_service.py` `_init_state()` is the single place instance attributes are set, and `agent/src/owlette_runner.py` builds the instance with `object.__new__` and calls it. | Any new `self._foo` goes in `_init_state()`. The two-copy version of this was bitten 3 times before the second copy was deleted. |
| 2 | Main loop is 10 seconds at `agent/src/owlette_service.py:6557`. `_upload_metrics()` is the recurring heartbeat, not `_update_presence`. Adaptive: about 5s GUI, 30s monitored procs, 120s idle. Dashboard checks `online && heartbeatAge < 300s`. | Do not strip `online` or `lastHeartbeat` from `_upload_metrics()`. |
| 3 | `ConnectionManager` backoff: `BACKOFF_BASE=30s`, `BACKOFF_MAX=3600s`, `BACKOFF_JITTER=0.5`, `FATAL_ERROR_BACKOFF=3600s`, `WATCHDOG_INTERVAL=10s` at `agent/src/connection_manager.py:225-234`. | Older "5 minute" docs refer to recovery probe cadence, not backoff cap. Backoff has 1 hour ceiling and never gives up. |
| 4 | Agent uses a custom Firestore REST client and never imports `firebase_admin`. Auth is Firebase ID token custom claims `{role:'agent', site_id, machine_id}`. Agents do not have `users/{uid}` docs. | Do not debug agent auth by looking for user docs or adding Admin SDK. |
| 5 | `.tokens.enc` is machine-bound to the machine binding alone — MachineGuid on Windows, IOPlatformUUID on macOS, `/etc/machine-id` on Linux. The hostname term was dropped when identity moved to `config/machine_id`, so a rename no longer bricks the store; another machine still cannot read it. A store written under the old derivation is re-encrypted on first load and the original is kept beside it as `.tokens.enc.v1` for one minor. | Re-pair via device code on transfer. Never read, log, or commit it. Rolling the agent back below that change: rename `.tokens.enc.v1` over `.tokens.enc` first, or the old build cannot decrypt the store — but the copy is never refreshed, so once the agent has refreshed once (hourly, 5-minute grace on the superseded token) the rename restores a dead refresh token and the 401 clears both files: copy `.tokens.enc` aside first and expect a re-pair. `cortex.apiKeyEncrypted` in `config.json` is re-encrypted in place with no copy kept, so re-provision the hoot key from the dashboard after any such rollback. |
| 6 | Under LocalSystem, `os.path.expanduser('~')` -> `C:\Windows\System32\config\systemprofile\`. `agent/src/destination_allowlist.py` resolves via auto-login user, most-recently-modified non-system profile, then `C:\Users\Public`. | Test service-context path behavior as a real Windows service. |
| 7 | Reboot scheduler uses machine local timezone. Process schedules use site timezone. | Do not change one when touching the other. |
| 8 | Web has two auth wrappers: `requireSiteAuthAndScope` is api-key scope only; `authorizedSiteHandler` is full pipeline. | Use `authorizedSiteHandler` on every mutating route. |
| 9 | `currentEnv()` reads `ROOST_ENV`, then `RAILWAY_ENVIRONMENT`, then `RAILWAY_PUBLIC_DOMAIN`. Default is `dev`. | Never default to `prod`; `ROOST_ENV` explicit override wins. |
| 10 | R2 keys still use `project-manifests/{roostId}/{versionId}` after manifest -> version rename. Migration deferred. | Do not "fix" the prefix without coordinating R2 migration. |
| 11 | `Idempotency-Key` required on `/api/installer/upload` for `POST` and `PUT`. Skipped for streaming responses by `428c78b`. | Do not remove idempotency when debugging upload retries. |
| 12 | Agent dev restart sequence is `CLAUDE.md:181-188`: taskkill GUI, service restart as admin, relaunch GUI. GUI-only edits skip service restart. | Use the correct sequence or you may verify stale service behavior. |
## landmines: don't do this
### files not to touch
- `web/components/ui/*`: auto-generated.
- `firestore.rules`: do not touch without asking, unless the active rollback is specifically Firestore rules.
- `.tokens.enc`: never read, log, or commit.
- `agent/owlette_installer.iss`: only touch if you understand the build.
### agent landmines
- Never import `firebase_admin`.
- Never log OAuth tokens.
- Never modify the firebase section of `config.json` during remote update.
- No blocking operations in the 10 second loop.
- No reconnection logic outside `ConnectionManager`.
- Never assume interactive-user paths match LocalSystem paths.
- Never set a new `self._foo` anywhere but `OwletteService._init_state()`.
- Never treat `_update_presence` as the recurring heartbeat.
- Never strip `online` or `lastHeartbeat` from `_upload_metrics()`.
- Never weaken destination allowlist behavior to get writes unstuck.
- Never rely only on standalone process tests for service code.
- Never migrate `.tokens.enc`; re-pair via device code.
### web landmines
- Never call Firestore from components.
- No hardcoded colors.
- No new icon libraries.
- No `localStorage` for user state.
- Do not add `turbopack.root` to `next.config.ts`; it caused a 59 GB fork-bomb on 2026-04-29.
- Every mutating route must use `authorizedSiteHandler`.
- Do not use `requireSiteAuthAndScope` for mutation.
- Do not accept local dev success as production-build proof.
### general landmines
- Do not push to `main` directly.
- Do not create new docs without ask.
- Do not install new packages without confirming.
- Never trigger reboot or shutdown on the user's local dev machine; multi-day TouchDesigner work was lost on 2026-04-08.
- Do not make kitchen-sink commits.
- Do not revert before reading whether the commit contains unrelated good code.
- Do not "log warning and proceed" on installer, updater, or execution paths.
- Tag discipline lapsed since `v2.0.47`; do not assume tags tell the full release story.
## restart sequence for agent dev
Use this when testing service-affecting agent changes.
GUI-only edits skip service restart.
### 1. kill the gui
```powershell
taskkill /IM Owlette.exe /F
```
If the executable name differs, kill the GUI process by its actual process name.
### 2. restart the service as admin
Run from an elevated shell:
```powershell
Restart-Service Owlette
```
If the service name differs in the local install, use the actual service name.
### 3. relaunch the gui
Start the GUI again after the service is running.
Confirm GUI connects, service logs show fresh process start, heartbeat resumes, and metrics upload uses current config.
## post-fix verification
Do not close the incident when the code merges.
Close it when production signals recover.
### required checks
- Smoke scripts green on prod.
- Status page back to operational when recovery is real.
- Sentry error rate dropped.
- No replacement Sentry group is rising.
- Customer-impacting error logs cleared.
- Railway deployment successful for web incidents.
- Function logs clean for cloud-function incidents.
- Live admins retain access after rules incidents.
- Unauthorized access remains blocked after rules incidents.
- Agent demotion prevents new uptake of a bad version.
- Higher fixed version reaches already-updated agents when agent rollback is involved.
### record
- Command or verification path.
- Environment.
- Timestamp.
- Result.
- Bad SHA.
- Fix, revert, or demotion SHA or artifact version.
- Remaining affected customers, machines, or sites.
### customer impact
Before declaring resolved, know:
- Which customers were affected.
- Whether data needs repair.
- Whether agents need re-pairing.
- Whether customers need reinstall, wait for auto-update, or take no action.
- Whether support has a precise message.
Known gap:
- Customer comms protocol on hotfix is not in any doc.
- Maintainer input needed for official communication process.
## known unknowns
These are currently undocumented and a hotfix author would otherwise have to discover during an incident.
Do not speculate around them.
- Cherry-pick / hotfix-on-main playbook not formalized.
- `setAsLatest:false` rollback procedure not documented.
- Agent fleet self-update kill switch undocumented.
- Roost has `sites/{siteId}.roostEnabled`; agent equivalent UNKNOWN.
- Branch-protection rules unknown.
- Tag discipline lapsed since `v2.0.47`.
- Migration rollback SOP not written.
- Sentry-context-for-hotfixes runbook doesn't exist.
- No pre-flight `setAsLatest` confirmation gate.
- Status-page readiness gate not wired into deploy.
- Customer comms protocol on hotfix not in any doc.
- Reboot-scheduler "fired against my dev machine" guard is memory-only, not a code-level guard.
Maintainer input needed:
- Exact `setAsLatest:false` command or finalize API call.
- Whether an agent fleet kill switch exists.
- Branch-protection constraints for hotfix-on-main.
- Migration rollback ordering SOP.
- Sentry release/context checklist for hotfixes.
- Customer communication owner and template.
- Code-level guard for reboot scheduler on dev machines.
## further reading
- [/docs/runbooks/production-deploy.md](production-deploy.md)
- [/docs/runbooks/agent-installer-release.md](agent-installer-release.md)
- [/docs/runbooks/dev-to-prod-workflow.md](dev-to-prod-workflow.md)
- [agent troubleshooting (published docs)](../../web/content/docs/agent/troubleshooting.mdx)
- [/docs/changelog.md](../changelog.md)
- [/.claude/CLAUDE.md](../../.claude/CLAUDE.md)
- [/agent/CLAUDE.md](../../agent/CLAUDE.md)
