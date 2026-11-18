# Move a machine between sites — Plan
**Created**: 2026-11-17 | **Status**: Active | **Branch**: `feat/move-machine` (worktree `Owlette-activity-wt`, cut from origin/dev bce9342b) | **Release**: 4.2.3 on dev

## Summary

A superadmin, or anyone who is admin of both sites, moves a paired machine from one site to another from the admin panel (**admin → sites → {site} → machines → move to…**), with nobody at the machine. The owner asked for this on 2026-11-04; it was dropped that day without the owner's agreement and is built now. It needs an agent release: a machine's site lives in its local `config.json` (`firebase.site_id`) and token store, and nothing remote can rewrite either today.

## Approach (design B: the agent confirms)

1. **Request.** `POST /api/sites/{siteId}/machines/{machineId}/move {targetSiteId}` checks the caller (MACHINE_REMOVE on the source, MACHINE_ENROLL on the target), refuses a busy or too-old machine, a same-id machine on the target and the target's plan limit, then writes `machine_moves/{sourceSiteId}:{machineId}` (`status: pending`, 7-day `expiresAt`) and a `site_move {moveId}` entry in the source's `commands/pending`, in one batch. `DELETE` cancels while pending.
2. **The agent learns of it** from the command (fast lane) or, as a backstop for offline machines and swept commands, from `move: {moveId}` on `GET /api/agent/site`.
3. **The agent fetches credentials.** `POST /api/agent/auth/move {refreshToken, machineId, moveId}` verifies the refresh token belongs to the source, re-checks the target, mints an ID token and refresh token under `agent_${target}_${machineId}`, and sets the move `switching`. The source token stays valid.
4. **The agent switches.** It ends hoot and the fleet session, writes the new credentials and the move phase atomically into `.tokens.enc`, writes `firebase.site_id`, drops the cloud cache and returns COMMAND_DEFERRED; the existing site-change detector reinitialises the client on the target.
5. **The agent confirms.** On connecting to the target it posts `POST /api/agent/auth/move/confirm` with its target ID token; the server runs remove machine's cleanup on the source (deleting its history, tokens and docs, pruning member scopes and the fleet grant, as remove does; talons untouched), records the pairing on the target and deletes the move.
6. **Guard.** Removal detection (#326) must not unpair an agent whose config already names another site.

Settled by the owner (2026-11-17): design B; superadmins and admins of both sites may move; history starts fresh; talons match remove; pending moves expire after 7 days; a `switching` move never expires (remove machine is the way out); release 4.2.3 on dev. Defaults stated and not objected to: refuse while a deployment or roost sync names the machine; refuse a same-id machine on the target; dev↔prod out of scope; a new ADR amends ADR 0016's last sentence.

Older agents can't follow: the server refuses them (409 `agent_too_old`) and the dialog disables the button, gated on the heartbeat flag `capabilities.siteMove` and `SITE_MOVE_MIN_AGENT_VERSION`. No installer-side half is needed (ADR 0006 covers updates; a move is refused while `update_owlette` is pending; the move state lives in `.tokens.enc`, which the installer never touches).

## Waves

- **Wave 0, shared pieces** (5 tasks): the agent-credential mint helper; remove machine split into its cleanup and its audit row; the move store; the version gate and copy; the agent's one-write credential save.
- **Wave 1, web routes and the agent** (6 tasks): request/cancel route (+ openapi); the agent's credential route; the agent's confirm route (+ remove and delete-site wiring); the two read projections; the agent's firebase_client changes; the agent's move handler.
- **Wave 2, UI** (3 tasks): hooks; the move dialog; the row's third action and pending tag.
- **Wave 3, proof and docs** (2 tasks): the e2e spec and its helpers; the ADR, glossary, docs, changelogs and readme.
- **Wave 4, release** (owner-gated, run by the main session): screenshots for the owner's visual sign-off, /verify, /preflight, the version bump and changelog heading, the full build-first release (exe here, pkg on the MBA, deb on the kiosk; upload to dev and verify), PR into dev, then one real move on dev on Windows and on macOS or Linux with the owner's go.

## Risks

- **The deploy-agent hook.** Any Edit or Write of a path containing `agent/src/` ending `.py`, from any worktree, copies it into the installed agent and restarts OwletteService with a UAC prompt. Agent tasks write new content to the session scratchpad and copy it into place with Bash `cp`, or patch with a script; never the Edit or Write tool on `agent/src/*.py`.
- **Ordering race.** Cleaning the source before the agent has switched makes #326 removal detection unpair it and clear the new credentials. The source is cleaned only on the agent's confirm from the target.
- **Hoot writes `offline` with its old-site token as it exits**, which would recreate the source doc after cleanup: hoot is ended before the switch.
- **A refresh-token bearer can mint target credentials**, so the agent route checks the token's site against the move's source, the move's machine against the token's machine, and the move's status and expiry.
- **The mint calls Google's real endpoint**, so the credential fetch can't run end to end on the emulators: jest covers it; e2e drives request, cancel, refusals and confirm.
- **Line numbers drift between waves**: every task anchors by function name as well as line.
- **Prod's oldest agent is unknown**; prod machines may need a fleet update before they can move.

## Success Criteria

- On dev, a superadmin and an admin of both sites can move an online machine and an offline one (which follows when it returns), cancel a pending move, and are refused with the right copy for an old agent, a busy machine, a same-id machine and a plan limit.
- After a move the machine reports on the target with its processes, the source has no trace of it, both sites' audit chains and the platform log record the move, and nothing was unpaired.
- jest, pytest, eslint, tsc, the full Playwright suite and the security gate are green; the owner has signed off the screenshots; one real move on dev on Windows and on macOS or Linux is proven before and after on both sites.
