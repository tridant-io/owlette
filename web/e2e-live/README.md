# Live dev smoke suite

`npm run smoke:dev` drives a real browser against live **https://dev.owlette.app** (Firebase
project `owlette-dev-3838a`) and checks what the emulator suite in [`web/e2e/`](../e2e/) cannot: a
hoot turn on a real LLM with a tool call, cancelling a turn, denying a tier-3 call, a public share
link, passkey registration and sign-in, and per-site member management — all against dev's real
rules, indexes and deploy config.

A green run on the commit being promoted is required before `dev` is merged to `main`
([production-deploy.md](../../docs/runbooks/production-deploy.md), step 5). It runs on the
maintainer's workstation, never in CI — see
[why it runs locally](#why-it-runs-locally-not-in-github-actions).

## Prerequisites

- Node 22 (`web/package.json` `engines`, `.nvmrc`), `web/node_modules` installed
  (`npm ci --legacy-peer-deps`), and Playwright's Chromium: `cd web && npx playwright install chromium`.
- A checkout whose `origin` is the GitHub repo: the deploy check runs `git fetch origin dev`.
- Three local credentials. All are gitignored, read at runtime only, and never committed or printed:

| credential | default location | override | what reads it |
|---|---|---|---|
| dev service account | `agent/config/firebase-creds-dev.json` | `SMOKE_SA_PATH` | firebase-admin: seed, teardown, stub agent, spec reads |
| dev web env file | `web/.env.local` | `SMOKE_ENV_FILE` | `NEXT_PUBLIC_FIREBASE_API_KEY` for the UI logins; must set `NEXT_PUBLIC_FIREBASE_PROJECT_ID=owlette-dev-3838a` |
| hoot LLM key | `SMOKE_LLM_API_KEY` in `.claude/.env.local`, or the environment | `SMOKE_LLM_ENV_FILE` | global setup, once — see below |

The service account must be `owlette-dev-3838a`'s; any other project aborts the run before its
first read or write. Obtain it and the web env file out of band.

### The hoot LLM key

hoot answers only with a per-user key stored at `users/{uid}/settings/llm`, which the app encrypts
with a secret that exists only on dev. So the suite never writes that document itself: on a run
where `smoke-siteadmin` has no key stored, global setup — signed in as `smoke-siteadmin` — saves
`SMOKE_LLM_API_KEY` through the app's own `POST /api/settings/llm-key`. Every later run finds the
stored key and ignores the variable (setup says so).

```sh
# .claude/.env.local at the repo root (gitignored)
SMOKE_LLM_API_KEY=<a dedicated, spend-capped key>
# only for an OpenAI key; the default is anthropic
SMOKE_LLM_PROVIDER=openai
```

- The runner reads the environment first, then that file. It hands the key to Playwright's
  environment only — never to the stub agent — and nothing logs it.
- The key is saved with no model, so hoot runs the app's default model: the run tests what users
  get. The hoot checks make real model calls on it every run, more when a check retries.
- Never create or edit `users/smoke-siteadmin/settings/llm` by hand or with firebase-admin: a
  document dev did not encrypt fails to decrypt mid-turn. Replace it through the app instead:
- Setup stores a key only when none is stored; later runs leave the stored one alone and say so,
  with a warning when `SMOKE_LLM_PROVIDER` disagrees with the stored provider. A revoked, exhausted
  or wrong-provider key shows up as the hoot checks failing with the provider's error
  (`the tool-call turn ended error (…)`). To replace it, run once with `SMOKE_LLM_REPLACE_KEY=1` in
  the environment (never in the file, or every run would store it again) and the right
  `SMOKE_LLM_API_KEY` / `SMOKE_LLM_PROVIDER`: setup posts the key through the same route, which
  overwrites the stored one.
- Before storing, setup refuses the unambiguous mismatches: an `sk-ant-` key declared `openai`, and
  an `sk-` key without `-ant-` declared `anthropic` (the default).
- The hoot and share checks need it (share makes no model call, but until a key is stored `/hoot`
  covers the conversation with its "requires an LLM API key" overlay). Without one they fail
  fast and say so; the passkey and roles checks still run.

### From a git worktree

`git worktree add` brings none of the three files along. Point `SMOKE_SA_PATH`, `SMOKE_ENV_FILE`
and `SMOKE_LLM_ENV_FILE` at the main checkout's copies rather than copying them into the worktree.

## Running it

```sh
cd web
npm run smoke:dev
```

One run, in order ([`run.mjs`](run.mjs)):

1. **Credentials** — the service account and web env file are checked (files only) before
   anything waits.
2. **Deploy check** — `git fetch origin dev`; the checkout itself must be at `origin/dev`'s HEAD
   (the specs that run must be the build's), or the runner refuses. Then
   `https://dev.owlette.app/api/health` is polled every 10 s until it answers healthy with `commit`
   equal to that SHA. It gives up after 10 minutes, so a run can start while Railway is still
   building. Uncommitted changes under `web/e2e-live/`, `playwright.live.config.ts` or a module the
   specs import (`lib/mcp-tools.ts`, `lib/hoot/shareTypes.ts`, `e2e/helpers/webauthn.ts`,
   `e2e/helpers/emulator.ts`) do not stop the run, but they print a `WARNING`.
3. **Stub agent** — a fresh 8-hex nonce; [`stub-agent.mjs`](stub-agent.mjs) registers
   `sites/smoke-live/machines/smoke-stub-01`, and the runner waits until it reads online by the
   dashboard's rule.
4. **Playwright** — [`playwright.live.config.ts`](../playwright.live.config.ts). Global setup
   proves the web API key is dev's, seeds site `smoke-live` and the three persistent users (fresh
   passwords, held in memory), signs `smoke-siteadmin` and `smoke-member` in through `/login`, and
   stores the LLM key if none is stored. The eight tests run one at a time with one retry each
   (120 s per test, 180 s for the tier-3 check). Global teardown then removes what the run created.
5. **Finish** — the stub is stopped over IPC (killed by PID after 15 s). Ten seconds later a last
   `teardown()` pass sweeps what its final writes set off — every write to its machine doc samples
   into `metrics_history`, and those can land after global teardown — along with anything a stub
   that did not stop cleanly left. A summary prints, and the runner exits with Playwright's code.

| command | effect |
|---|---|
| `npm run smoke:dev -- --any-commit` | skip the deploy check and test whatever dev serves; never counts for the release gate |
| `npm run smoke:dev -- -- --grep share` | forward arguments to `playwright test` (`--config`, `--reporter` and any short-option cluster holding `-c` are refused); a filtered run never counts for the release gate |
| `node e2e-live/run.mjs --help` | usage and environment variables; reads no credentials |

Always start through the runner. The hoot checks refuse to run without the nonce (`SMOKE_NONCE`)
and stub log (`STUB_LOG`) it provides, and a bare `npx playwright test -c playwright.live.config.ts`
skips the deploy check.

### Reading the result

The summary ends the output:

- `commit` — the `origin/dev` SHA tested, and whether dev served it when the specs started (with
  `--any-commit`, whatever dev reported instead).
- `WARNING` — dev changed commit mid-run, so the results mix two builds; dev's commit could not be
  re-read after the specs, so a mid-run deploy cannot be ruled out; Playwright arguments were
  forwarded, so the specs may have been filtered; or the suite's files (or a module its specs
  import) had uncommitted changes, so the specs that ran were not the commit's. Any of these means
  the run does not count.
- One row per test: `PASS`, `FLAKY` (passed on its retry), `FAIL`, `SKIP`, `NOT RUN` or
  `INTERRUPTED`, then totals and a count of global setup or teardown errors.
- `stub`, `sweep` — how the stub agent stopped, and what the last `teardown()` pass found (nothing,
  on a clean run).
- `exit` — `0` green; `1` a failed test, or a step before Playwright failed; `130` interrupted;
  `2` bad arguments.

Output lands in `e2e-live/.output/` (gitignored): `report/` (open it with
`npx playwright show-report e2e-live/.output/report`), `report.json`, `results/` (traces and
screenshots of failures), `stub-log.jsonl` (one JSON line per command the stub saw), and
`debug/login-failure-<role>.png` when a setup login fails. Signed-in role states live in
`e2e-live/.auth/` only while a run is going; global teardown deletes them and revokes the
persistent users' Firebase refresh tokens.

**After a failure, `.output/` holds a live dev session.** A failed test keeps its trace in
`results/`, copied into `report/data/`, and the trace's network log carries that role's
`__session` cookie. It works until global teardown revokes the persistent users' refresh tokens,
after which the API refuses it within a minute; a run whose teardown did not finish (a forced
exit, a crash) leaves it valid for up to 7 days. For the hoot, share and roles checks it is a site
admin of `smoke-live`, able to run hoot turns billed to the stored LLM key. Treat `.output/` like `.auth/`: never attach a report, trace or screenshot from it to a PR,
issue or chat. The next run empties `results/` and replaces `report/`.

Ctrl-C once: Playwright runs its global teardown, the stub removes its machine, and the runner
waits for both, then sweeps. Ctrl-C twice: an immediate exit that leaves the cleanup to the
[cleanup CLI](#manual-cleanup). A machine stranded that way reads offline after five minutes, and
the offline alert the health-check cron raises for it reaches no one (see [no alerts](#safety-chain)).

### Before you start

- One live run at a time. Runs share the three test users and the one stub machine; a second
  stub refuses to start.
- Not alongside a local `npm run e2e` (CPU contention).
- Keep dev closed in browsers on the same network. Dev's auth rate limit is 10 requests a minute
  per public IP, shared by every sign-in, passkey and LLM-key request from that IP. The passkey
  check paces itself and fails with a clear message when something else drained the budget.
- Runs leave traces on dev by design: `global/audit_log` rows for member and passkey changes, and
  dev Sentry events when something fails. Every smoke account's uid starts `smoke-` and its email
  ends `@owlette.test`; filter on that.

## What each check asserts

Assertions read machine state — request bodies, Firestore documents, the stub's command log —
never the model's wording.

### hoot — [`specs/hoot.spec.ts`](specs/hoot.spec.ts)

As `smoke-siteadmin` (site admin of `smoke-live`, so tier-3 tools are on offer), each check in a
new chat aimed at `smoke-stub-01`, which the target picker must list online and with hoot on.
Aiming clears the tri-state "all machines" row and then ticks the stub. The row is filled first
when it opens partial — the ticked set is stored as the user's site preference, so it does not open
full after the first chat, and from a partial set that row ticks all rather than clearing. Because
`smoke-live` holds exactly that one machine, the tick collapses back to the dynamic "all machines"
(a set covering the site is stored as `null`), which the server resolves to the same single
machine. A site left holding a machine stranded by an earlier run gives the explicit subset
instead, so the body assertion accepts either shape: `target.machineIds` `null` with the legacy
`machineId` `__site__`, or `[smoke-stub-01]` with `machineId` `smoke-stub-01` — never a subset
beside a widening legacy field. Every prompt names its tool, and every `POST /api/hoot` must carry
`smoke-live` and exactly one question, and answer 200.

- **Tool call** — "Use your get_system_info tool on this machine…". The turn's
  `chats/{id}/stream/current` ends `complete`, the stub log shows a completed `get_system_info`
  relay from this chat, the stream doc's `toolCommands` (the runner's own record of what it
  dispatched) names that same command, and both the saved answer and the page carry
  `smoke-<nonce>` as a whole token — the hostname the stub reports for this run only.
- **Cancel** — the stub holds commands (`smoke/control` `hold: true`) and the same prompt is sent.
  Once the stub has logged the held command and the turn reads `running`, stop is clicked: the
  stop button is gone within 10 s, `POST /api/hoot/stop` answers 200, the composer is editable
  again, and that turn's stream doc reads `cancelled`. Those prove the route and the browser. The
  server turn stops only when the runner's next heartbeat (every 20 s) sees the cancel and aborts,
  and its tool poll then withdraws the held command. So the held command must leave
  `commands/pending` before the tool's own timeout (30 s + 10 s after it was queued) could take it
  out, and nothing from the chat may reach the stub after the stop. A stop that lands too late in
  the hold to tell the two apart fails as `inconclusive` rather than pass.
- **Tier-3 deny** — first confirms `run_powershell` is tier 3 and that `smoke-live`'s
  `settings/cortex.requireTier3Approval` is not `false`. The prompt asks for `Get-Date` through
  `run_powershell`; the asking turn ends with each such call `approval-requested`, its card
  "awaiting approval", and no such dispatch in its `toolCommands`. Only the button named `deny` is
  clicked, once per card. Every card then reads denied, the resumed turn completes with no such
  dispatch recorded either, and every saved call is denied. The stub then answers a canary command,
  proving it was listening throughout, and its log holds no `run_powershell` entry and no tier-3
  command at all.

### share — [`specs/share.spec.ts`](specs/share.spec.ts)

A finished conversation for `smoke-siteadmin` is seeded straight into Firestore, so no LLM turn
runs; its tool call carries marker strings in its input and output. From `/hoot/{chatId}`: share
conversation → create link (201). The link must be `https://dev.owlette.app/share/shr_…`, backed
by an unrevoked `chat_shares` doc for this chat, site and user. A signed-out reader then gets 200,
the title, the question and answer in `shared-conversation`, the tool as its name and outcome
only, neither marker anywhere in the served HTML, `noindex` in `meta[name="robots"]`, and
`no-store` in its `cache-control`. The unfurl card answers 200 for any token, falling back to one
generic card for a dead one, so the check compares images rather than statuses: the generic card
(from a well-formed token no share holds) must render the same bytes twice, and the link's card
must differ from it. Revoking from the dialog (200) stamps the doc revoked; the reader's reload of
the same URL is a 404 with no conversation, the link's card is now the generic one, and the chat
itself still exists. The 200 before the revoke is the positive control for the 404.

### passkeys — [`specs/passkeys.spec.ts`](specs/passkeys.spec.ts)

A fresh MFA-free account, `smoke-passkey-<runId>@owlette.test`, for every attempt: registering
makes an account MFA-enrolled, so one is never reused. It signs in with its password and lands
on `/dashboard`. Account settings → security → add passkey, answered by a CDP virtual
authenticator: `register/options` must answer 200 (a 403 `mfa_challenge_required` would mean the
first passkey now needs an MFA step-up); the credential must be scoped to RP ID `owlette.app`,
which production builds use on dev.owlette.app too, and must be the one dev stored; the user doc
must then read one passkey and `mfaEnrolled: true`. After signing out (no session left),
"continue with passkey" must reach `/dashboard` with no MFA page on the way, holding a verified
session for that uid, and dev's stored sign counter must match the authenticator's.

### per-site roles — [`specs/roles.spec.ts`](specs/roles.spec.ts)

`smoke-target` has no standing in `smoke-live` before or after each check.

- **Site admin** — `smoke-siteadmin` goes dashboard → user menu → admin panel, which lands on
  `/admin/sites`, then `smoke-live`'s gear → members, and the members section must list
  `smoke-live` alone. It adds `smoke-target` as a member by typing their email into the dialog's
  "name or email", makes them an admin with the row menu's "change access..." (the dialog's role
  select, then save), and removes them; `sites/smoke-live/members/smoke-target` is read back after
  each step. The row menu must offer a site admin "change access..." and "remove...": site admins
  change roles in the UI (owner ruling, 2026-11-04).
- **Hard loads** — `smoke-siteadmin` loads `/admin/sites` and
  `/admin/sites/smoke-live?section=members` fresh, and each settles on its page with no "access
  denied" toast: the admin panel's guard waits for the memberships before it decides.
- **Member** — `smoke-member` is turned away from `/admin/sites` (back on `/dashboard`, "access
  denied"), has no "admin panel" in the user menu, and an in-page
  `POST /api/sites/smoke-live/members` is refused 403 `capability not granted` with no row
  written. Positive control: the same request as `smoke-siteadmin` answers 200 and writes the row,
  then is undone.

## Manual cleanup

Global teardown runs after every run, even when global setup fails. Use the CLI after a forced
exit or a crash, or whenever a dry run shows residue. From `web/`:

```sh
node e2e-live/lib/seed.mjs --teardown --dry-run   # count what would be deleted; changes nothing
node e2e-live/lib/seed.mjs --teardown             # delete it; prints a count per path
node e2e-live/lib/seed.mjs --seed --dry-run       # show drift in the site and users; changes nothing
```

Teardown deletes `smoke-target`'s member row; every chat a smoke account owns (and ownerless
autonomous chats in `smoke-live`) with all its subcollections; their `chat_shares` and
`cortex-followups`; the stub machine with its `commands`, `smoke` and `metrics_history` docs and
its config doc; and every `smoke-passkey-` account with its user doc, passkeys, trusted devices,
pending MFA setup and WebAuthn challenges. It also repairs two fields a run can leave on documents
it keeps: `requireTier3Approval: false` on `smoke-live`'s `settings/cortex` (the tier-3 gate
switched off), and `smoke-live` in `smoke-target`'s legacy `users.sites[]`, which the app's member
add mirrors there. It keeps the `smoke-live` site and the three persistent users with their own
member rows and settings — the stored LLM key included. A clean dev reads `total 0` on
`--teardown --dry-run`.

`--seed` without `--dry-run` repairs drift and rotates the three passwords without printing them;
the next run rotates them again anyway.

The stub agent runs alone too. `node e2e-live/stub-agent.mjs --nonce <n> --log <path> --dry-run`
self-checks its command handling offline; without `--dry-run` it registers `smoke-stub-01` until
Ctrl-C. If it refuses with "another stub agent is running", another run is live or one crashed
less than 90 s ago: stop it, wait, or run the teardown above.

## Safety chain

Enforced in code, not configuration:

- **Dev host only.** `playwright.live.config.ts` throws at load unless every `baseURL` is
  `https://dev.owlette.app`, and global setup refuses a config whose origin differs from
  `lib/devAdmin.mjs`'s. The fixtures watch every page of `siteAdminPage`, `memberPage` and the
  built-in `page` and `context`: a top-level navigation to another origin closes the page and fails
  the test. A context a spec builds itself with `browser.newContext()` is not watched, so use
  `page` for a signed-out one.
- **Dev data only.** [`lib/devAdmin.mjs`](lib/devAdmin.mjs) is the suite's only firebase-admin
  handle. It refuses a service account whose `project_id` is not `owlette-dev-3838a` before
  `initializeApp`, and refuses to start at all while an `*_EMULATOR_HOST` variable is set.
- **Dev sign-in only.** The web env file must name `owlette-dev-3838a`. Before the first login,
  global setup proves the web API key is dev's: the project number Identity Toolkit reports for
  the key must equal the one the service account reads for the project. During setup's logins,
  every Firebase Auth request is held until its key passes the same check, so a password never
  leaves for another project.
- **Never approve.** [`__tests__/e2eLiveGuard.test.ts`](../__tests__/e2eLiveGuard.test.ts), part of
  `npm test`, parses every source file here and fails on all three ways to approve: a string,
  pattern or identifier naming an approve control; switching the site's approval gate off (the
  toolbar toggle's names, the `hoot-settings` route, a write of `requireTier3Approval` other than
  `true` or its removal); and an approving answer (`addToolApprovalResponse`, a write of `approved`
  other than `false`). The tier-3 check clicks only `deny`. The guard is a tripwire for honest
  mistakes, not a sandbox. Behind it, the stub agent executes nothing — it answers
  `get_system_info` and `get_running_processes` with canned data and fails every other command —
  so even an approved tier-3 call could not run. `requireTier3Approval` is never set on
  `smoke-live` (absent means approval is required); seed and teardown both remove a `false` left
  there.
- **Never superadmin.** Seed holds every smoke account at global role `member` with MFA off; site
  standing comes only from `sites/smoke-live/members/{uid}` rows (`admin` for `smoke-siteadmin`,
  `member` for `smoke-member`, none for `smoke-target`). It refuses any identity whose uid lacks
  the `smoke-` prefix or whose email is not `@owlette.test`, an email another uid holds, and an
  account holding a second factor.
- **No real machine.** The stub registers only `smoke-stub-01` in `smoke-live` and deletes it on
  the way out.
- **No alerts.** Every alert preference of every smoke user is off, and seed empties `smoke-live`'s
  threshold rules. Seed also holds `sites/smoke-live.owner` at `smoke-siteadmin`: alert delivery
  still finds a site's users only through that legacy field (and `users.sites[]`), and a site with
  none counts as orphaned, so its alerts would go to the dev admin address instead. The field grants
  nothing; access is the member row. So an alert about `smoke-live`, such as the offline alert for a
  stub stranded by a forced exit, has no recipient.
- **No secrets in the console.** Passwords are random per run and held in memory. The LLM key
  reaches Playwright's environment only. Text echoed from the browser is redacted of API keys, a
  failed login saves a screenshot rather than page HTML, and no message quotes a share link's
  token. Files are another matter: a failed test's trace in `.output/` carries that role's session
  cookie, valid until teardown revokes the role's refresh tokens, or up to 7 days when teardown
  did not finish (see [reading the result](#reading-the-result)). `.auth/` and
  `.output/` are gitignored; teardown deletes `.auth/` and revokes the persistent users' refresh
  tokens.
- **The whole gate or nothing.** `forbidOnly` fails a run that contains a stray `test.only`.

## Why it runs locally, not in GitHub Actions

Both cost the same: Actions minutes are free for this public repository, and the LLM spend is
identical either way. The difference is the dev firebase-admin key the suite needs. In Actions it
would be a secret of a public repository, and that key can write `commands/pending` for every
machine paired to dev — maintainers' own workstations included — while Firebase IAM cannot narrow
it to test data. So it stays on the workstation, and the release gate is a runbook step rather
than a required GitHub check.

The deferred upgrade is a workflow on Railway's `deployment_status` event for the dev environment,
reporting a required `live-smoke/dev` status on `main`. Nothing here assumes a workstation —
every credential resolves from a path or environment variable, and the runner prompts for
nothing — so moving it is a workflow file plus secrets.

## Troubleshooting

| message | meaning |
|---|---|
| `has no commit field` | dev is serving a build older than the `commit` field in `web/app/api/health/route.ts`; the check waits for a deploy that has it |
| `reports commit: null` | the running deploy carries no SHA (Railway sets `RAILWAY_GIT_COMMIT_SHA` only for GitHub-triggered deploys); the check waits for one that does |
| `this checkout is at … and origin/dev at …` | the specs here are not the ones dev will serve: `git pull --ff-only origin dev`, or `--any-commit` for a run that does not count |
| `ABORT: service account project …` or `ABORT: … targets project …` | a credential is not dev's; fix the file — nothing was written |
| `ABORT: FIRESTORE_EMULATOR_HOST is set` (or another `*_EMULATOR_HOST`) | unset it in this shell |
| `another stub agent is running` | another run is live, or one crashed less than 90 s ago |
| `smoke-stub-01 is listed offline` | the stub's heartbeat stopped; its `[stub]` output says why |
| `sign-in landed on /setup-2fa` (or `/verify-2fa`) | the seed's MFA bypass did not hold; `--seed --dry-run` shows the drift |
| `holds a second factor` | a persistent smoke user has enrolled one; remove it by hand |
| `dev's auth rate limit … refused` | something else on this IP spent the budget; wait two minutes and re-run |
| `has no hoot LLM key` | set `SMOKE_LLM_API_KEY` — see [the hoot LLM key](#the-hoot-llm-key) |
| `the tool-call turn ended error (…)` | the provider rejected the turn; often the stored key is revoked, out of credit, or saved under the wrong provider — replace it with `SMOKE_LLM_REPLACE_KEY=1` ([the hoot LLM key](#the-hoot-llm-key)) |
| `inconclusive: the stop landed … into the hold` | the page attached to the turn late, so the cancel check could not tell the runner's abort from the tool's own timeout; its retry usually settles it |
| `the held command was still in … commands/pending` | the cancelled turn kept running on dev: the runner's heartbeat → abort → tool-poll path is broken |
| every navigation fails or times out | Cloudflare may be challenging headless Chrome from this IP |

## Files

```
web/
├── playwright.live.config.ts         dev-only config: throws on any other host
├── __tests__/e2eLiveGuard.test.ts    no approve control anywhere in e2e-live
└── e2e-live/
    ├── run.mjs                       npm run smoke:dev: deploy check → stub → Playwright → summary
    ├── stub-agent.mjs                fake online machine smoke-stub-01; canned tier-1 answers only
    ├── global-setup.ts               API key pin → seed → UI logins → one-time LLM key
    ├── global-teardown.ts            teardown(), delete .auth/, revoke refresh tokens
    ├── fixtures.ts                   siteAdminPage, memberPage, navigation guard, nonce and stub log
    ├── lib/devAdmin.mjs              the only firebase-admin handle, pinned to owlette-dev-3838a
    ├── lib/seed.mjs                  seed() and teardown(), and the cleanup CLI
    ├── lib/harness.ts                shared paths: role states, login roles
    └── specs/                        hoot, share, passkeys, roles
```
