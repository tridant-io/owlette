# prod promotion research: `origin/main` → `origin/dev`

Read-only research. No code changed, nothing pushed, no mutating API call made.

| fact | value | evidence |
| --- | --- | --- |
| `origin/main` | `73f5d512` | `git rev-parse origin/main` |
| `origin/dev` | `723fc344` | `git rev-parse origin/dev` |
| merge base | `c4a8d578` | `git merge-base origin/main origin/dev` |
| main..dev | **170 commits**, 717 files, +150305 / −18966 | `git rev-list --count`, `git diff --stat` |
| dev..main | 5 commits, all merge commits, **zero content** dev lacks | `git log origin/dev..origin/main` |
| prod live commit | `73f5d512` | `GET https://owlette.app/api/health` |
| dev live commit | `723fc344` | `GET https://dev.owlette.app/api/health` |
| **vercel failover live commit** | **`da031235`** — one promotion *behind* prod | `GET https://vercel-origin.owlette.app/api/health` → `{"origin":"vercel:iad1","commit":"da031235…"}` |

`main` is a strict ancestor of `dev` in content terms — a fast-forward-equivalent merge. Nothing on `main` needs preserving.

**Note:** `dev/active/` is gitignored (`.gitignore:32`). This file will not be committed unless it is copied somewhere tracked — the same trap that lost the first Swoop plan.

---

## 1. Inventory of `main..dev`

### 1.1 Grouped commit inventory

| group | scale | representative commits |
| --- | --- | --- |
| **swoop (remote KVM)** | ~70 commits, PRs #168 / #169 / #170 | `d51dc560` feat: swoop — remote kvm (#168), `d48f9d9e` multi-viewer fan-out (#169), `386f0ffd` refuse api keys on swoop-settings (#170), `81f08a8c` the 80-task plan, waves 0-9 |
| **tri-platform agent** (macOS/Linux + osadapter) | ~25 commits, PR #167 + `a11c78ea` (#171) | `6ef1b057` waves 0-3 osadapter seam, `fc330739` linux lane, `4b7618e5` macOS arm, `f56487b8` machines report OS + version |
| **dependency + security** | ~20 commits | `37547fc9` clear the Dependabot security backlog, `0f0466f0` close live advisories and gate releases, `520e376b` npm-minor-patch × 48, `78f59671` psutil 5.9.5→7.2.2 |
| **web UI fixes** | ~20 commits | `978ba70b` multi-select action filter on logs, `97e4097d` metric charts label every scale, `18db25dc` machine card legibility, `70600a0f` restart-pending banner, `ab32d367` open last viewed site on reload |
| **docs** | ~15 commits | `cfa2b002` cover the dashboard functions that had no page, `454bc90d` docs search returns usable results, `723fc344` internal docs link test |
| **release 3.3.5** | `d5e0495c` | version bump only; changelog entry is about library currency |

### 1.2 Web features and pages

New pages (`git diff --name-status origin/main..origin/dev -- web/app`):
- `web/app/swoop/[siteId]/[machineId]/page.tsx` + `layout.tsx` — the swoop stage (the only new route).

New components: 9 under `web/components/swoop/` (`SwoopStage`, `SwoopToolbar`, `SwoopStepUpDialog`, `SwoopPresence`, `SwoopQualityMenu`, `SwoopDisplayPicker`, `SwoopAudioToggle`, `SwoopSpecialKeys`, `SwoopStatsOverlay`), plus two shadcn primitives `web/components/ui/multi-select.tsx` and `web/components/ui/truncated-text.tsx`.

New client libs: 23 files under `web/lib/swoop/` (peer, signaling, protocol, input, keymap, clipboard, audio, displays, presence, lease, stepUp, features, feedback, clientCaps, video/{decoder,presenter,receiver}) and 8 `.server.ts` (tokens, keys, signal, turn, sessionStore, policy, audit, revokeViewerSessions).

New hooks: `useSwoopSession.ts`, `useSwoopSettings.ts`, `useCommandResult.ts`.

Deleted (dead code): `web/components/AllowlistEditor.tsx`, `RequireSuperadmin.tsx`, `RollbackConfirmDialog.tsx`, `charts/DisplayMonitorCard.tsx`, `landing/RotatingWord.tsx`, `web/lib/sessionManager.ts` (the deprecated client-side plaintext-cookie module — zero importers).

Modified user-facing: `dashboard/page.tsx`, `MachineCardView.tsx`, `MachineListView.tsx`, `logs/page.tsx`, `settings/webhooks/page.tsx`, `add/page.tsx`, `MachineContextMenu.tsx`, `MachineStatusPill.tsx`, `ManageSitesDialog.tsx`, `RestartScheduleDialog.tsx`, `ProjectDistributionDialog.tsx`, `charts/*`, `talons/components/TalonRunRow.tsx`, `contexts/AuthContext.tsx`, `hooks/useFirestore.ts`, `web/proxy.ts`.

### 1.3 API routes

Live spec comparison (`GET /api/openapi` on both hosts): **prod 114 paths → dev 120 paths**, `info.version` **`2.3.1` on both sides** (not bumped despite 6 new paths).

**Added (6), zero removed:**

| path | methods |
| --- | --- |
| `/api/sites/{siteId}/machines/{machineId}/reboot-pending` | DELETE |
| `/api/sites/{siteId}/machines/{machineId}/swoop/sessions` | POST |
| `/api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}` | GET, DELETE |
| `/api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}/lease` | POST |
| `/api/sites/{siteId}/machines/{machineId}/swoop/kill` | POST |
| `/api/sites/{siteId}/swoop-settings` | GET, PATCH |

**Changed (3), all additive except one tightening:**
- `/api/sites/{siteId}/logs` DELETE — new optional `actions: string[]` (mutually exclusive with existing `action`). No required field added.
- `/api/sites/{siteId}/members` POST — `roleHonored` changes from always-`true` decoration to load-bearing (`false` when already a member).
- `/api/sites/{siteId}/members/{uid}` PATCH + DELETE — **new 403 `cannot_modify_own_membership`**. A self-demote or self-remove that returned 200 on `main` now 403s. Dashboard/API-key surface only.
- Schema: new optional nullable `capabilities` object on the machine schema; new `SwoopSiteSettings` schema.

**Route files** (`git diff --name-status … -- web/app/api/`): 12 added, 9 modified, 0 deleted, 0 renamed. The 12 added are the 6 dashboard swoop routes + `_shared.ts`, 4 agent-facing swoop routes (`/api/agent/swoop/{bundle,doorbell-token,events}` + `_shared.ts` — undocumented in openapi, as is the whole `/api/agent/*` family), `/api/cron/swoop-retention`, and `/api/sites/…/reboot-pending`.

Confirmed live by status code (the CLAUDE.md heuristic): `GET https://owlette.app/api/sites/x/swoop-settings` → **404** (not deployed); same on dev → **401** (deployed, gated). `https://owlette.app/swoop/x/y` → **404**; dev → **307** to login.

### 1.4 Auth / session changes

`web/middleware.ts` is **unchanged**; the real gating lives in `web/proxy.ts`.

- `web/lib/sessionManager.server.ts` (+103): new optional `mfaSatisfiedBy?: 'challenge' | 'passkey-uv' | 'device-trust'`, fails closed when absent. New `sessionPassedMfaCeremony()` / `markSessionMfaCeremony()`. No cookie name, encryption or lifetime change.
- `web/lib/capabilities.ts` (+38): three new capabilities — `MACHINE_REMOTE_CONTROL`, `MACHINE_REMOTE_VIEW` (site member), `SWOOP_SETTINGS_MANAGE` (site admin). Purely additive; no existing capability moved roles. Also a `hasOwnProperty` guard fix (`bbdbbebf` "an inherited property name is not a site role").
- **`web/lib/authorizedHandler.server.ts:106` narrows the break-glass switch.** New `BYPASS_EXEMPT_CAPABILITIES` set means the `capability_enforcement` kill switch **no longer disables** the three swoop capabilities. Operators who rely on that switch during an authorization misfire can no longer reach swoop through it. Everything else still bypasses.
- New step-up ceremony (`web/lib/swoop/stepUp.ts`): taking *control* requires a live second factor in the request (TOTP/backup code or WebAuthn assertion), deliberately not re-run on lease renewal.
- `web/proxy.ts`: `/swoop` added to `PROTECTED_PATHS`; `swoopSignalConnectSources()` appends the `SWOOP_SIGNAL_URL` origin and its `ws`/`wss` form to `connect-src`. **Derived from the env var at runtime — no hardcoded host to add.** Unset ⇒ emits nothing, malformed ⇒ swallowed.
- `web/lib/rateLimit.server.ts`: per-capability ceilings for the three new capabilities only.
- **App Check: no change.** No file matching `appcheck|app-check|attest` is in the diff.
- **No new or renamed API-key scopes.** The new routes reuse `machine=<id>:write` and `site=<siteId>:admin`.

### 1.5 Firestore rules — **zero change**

```
git rev-parse origin/main:firestore.rules origin/dev:firestore.rules
d5932a3a20153aa22cf28812bfb55632958d4cd4
d5932a3a20153aa22cf28812bfb55632958d4cd4
```

Version string identical on both sides — `firestore.rules:4` `// Version: 2.11.0`, `// Last Updated: 2026-09-06`, `rules_version = '2'` at `:1`. **No rules deploy is needed and no rules ordering risk exists.**

Swoop's new subcollection `sites/{siteId}/machines/{machineId}/swoop_sessions/{sid}` appears nowhere in the rules **by design** — it is server-only (Admin SDK bypasses rules) and falls to the catch-all deny at `firestore.rules:940-941`. `web/__tests__/rules/swoopSessions.test.ts:1-15` is a new regression guard asserting exactly that; it is the only new rules spec (+119 lines, 2 tests).

`storage.rules` and `firebase.json` are also byte-identical (`firebase.json` blob `76f349a3` on both).

### 1.6 Firestore indexes — **one new index, and prod does not have it**

`firestore.indexes.json` +8 lines, one entry at `:288-296`:

```json
{ "collectionGroup": "swoop_sessions", "queryScope": "COLLECTION_GROUP",
  "fields": [ { "fieldPath": "siteId", "order": "ASCENDING" },
              { "fieldPath": "state",  "order": "ASCENDING" } ] }
```

Needed by `web/lib/swoop/sessionStore.server.ts:219-226` (`listUnendedSwoopSessionsForUser`), called from `web/lib/swoop/revokeViewerSessions.server.ts:24`, `web/app/api/cron/swoop-retention/route.ts`, and the kill route.

**Verified live, read-only:** `firebase firestore:indexes --project prod` returns **34 composite indexes**; the repo declares 35. Normalising Firestore's implicit trailing `__name__` field, the single difference is `swoop_sessions|COLLECTION_GROUP|siteId:ASC,state:ASC` — **present in the repo, absent on prod.** `fieldOverrides` match (3 = 3). No other index drift exists in either direction.

### 1.7 Cloud functions — effectively no change

3 files touched: `functions/package-lock.json` (991 lines of churn), `functions/package.json` (+3/−1: one nested npm override `"gaxios": { "uuid": "^11.1.1" }`), `functions/src/distributionFanout.ts` (+2/−2, **comment only** — the `DEFAULT_EXTRACT_ROOT` constant is unchanged).

`functions/src/index.ts` is byte-identical: no function added, removed or retriggered, **no new `onSchedule`** and therefore no new Cloud Scheduler job to provision. Runtime stays Node 22. **A functions deploy is optional for this release.**

### 1.8 Env vars

`scripts/env-manifest.json` diff is **pure addition: 10 new keys, zero removed, zero metadata changes.** All 10 declare `["railway-dev","railway-prod","vercel-prod"]`.

| key | class | manifest line |
| --- | --- | --- |
| `CLOUDFLARE_TURN_KEY_API_TOKEN` | `secret` | `:62` |
| `CLOUDFLARE_TURN_KEY_ID` | `config` | `:63` |
| `SWOOP_JWT_KID` | `config` | `:112` |
| `SWOOP_JWT_KID_PREVIOUS` | `config` | `:113` |
| **`SWOOP_JWT_PRIVATE_KEY`** | **`must-match`** | `:114` |
| `SWOOP_JWT_PUBLIC_KEY` | `config` | `:115` |
| `SWOOP_JWT_PUBLIC_KEY_PREVIOUS` | `config` | `:116` |
| **`SWOOP_SESSION_MASTER_KEY`** | **`must-match`** | `:117` |
| **`SWOOP_SIGNAL_RING_SECRET`** | **`must-match`** | `:118` |
| `SWOOP_SIGNAL_URL` | `config` | `:119` |

An independent sweep of every `process.env.<KEY>` read across `web/ functions/ scripts/ infra/` between the branches found exactly these 10 plus `GITHUB_REF` / `GITHUB_REF_NAME` (Actions-injected, read only in `scripts/check-security-alerts.mjs:815,826`). **Nothing dev reads is missing from the manifest, and nothing was dropped.**

`web/.env.example` (+118) documents all 10. `.claude/.env.example` gains local-tooling keys only.

`must-match` count is now **seven** (`LLM_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `SESSION_SECRET`, `TURNSTILE_SECRET` + the three swoop ones) but `.claude/skills/env-management.md:53-56` and `scripts/env-manifest.json:35` both still say "three". Doc drift to fix.

### 1.9 Infra

| surface | change | note |
| --- | --- | --- |
| `infra/cloudflare/` (Terraform LB) | **0 files** | no `terraform apply` needed. The LB has two pools: `railway` (`main.tf:48-57`, Host header rewritten to `app_host`) and `vercel` (`:68-77`, Host header = the vercel origin's own name). No tfstate in repo. |
| `infra/r2/`, `infra/monitoring/` | **0 files** | unchanged |
| `infra/cron-jobs.json` | +24 | one new job `cron-swoop-retention` (`:152-175`): `GET /api/cron/swoop-retention`, `X-Cron-Secret` raw, `30 4 * * *`, environments `["dev","prod"]`. **This file is a registry, nothing applies it** — the job must be created by hand on cron-job.org, once per environment. Declared failure mode is silent. |
| `infra/swoop-signal/` | **+5378, 18 new files — does not exist on `main`** | the Cloudflare Worker + Durable Object signalling relay |

**Worker config** (`infra/swoop-signal/wrangler.toml`): `compatibility_date = "2026-09-01"`, `workers_dev = false`, **no `[vars]` block at all** (`:4-7`: "NO SECRETS IN THIS FILE, EVER"). One migration, `tag = "v1"`, `new_sqlite_classes = ["SignalRoom"]` (`:19-21`). Two environments: `[env.dev]` → `swoop-signal-dev` on `signal-dev.owlette.app` (`:43-45`); `[env.prod]` → `swoop-signal-prod` on **`signal.owlette.app`** (`:51-53`). The one-label-deep subdomain is load-bearing — the zone's universal cert is `*.owlette.app`, which matches exactly one label (`:33-41`). A custom domain on a subdomain is independent of the apex LB, so **this does not touch the Railway/Vercel failover**.

Worker secrets, set out of band via `wrangler secret put` (`README.md:57-68`): `SWOOP_JWT_KID`, `SWOOP_JWT_PUBLIC_KEY`, `SWOOP_JWT_KID_PREV`, `SWOOP_JWT_PUBLIC_KEY_PREV` (note `_PREV`, not the API's `_PREVIOUS`), `SWOOP_SIGNAL_RING_SECRET`.

### 1.10 CI workflows — what fires on the push to `main`

19 workflows on dev, 14 on main; 5 are new (`swoop-signal-deploy`, `security-preflight`, `security-gate`, `rust-build`, `loc-metric`), none removed. The 14 pre-existing changed **only** in action SHA pins plus the `security-gate` `needs:` wiring — no trigger changed on any of them.

**Fires on the promotion push:** `swoop-signal-deploy` (🔴 deploys), `e2e`, `functions`, `agent-tests`, `rust-build`, `openapi-validate`, `admin-sdk-guard`, `no-token-logs`, `repo-refs`, `codeql`, `zizmor`, `loc-metric`, `security-preflight`.

**Does not fire:** `security-gate` (`workflow_call` only), `dependency-review` (PR only), and all four publishing workflows — `cli-publish` (tag `cli-v*`), `node-sdk-publish` (tag `node-sdk-v*`), `py-sdk-publish` (tag `py-sdk-v*`), `build-installer` (tag `v[0-9]+.[0-9]+.[0-9]+`). **A branch push cannot reach any of them.** CLI and node-SDK versions are unchanged main↔dev (`1.0.0-rc.0` / `1.0.0-rc.1`); the python SDK is untouched.

> `VERSION` bumps `3.3.4` → `3.3.5`, which is a **file**, not a tag. Do **not** push a `v3.3.5` tag with the promotion unless an installer release is intended.

**`swoop-signal-deploy.yml` is the one irreversible thing.** `:23-29` triggers on `push: [main, dev]` filtered to `infra/swoop-signal/**`; `:77` selects `WRANGLER_ENV: ${{ github.ref_name == 'main' && 'prod' || 'dev' }}`; `:111` runs `npx --no-install wrangler deploy -e "$WRANGLER_ENV"`; `:116-136` smoke-checks `GET $PROD_ORIGIN/health` for a 200 **and** `"service":"swoop-signal"` in the body. The whole `infra/swoop-signal/**` tree arrives in the promotion merge, so the filter matches and the newly-arrived workflow runs itself. `wrangler deploy` applies `[[migrations]]` implicitly, so the `v1` DO migration executes on this push.

### 1.11 Dependency bumps

**Web** (`web/package.json`): no framework majors. `next ^16.2.3`, `react 19.2.0 → 19.2.8`, `react-dom` likewise, `firebase-admin ^14.3.0` all unchanged in major. Minor/patch sweeps across `@aws-sdk/*` (3.1033 → 3.1127), all 15 `@radix-ui/*`, `@sentry/nextjs` 10.47 → 10.73, `firebase` 12.5 → 12.18, `fumadocs-*` 16.8 → 16.15, `recharts` 3.6 → 3.10, `resend` 6.4 → 6.26, `zod` 4.3 → 4.5, `@upstash/redis` 1.34 → 1.38. Minor-major bumps worth naming: `@fumadocs/tailwind` 0.0.5 → 0.1.1, `@scalar/nextjs-api-reference` 0.10 → 0.11, dev-dep `@types/node` ^20 → ^22, `@playwright/test` 1.59 → 1.63. One new nested override `"gaxios": { "uuid": "^11.1.1" }`.

**Agent** (`agent/requirements.txt`): `psutil 5.9.5 → 7.2.2` (**major**), `setuptools 83 → 84`, `cryptography 50.0.0 → 50.0.1`, `email-validator 2.0 → 2.3`, `tzlocal 5.2 → 5.4.4`, `GPUtil` **removed**, `pywin32==312` now platform-gated `; sys_platform == "win32"`. Dev deps: `black 24.3 → 26.5.1` (major), `flake8 6.1 → 7.3` (major), `pytest 9.0.3 → 9.1.1`, `responses`, `freezegun`. **None of this ships with a web promotion** — it ships in the next installer.

**Desktop** (`desktop/src-tauri`): `windows 0.61.3 → 0.62.2`, cargo-minor-patch group. Also ships only in an installer.

### 1.12 Agent / desktop source (ships separately)

`agent/src`: 5 new swoop modules (`swoop_manager`, `swoop_spawn`, `swoop_doorbell`, `swoop_commands`, `swoop_capability`), the new `osadapter/` package (`win`, `linux`, `darwin`, `posix`), `tools_windows.py` / `tools_posix.py`, and 22 modified files. `agent/swoop/` is 215 new files (the Rust streamer crate). `desktop/`: tray, commands, lib, process-icon rework; `exe_icon.rs` / `png.rs` deleted.

**None of this reaches a production machine through a web promotion.** Agents get code from the installer, released separately per `.claude/skills/build-system.md`. `web/lib/versionUtils.ts:169` sets `SWOOP_MIN_AGENT_VERSION = '3.4.0'` and its own comment marks it **"Provisional: Task 10.1, the swoop release, sets the real version"**. No such agent exists — the fielded floor is 3.3.6.

### 1.13 Docs

`docs/changelog.md` +52, `docs/internal/{architecture-decisions,cortex-cli-provisioning,threat-model,version-management}.md`, `docs/maintainer-quickstart.md`, `docs/runbooks/{agent-installer-release,hotfix-rollback,index,manual-infrastructure}.md`. Public docs: 5 new MDX pages (`dashboard/swoop.mdx`, `dashboard/displays.mdx`, `dashboard/restart-schedules.mdx`, `dashboard/account-settings.mdx`, `dashboard/admin/schedule-presets.mdx`, `cli/reference/swoop.mdx`) and ~25 modified.

> **`docs/changelog.md` contains no entry for swoop.** `grep -i swoop docs/changelog.md` → no matches. `[Unreleased]` holds only two metrics-chart items; the `[3.3.5] - 2026-09-15` entry is about dependency currency. A promotion today ships the single largest feature in the project's history with no changelog line and a version number that describes something else.

### 1.14 Billing / email / observability

`git diff --name-only origin/main..origin/dev` filtered for `stripe|resend|sentry|instatus` returns **nothing for any of the four**. All four are pre-existing on `main` and untouched. `https://*.ingest.sentry.io` was already in `connect-src`. The only new external integration is the signalling worker origin.

---

## 2. Live prod state — confirmed read-only

| check | prod | dev |
| --- | --- | --- |
| `/api/health` | `{"ok":true,"origin":"railway","commit":"73f5d512…"}` | `{"ok":true,"origin":"railway","commit":"723fc344…"}` |
| `/api/openapi` paths | **114** (`info.version 2.3.1`) | **120** (`info.version 2.3.1`) |
| `/api/sites/x/swoop-settings` | **404** (not deployed) | **401** (deployed, gated) |
| `/swoop/x/y` | **404** | **307** → `/login` |
| Vercel failover `/api/health` | `{"origin":"vercel:iad1","commit":"da031235…"}` — **stale by one promotion** | n/a |
| swoop worker `/health` | **`signal.owlette.app` does not resolve (NXDOMAIN)** — the prod worker does not exist | `signal-dev.owlette.app` → `200 {"ok":true,"service":"swoop-signal","protocolVersion":1}` |

**Railway** (`railway status`, project `owlette`, one environment named `dev`, two services):
- `owlette-prod` — watches branch **`main`**, deployment `49cbfb29`, commit `73f5d512`, created 2026-09-14T20:15:11Z, `RUNNING`, config `/web/railway.toml`, NIXPACKS, `npm run build`.
- `owlette-dev` — watches branch **`dev`**, commit `723fc344`, created 2026-09-20T22:10:11Z, `RUNNING`.
- **There is no third service.** No staging, no preview environment.

**Env coverage** (`railway variables --json`, key names only; values never read):

```
railway-dev  (owlette-dev)   live=37  declared=41
  MISSING (4): CLOUDFLARE_TURN_KEY_API_TOKEN, CLOUDFLARE_TURN_KEY_ID,
               SWOOP_JWT_KID_PREVIOUS, SWOOP_JWT_PUBLIC_KEY_PREVIOUS
  UNDECLARED (0)

railway-prod (owlette-prod)  live=36  declared=46
  MISSING (10): CLOUDFLARE_TURN_KEY_API_TOKEN, CLOUDFLARE_TURN_KEY_ID,
               SWOOP_JWT_KID, SWOOP_JWT_KID_PREVIOUS, SWOOP_JWT_PRIVATE_KEY,
               SWOOP_JWT_PUBLIC_KEY, SWOOP_JWT_PUBLIC_KEY_PREVIOUS,
               SWOOP_SESSION_MASTER_KEY, SWOOP_SIGNAL_RING_SECRET, SWOOP_SIGNAL_URL
  UNDECLARED (0)
```

`railway-prod` is missing **exactly the 10 new keys** and nothing else. `railway-dev` is missing the TURN pair and the rotation-only `_PREVIOUS` pair — **so TURN relay is not configured even on dev**, and every swoop session tested so far has been STUN-only.

**`node scripts/sync-env.mjs status` cannot run here** — it exits 1 at the Vercel step: *"Your codebase isn't linked to a project on Vercel"* (no `web/.vercel` directory in this checkout). `diff railway-dev railway-prod` works and produced the above. **The Vercel read-back caveat still applies regardless** (`scripts/sync-env.mjs:19-21`, `.claude/skills/env-management.md:76-80`): sensitive vars are write-only on Vercel, so any check proves key *coverage*, never value *equality*. The only way to guarantee the mirror matches is to run `sync vercel-prod --apply`.

**Firestore rules version deployed on prod: NOT confirmed.** There is no read-only CLI for it (`firebase` has no `firestore:rules get`) and no endpoint in this app reports one — `grep -rn "rulesVersion|rules_version|RULES_VERSION" web/app web/lib` returns nothing. It is moot for this promotion (the file is byte-identical main↔dev), but if the owner wants certainty the ruleset body and its `createTime` are visible in the Firebase console at *Firestore → Rules → history* for project `owlette-prod-90a12`, or via `GET https://firebaserules.googleapis.com/v1/projects/owlette-prod-90a12/releases` with an authed token.

**Firestore indexes deployed on prod: confirmed.** 34 composite indexes; the `swoop_sessions` index is the only repo index not among them (§1.6).

**Cloud functions version deployed on prod: NOT confirmed read-only** — `firebase functions:list` reports names and triggers, not the source revision. Irrelevant here: the functions delta is one comment.

**GitHub repo state** (read-only via `gh`):
- Secrets present: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (both created 2026-09-19).
- Variables present: `SWOOP_SIGNAL_DEV_URL=https://signal-dev.owlette.app`, `SWOOP_SIGNAL_PROD_URL=https://signal.owlette.app`.
- **`swoop-signal-deploy` has run 7 times, all on `dev`/`feat/swoop`, 6 successes, most recently 2026-09-19T20:13Z on `dev`.** The `infra/swoop-signal/README.md` claim that "the workflow has never run" is **stale**. Because the dev run created the `signal-dev.owlette.app` custom domain on the *same zone*, the `zone → workers routes → edit` scope on `CLOUDFLARE_API_TOKEN` is **already proven** — that risk is retired.
- Branch protection on `main`: 3 required status checks — `run suite against firebase emulators`, `firestore rules tests`, `lint, types and unit tests`. `required_approving_review_count: 0`, `enforce_admins: false`, `strict: false`, force-push and deletion blocked.
- 18 open PRs, **all targeting `dev`**, none targeting `main`. 16 are Dependabot, all opened 2026-09-16 (6 days — under the 30-day blocker). #173 is the `release/3.3.6` forward-merge; #172 is a CodeQL-ack fix.
- `node scripts/check-security-alerts.mjs` against this branch: **`RESULT: CLEAR`** — 1 acknowledged blocker (`alert:dependabot:230`, glib 0.18.5 via Tauri's linux-gated GTK backend, accepted 2026-09-12, expires 2026-12-12), 27 warnings (the 16 Dependabot PRs + two `verify:*` notes + 9 routine). Note two `verify:*` warnings: code-scanning has not run on this ref, and secret-scanning is disabled or absent.

**What `main`'s workflows would do on the next push:** see §1.10. The only deploy beyond Railway's own is `wrangler deploy -e prod`.

---

## 3. Gaps and prerequisites

### 3.1 Env vars prod lacks that dev code reads

**None of the 10 is `NEXT_PUBLIC_*` and none is read at module scope** — every read sits inside a function body. Verified by reading each enclosing function:

| key | read at | fallback | failure mode with prod's current (absent) value |
| --- | --- | --- | --- |
| `SWOOP_JWT_PRIVATE_KEY` | `web/lib/swoop/tokens.server.ts:120` via `requiredEnv()` `:113-117` | none — throws | **500 at request time**, via `problemFromError` → `ProblemType.Internal` + Sentry. In `…/swoop/sessions/route.ts` the Firestore writes are at `:308` and `:316` and the mint at `:323`, so each attempt **leaves an orphaned `pending` session doc**. |
| `SWOOP_JWT_KID` | `tokens.server.ts:149` | none — throws | 500, same path. Also on the *verify* path (`:344`). |
| `SWOOP_JWT_PUBLIC_KEY` | `tokens.server.ts:159` | none — throws | 500 on `bundle` and `doorbell-token`. |
| `SWOOP_SESSION_MASTER_KEY` | `web/lib/swoop/keys.server.ts:44` inside `masterKey()` | none — throws `SwoopKeyError` `:45` | **500**, and in the sessions route the throw is at `:382` — *after* the session doc, the viewer doc, the token mint, the TURN mint and a **real doorbell ring to the agent**. Worst ordering of the set. |
| `SWOOP_SIGNAL_URL` | `swoop/_shared.ts:76`; `agent/swoop/_shared.ts:90`; `web/proxy.ts:66` | returns null / `''` | **Clean fail-closed: 503 `swoop_not_configured`** on the dashboard route (`_shared.ts:63-72`), **503 `signal_not_configured`** on `bundle` and `doorbell-token` (chosen deliberately so an agent reads it as "slow retry", not "disabled"). In the proxy: silent — CSP simply omits the origin. |
| `SWOOP_SIGNAL_RING_SECRET` | `web/lib/swoop/signal.server.ts:39` inside `config()` | `return null` `:40` | **Silent degradation.** Session start still returns 201; the doorbell is never rung (agent falls back to 2-5 s Firestore polling); crucially `killSession` silently does not broadcast, so kills and membership revocations degrade to the polled path. |
| `CLOUDFLARE_TURN_KEY_ID` / `_API_TOKEN` | `web/lib/swoop/turn.server.ts:53-54` | `return null` `:55` | **Degraded, never fatal.** Sessions ship `iceServers: STUN_ONLY` (`sessions/route.ts:383`) or `[]` in the bundle. Every viewer behind a symmetric NAT silently fails to connect. Warning-logged only. |
| `SWOOP_JWT_{KID,PUBLIC_KEY}_PREVIOUS` | `web/app/api/agent/swoop/bundle/route.ts:71-72` | `if (!value \|\| !kid \|\| kid === keys[0].kid) return keys;` `:73` | **Silent feature-off by design** — the bundle carries one key, and a future kid rotation becomes a flag day. |

**Net:** because every read is lazy and every route fails closed or degrades, **the Next.js build will not fail and no non-swoop surface breaks** if prod ships without these. The blast radius of the gap is confined to swoop itself.

**One build-time caveat that could not be settled from the repo.** `web/proxy.ts` is the Next 16 rename of `middleware.ts` (`:6-9`); `web/next.config.ts` sets no `experimental.nodeMiddleware` and `proxy.ts` exports no `runtime`. If it compiles to the Edge runtime, Next inlines `process.env.*` at build time and `SWOOP_SIGNAL_URL` would have to exist **in the build environment**, not just at runtime — adding it after the build would leave the swoop `connect-src` permanently absent until a rebuild. Ordering makes the question moot: set the vars before the promotion build.

**`sync-env.mjs check` will exit 1 even after setting the eight real keys.** `SWOOP_JWT_KID_PREVIOUS` and `SWOOP_JWT_PUBLIC_KEY_PREVIOUS` are declared on all three targets while every source of truth (`env-manifest.json:113,116`, `web/.env.example:196-200`, `infra/swoop-signal/README.md:64`) says the steady state is **unset**. `missing = declared − live` (`scripts/sync-env.mjs:93`), so an unset-but-declared key reads as missing forever — and they are already the reason `railway-dev` shows 4 missing today. Resolve by setting both to empty strings on all three targets (the consumer is falsy-guarded at `bundle/route.ts:73`, so empty is safe), or move the rows to `targets: []`. Do not waive the gate.

### 3.2 Rules and index deploy, and their ordering

- **Rules: no deploy needed.** File byte-identical.
- **Indexes: `firebase deploy --only firestore:indexes --project prod` must land AND finish building BEFORE dev's web code serves prod traffic.** `firebase deploy` returns when the build is *enqueued*, not when it is `READY`; until then the query returns `FAILED_PRECONDITION` → 500. `docs/runbooks/manual-infrastructure.md:33` classes this failure as "SILENT at deploy, loud and late at runtime", and `dev/completed/api-keys-consolidation/plan.md:2` records the team hitting exactly this on dev, with the note "ORDER MATTERS on prod: deploy firestore indexes to prod FIRST". Verify with `gcloud firestore indexes composite list --project owlette-prod-90a12` and require `READY`.
- Nothing about the index is destructive and it costs nothing to deploy it early. **Deploy it now, days ahead of the promotion.**

### 3.3 Worker deploy

The prod Worker **does not exist** (`signal.owlette.app` is NXDOMAIN). The promotion push creates it, including the one-way `v1` `new_sqlite_classes = ["SignalRoom"]` migration.

Set the three prod Worker secrets **before** the promotion merge (`npx wrangler secret put <name> -e prod` from `infra/swoop-signal`): `SWOOP_JWT_KID`, `SWOOP_JWT_PUBLIC_KEY`, `SWOOP_SIGNAL_RING_SECRET`. `infra/swoop-signal/README.md:143-147`: a new environment starts with none, and **a worker missing `SWOOP_SIGNAL_RING_SECRET` answers every ring `500 ring_secret_unconfigured` while `/health` still returns 200** — the workflow's smoke check (`swoop-signal-deploy.yml:116-136`, which deliberately sends no ring secret) **cannot catch it.**

`SWOOP_SIGNAL_RING_SECRET` must be byte-identical across the Worker, `railway-prod` **and** `vercel-prod`.

The README also prescribes doing the first deploy of an environment **by hand** (`npx wrangler deploy -e prod`) so a first failure is read at a terminal rather than a job log, and records that the **rollback rehearsal has never been performed, even on dev**.

Safe pre-flight that touches nothing: `cd infra/swoop-signal && npm ci && npm run dryrun` (`wrangler deploy --dry-run` for both envs) and `npm test` (vitest against a local `wrangler dev` on :8790, no Cloudflare calls).

### 3.4 Data migrations / backfills

**None.** No backfill script, no schema migration, no document rewrite. `swoop_sessions` is a brand-new collection written only by the new code. `capabilities`, `osFamily` and `osVersion` are new optional machine fields written by agents that support them; the dashboard treats absence as the legacy case (`web/hooks/useFirestore.ts:261-266`, `:1327-1329`; `MachineListView.tsx:447-455` renders nothing when `osVersion` is absent; `ProjectDistributionDialog.tsx:107` "absent still means windows").

### 3.5 Feature flags and per-site gates

Swoop is **double-gated and inert on prod as shipped**:

1. **Per-site, off by default.** `web/lib/swoop/policy.server.ts:79` `enabled: false` in `SWOOP_SETTINGS_DEFAULTS`, and `:122` reads `enabled: d.enabled === true` — fails closed against a missing or malformed document. `:175-176` returns `403 swoop_disabled` when off. A site admin turns it on with the switch in `web/components/ManageSitesDialog.tsx:86-94`.
2. **Per-machine capability, which no fielded agent reports.** `web/app/dashboard/components/MachineCardView.tsx:369` and `MachineListView.tsx:693` gate on `machine.capabilities?.swoop === 1`. `web/hooks/useFirestore.ts:271` — "`swoop === 1` is the ONLY gate for the swoop" entry. A 3.3.6 agent writes no `capabilities` key, so `capabilities` reads `null` and the swoop entry never renders; legacy live view keeps being offered.

`SWOOP_MIN_AGENT_VERSION = '3.4.0'` (`web/lib/versionUtils.ts:169`) is **advisory copy only**, exactly like `SITE_TIME_MIN_AGENT_VERSION` — the comment says so at `:163`, and `web/__tests__/lib/swoopMinVersion.test.ts:6` asserts it. Its only non-test consumer is `web/app/api/agent/swoop/bundle/route.ts:29`, a route no 3.3.x agent calls.

Other kill switches that continue to work: the `capability_enforcement` platform switch (but see §1.4 — it no longer covers the three swoop capabilities), the roost kill switch, and the security-boundary kill switches.

### 3.6 Would anything break existing prod users or agents at the moment of deploy?

**Agents: no contract break.** All nine pre-existing `/api/agent/*` route files are **byte-identical** between `main` and `dev` (blob-hash compared): `site`, `alert`, `screenshot`, `auth/exchange`, `auth/refresh`, `auth/device-code`, `auth/device-code/poll`, `auth/device-code/authorize`, `generate-installer`. So are `web/app/api/_shared.ts` (which owns `requireMachineAuthAndScope`), `firestore.rules`, `storage.rules`, `web/middleware.ts`, and the `/api/chunks/*`, `/api/bug-report`, `/api/roosts/{roostId}/version-url` routes the agent uses. `git diff --stat … -- web/app/api/agent/` = 4 files, +667, −0 — all four are the new swoop files.

The 3.3.6 agent also makes **no version or update check against the web API** (`grep -E "installer/latest|api/version|api/health|check_for_update"` over `release/3.3.6:agent/src/*.py` → nothing), so those routes are not on its path at all.

**Two real deltas that reach an old agent:**

1. **🔴 `POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url` is now rate-limited 300/hour keyed on client IP.** `route.ts` changed `export async function POST` to `export const POST = withRateLimit(handlePost, { strategy: 'api', identifier: 'ip' })`. Resolving: `web/lib/withRateLimit.ts:98` → `apiRateLimit`; `web/lib/rateLimit.ts:118-123` → `Ratelimit.fixedWindow(300, '1 h')`; `withRateLimit.ts:104-109` → `getApiKeyRateLimitIdentifier()` returns null because `requestHasApiKeyCredential()` (`:58-68`) matches only credentials starting `owk_`, and the agent sends `Authorization: Bearer <firebase-id-token>` (`screenshot_capture.py:211`) — so the identifier falls back to `getClientIp(request)`. **All machines behind one NAT share one 300/hr budget.** A 429 makes the agent raise `ScreenshotCaptureError` with no retry (`screenshot_capture.py:222-225`; the retry logic at `:246-270` is on the signed-URL PUT only). Reachable because talon visual checks run at up to 1/5 s per machine (`web/lib/talons/visualCheck.server.ts:13`). **Mitigating:** legacy live view does *not* use this route — `owlette_service.py:7638-7655` posts to `/api/agent/screenshot`, which is byte-identical and unlimited. Without Upstash Redis configured the fallback is tighter still (15/window, `rateLimit.ts:226`); `UPSTASH_REDIS_REST_URL`/`_TOKEN` *are* set on railway-prod, so the Redis path applies.
2. **A new command type reaching an old agent, handled gracefully.** `web/lib/actions/dismissRebootPending.server.ts:87` queues `type: 'dismiss_reboot_pending'`; a 3.3.6 agent logs `Unknown command type:` (`owlette_service.py:5805-5806`) and returns. The server treats the relay as best-effort (`:72-98`, returns 200 with `commandId: null`), and the public commands allowlist is unchanged, so the type cannot be injected through the command API.

**Dashboard users: one behaviour tightening.** A site owner/admin who previously could demote or remove *their own* membership row now gets `403 cannot_modify_own_membership`, "whatever their role and whatever the platform's `capability_enforcement` setting".

### 3.7 The Vercel failover origin

**Already out of sync before this promotion.** `vercel-origin.owlette.app/api/health` reports commit `da031235` — the *previous* promotion's merge, not `main`'s current `73f5d512`. If Railway fails over today, users are served a build that is two promotions old.

The Cloudflare LB (`infra/cloudflare/main.tf:44-77`) has two pools, both `enabled = true`, `minimum_origins = 1`, health probe `/api/health`, with the Vercel pool rewriting the Host header to the Vercel origin's own name because Vercel holds no certificate for `owlette.app` (`:73-77`).

Keeping it in sync after the promotion needs two things: the Vercel project to build the new `main`, and `node scripts/sync-env.mjs sync vercel-prod --apply` for the 10 new keys — which is also the only way to make the three `must-match` secret *values* provably equal across the mirror, since Vercel stores sensitive vars write-only. The Vercel CLI is **not linked in this checkout** (`vercel env ls` fails with "Your codebase isn't linked to a project"), so that has to be fixed before the sync can run.

### 3.8 Prerequisite checklist — 17 items

**Content and decisions (do first, they land in a commit on `dev`):**

1. Write changelog entries for swoop, the cross-platform agent, machine OS reporting, the logs action filter, docs search and restart schedules, in **both** `docs/changelog.md` and `web/content/docs/changelog.mdx`, cutting `[Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`. *(§1.13; `production-deploy.md:64-72`)*
2. Decide the version and run `node scripts/sync-versions.js X.Y.Z`; commit. *(§1.11, open question 4)*
3. Resolve the `_PREVIOUS` pair so `sync-env.mjs check` can go green. *(§3.1)*
4. Decide the swoop posture: Worker deployed now or held back; swoop left off per site. *(open questions 1–2)*

**Environment and infrastructure (before the merge):**

5. `firebase deploy --only firestore:indexes --project prod` — **`--project prod` explicitly**, never relying on `firebase use`. *(§3.2, risk 6a)*
6. Wait until `gcloud firestore indexes composite list --project owlette-prod-90a12` shows the `swoop_sessions` entry `READY`/`Enabled`. **Hard gate.**
7. Set the three prod Worker secrets via `npx wrangler secret put … -e prod` — **before** the first prod deploy; the CI smoke check cannot detect their absence. *(§3.3)*
8. Set all 10 new keys on `railway-prod`: `SWOOP_SIGNAL_URL=https://signal.owlette.app`, ring secret byte-identical to the Worker's.
9. Link the Vercel CLI (`web/.vercel` is absent here), then `node scripts/sync-env.mjs sync vercel-prod --apply` — the only thing that makes the three `must-match` values provably equal.
10. `node scripts/sync-env.mjs check` — expect clean. Do not waive it.
11. Confirm, once, that the `owlette-prod` Railway service really points at `owlette-prod-90a12` and prod R2 (`production-deploy.md:43-45` — the repo cannot prove it, §4.0).
12. Optional, free: `cd infra/swoop-signal && npm ci && npm run dryrun && npm test`. Take a Firestore export as insurance even though no migration is needed.

**Gates (immediately before the merge):**

13. `/preflight` clean on the promotion commit — including `npm run test:rules`, since `web/__tests__/rules/` gained a spec.
14. **`cd web && npm run smoke:dev` green on the exact commit**, all four conditions, no `WARNING` line; then `git fetch origin dev && git rev-parse origin/dev` to confirm the SHA has not moved. *(§4.0 — the gate `/preflight` omits)*

**Merge and after:**

15. Merge `dev` → `main` as a **regular merge commit, not a squash**, subject `chore: merge dev for vX.Y.Z production release`. Watch Railway to completion.
16. Register `cron-swoop-retention` on cron-job.org for prod (`30 4 * * *`, `X-Cron-Secret`, prod `CRON_SECRET`). Silent failure mode if skipped. *(§1.9)*
17. Verify the prod Worker answers a real ring, not just `/health`; run `scripts/check-status-page-ready.mjs` and `scripts/checks/smoke-r2-roundtrip.mjs`; tag the release.

**Not needed:** `firebase deploy --only firestore:rules` (unchanged), `--only storage` (unchanged), `terraform apply` (`infra/cloudflare/` unchanged). **Optional:** `firebase deploy --only functions --project prod` (one comment; if run, confirm `functions/.env.owlette-prod-90a12` exists locally and set `FUNCTIONS_DISCOVERY_TIMEOUT=120`).

---

## 4. Verification available

### 4.0 The documented promotion procedure — and which file to follow

Two runbooks describe the promotion and **they contradict each other on ordering.** `docs/runbooks/production-deploy.md:10` says indexes and rules go before the web deploy, but its own numbered steps put the merge at 6 and the firebase deploys at 7–9. `docs/runbooks/manual-infrastructure.md:326-329` explicitly declares its order **supersedes steps 6–9 of `production-deploy.md`**. **Follow `manual-infrastructure.md:324-366`:**

1. Changelog (**both** `docs/changelog.md` *and* `web/content/docs/changelog.mdx` — the second is the published one) + `node scripts/sync-versions.js X.Y.Z`, committed first. "Nothing downstream is safe to build until this lands."
2. Any data migration a new rule or index depends on — **take a Firestore export first**: `gcloud firestore export gs://owlette-prod-backup/pre-X.Y.Z-$(date +%Y%m%d-%H%M) --project owlette-prod-90a12`. *(No migration is needed for this promotion; the export is still cheap insurance.)*
3. `firebase deploy --only firestore:indexes --project prod`
4. **Hard gate: wait until every new index reads `Enabled`, not `Building`** (`:343-345`). A query against a building index fails `FAILED_PRECONDITION` and the talon janitor swallows it → silent degradation.
5. `firebase deploy --only firestore:rules --project prod` — **not needed here** (file unchanged).
6. `firebase deploy --only storage --project prod` — **not needed here** (unchanged).
7. `firebase deploy --only functions --project prod` — **optional here** (one comment). If run: confirm `functions/.env.owlette-prod-90a12` exists locally first (gitignored; a missing `CORTEX_INTERNAL_SECRET` silently kills every display talon, every `process_restarted` talon and every threshold alert — `manual-infrastructure.md:38`), and `FUNCTIONS_DISCOVERY_TIMEOUT=120` is mandatory with firebase-tools 15.x. "Functions before web is the safe direction; web before functions is the dangerous one."
8. **Deploy the web app — merge `dev` → `main` and push.** A **regular merge commit, not a squash** (`dev-to-prod-workflow.md:123-124`), subject `chore: merge dev for vX.Y.Z production release`. Watch Railway to completion.
9. Register/verify the cron-job.org jobs, last — including the new `cron-swoop-retention`.
10. `node scripts/sync-env.mjs check`; re-run `sync vercel-prod --apply` if any prod secret changed; `scripts/check-status-page-ready.mjs`; `scripts/checks/smoke-r2-roundtrip.mjs`; **tag the release.**

**🔴 The gate I have to flag hardest, because it is easy to skip: `cd web && npm run smoke:dev`** (`production-deploy.md:139-190`). It must be green **on the exact commit being promoted**, with all four conditions at `:157-173`: exit 0 with a `commit` line reading `<sha> (origin/dev; dev served it when the specs started)`; that SHA still `origin/dev` at merge time (re-run `git fetch origin dev && git rev-parse origin/dev` immediately before merging); no `--any-commit`; no forwarded `-- --grep`; and **no `WARNING` line**. A red run blocks the promotion — fix forward and re-run. `/preflight` does **not** include it. A promotion needs both.

**🔴 The landmine that has already cost people: `.firebaserc:3` defaults to `owlette-dev-3838a`.** A `firebase deploy --only firestore` with no `--project prod`, relying on an earlier `firebase use prod` in the shell, **deploys production rules and indexes to dev — successfully, green, with no warning** (`manual-infrastructure.md:21-26`). Pass `--project prod` on every firebase command.

Also documented and worth knowing: `/api/health` is the fastest liveness check and returns 200 **only when the origin can also reach Firestore**; it is the LB's failover probe, so a 503 means the origin is about to be failed out. Never use `/api/cron/health-check` as a probe — it is a write-side cron route needing `X-Cron-Secret` (`production-deploy.md:356-357`).

**Documented unknowns in the runbooks that this research can now close:**
- `dev-to-prod-workflow.md:297-327` treats branch protection on `main` as "Maintainer input needed / operational unknown". **It is now known** (§2): 3 required checks, 0 required reviews, `enforce_admins: false`, `strict: false`.
- `infra/swoop-signal/README.md` says the deploy workflow "has never run". **It has** — 6 successful runs, last on `dev` 2026-09-19.

Still unknown: `dev-to-prod-workflow.md:26-29` and `production-deploy.md:504-508` both record that the branch→Railway-service→Firebase-project mapping **is not pinned in the repo**, so repo files alone cannot prove the prod Railway service points at `owlette-prod-90a12` and prod R2. I confirmed the branch mapping live (`railway status`: `owlette-prod` ← `main`, `owlette-dev` ← `dev`) but **not** which Firebase project each service's `FIREBASE_PROJECT_ID` names — that would require reading values, which I did not do. `production-deploy.md:43-45` makes confirming it a one-time prerequisite; do it.

### 4.1 What the repo's own gates cover

`/preflight` (`.claude/commands/preflight.md`) runs, in order:

1. `node scripts/check-security-alerts.mjs` — exit 1 ⇒ do not push. **Already run: `RESULT: CLEAR`** (§2).
2. Scope check against the e2e path filter.
3. `cd web && npm run lint` (`eslint`) and `npx tsc --noEmit`.
4. `cd web && npm test` (jest, ~4400 unit tests).
5. `cd web && npm run test:rules` — boots a Firestore emulator on :8080 and runs `jest --config jest.rules.config.js --runInBand`. **121 tests across 5 files** (`denials` 44, `wave-hardening` 32, `membership` 24, `baseline` 19, `swoopSessions` 2). Must finish before step 6 — it binds the same :8080 the e2e emulators want.
6. `cd web && npm run e2e` — `node scripts/e2e-build.mjs` (a real production build), then `firebase emulators:exec --only auth,firestore,storage --project demo-playwright-e2e` running `playwright test --project=chromium --project=mobile-chromium`. ~45 s steady-state after the first build. App on :3100.

CI mirrors 3–6 as the `playwright e2e` workflow's three jobs, and **those three are exactly the required status checks on `main`**: `run suite against firebase emulators`, `firestore rules tests`, `lint, types and unit tests`.

> **But they gate the PR, not the deploy.** Railway watches the `main` branch directly through its own integration — it is not an Actions job and nothing sequences it after the checks. A red `playwright e2e` on the push does not stop or roll back the Railway deploy. Protection is `strict: false` (no up-to-date requirement), `enforce_admins: false`, `required_approving_review_count: 0` — so a PR can be self-merged the moment the three checks are green.

### 4.2 What the e2e suite exercises

113 spec files under `web/e2e/specs/`. `playwright.config.ts:113,117` sets `testDir: './e2e/specs'` with `testIgnore: ['**/security-boundary/**', '**/functions/**']`, so the default run covers: auth/signup/logout/password-reset, MFA + passkeys, account settings, sites CRUD + role boundaries, access control + route guards, dashboard process config, dispatch (reboot, shutdown, kill, layouts, deployments), roosts (17 specs), talons, hoot, logs, admin (alerts, email, installers, schedules, tokens, webhooks), API contracts, time-travel heartbeat/reboot, landing, a11y, visual, and 10 mobile specs.

### 4.3 What has NO automated coverage

- **🔴 swoop has zero Playwright e2e specs.** `ls web/e2e/ | grep -i swoop` → nothing; the only *new* spec in the whole diff is `public/docs-links.spec.ts`. The largest feature on `dev` is not exercised by any of the three checks that gate `main`. It does have **30 unit/component test files** (`web/__tests__/{lib,api,components}/swoop*`, 46 new test files overall) plus the Worker's own vitest suite (~1478 lines, boots a local `wrangler dev` on :8790, no Cloudflare calls) and the `swoopSessions` rules spec — but nothing drives a browser through a session.
- **Nothing tests the WebRTC media path** at all. The Worker tests cover signalling; there is no end-to-end capture → encode → transport → decode assertion in CI.
- **The security-boundary drills are excluded from the gate** (`testIgnore`): `railway-drill.spec.ts` (Railway failover, uses the Railway CLI) and `rollback-rehearsal.spec.ts` (asserts against the *dev* project via `assertDevProject`). These are hand-run drills, and the `W8_1_DRILL_TS` var exists only on `railway-dev`.
- **The functions-trigger suite is a separate project** (`e2e:functions`, `--project=functions-triggers`) and is not in the default `npm run e2e`. CI does run it as its own job.
- No test covers the TURN path, the cron-job.org registration, or Vercel/Railway failover behaviour in CI.

### 4.4 Can `main`-to-be be staged?

**No, not as configured.**

- **Railway:** `railway status` shows one project, one environment (`dev`), exactly two services — `owlette-prod` (watches `main`) and `owlette-dev` (watches `dev`). There is no staging service and no PR-environment config in the repo (`railway.json`, `railway.toml` at root, `nixpacks.toml`, `Dockerfile` all absent; the only config is `web/railway.toml`, identical main↔dev). A push to `main` deploys prod immediately. Standing up a third service pointed at a `promote/*` branch, with prod's env vars, is the only way to rehearse — and it is not something the repo currently supports.
- **Vercel:** no `vercel.json`, no `.vercel/` in the checkout, and the CLI is not linked here. Vercel previews may exist in the dashboard but cannot be confirmed read-only from the repo.
- **The nearest available rehearsal is `dev` itself** — `dev.owlette.app` has been running `723fc344` since 2026-09-20 with the swoop env vars set (minus TURN). That covers the code, not the prod data shape, the prod Worker, or the prod Firestore.

**Vercel previews are structurally impossible.** `.claude/skills/cf-load-balancing.md:14-15`: the Vercel project "builds production from `main` only (its **Ignored Build Step cancels every other deployment**)". So the standby is a mirror of what you are promoting *to*, never a place to stage before it.

**Cloudflare LB as a staging lever — and a live-state question I could not settle.** `infra/cloudflare/main.tf` defines a monitor (`GET /api/health`, 60 s, expect 200), two pools (`owlette-railway-primary`, `owlette-vercel-standby`, both `enabled = true`, `minimum_origins = 1`), and an LB on `owlette.app` with `steering_policy = "off"` = pure cascade: all traffic to Railway, Vercel only when Railway's monitor fails. No weighted split, no percentage ramp, no documented manual promote/demote. The one rehearsal method the skill prescribes (`:60-63`) is to prove failover on a **throwaway hostname** (`lbtest.owlette.app` with a deliberately broken Railway monitor path) and then delete it. `:105-107` warns not to change `steering_policy` from `"off"`. `:60` warns that applying "moves `owlette.app` behind the load balancer **immediately**".

> **`.claude/skills/cf-load-balancing.md:17-20` says the LB is NOT LIVE:** *"As of 2026-09-10 no load balancer, pool, or monitor exists — `owlette.app` is a plain proxied CNAME to Railway, and the May 2026 apply was destroyed the same day. Verify with a GET on `zones/{zone_id}/load_balancers` before assuming otherwise."* I tried exactly that. The `CLOUDFLARE_API_TOKEN` in `.claude/.env.local` **can** list zones (the `owlette.app` zone id resolved) but the LB list returns `{"code":10000,"message":"Authentication error"}` — that token is the Workers deploy token and lacks *Zone › Load Balancers › Read*. **So whether the failover LB exists today is UNCONFIRMED.** This matters a lot for risk #5: if there is no LB, the stale Vercel origin is serving nobody and the exposure is "you have no failover", not "failover serves an old build". The owner can settle it in one command with an LB-scoped token: `curl -H "Authorization: Bearer $TOKEN" https://api.cloudflare.com/client/v4/zones/<zone_id>/load_balancers`. Corroborating: `infra/cloudflare/` holds **no `terraform.tfvars` and no `*.tfstate`** in this checkout, and `cf-load-balancing.md:90-91` records that state is local and gitignored with the R2 backend still only stubbed — so a second operator may not be able to `plan`, let alone revert.

Origin-hostname gotchas (`cf-load-balancing.md:71-107`), all three: `railway_origin` is **not** `RAILWAY_PUBLIC_DOMAIN` (that variable *is* `owlette.app`, so the pool would loop back on itself) — use the hostname `owlette.app` CNAMEs to; keep `vercel-origin.owlette.app` **DNS-only / grey cloud** or Vercel's HTTP-01 renewals break; never build absolute URLs from the Host header in web code (behind the LB the Vercel origin sees `Host: vercel-origin.owlette.app`) — use `publicOrigin(request)`. And do not bump the Cloudflare provider to v5; the `~> 4.52` pin in `versions.tf` is deliberate.

### 4.5 Rollback

| surface | rollback | blast radius / caveat |
| --- | --- | --- |
| **Railway web** | revert the merge on `main` and push; Railway redeploys. Railway also keeps prior deployments and can redeploy `49cbfb29` (the current `73f5d512` build) directly from its dashboard — faster and needs no git. | Clean. This is the well-trodden path; `docs/runbooks/hotfix-rollback.md` covers it. |
| **Vercel failover** | Vercel's instant rollback / promote-previous. | It is already on `da031235`, so "rolling back" mostly means leaving it alone. |
| **Firestore rules** | not applicable — unchanged. | — |
| **Firestore indexes** | an index can be deleted, but a *missing* index only breaks swoop queries. Leaving it in place after a rollback is harmless and costs a few bytes. | **Do not delete it on rollback.** Re-building it later is slow; leaving it costs nothing. |
| **Cloudflare Worker** | 🔴 **effectively none.** `infra/swoop-signal/README.md` (rollback section): *"a deploy is a version; rolling back publishes an earlier one. it does not touch secrets and it does not undo a durable-object migration, so a rollback across the `v1` migration is not a rollback."* There is no prior prod version to return to, the `new_sqlite_classes` migration is one-way, and the README records that **the rollback procedure has never been rehearsed, even on dev.** | Forward-only. The practical kill is per-site: turn swoop off, which is the default anyway. |
| **Cloud functions** | not applicable unless deployed; if deployed, redeploy from the previous ref. | Delta is one comment. |
| **cron-job.org job** | disable it in the vendor UI. | No repo config; vendor UI only, no API, no Terraform (`infra/cron-jobs.json` scheduler block). |

The Worker's own rollback commands (`infra/swoop-signal/README.md`, **the only place documented — no runbook covers it**):

```
cd infra/swoop-signal
npx wrangler deployments list -e prod       # newest first; copy the version id
npx wrangler rollback <version-id> -e prod  # prompts for a reason, then publishes
```

With no version id it goes back one. It does not touch secrets and does not undo a DO migration. The deploy workflow deliberately does **not** auto-roll-back on a failed smoke check, because "a red `/health` is as often a missing secret or a missing route as it is bad code". `concurrency: cancel-in-progress: false` — a cancelled `wrangler deploy` leaves whatever version Cloudflare last accepted. Blast radius: dev and prod are separate scripts with separate secrets; a bad prod Worker ends every live swoop session and touches nothing else.

**Asymmetry to plan around:** the web half rolls back in minutes; the Worker half does not roll back at all. Treat the prod Worker deploy as a one-way door and decide it on its own merits, separately from the web promotion.

### 4.6 What the repo documents NOTHING about (13 gaps, mostly self-declared)

`docs/runbooks/hotfix-rollback.md:453-475` lists 12 "known unknowns" itself. The ones that bear on this promotion:

1. **Railway "redeploy previous deployment"** — the no-build rollback. Not in any runbook; only `git revert` is documented. It is the fastest lever available and nobody has written it down.
2. **Vercel instant rollback / promote-previous** — zero mentions anywhere in the repo.
3. **Firestore index removal** — whether it deletes the live index, whether it prompts, what it costs. Never stated.
4. **The Cloudflare LB's own rollback** — `terraform destroy` is never mentioned, and `cf-load-balancing.md:17-20` records that the May 2026 apply *was* destroyed the same day without saying how.
5. **🔴 Reverting the promotion merge itself.** No runbook covers reverting a 170-commit merge commit on `main`. Both rollback sections assume a single offending SHA, and `hotfix-rollback.md:341-345` (the `d404289`/`fa164af` v2.5.0 case study) is exactly the cautionary tale for reverting a bundled change — one far smaller than this.
6. **🔴 swoop operations, entirely.** `grep -rn -i "swoop" docs/` returns **zero hits**: no deploy runbook, no kill-switch runbook, no rollback runbook, no incident playbook, for the largest feature in this promotion. The code ships three runtime levers (per-site `enabled`, the per-machine kill route, and `setSwoopSettings.server.ts` fanning a `swoop_refresh` command to online machines) and none of them is written down anywhere an on-call person would look.
7. Agent-side: `setAsLatest:false` demotion procedure "currently undocumented" (`:245`, `:457`); **agent fleet self-update kill switch** "undocumented", with "whether one exists" listed as maintainer input needed (`:458`, `:470`); migration rollback SOP "not written"; cherry-pick/hotfix-on-main playbook "not formalized"; customer-comms protocol "not in any doc"; Sentry release checklist "doesn't exist".

### 4.7 Kill switches that work without a deploy

Three documented, all Firestore or API writes:
- **Roost, per site** — `sites/{siteId}.roostEnabled = false` (`docs/runbooks/roost-kill-switch.md`). Fails **open** on a Firestore read error. 30 s cache, effect within 60 s. Carries no owner/reason/expiry metadata — the ticket is the only audit trail.
- **`capability_enforcement` / `rate_limit_enforcement`** — `global/security_config`, flipped via `POST /api/platform/security/kill-switch` with a superadmin token, `expiresInMinutes <= 240`, 5 s cache, expired flags read as enabled. **Remember it no longer covers the three swoop capabilities** (§1.4).
- **App Check** — console toggle → Unenforce, effective in minutes. **Never enforce App Check on Cloud Firestore** — it takes the entire agent fleet offline, because agents hit `firestore.googleapis.com/v1` over REST with no attestation (`docs/runbooks/app-check-rollout.md:13-31`).

**Swoop's equivalent levers exist in code but in no runbook** — see gap 6 above. The per-site `enabled = false` default is the de facto kill switch, and it is already the shipped state.

---

## 5. Risks, ranked

**1. 🔴 The promotion push irreversibly creates the prod Worker and its Durable Object, and nothing about that is rehearsed.**
`swoop-signal-deploy.yml:23-29` fires on `push: [main]` filtered to `infra/swoop-signal/**`; the whole tree arrives in the merge, so it matches. `:77` selects `-e prod`, `:111` runs `wrangler deploy`, which applies `[[migrations]] tag = "v1"` / `new_sqlite_classes = ["SignalRoom"]` (`wrangler.toml:19-21`) implicitly. `signal.owlette.app` is NXDOMAIN today, so this is the class's first creation in prod. The README's own rollback note says a rollback across a DO migration is not a rollback, and the rehearsal has never been done. *Retired sub-risks:* the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets exist and the workflow has succeeded 6 times on `dev`, creating `signal-dev.owlette.app` as a custom domain on the same zone — so the `zone → workers routes → edit` scope is proven, and `SWOOP_SIGNAL_PROD_URL` is set, so the smoke step will not trip the "unset variable" exit.

**2. 🔴 A prod Worker with no secrets passes its own smoke check.**
`infra/swoop-signal/src/index.ts:133` returns `500 ring_secret_unconfigured` on every ring when `SWOOP_SIGNAL_RING_SECRET` is unset, **while `/health` still returns 200** — and the workflow's smoke step deliberately sends no ring secret (`swoop-signal-deploy.yml:130-135`). A green deploy job is therefore not evidence of a working Worker. Whether the prod secrets are set is **not discoverable read-only**; `README.md:149-152` asserts they are not, but that same paragraph also wrongly claims the workflow has never run, so it cannot be trusted either way.

**3. 🟠 The `swoop_sessions` composite index is absent on prod and its failure is silent at deploy, loud at runtime.**
Confirmed live: prod has 34 composite indexes, the repo declares 35, and the one difference is `swoop_sessions|COLLECTION_GROUP|siteId:ASC,state:ASC`. Three call sites depend on it, including the membership-revocation sweep (`web/lib/swoop/revokeViewerSessions.server.ts:24`) and the new retention cron. `firebase deploy` returns when the build is *enqueued*, not `READY` (`docs/runbooks/manual-infrastructure.md:33`), and the team already hit this exact failure on dev (`dev/completed/api-keys-consolidation/plan.md:2`). **Cheap to retire: deploy the index today, verify `READY`, and this drops off the list.**

**4. 🟠 The screenshot upload-url route is now rate-limited per source IP, and the fielded agent has no retry.**
`POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url` became `withRateLimit(handlePost, { strategy: 'api', identifier: 'ip' })` = 300/hour (`web/lib/rateLimit.ts:118-123`). The agent's Firebase ID token does not start `owk_`, so `getApiKeyRateLimitIdentifier` returns null (`web/lib/withRateLimit.ts:58-71`) and the key is the client IP — **shared by every machine at a site behind one NAT**. A 429 raises `ScreenshotCaptureError` with no retry (`agent/src/screenshot_capture.py:222-225`). Talon visual checks can drive up to 1/5 s per machine (`web/lib/talons/visualCheck.server.ts:13`). *Bounding it:* legacy live view uses the unlimited `/api/agent/screenshot` instead, which is the high-volume path, and Upstash Redis is configured on railway-prod so the tighter 15/window in-memory fallback does not apply. This is a degradation for large NAT'd sites, not an outage. **Not verified:** how `getClientIp` derives the IP behind Cloudflare + Railway, which decides whether machines really do collapse to one identifier.

**5. 🟠 The failover story is broken in one of two ways and nothing tells you which.**
`vercel-origin.owlette.app/api/health` reports commit `da031235` — one promotion behind prod's `73f5d512`. Either (a) the Cloudflare LB is live, in which case a Railway failure today serves an old build and after the promotion would serve a *two*-promotion-old build with none of the new env vars — so any swoop session minted from the failover origin fails verification at the Worker, which is precisely why `SWOOP_JWT_PRIVATE_KEY`, `SWOOP_SESSION_MASTER_KEY` and `SWOOP_SIGNAL_RING_SECRET` are classed `must-match`; or (b) the LB does not exist (`.claude/skills/cf-load-balancing.md:17-20` says it did not as of 2026-09-10), in which case there is **no automatic failover at all** and the standby is a stale ornament. **I could not determine which** — the available Cloudflare token lacks LB read scope (§4.4). Compounding either case: the Vercel CLI is not linked in this checkout, so `sync-env.mjs status` and `sync vercel-prod --apply` cannot run until that is fixed, and Vercel's write-only secret storage means **no check can ever prove the values match** — only re-running the sync can. `manual-infrastructure.md:53` calls this mirror "CATASTROPHICALLY SILENT" for exactly that reason.

**6. 🟠 Two procedural landmines that would produce a green, wrong result.**
(a) **`.firebaserc:3` defaults to `owlette-dev-3838a`.** A `firebase deploy --only firestore` without `--project prod` deploys production indexes to *dev*, exits 0, prints no warning (`manual-infrastructure.md:21-26`). Given that the index deploy is prerequisite #1, this is the single easiest way to believe the prerequisite is met when it is not — and my own live check (34 indexes on prod, `swoop_sessions` absent) is exactly the command that would catch it.
(b) **`npm run smoke:dev` is a mandatory gate that `/preflight` does not run.** `production-deploy.md:139-190` requires it green *on the exact commit being promoted*, with the SHA still `origin/dev` at merge time and no `WARNING` line. Skipping it is invisible; nothing in CI enforces it.

**Below the line, worth knowing:**

- **Swoop ships inert, which is the single biggest de-risker.** Off per site by default (`policy.server.ts:79`, `:122` fails closed), and gated per machine on `capabilities.swoop === 1`, which no fielded agent writes (`useFirestore.ts:271` — "the ONLY gate"). `SWOOP_MIN_AGENT_VERSION = '3.4.0'` and no 3.4.0 agent exists. Every missing env var fails closed (503 `swoop_not_configured`) or degrades silently within swoop only.
- **Swoop has no e2e coverage at all**, so the three required checks on `main` prove nothing about it (§4.3). `web/playwright.config.ts:38-39` deliberately blanks `SWOOP_SIGNAL_URL` and `SWOOP_SIGNAL_RING_SECRET`, so the suite *structurally* cannot cover it. Neither does `smoke:dev` — `web/e2e-live/README.md:1-7` scopes it to a hoot turn, cancel mid-turn, a denied tier-3 call, a public share link, passkey register/sign-in and site-member management. **Nothing in any gate drives swoop end to end before prod.** The cross-platform agent/OS-reporting work and restart-schedule authoring are in the same position (covered by Jest/pytest/cargo, never through a browser).
- **Swoop has no operational documentation at all** — `grep -rn -i "swoop" docs/` = 0 hits (§4.6 gap 6).
- **No changelog entry exists for swoop** and the version number says 3.3.5, which is about library currency (§1.13). The `[Unreleased]` section is open in *both* changelog files, so promoting as-is ships an unnumbered release.
- **`sync-env.mjs check` will stay red** until the `_PREVIOUS` pair is resolved (§3.1) — and it is the gate `.claude/skills/env-management.md:65` mandates before a prod deploy.
- **The break-glass switch narrowed.** `capability_enforcement` no longer covers the three swoop capabilities (`web/lib/authorizedHandler.server.ts:106`). If it is ever used during an incident, swoop stays locked.
- **`cron-swoop-retention` must be registered by hand** or session records naming every viewer accumulate forever with no other deletion path, and stale docs keep answering as live to the revocation sweep (`infra/cron-jobs.json:152-175`).
- **A self-demote/self-remove that returned 200 now 403s** (`cannot_modify_own_membership`) — a small behaviour change for existing prod admins.
- **`info.version` in `web/openapi.yaml` stayed `2.3.1`** across 6 new paths and 3 changed ones.
- **Doc drift that will mislead whoever runs this:** `infra/swoop-signal/README.md:72-80` and `web/app/api/agent/swoop/bundle/route.ts:62-67` both claim the manifest has no `_PREVIOUS` rows (it now does, `:113`/`:116`); the README claims the workflow has never run (it has, 6 successful runs on `dev`); `.claude/skills/env-management.md:53-56` and `env-manifest.json:35` still say there are three `must-match` keys (there are seven).
- **`web/playwright.config.ts:106` will throw** for any developer who copies the new `web/.env.example` — `CLOUDFLARE_TURN_KEY_API_TOKEN`, `R2_S3_SECRET_ACCESS_KEY` and `CLOUDFLARE_API_TOKEN` match `/(_KEY|_SECRET|_TOKEN|_DSN)$/` but are in neither classification list (`:34-40`, `:47-61`). Blocks `/preflight` locally, not production.

**Explicitly NOT risks, checked and cleared:** no Firestore rules change; no storage rules change; no `firebase.json` change; no Terraform change; no cloud function behaviour change; no new Cloud Scheduler job; no data migration; no App Check change; no new or renamed API-key scopes; no billing/Stripe/Resend/Sentry/Instatus change; no framework major; **no workflow can publish an npm or PyPI package or cut a GitHub release on a branch push** — all four publishing workflows are tag-triggered and `workflow_dispatch` defaults to dry-run; and **no `/api/agent/*` route a 3.3.x agent calls has changed by a single byte.**

---

## 6. Open questions for the owner

1. **Do you want the prod signalling Worker at all in this promotion?** It is the only irreversible act in the push and it is the only thing that cannot be rolled back. The alternatives: (a) let it deploy as part of the promotion; (b) deploy it by hand first, with secrets set, as `infra/swoop-signal/README.md` prescribes, so a first failure is read at a terminal; (c) hold the swoop tree back entirely and promote everything else. Only you can weigh "swoop reaches prod inert" against "one-way door".

2. **Are the prod Worker secrets set, and is `signal.owlette.app` intended to exist today?** Not discoverable read-only. If they are not set, the deploy still goes green and the Worker is quietly broken.

3. **Do you accept the per-IP rate limit on `screenshots/upload-url` for the existing fleet?** It is the one real regression for machines already in the field. The options are accept it, raise the limit, or key it on machine rather than IP — all code changes, so this decides whether the promotion is the current `dev` tip or a `dev` plus one fix.

4. **What version number ships, and what goes in the changelog?** `dev` says 3.3.5, which is a dependency-currency release, while carrying swoop and tri-platform. Bumping to 3.4.0 would also make `SWOOP_MIN_AGENT_VERSION` honest — but the version is shared with the agent installer, and the fielded agent is 3.3.6. This interacts with #6.

5. **How do we get the Vercel failover back in sync, and should it be drained during the window?** It is already a promotion behind. Getting it current needs the CLI linked and `sync vercel-prod --apply` run, and the `must-match` values can never be *verified*, only re-pushed.

6. **Does `release/3.3.6` (PR #173) land on `dev` before the promotion, or after?** The fielded agent is 3.3.6 and prod's installer catalog already serves it, but `main`'s tree says 3.3.4. Promoting before that merge leaves `main` describing a version older than what is shipping to customers.

7. **Are you willing to promote a feature with no e2e coverage?** Swoop has 30 unit-test files and zero browser tests, and the three required checks on `main` would go green without exercising it once. Writing an e2e spec first is a schedule decision, not a technical one.

8. **Should a staging rehearsal be built?** There is no third Railway service and no preview environment. Creating one pointed at a `promote/*` branch with prod's env vars is the only way to rehearse this before it is live — worth it only if you expect to do this repeatedly.

9. **Does the Cloudflare failover load balancer actually exist right now?** The skill says it did not as of 2026-09-10; the Vercel origin answers but on a stale commit; and the token available here cannot read the LB. This changes what "the failover origin staying in sync" even means, and it is a one-command answer for you (§4.4). If the LB is not live, is standing it up part of this promotion or a separate piece of work?

10. **What is the abort plan if the promotion goes wrong?** No runbook covers reverting a 170-commit merge commit on `main`, and the repo's own cautionary tale (`hotfix-rollback.md:341-345`) is about reverting a far smaller bundled change. The realistic answer is probably "redeploy the previous Railway deployment, don't revert git" — which is also one of the 13 things the repo documents nowhere (§4.6 gap 1). Decide it before you need it, and ideally write it down.

11. **`dev/active/` is gitignored** (`.gitignore:32`), so this research and any plan built on it vanish with the working tree. Where should the tracked copy live?

