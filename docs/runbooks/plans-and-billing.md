# plans and billing runbook

Operator reference for owlette's plans: owlette free (1 machine, 1 site, monitoring only), the
14-day pro trial, and core/pro billed per active machine. It covers turning enforcement on, dev
first and then prod, checking it is really on, rolling it back, and running it day to day.

Design source of truth: `dev/active/owlette-free/plan.md` (numbered decisions) and its `tasks.md`
(review log). Entitlements come from tridant id. Owlette holds no billing state of its own beyond
the two server-only collections described below.

---

## current state: dormant

Every gate is shipped and none of them is enforced. A gate enforces only when **all** of these hold
on the origin that answers the request:

1. `PLAN_ENFORCEMENT` is exactly `on`. `On`, `true` and `1` all count as off.
2. `TRIDANT_API_URL` and `TRIDANT_LICENSE_KEY` are both set (non-blank).
3. tridant id answers the entitlement lookup (`GET /v1/licenses/owlette:{uid}/entitlements?app=owlette`).
4. The payer (the site's `owner`) is not a superadmin.

With (1) or (2) missing, every gate returns before it reads anything, so behaviour is identical to
before plans existed (`offBeforeReads` in `web/lib/plan.server.ts`).

**What fails open, and why.** These answer "unrestricted" and are logged:

| reason | cause | why it fails open |
|---|---|---|
| `enforcement_off` | `PLAN_ENFORCEMENT` isn't `on` | the off switch |
| `not_configured` | URL or key blank | logged once per process: `[plan] PLAN_ENFORCEMENT is on but tridant id is not configured` |
| `unreachable` | network error, 5 s timeout, 429 or 5xx | a tridant outage must not lock every customer out |
| `rejected` | tridant answered 4xx: wrong key, scope, or environment | a misconfiguration on our side, so the same reason applies. Logged once as an error: `[plan] tridant id refused the entitlement lookup` |
| `malformed_response` | a 2xx that isn't the expected shape | contract drift (#76 is still a proposal) |
| `superadmin` | the payer's `users/{uid}.role` is `superadmin` | staff accounts are never limited |
| `no_payer` | the site has no `owner` | nothing to bill |

Each failed lookup is also logged as `[tridant] request failed` with `reason` and `status`.
Answers, failures included, are cached for 60 s per uid per process.

**Not failing open, by design.** Under enforcement, `resolved: false` (an account tridant id has
never mapped, such as an unverified password sign-up) is **free**, not unrestricted (decision 3).
This is why existing accounts must get a trial before the flip.

**A key missing from the answer is unrestricted** until task 6.4 flips it to "not entitled". It
logs `[plan] tridant sent no value for <key>; treating it as unrestricted` once per key, and
`/api/account/plan` reports `reason: "keys_missing"` with `missingKeys`.

**What already runs while dormant:**
- the `plan-daily` cron, if registered, stamps active machines and writes every
  `plan_snapshot` as `enforced: false`;
- pairing stamps `pairedAt` on new machines;
- password sign-ups get the email-verification link.

None of these withholds anything.

### the three variables

All three are `must-match` in `scripts/env-manifest.json`: railway-prod and vercel-prod must hold the
same values, or a failover to Vercel silently drops (or adds) enforcement.

| var | railway-dev | railway-prod + vercel-prod |
|---|---|---|
| `TRIDANT_API_URL` | `https://api-staging.tridant.io` | `https://api.tridant.io` |
| `TRIDANT_LICENSE_KEY` | `license.read` key from admin-staging.tridant.io | `license.read` key from tridant id production |
| `PLAN_ENFORCEMENT` | `on` / `off` | `on` / `off` |

Owlette dev talks only to tridant staging, and prod only to tridant production (decision 2). A
staging key against production answers `rejected`, which fails open.

---

## prerequisites (dev)

Do these in order. Do not flip `PLAN_ENFORCEMENT` until every box is ticked.

- [ ] **tridant-id #75 and #76 shipped on staging.** These cover the free entitlements
  (`owlette.machines`, `owlette.sites`, `owlette.control`, `owlette.deployments`, `owlette.swoop`,
  `owlette.hoot`, `owlette.roost`, `owlette.talons`, `owlette.webhooks`, `owlette.api_keys`), S2S
  trial start, metered prices, `POST /v1/usage`, and the period in the entitlement answer. Verify
  with an unmapped probe subject, using the key from the next step held in `$TRIDANT_LICENSE_KEY`
  (never echo it):

  ```bash
  curl -s -H "Authorization: Bearer $TRIDANT_LICENSE_KEY" \
    "https://api-staging.tridant.io/v1/licenses/owlette:runbook-probe/entitlements?app=owlette"
  ```

  Expect `200`, `resolved: false`, `standing: "expired"`, and an `ent` holding all ten keys:
  machines and sites `1`, the eight flags `0`. Any key absent here shows up later as `keys_missing`.
- [ ] **License key set on railway-dev.** Create a `license.read` key in admin-staging.tridant.io.
  In the Railway UI (service `owlette-dev`, environment `dev`), set it as `TRIDANT_LICENSE_KEY`, and
  set `TRIDANT_API_URL=https://api-staging.tridant.io`. Put the secret in the UI, never on a command
  line. Leave `PLAN_ENFORCEMENT` off. Verify:
  - the probe above returns `200` with this exact key (`401`/`403` means wrong key or scope);
  - `node scripts/sync-env.mjs` shows both keys present on railway-dev.
- [ ] **Functions deployed to dev from this code.** Functions don't ship on push. Run
  `firebase deploy --only functions --project dev` (the full invocation is in
  [production-deploy.md](production-deploy.md)) from a checkout containing
  `functions/src/lib/planSnapshot.ts`. Without it, scheduled rollouts ignore plans.
- [ ] **`plan-daily` registered on cron-job.org for dev.** The entry is `cron-plan-daily` in
  `infra/cron-jobs.json`:

  | setting | value |
  |---|---|
  | method | `GET` |
  | url | `https://dev.owlette.app/api/cron/plan-daily` |
  | schedule | `0 3 * * *` (keep 03:00 UTC, see operating notes) |
  | header | `X-Cron-Secret: <dev CRON_SECRET>` |
  | timeout | at least 60 s |

  Verify by hand: `curl -si -H "X-Cron-Secret: $CRON_SECRET" https://dev.owlette.app/api/cron/plan-daily`
  returns `200` with a summary where `errors` is 0 and `snapshots` equals `payers` (see
  [reading the summary](#reading-the-daily-summary)). Register it before the flip so the month's day
  stamps are already accumulating.
- [ ] **Wave 6.1 deployed, then the bulk trial start run on dev.** New sign-ups must start a trial
  on their own: password accounts after email verification, Google at bootstrap. Then existing
  accounts are started by the bulk script: `node scripts/start-trials.mjs --env dev` (a dry run by
  default), then the same with `--apply`. Task 6.1 isn't built yet, so confirm the flags when it
  lands. Before applying, decide what happens to existing **unverified** password accounts: any
  account the run skips resolves to free at the flip. Verify with the probe for two or three
  existing uids: `resolved: true`, `standing: "trialing"`, flags `1`.
- [ ] **Test accounts ready.** You need a non-superadmin account that went through the bulk trial,
  and a fresh password account left **unverified**, which is unmapped and therefore free. A superadmin
  always reads as `reason: "superadmin"` and proves nothing.

---

## enable on dev

1. Set `PLAN_ENFORCEMENT=on` on railway-dev (UI, or
   `railway variables --set "PLAN_ENFORCEMENT=on" -s owlette-dev -e dev`). Wait for the redeploy to
   go live.
2. **Verify it is on.** Signed in to dev.owlette.app as the trial test account, run this in the
   browser console. The route takes a session or the user's own ID token, never an API key.

   ```js
   await (await fetch('/api/account/plan')).json()
   ```

   Expect `enforced: true`, `plan: "trial"`, `standing: "trialing"`, all flags `true`, and **no
   `reason`**. Then the free test account should show `plan: "free"`, `limits: {machines: 1, sites: 1}`,
   and all flags `false`.

   | you see | meaning | fix |
   |---|---|---|
   | `reason: "enforcement_off"` | the redeploy isn't live, or the value isn't exactly `on` | check the variable, wait for the deploy |
   | `reason: "not_configured"` | URL or key blank on this service | set both |
   | `reason: "rejected"` | tridant refused the key | wrong key, wrong scope, or a prod key against staging |
   | `reason: "unreachable"` / `"malformed_response"` | tridant is down, or its answer changed shape | check `[tridant] request failed` in the Railway logs |
   | `reason: "superadmin"` | you are testing as a superadmin | use the test accounts |
   | `enforced: true`, `reason: "keys_missing"` | tridant sent no readable value for `missingKeys`, which stay unrestricted | fix on the tridant side (#76); not a pass |

   Failures are cached for 60 s per uid, so wait a minute after a config fix.
3. **Smoke checks**, as the free test account:
   - create a site: allowed. A second site is refused with `402` and
     "your plan doesn't cover another site. upgrade for more sites."
   - pair one machine: allowed. Pairing a second machine's phrase on `/add` toasts
     "owlette free covers one machine. upgrade to add more, or remove a machine first." The second
     agent logs `Device code poll failed: owlette free covers one machine…` and stays unpaired. A
     dashboard-generated `/ADD=` code for that machine gets the same refusal at poll.
   - re-pair the first machine (reinstall, or run pairing again): allowed. A re-pair is always exempt.
   - from the dashboard, restart a process or reboot the machine: refused with
     "your plan doesn't include remote control. upgrade to continue."
   - update owlette on an out-of-date machine with the update owlette button: accepted, and the agent
     updates. Editing the process configuration (crash-restart) is also allowed.
   - swoop won't start, and hoot answers `402`.
4. **Agents keep heartbeating.** No plan gate touches `/api/agent/auth/refresh`, but this is the
   failure that costs the most, so prove it: note the number of online machines on dev before the
   flip, and confirm it is unchanged an hour later. That is past one access-token refresh. No
   machine should go offline or ask to pair again.
5. Run `plan-daily` by hand once, so `plan_snapshot` carries enforcement now rather than at 03:00
   (optional; see the caveat under [manual runs](#manual-runs)).
6. Leave dev on through at least one scheduled 03:00 run, then read that run's summary in the
   cron-job.org history.

---

## enable on prod

### prerequisites (prod)

- [ ] Dev has been on and clean: smoke checks passed, one 03:00 run read, no
  `[plan]` errors in the logs.
- [ ] tridant-id #75/#76 shipped on **production**. Verify with the probe against
  `https://api.tridant.io`, using the prod key.
- [ ] Waves 6.2 (usage report) and 6.3 (upgrade flow) are on `main`. Without them nobody is billed
  and nobody on free can upgrade. Also 6.4's code change: a missing key now means not entitled. Ship
  it only once the dev probe and `/api/account/plan` show no `keys_missing`.
- [ ] The pricing copy no longer says "free during beta". That covers `STATUS`, `PRICE_LINE` and
  `PRICING` in `web/lib/product-facts.ts`, and the "applies after beta" framing in the plans docs.
  The change is on `main` and deployed.
- [ ] `TRIDANT_API_URL` and `TRIDANT_LICENSE_KEY` are set on railway-prod (service `owlette-prod`,
  environment `dev`: both Railway services live in the one `dev` environment). `PLAN_ENFORCEMENT`
  is still off.
- [ ] Vercel is mirrored. Run `node scripts/sync-env.mjs sync vercel-prod` as a dry run: both tridant
  vars should be listed under "would set", and neither should appear under "absent at source". Then
  run it with `--apply`. Vercel applies env changes only to **new** deployments, so redeploy the
  current production deployment (Vercel dashboard → owlette → Deployments → Redeploy). Confirm with
  `node scripts/sync-env.mjs check` and `curl -s https://vercel-origin.owlette.app/api/health`.
- [ ] Functions are deployed to prod (`--project prod`, explicitly: `.firebaserc` defaults to dev).
- [ ] `plan-daily` is registered for prod at `https://owlette.app/api/cron/plan-daily` with the prod
  `CRON_SECRET`, and a manual run returns `200` with `errors: 0`.
- [ ] The customer notice (below) has been signed off by the owner.

### the flip

1. **Bulk trial start on prod:** `node scripts/start-trials.mjs --env prod`, check the dry run's
   count, then `--apply`. This starts every account's 14 days, so send the customer notice the same
   day and flip the same day. A gap between them is trial time customers lose without seeing it.
2. Set `PLAN_ENFORCEMENT=on` on railway-prod and wait for the redeploy.
3. Mirror it: `node scripts/sync-env.mjs sync vercel-prod` (dry run), then `--apply`, then redeploy
   Vercel. **Don't skip this.** Until it is done, a failover serves owlette.app with plans off.
4. Verify on owlette.app as a non-superadmin trial account: `enforced: true`, `plan: "trial"`, no
   `reason`. Verify the standby too, with that session's cookie (DevTools → Application → Cookies →
   `__session`):

   ```bash
   curl -s -H "Cookie: __session=<value>" https://vercel-origin.owlette.app/api/account/plan
   ```

5. Light smoke checks on prod, with a throwaway unverified password account: `/api/account/plan`
   shows free, and a second site is refused. Delete the account afterwards. The pairing smoke was
   proved on dev.
6. Run `plan-daily` by hand (optional, as on dev).
7. Watch for 24 h: the number of online machines, `[plan]` and `[tridant] request failed` in the
   Railway logs, deny audit rows with `denyReason: "plan_locked"`, the support inbox, and the first
   03:00 summary.

### the customer notice

Draft it beside this runbook, in the form of [security-boundary-customer-email.md](security-boundary-customer-email.md),
and send it with the prod bulk trial start. It must say:
- the 14-day pro trial starts today, no card;
- after the trial, the account falls to owlette free (1 machine, 1 site, monitoring and updates)
  unless the customer picks core or pro, billed per active machine per month;
- "active" means online at any point in the billing period;
- on free, agents keep running, supervising crash-restarts and updating;
- nothing is unpaired, and one machine stays live;
- remote control, deployments, swoop, hoot, alerts and the pro features stop;
- integrations using an API key get `402 plan_required`;
- a link to the plans docs page.

---

## rollback

Set `PLAN_ENFORCEMENT=off` (or delete it). Once the redeploy is live, every gate returns before
any read: fully open, no tridant calls.

1. railway-prod (or railway-dev) first, because it is serving.
2. On prod, mirror to Vercel: `sync vercel-prod` (dry run), then `--apply`, then redeploy Vercel. A
   standby left on `on` re-enforces plans the moment Railway fails over.
3. Run `plan-daily` by hand. This rewrites every snapshot as `enforced: false`. Until it runs, the
   rollout scheduler keeps reading the last enforced snapshots, and keeps writing off a free payer's
   scheduled rollouts.
4. Verify `/api/account/plan` answers `enforced: false, reason: "enforcement_off"`.

Roll back without waiting to diagnose if agents go offline or ask to pair again. That should be
impossible, so investigate it as a bug. Also roll back if trial or paying accounts are refused
`plan_required`, or if tridant answers `resolved: false` for accounts it should know.

**What persists after rollback:**
- `billing_usage/{payerUid}/days/*`: kept. The cron keeps stamping whatever the switch says, and
  prunes past 100 days.
- `plan_snapshot/{payerUid}`: overwritten by the next run (step 3).
- `pairedAt` on machine docs: kept, and harmless.
- Rollouts already written off as `aborted` stay aborted, because `aborted` is terminal. Deploy the
  version again.
- Device codes refused at authorize stay refused until they expire (10 minutes). The agent pairs
  again with a new phrase.
- Deny audit rows (`plan_locked`) stay in `sites/{siteId}/audit_log`.
- **tridant id state is untouched.** Trials keep counting down while enforcement is off, so a long
  rollback means accounts come back on free when it is turned on again. Extend trials in tridant id
  before re-enabling if that matters.

---

## operating notes

### the daily job

`GET /api/cron/plan-daily` (`web/lib/planUsage.server.ts`) runs at 03:00 UTC. For every site with
an owner, it unions the machines whose `lastHeartbeat` falls in the last 26 h into
`billing_usage/{payerUid}/days/{YYYY-MM-DD}`. That is the **previous** UTC day, so today's machines
appear tomorrow. It then writes `plan_snapshot/{payerUid}` = `{enforced, control, roost, resolvedAt}`
for every payer, and prunes day docs older than 100 days. Nothing is reported to tridant id until
6.2.

Both collections are server-only: the `firestore.rules` catch-all denies them, and
`web/__tests__/rules/planCollections.test.ts` holds that.

Keep the 03:00 slot. The 26 h window overlaps the previous run by two hours, so a run up to two
hours late misses nothing. The job is rerun-safe: the day stamp is an array union and the snapshot
an overwrite.

`/api/account/plan`'s `activeMachinesThisMonth` is the union of the day docs from the 1st of the
current UTC month to today. It stays a calendar month until tridant sends the subscription period
(#76). A machine active only on a boundary day counts in both periods; that is accepted and
documented.

### reading the daily summary

```json
{"ok":true,"day":"2026-10-07","sites":42,"payers":30,"machines":57,"snapshots":30,"pruned":0,"errors":0}
```

| field | healthy |
|---|---|
| `day` | yesterday (UTC) on the 03:00 run |
| `snapshots` | equals `payers`. Less means a snapshot write failed; `errors` counts it |
| `errors` | 0. Otherwise search the logs for `[plan-daily] … failed` |
| `machines` | non-zero on any fleet with a machine online in the last day. Summed per payer |
| `pruned` | 0 for the first 100 days, then roughly one per stamped payer per day |

A `401` means the header or secret is wrong for that environment. A `500` means the handler threw;
check the host logs for `cron/plan-daily`.

`errors: 0` is not proof that tridant answered. A tridant outage during the run fails open, so
every snapshot that day is written `enforced: false` and nothing counts as an error. Check for
`[tridant] request failed` around 03:00.

Runtime grows with payers: one tridant lookup per payer, ten at a time, each up to 5 s. Watch the
duration in the cron-job.org history as the payer count grows.

### manual runs

`curl -si -H "X-Cron-Secret: $CRON_SECRET" https://<host>/api/cron/plan-daily` is safe at any
time. One quirk: it always labels its 26 h window as yesterday. So a midday run credits machines
first seen today to yesterday, and on the 1st of a month that adds them to last month. Once 6.2
reports usage from this job, re-check that a manual run is still safe before using one.

### snapshot staleness and the rollout scheduler

Functions can't call tridant id, so `rolloutScheduler` (every 5 min) reads the site owner's
`plan_snapshot` instead (`functions/src/lib/planSnapshot.ts`):

- Snapshot missing, unreadable, `enforced: false`, or the site has no owner: allow.
- A due scheduled rollout is written off when both of these hold:
  - the snapshot is enforced and lacks `roost` or `control`;
  - the snapshot's `resolvedAt` is **newer** than the rollout's `startedAt`.

  The write-off sets `stage: "aborted"`, with `abortReason` "the site owner's plan doesn't include
  roost" or "… remote control".
- A rollout scheduled after the snapshot passed the web's live entitlement check at deploy time,
  which is fresher, so it fires. A rollout with no `startedAt` counts as older. A snapshot with no
  readable `resolvedAt` never counts as newer.
- So a lapse reaches scheduled rollouts at the next 03:00 run, up to a day late. Once a rollout has
  fired, its canary → fleet fan-out (`distributionFanout`) is not gated.
- The opposite case: a payer who upgrades mid-day still has a "no" snapshot until 03:00. Their
  rollouts scheduled before the upgrade are written off. After fixing a customer's plan by hand, run
  `plan-daily` manually, or tell them to deploy again.
- The sweep logs `planBlocked=N` in `[rolloutScheduler] sweep complete`. A read failure logs
  `[planSnapshot] … proceeding (fail-open)`.

### entitlement changes

A change in tridant id (an upgrade, a support override, a lapse) reaches the web within 60 s per
process (the entitlement cache), and functions at the next `plan-daily` run. The machine limit
counts every machine doc across the payer's sites, online or not. Billing counts only active
machines. A customer at the limit frees a slot by removing a machine.

### known limitations

Accepted in review (`tasks.md` log, plan.md risks):

- A missing entitlement key is unrestricted (`keys_missing`) until 6.4.
- Concurrent pairings or site creates can overshoot a limit by one (`createSite` isn't transactional).
- A superadmin acting on a free payer's site is gated by that payer's plan. The superadmin exemption
  applies only when the superadmin is the payer.
- CLI device authorize on free shows "expired" in the CLI. The browser shows the real reason.
- `webhooks/test` stays open on free.
- The lapse overlay (one live machine per payer) is cosmetic. Clients read Firestore directly and
  the rules are unchanged; every action is gated on the server.
- `lastHeartbeat` is written by the agent, so active-machine metering can be forged. Hardening
  would stamp it at `agent/auth/refresh`.
- A machine active only on a period's boundary day counts in both periods.
- The scheduled-rollout gate lags a lapse by up to a day, and fan-out after firing is ungated.
- No usage reaches tridant until 6.2, and there is no checkout until 6.3 (the plan page's upgrade
  buttons are disabled).
