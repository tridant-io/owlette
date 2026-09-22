# prod promotion — Plan
**Created**: 2026-09-22 | **Status**: Awaiting owner sign-off on [Owner decisions](#owner-decisions)

Promote `dev` to `main` (production) without losing a feature, a change or a fielded machine. The evidence base is
[research/main-vs-dev.md](research/main-vs-dev.md) (the full delta, live prod state, gates, rollback) and
[research/env-vars.md](research/env-vars.md) (per-key env gap analysis). Read both before executing any task.
Section references below (`§1.6`, `§3.2`, `risk 4`…) point at `main-vs-dev.md` unless marked `env-vars`.

**Nothing here is executed without the owner's explicit go, per step.** Every mutating production action is its own
`[human]` task in [tasks.md](tasks.md) carrying the exact command, the read-back that confirms it, and the rollback.

**`dev/active/` is gitignored** (`.gitignore:32`) — the trap that destroyed the first swoop plan. Task 0.4
force-adds this directory, as `dev/active/swoop/` already is. That closes research open question 11.

---

## Hard prerequisite

The forward-merge of `release/3.3.6` into `dev` ([dev/active/forward-merge-3.3.6/](../forward-merge-3.3.6/)) lands
first. **This promotion starts from the `dev` commit that contains that merge** — call it the *promotion base*.

Why it is hard, not preferred: `main` reads `3.3.4`, `origin/release/3.3.6` reads `3.3.6` in `VERSION`,
`agent/VERSION` and `web/package.json`, and prod's installer catalog already serves the 3.3.6 agent. Promoting
before the merge publishes a `main` that describes a version older than what customers are running, and leaves the
`[3.3.6]` changelog entry — which is on `release/3.3.6`, not on `dev` — out of the published changelog. Every
version, changelog and gate task below assumes the merge has landed and `dev` is green.

Facts at research time: `origin/main` `73f5d512`, `origin/dev` `723fc344`, merge base `c4a8d578`,
**170 commits / 717 files / +150305 −18966** in `main..dev`, and `dev..main` is five merge commits with **zero
content `dev` lacks**. `main` is a strict ancestor in content terms — nothing on `main` needs preserving. Every SHA
in this plan is re-read at execution time; the promotion base will not be `723fc344`.

---

## Scope

### Ships and becomes live
- The whole web delta: 6 new API paths (prod 114 → 120), the swoop dashboard surface, the cross-platform agent's
  server side (machine `osFamily` / `osVersion` / `capabilities` reporting), ~20 web UI fixes, the docs rebuild
  (5 new MDX pages, ~25 modified, the docs-search fix), the logs multi-select action filter, restart schedules,
  `reboot-pending` DELETE, and the dependency + security sweeps (§1.1–§1.3, §1.11).
- One new Firestore composite index, deployed **ahead** of the code (§1.6, Task 1.1).
- Ten new env keys on `railway-prod` and the `vercel-prod` mirror (env-vars §1, Task 1.2).
- Three behaviour changes that reach existing prod users and agents: `403 cannot_modify_own_membership` on
  self-demote/self-remove (§1.3), the `capability_enforcement` break-glass switch no longer covering the three
  swoop capabilities (§1.4), and the screenshot upload rate limit — re-keyed in Task 0.2 before it ships.

### Ships inert (present, unreachable)
Swoop's web side, triple-gated and fail-closed:
1. **Per site, off by default** — `web/lib/swoop/policy.server.ts:79` `enabled: false`; `:122` reads
   `enabled: d.enabled === true`, so a missing or malformed settings document reads as off; `:175-176` returns
   `403 swoop_disabled`.
2. **Per machine** — `MachineCardView.tsx:369` / `MachineListView.tsx:693` gate on `machine.capabilities?.swoop === 1`;
   `useFirestore.ts:271` calls it "the ONLY gate". No fielded agent writes `capabilities`, so the entry never renders
   and legacy live view keeps being offered (§3.5, D15 of the swoop plan).
3. **No prod signalling Worker** — `signal.owlette.app` is NXDOMAIN and this promotion does not create it (D1).

`SWOOP_MIN_AGENT_VERSION = '3.4.0'` (`web/lib/versionUtils.ts:169`) is advisory copy only, asserted as such by
`web/__tests__/lib/swoopMinVersion.test.ts:6`. No 3.4.0 agent exists; the fielded floor is 3.3.6.

### Explicitly held back
- **The prod signalling Worker and its `v1` Durable Object migration** — the one irreversible act in the push, and
  the only thing that cannot be rolled back (§4.5, risk 1). Task 0.1 removes `main` from the deploy workflow's push
  trigger so the merge cannot fire it. Standing prod up is handed to the swoop plan (D1).
- **All agent, desktop and Rust code.** `agent/src` (5 swoop modules + `osadapter/`), `agent/swoop/` (215 files),
  `desktop/`, and the agent/desktop dependency bumps (`psutil 5.9.5 → 7.2.2`, `windows 0.61 → 0.62`) reach machines
  only through an installer release, on its own track (§1.12, `.claude/skills/build-system.md`).
- **No `v3.3.6` tag with the promotion push** unless an installer release is intended — `build-installer.yml` is
  tag-triggered (`v[0-9]+.[0-9]+.[0-9]+`) and 3.3.6 is already released and fielded (§1.10).
- **No Terraform apply, no rules deploy, no storage deploy, no data migration** — all four surfaces are byte-identical
  or empty (§1.5, §1.9, §3.4). A functions deploy is optional; the delta is one comment (§1.7).

### Not required, and proven so
`firestore.rules` is byte-identical (`d5932a3a…` on both sides, §1.5) so there is no rules deploy and no
rules-ordering risk. `storage.rules`, `firebase.json` and `infra/cloudflare/` are unchanged. No App Check change, no
new or renamed API-key scopes, no new Cloud Scheduler job, no billing/Stripe/Resend/Sentry/Instatus change, no
framework major, and **no workflow can publish an npm or PyPI package or cut a GitHub release on a branch push** —
all four publishing workflows are tag-triggered (§1.10, §5 "Explicitly NOT risks").

---

## Owner decisions

Eleven questions, each a **recommended default the owner may override**. Answer in one pass; the task that encodes
each answer is named. Defaults are what [tasks.md](tasks.md) is written against.

**D1 — the prod signalling Worker: do not let this promotion deploy it.** *(research Q1, Q2 · risks 1, 2 · Task 0.1)*
Wave 1 of the swoop plan stands prod up as its own step, in order: `wrangler secret put` the three prod secrets, then
a hand-run `npx wrangler deploy -e prod` so a first failure is read at a terminal, then DNS, then a rehearsed
rollback. Task 0.1 changes `.github/workflows/swoop-signal-deploy.yml` on `dev` so the prod deploy runs only on
`workflow_dispatch` (dev's push deploy unchanged).
*Trade-off:* swoop cannot be switched on for any site until that separate step happens — which is the point, since
`wrangler deploy` applies the one-way `new_sqlite_classes = ["SignalRoom"]` migration implicitly and the README's own
note is that a rollback across a DO migration is not a rollback.
*Alternative:* let it deploy with the merge and accept a one-way door in an otherwise minutes-reversible promotion.

**D2 — screenshot upload rate limit: fix it on `dev` before promoting.** *(research Q3 · risk 4 · Task 0.2)*
Key the limit on the authenticated machine (site + machine id) after `requireMachineAuthAndScope`, with the client IP
used only for unauthenticated callers.
*Trade-off:* the promotion is `dev` plus one fix rather than the current `dev` tip — one extra commit and one extra
preflight, against a real degradation for every customer site whose machines share a NAT egress IP.
*Alternative:* accept it, or raise the ceiling. Both leave the shared-budget shape in place.
**Verified beyond the research:** `getClientIp` (`web/lib/rateLimit.ts:185-189`) prefers `cf-connecting-ip`, so
behind Cloudflare the identifier *is* the site's NAT egress address — the collapse the research could not confirm
is real. The research's "not verified" note on this is now closed.

**D3 — create the `swoop_sessions` composite index on prod ahead of the code.** *(research §1.6, §3.2 · risk 3 · Task 1.1)*
Additive, harmless early, and harmless to leave behind after a rollback.
*Trade-off:* none. The only cost is the wait for `Enabled`.
*Alternative:* none worth taking — `firebase deploy` returns when the build is *enqueued*, and the team has already
hit `FAILED_PRECONDITION` this way on dev.

**D4 — env vars: set all ten on `railway-prod` and mirror them to `vercel-prod` before the promotion build.**
*(research Q5, §3.1 · env-vars §2, §4, §6 · Tasks 1.2, 2.3, 3.3)*
`node scripts/sync-env.mjs diff railway-dev railway-prod` drives the checklist. The six `SWOOP_*` keys and the
`CLOUDFLARE_TURN_*` pair go on both mirror targets even though swoop is inert, so a later enablement is not a flag
day. The `_PREVIOUS` pair is set to **empty strings on all three targets** — `missing = declared − live`
(`sync-env.mjs:93`) and `liveKeys` counts a key by name (`:52`), so an empty value reads as present and
`check` can go green without inventing a rotation; the consumer is falsy-guarded at
`web/app/api/agent/swoop/bundle/route.ts:73`. `railway-dev` needs the same four keys it is missing today, or `check`
stays red on that target.
*Trade-off:* setting `SWOOP_SIGNAL_URL` while no prod Worker exists trades a clean `503 swoop_not_configured` for a
201 whose `wss` dial cannot resolve — see risk R7; ordering is why it is still the default (env-vars §4: if
`web/proxy.ts` is Edge-compiled, `SWOOP_SIGNAL_URL` is inlined at build time and adding it after the build leaves
swoop's `connect-src` absent until a rebuild; setting it first makes the undetermined question moot).
*Alternative:* leave `SWOOP_SIGNAL_URL` unset until the Worker ships and accept a rebuild then.
The three dev-only debugging keys get an explicit decision each in Task 2.3: `RATE_LIMIT_OBSERVE_ONLY`,
`W8_1_DRILL_TS`, `SECURITY_BOUNDARY_SENTRY_METRICS`. Recommended: all three stay **dev-only and out of
`railway-prod`** — observe-only would disable enforcement, the drill timestamp is a `railway-dev`-only rehearsal
artifact, and the Sentry metrics flag belongs with the drills.

**D5 — the promotion is web release 3.3.6.** *(research Q4, Q6, §1.13 · Task 0.4)*
Same release train as the agent 3.3.6 already fielded. The `[Unreleased]` metrics-chart items move under the
`[3.3.6]` entry as web bullets in **both** `docs/changelog.md` and `web/content/docs/changelog.mdx` (the second is
the published one), and the entry gains the missing bullets: swoop, the cross-platform agent, machine OS reporting,
the logs action filter, docs search, restart schedules. Swoop gets one line saying it ships disabled by default,
pending its own release.
*Trade-off:* 3.3.6 describes an agent security release and now also carries the largest web feature in the project's
history; the entry has to carry both honestly.
*Alternative:* bump to 3.4.0, which would make `SWOOP_MIN_AGENT_VERSION` honest. **Not now:** `sync-versions.js`
writes one version across `/VERSION`, `agent/VERSION`, `web/package.json`, `desktop/package.json`,
`tauri.conf.json` and three `Cargo.toml`s, so a 3.4.0 web release claims a 3.4.0 agent that does not exist.
**Resolved (coordinator, 2026-09-22):** the `[3.3.6]` entry is meant to be public. It was written as a release
note (what is fixed and what to do, no reproduction detail), it has been public on GitHub since the release day via
the pushed `release/3.3.6` branch and PR #173, and the 14-day hold covers only the private memos that carry
exploit-level detail — not the changelog. Publishing it to owlette.app/docs/changelog with this promotion is the
intended outcome; see risk R5.

**D6 — swoop's missing e2e coverage is an accepted gap for this promotion.** *(research Q7, §4.3 · no task)*
Swoop is inert (see Scope), so the gap has no production exposure. Swoop has 30 unit/component test files, the
Worker's own vitest suite and the `swoopSessions` rules spec; what it has is no browser-driven path.
*Trade-off:* the three required checks on `main` go green without exercising swoop once, and
`web/playwright.config.ts:38-39` blanks `SWOOP_SIGNAL_URL` and `SWOOP_SIGNAL_RING_SECRET`, so the suite
*structurally* cannot cover it.
*Alternative:* write the suite first and delay. **A swoop e2e suite is a prerequisite of *enabling* swoop** — handed
to the swoop plan, not to this promotion.

**D7 — failover: the owner settles the LB's existence before the push, and re-syncs Vercel after it.**
*(research Q9, §3.7, §4.4 · risk R2 · Tasks 1.3, 3.3)*
`.claude/skills/cf-load-balancing.md:17-20` says no LB existed as of 2026-09-10; `vercel-origin.owlette.app`
answers but on `da031235`, one promotion behind prod. The token in `.claude/.env.local` can list zones but not load
balancers, so this is not answerable from here — one command with an LB-scoped token, or the Cloudflare dashboard,
settles which origins are in the pool. After the push: `sync vercel-prod --apply`, a Vercel deploy of the same
commit, then a read-back that both origins report the same commit at `/api/health`.
*Trade-off:* if the LB does not exist there is no automatic failover at all, and the exposure changes from "failover
serves an old build" to "there is none" — a different piece of work either way.
*Alternative:* promote without settling it and accept an unknown failover posture through the window.

**D8 — the abort plan is Railway "redeploy previous deployment" first, `git revert -m 1` second.**
*(research Q10, §4.5, §4.6 gaps 1 and 5 · Task A.1)*
Record the previous deployment id **before** the push (Task 1.4) — at research time `owlette-prod` was on deployment
`49cbfb29`, commit `73f5d512`. Redeploying it is a no-build rollback in minutes and needs no git. The code path is a
`git revert -m 1 <merge>` on `main` through a PR. Env additions and the index are safe to leave in place. Because
D1 keeps the Worker out, **no one-way door remains in the push**.
*Trade-off:* the fast path is undocumented in every runbook (§4.6 gap 1), which is exactly why the id is recorded
and the path written down before it is needed.
*Alternative:* revert-first. Not recommended: no runbook covers reverting a 170-commit merge, and the repo's own
cautionary tale (`hotfix-rollback.md:341-345`) is a far smaller bundled revert that went wrong.
Task A.1 also checks whether Railway permits rehearsing a previous-deployment redeploy on `owlette-dev`; if it does,
rehearse there.

**D9 — the Dependabot backlog does not block this promotion.** *(research Q&A §2 · no task)*
`node scripts/check-security-alerts.mjs` reports `RESULT: CLEAR` on this branch: one acknowledged blocker
(`alert:dependabot:230`, glib 0.18.5 via Tauri's linux-gated GTK backend, accepted 2026-09-12, expires 2026-12-12)
and 27 warnings, 16 of them the open Dependabot PRs opened 2026-09-16.
*Trade-off:* none today. **The 30-day rule stands** — a Dependabot PR open past 30 days is itself a blocker, which
for this batch is 2026-10-16. The gate is re-run on the promotion commit in Task 2.1, not assumed from this result.
*Alternative:* land the 16 PRs first, which re-opens the whole verification chain.

**D10 — the gate set is four, not one.** *(research §4.0, §4.1 · risk 6b · Tasks 2.1, 2.2, 2.3)*
`/preflight` (security alerts → lint + tsc → jest → rules tests → e2e), **plus** `cd web && npm run smoke:dev` on
the exact promotion commit, **plus** `node scripts/check-security-alerts.mjs` (inside preflight, named separately
because it is a release gate), **plus** `node scripts/sync-env.mjs check`.
*Trade-off:* none. `/preflight` does not run `smoke:dev` and nothing in CI does either; skipping it is invisible.
*Alternative:* none. A red `smoke:dev` blocks the promotion — fix forward on `dev` and re-run on the new commit.

**D11 — staging: use a Railway PR environment or a Vercel preview of the promotion commit if one exists; otherwise
walk dev.owlette.app at the same commit and say so.** *(research Q8, §4.4 · Task 2.5)*
The research found no third Railway service, no PR-environment config in the repo, and
`.claude/skills/cf-load-balancing.md:14-15` records that the Vercel project's Ignored Build Step cancels every
deployment that is not `main` — so **Vercel previews are structurally impossible** and the nearest rehearsal is
`dev` itself. Flows to walk either way: login including passkey, the site and machine list, machine detail, roost,
the billing pages, docs, and `/download`.
*Trade-off:* dev covers the code, not the prod data shape, the prod Worker or prod Firestore.
*Alternative:* stand up a third Railway service on a `promote/*` branch with prod's env vars. Worth it only if this
promotion is going to be repeated often; it is not something the repo supports today.

---

## Waves

Labels: **[agent]** runs unattended on this box; **[human]** needs the owner's accounts, dashboards, eyes or an
explicit go. Full task text: [tasks.md](tasks.md).

- **Wave 0 — prerequisites on `dev`** `[agent]`, one commit each, all landing before the promotion base is frozen:
  0.1 gate the prod Worker deploy behind `workflow_dispatch` · 0.2 re-key the screenshot upload rate limit ·
  0.3 env-surface housekeeping (the four stale claims, the playwright classification, `.env.example`) ·
  0.4 changelog + version + track this plan + freeze the promotion base (`[human]` sign-off on R5).
- **Wave 1 — prod preparation** `[human]`, every task mutating, every task with a read-back:
  1.1 Firestore export, then the `swoop_sessions` index with an explicit `--project prod`, then the hard
  `Enabled` gate · 1.2 the ten keys on `railway-prod` and the four on `railway-dev` · 1.3 confirm whether the LB
  exists and which origins are in the pool · 1.4 record the rollback anchors and confirm the Railway → Firebase
  project mapping.
- **Wave 2 — verification on the promotion base**:
  2.1 `/preflight` clean `[agent]` · 2.2 `npm run smoke:dev` green, all four conditions `[agent]` ·
  2.3 link the Vercel CLI, `sync-env.mjs check` green, the diff checklist closed, the three dev-only keys decided
  `[human]` · 2.4 fleet-path probes, and a real heartbeat + screenshot from a paired 3.3.6 machine if one exists
  `[agent]` · 2.5 the staging walkthrough `[human]`.
- **Wave 3 — the push** `[human]`:
  3.1 PR `dev` → `main`, regular merge commit · 3.2 watch Railway and the `main` workflows to completion, read back
  `/api/health`, confirm `swoop-signal-deploy` did not run · 3.3 Vercel: sync, deploy, both origins on one commit.
- **Wave 4 — post-deploy and the 24-hour watch** `[human]`:
  4.1 the post-deploy check set and the release tag decision · 4.2 register `cron-swoop-retention` for prod ·
  4.3 the 24-hour watch.
- **Abort** — A.1, written and rehearsed before Wave 3, executed only if a gate in Wave 3 or 4 goes red.

Gates, in order: **the forward-merge has landed** → **Wave 0 complete and the promotion base frozen** → **the index
reads `Enabled`** → **`sync-env.mjs check` exits 0** → **`/preflight` and `smoke:dev` both green on the promotion
base** → the push.

---

## Success criteria

Each is a command a reader can run and a result they can compare.

1. `curl -s https://owlette.app/api/health` returns `{"ok":true,"origin":"railway","commit":"<merge sha>"}` — the
   promotion merge's SHA, not `73f5d512`.
2. `curl -s https://owlette.app/api/openapi | jq '.paths|length'` returns **120**, up from 114. `info.version` stays
   `2.3.1` on both sides — unchanged by design, recorded so nobody reads it as a failed bump (§1.3).
3. **All nine pre-existing agent routes answer as before.** The probe, run unauthenticated against
   `https://owlette.app` before and after, comparing status codes and asserting no `404` and no `5xx`:
   `POST /api/agent/site`, `/api/agent/alert`, `/api/agent/screenshot`, `/api/agent/auth/exchange`,
   `/api/agent/auth/refresh`, `/api/agent/auth/device-code`, `/api/agent/auth/device-code/poll`,
   `/api/agent/auth/device-code/authorize`, `/api/agent/generate-installer`. All nine are **byte-identical**
   `main`↔`dev` (blob-hash compared, re-verified for this plan), as are `web/app/api/_shared.ts`,
   `/api/chunks/download-urls`, `/api/roosts/{roostId}/version-url` and `/api/bug-report`.
4. **The fleet's heartbeat and screenshot paths keep working.** A paired 3.3.6 machine's `lastSeen` advances and it
   reads online in the dashboard; one screenshot completes the full three-leg path
   (`POST …/screenshots/upload-url` → signed `PUT` → `POST …/screenshots/finalize`); the legacy live-view path
   `POST /api/agent/screenshot` still serves; and the `api-ops` limiter records **zero** 429s for the fleet in the
   first 24 hours. The fielded agent raises `ScreenshotCaptureError` with no retry on a 429
   (`screenshot_capture.py:222-225`), so a normal fleet must never reach the ceiling.
5. **Swoop is present and unreachable.** `GET /api/sites/x/swoop-settings` → **401** (deployed and gated), not the
   pre-promotion 404; `GET /swoop/x/y` → **307** to `/login`; a real authenticated session against
   `POST …/machines/{m}/swoop/sessions` → **403 `swoop_disabled`**; and no machine card offers a swoop entry.
6. **The one-way door stayed shut.** `signal.owlette.app` still returns NXDOMAIN after the push, and
   `gh run list --workflow swoop-signal-deploy` shows **no run** for the merge commit.
7. `node scripts/sync-env.mjs check` exits **0** — all three targets, no missing, no undeclared.
8. Both origins serve the same build: `https://owlette.app/api/health` and
   `https://vercel-origin.owlette.app/api/health` report the **same** `commit`.
9. `node scripts/check-status-page-ready.mjs --base-url https://owlette.app` and
   `node scripts/checks/smoke-r2-roundtrip.mjs --base-url https://owlette.app --site <id> --api-key owk_…` both green.
10. Over 24 hours: no new Sentry issue class attributable to the release, no sustained 5xx on `/api/health`,
    `/download` serves the 3.3.6 installer, and `cron-swoop-retention` has run once on prod returning 200.
11. **Agent-side criteria are n/a for this promotion.** Install-tree ACLs (no `BUILTIN\Users` write on the program
    folders), the credential-file permissions and "no UAC prompt anywhere" belong to the 3.3.6 *installer* release,
    which is already built, released and fielded. A web promotion ships no agent code (§1.12) — these are recorded
    as n/a so the omission is deliberate rather than forgotten.

---

## Risks, ranked

Each names the task that retires it. Severities are post-mitigation where a Wave 0/1 task changes the exposure.

**R1 🟠 The screenshot upload-url route is rate-limited per source IP and the fielded agent has no retry.**
*(research risk 4)* `withRateLimit(handlePost, { strategy: 'api', identifier: 'ip' })` = 300/hour
(`rateLimit.ts:118-123`), and the agent's `Authorization: Bearer <firebase-id-token>` does not start `owk_`, so
`getApiKeyRateLimitIdentifier` returns null (`withRateLimit.ts:58-71`) and the key is the client IP. **Confirmed for
this plan:** `getClientIp` prefers `cf-connecting-ip` (`rateLimit.ts:185-189`), so behind Cloudflare every machine at
one site behind one NAT really does collapse to one identifier — the research's open "not verified" is closed, and
against 300/hour. Talon visual checks run at up to one per five seconds per machine
(`visualCheck.server.ts:12-15`) = 720/hour, so **even a single machine can exhaust the ceiling**, which makes the
per-machine key a floor-raise and not a cure: Task 0.2 must state the chosen ceiling against that cadence.
→ **Task 0.2**, before the promotion base is frozen. Bounding it meanwhile: legacy live view uses the unlimited
`/api/agent/screenshot`, and Upstash Redis is configured on `railway-prod` so the tighter 15/window in-memory
fallback does not apply.

**R2 🟠 The failover story is broken in one of two ways and nothing tells you which.** *(research risk 5, §3.7)*
`vercel-origin.owlette.app` answers on `da031235`, one promotion behind prod. Either the LB is live and a Railway
failure serves a stale build with none of the new env vars — which is precisely why `SWOOP_JWT_PRIVATE_KEY`,
`SWOOP_SESSION_MASTER_KEY` and `SWOOP_SIGNAL_RING_SECRET` are classed `must-match` — or the LB does not exist and
there is no automatic failover at all. Compounding: Vercel stores sensitive vars write-only, so **no check can ever
prove the values match**; only re-running the sync can (`sync-env.mjs:19-21`,
`.claude/skills/env-management.md:76-80`; `manual-infrastructure.md:53` calls the mirror "CATASTROPHICALLY SILENT").
→ **Task 1.3** settles which case this is; **Task 2.3** links the CLI (`web/.vercel` is absent, so `status`, `check`
and `sync` all fail until it is); **Task 3.3** re-pushes the values and proves both origins serve one commit.

**R3 🟠 Two procedural landmines that produce a green, wrong result.** *(research risk 6)*
(a) `.firebaserc:3` defaults to `owlette-dev-3838a`: a `firebase deploy --only firestore` without `--project prod`
deploys production indexes to **dev**, exits 0, prints no warning (`manual-infrastructure.md:21-26`).
(b) `npm run smoke:dev` is mandatory and `/preflight` does not run it; nothing in CI enforces it.
→ **Standing rule** in tasks.md (explicit `--project` on every firebase command), the read-back in **Task 1.1**
(which is the same command that would catch a mis-targeted deploy), and **Task 2.2**.

**R4 🟠 The missing `swoop_sessions` composite index fails silently at deploy and loudly at runtime.**
*(research risk 3, §1.6, §3.2)* Prod has 34 composite indexes, the repo declares 35, and the one difference is
`swoop_sessions|COLLECTION_GROUP|siteId:ASC,state:ASC`. Three call sites need it, including the membership-revocation
sweep (`revokeViewerSessions.server.ts:24`) and the new retention cron. `firebase deploy` returns when the build is
*enqueued*, not `READY`.
→ **Task 1.1**, days ahead of the push, with `Enabled` as a hard gate.

**R5 🟢 Resolved: the 3.3.6 security changelog entry is intended to be public.** *(raised while drafting)*
`origin/release/3.3.6:docs/changelog.md:32-61` and the same text in `web/content/docs/changelog.mdx` describe the
hardening as a release note — what is fixed and what to do, no reproduction detail — and have been public on GitHub
since release day (the pushed branch and PR #173). The disclosure hold covers the private memos, not the changelog.
→ Publish as-is with the promotion (D5, Task 0.4). Do not shorten or drop the entry — an installer release without
its matching changelog entry is its own rule violation.

**R6 🟡 The prod Worker is a one-way door — retired for this promotion, not for the project.**
*(research risk 1, §4.5)* `swoop-signal-deploy.yml` fires on `push: [main, dev]` filtered to `infra/swoop-signal/**`;
the whole 18-file tree arrives in the merge, so the filter matches and the newly-arrived workflow deploys itself with
`-e prod`, applying `[[migrations]] tag = "v1"` / `new_sqlite_classes = ["SignalRoom"]` implicitly. The README's own
rollback note: a rollback across a DO migration is not a rollback, and the rehearsal has never been performed, even
on dev. Related: a prod Worker with no secrets answers every ring `500 ring_secret_unconfigured` while `/health`
still returns 200, and the workflow's smoke check deliberately sends no ring secret, so a green deploy job is not
evidence of a working Worker (research risk 2).
→ **Task 0.1** removes `main` from the push trigger; **success criterion 6** proves it stayed shut. Both sub-risks
move to the swoop plan intact.

**R7 🟡 Accepted: `SWOOP_SIGNAL_URL` will point at a hostname that does not resolve.** *(consequence of D1 + D4)*
Unset, the viewer route fails closed with `503 swoop_not_configured` (`swoop/_shared.ts:63-76`). Set to
`https://signal.owlette.app` before the Worker exists, a session-create instead returns 201 and the browser's `wss`
dial fails, after `createSwoopSession` has written a session document (`…/swoop/sessions/route.ts:308`), a viewer
document (`:316`) and attempted a real doorbell ring — so each attempt leaves an orphaned `pending` document.
**Why it is accepted:** nothing can reach that path. Swoop is off for every site by default and no fielded agent
reports `capabilities.swoop`, so `403 swoop_disabled` fires first. The mitigation is procedural — **no site is
enabled until the prod Worker exists** — and it is a prerequisite of the swoop plan's enablement step, not of this
promotion. The alternative in D4 (leave it unset, rebuild later) is the owner's to take.

**R8 🟡 Reverting the promotion merge is undocumented and the repo's own precedent is a cautionary tale.**
*(research §4.6 gaps 1 and 5)* No runbook covers reverting a 170-commit merge commit; `hotfix-rollback.md:341-345`
records a far smaller bundled revert going wrong; and Railway's "redeploy previous deployment" — the fastest lever —
is in no runbook at all.
→ **Task A.1**, written and rehearsed before Wave 3, with the deployment id recorded by **Task 1.4**.

**R9 🟡 Accepted: swoop has no end-to-end coverage and no operational documentation.**
*(research §4.3, §4.6 gap 6)* Zero Playwright specs, nothing exercising the WebRTC media path, and
`grep -rn -i "swoop" docs/` returns zero hits — no deploy runbook, no kill-switch runbook, no incident playbook,
for the largest feature in the promotion. The three required checks on `main` prove nothing about it.
→ **Accepted because swoop is inert** (D6). Both gaps are prerequisites of *enabling* swoop and are handed to the
swoop plan. The cross-platform agent work and restart-schedule authoring are in the same position — covered by
Jest/pytest/cargo, never through a browser — and are *not* inert, which is what Task 2.5's manual walkthrough is for.

**R10 🟢 Two small behaviour changes reach existing prod users.** *(research §1.3, §1.4, §3.6)*
A site owner/admin who could previously demote or remove their **own** membership row now gets
`403 cannot_modify_own_membership`, whatever their role and whatever `capability_enforcement` is set to. And the
`capability_enforcement` break-glass switch no longer disables the three swoop capabilities
(`authorizedHandler.server.ts:106`) — during an authorization misfire, swoop stays locked rather than opening.
→ Recorded, not mitigated. Both are intended. Verified in **Task 4.1** and named in the changelog (**Task 0.4**).

**R11 🟢 A new command type reaches old agents, handled gracefully.** *(research §3.6)*
`dismissRebootPending.server.ts:87` queues `type: 'dismiss_reboot_pending'`; a 3.3.6 agent logs
`Unknown command type:` (`owlette_service.py:5805-5806`) and returns. The server treats the relay as best-effort and
the public commands allowlist is unchanged, so the type cannot be injected through the command API.
→ Recorded. No action.

**R12 🟢 The Dependabot backlog.** 16 PRs opened 2026-09-16, all targeting `dev`, all inside the 30-day window;
`check-security-alerts.mjs` reports `RESULT: CLEAR`.
→ Not a blocker (D9). The gate is re-run on the promotion base in **Task 2.1**; the 30-day line for this batch is
2026-10-16.

**Correction to the research, found while writing this plan:** §3.6 lists the screenshot **upload-url** route as the
only changed route on the agent's path. `screenshots/finalize/route.ts` also differs `main`↔`dev` — but the diff is
**comment-only** (a note that finalize is deliberately not separately rate-limited, and a reworded `MAX_HISTORY`
comment), so the research's conclusion of no contract break stands. Task 0.2 must update that comment, which
currently describes a "per-IP screenshot budget".

---

## Abort plan

Trigger: a red gate in Wave 3 or 4 — Railway build failure, `/api/health` not returning 200 with the merge SHA, a
5xx spike, broken agent heartbeats, or a broken dashboard critical flow.

1. **Stop.** Do not push a fix forward under pressure, and do not revert first.
2. **Fast path (minutes, no build, no git): Railway → `owlette-prod` → redeploy the previous deployment.** At
   research time that was deployment `49cbfb29`, the build of commit `73f5d512`. **Task 1.4 re-reads and records the
   real id before the push** — the id is not knowable after the new deployment supersedes it without digging.
3. **Code path (slower, durable): `git revert -m 1 <merge sha>` on `main` through a PR.** `-m 1` keeps `main`'s
   first-parent line. Do not force-push; `main` blocks force-push and deletion. The three required checks must go
   green on the revert PR like any other.
4. **Leave these alone.** The `swoop_sessions` index — deleting it only breaks swoop queries and rebuilding later is
   slow; the new env vars — every one is read lazily inside a function body and every consumer fails closed or
   degrades within swoop only (§3.1); the Vercel origin — it is on an older commit already.
5. **No Worker rollback is needed** because D1 keeps the Worker out of the push. If the Worker is ever deployed,
   `npx wrangler deployments list -e prod` then `npx wrangler rollback <version-id> -e prod` is the only documented
   path, it does not touch secrets, and it does not undo a DO migration.
6. **Then diagnose on `dev`,** fix forward, and re-enter at Wave 2.

Write this down where an on-call person will find it (`docs/runbooks/hotfix-rollback.md` names the gap itself at
`:453-475`), and rehearse step 2 on `owlette-dev` first if Railway allows it — Task A.1 checks.
