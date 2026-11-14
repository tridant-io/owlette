# plans and billing runbook

Operator reference for owlette's plans. A plan belongs to a site (ADR 0018): each site is on
owlette free, core or pro, or in its owner's 14-day pro trial. The owner pays, per active machine
per calendar month, and owlette free is counted per account (one free site, one machine across an
account's free sites; every further site is created on core or pro). This runbook covers turning
enforcement on, dev first and then prod, checking
it is really on, rolling it back, and running it day to day.

Design source of truth: [ADR 0018](../adr/0018-a-site-has-a-plan-and-its-owner-pays.md) and the
"Plans and billing" terms in `GLOSSARY.md`. Plans, the trial and billing all live in tridant id.
Owlette holds no Stripe key and no billing state of its own beyond a pointer on the site document
and the four server-only collections described under [what owlette stores](#what-owlette-stores).

---

## current state

Every gate is shipped. As of 2026-11-12, plans are enforced on dev (since 19:13 UTC that day) and
ship off on prod, where every gate is dormant. A gate enforces for a site only when **all** of
these hold on the origin that answers the request:

1. `PLAN_ENFORCEMENT` is exactly `on`. `On`, `true` and `1` all count as off.
2. `TRIDANT_API_URL` and `TRIDANT_LICENSE_KEY` are both set (non-blank).
3. tridant id answers the site's entitlement lookup
   (`GET /v1/sites/owlette:{siteId}/entitlements?app=owlette`).
4. The site has an `owner`, and the owner is not a superadmin.

With (1) or (2) missing, every gate returns before it reads anything, so behaviour is identical to
before plans existed (`planOffReason` in `web/lib/plan.server.ts`), and nothing can be bought:
an upgrade answers `503 billing_unavailable`.

**What fails open, and why.** These answer "unrestricted" for the site, and are logged:

| reason | cause | why it fails open |
|---|---|---|
| `enforcement_off` | `PLAN_ENFORCEMENT` isn't `on` | the off switch |
| `not_configured` | URL or key blank | logged once per process: `[plan] PLAN_ENFORCEMENT is on but tridant id is not configured` |
| `unreachable` | network error, 5 s timeout, 429 or 5xx | a tridant id outage must not lock every customer out |
| `rejected` | tridant id answered 4xx: wrong key, missing scope, expired key, or wrong environment | a misconfiguration on our side, so the same reason applies. Logged once as an error: `[plan] tridant id refused the entitlement lookup` |
| `malformed_response` | a 2xx that isn't the expected shape | contract drift |
| `superadmin` | the site owner's `users/{uid}.role` is `superadmin` | staff sites are never limited |
| `no_payer` | the site has no `owner` | nobody to bill |

Each failed lookup is also logged as `[tridant] request failed` with `reason` and `status`.
Answers, failures included, are cached for 60 s per site per process.

**Not failing open, by design.** Under enforcement, a site tridant id does not know (`resolved:
false`) is **owlette free**, not unrestricted, and so is a site whose trial or billing has lapsed.
A site becomes known when its owner's trial starts and their sites are registered, or when it is
upgraded. This is why existing accounts get their trial started just before the flip, with
enforcement still off (see [the bulk trial start](#the-bulk-trial-start)).

**A key missing from a site's answer is unrestricted.** It logs `[plan] tridant sent no value for
<key>; treating it as unrestricted` once per key, and `/api/account/plan` lists the keys in
`missingKeys`. The pro floor on usage is the exception: it applies only when the answer says
`owlette.deployments` is on, so a missing key never raises a bill.

**What already runs while dormant:**
- the `plan-daily` cron, if registered, stamps active machines and writes every `plan_snapshot` as
  `enforced: false`. It asks tridant id nothing and reports nothing;
- pairing stamps `pairedAt` on new machines;
- password sign-ups get the email-verification link;
- transferring a site that carries a billing pointer, and deleting one that carries a pointer or
  that tridant id says it bills (an account delete included), still stops its billing with tridant
  id, whatever the switch says. Someone is being billed for it;
- once tridant id is configured, [the bulk trial start](#the-bulk-trial-start) runs, and a new site
  is registered with tridant id when its owner already has a tridant organization, so it is under
  the owner's trial when the switch flips.

None of these withholds anything.

### the variables

All six are `must-match` in `scripts/env-manifest.json`: railway-prod and vercel-prod must hold the
same values, or a failover to Vercel silently drops (or adds) enforcement, or breaks linking.

| var | railway-dev | railway-prod + vercel-prod |
|---|---|---|
| `PLAN_ENFORCEMENT` | `on` / `off` | `on` / `off` |
| `TRIDANT_API_URL` | `https://api-staging.tridant.io` | `https://api.tridant.io` |
| `TRIDANT_LICENSE_KEY` | the owlette key from admin-staging.tridant.io | the owlette key from tridant id production |
| `TRIDANT_OIDC_ISSUER` | `https://id-staging.tridant.io` | `https://id.tridant.io` |
| `TRIDANT_OIDC_CLIENT_ID` | the staging client, `oic_cwGUoks7wJjctlSp` | the production client |
| `TRIDANT_OIDC_CLIENT_SECRET` | that client's secret | that client's secret |

Owlette dev talks only to tridant id staging, and prod only to tridant id production. A staging key
against production answers `rejected`, which fails open.

### the tridant id key

One key per environment, under the env name `TRIDANT_LICENSE_KEY`. It does every plan and billing
call owlette makes, so it needs all of this:

- **Bound to the app `owlette`.** tridant id binds every key to one app.
- **Three scopes:** `license.read` (the per-site entitlement lookup), `site.write` (registering a
  site under its owner's tridant organization, `POST /v1/sites`) and `billing.write` for owlette
  Core (`billing.write:prd_owlette_core`: the trial, checkout, linking, adding, switching and
  stopping a site, and the usage report). The scope is bound to the product's group, so it covers
  pro as well.
- **It expires.** tridant id mints keys with a 400-day life by default. In a key's last 30 days
  every answer carries a `Sunset` header, and owlette logs it once per process at error:
  `[tridant] tridant id says this api key expires on YYYY-MM-DD; rotate TRIDANT_LICENSE_KEY before
  then`. Alert on that line. An expired key is refused, which reads as `rejected` and **turns every
  gate off quietly**; billing calls fail with `billing_upstream`.

To rotate: rotate the key in the tridant id admin, set the new value on Railway (UI, never a
command line), mirror it to Vercel on prod (`node scripts/sync-env.mjs sync vercel-prod`, dry run
then `--apply`, then redeploy Vercel), and confirm `/api/account/plan` still answers `enforced:
true` with no `reason`.

### the OIDC client

Linking an existing tridant account ("link it" on the plan page) signs the owner in to tridant id
through owlette's OIDC client there. It needs all three `TRIDANT_OIDC_*` variables. With any of
them blank, `/api/account/plan` answers `linkAvailable: false`, the plan page offers "contact
support" in place of "link it", and `GET /api/auth/tridant/link` answers `503
tridant_link_not_configured`.

- The client must be bound to the app `owlette` in tridant id, or its ID tokens are refused as
  link consent.
- The client must allow the `orgs` scope. Owlette asks for `openid email orgs` to learn which
  organizations the owner owns, and tridant id's default for a client is `openid email profile`,
  so without it tridant id refuses the sign-in as `invalid_scope`.
- Its redirect URI is `https://<origin>/api/auth/tridant/callback` (`dev.owlette.app`,
  `owlette.app`). Register every origin that serves the app.
- The secret comes from the tridant id admin, who sees it once when the client is registered or its
  secret rotated.
- `TRIDANT_OIDC_ISSUER` is also where the plan page's "your tridant account" link points
  (`{issuer}/billing`, `portalUrl` in `/api/account/plan`).

Without the link flow, an owner whose email already has a tridant organization gets
`link_required` and can neither trial nor buy.

---

## prerequisites (dev)

Do these in order. Do not flip `PLAN_ENFORCEMENT` until every box is ticked.

- [ ] **tridant id staging answers site entitlements.** Verify with a site it has never seen, using
  the key from the next step held in `$TRIDANT_LICENSE_KEY` (never echo it):

  ```bash
  curl -s -H "Authorization: Bearer $TRIDANT_LICENSE_KEY" \
    "https://api-staging.tridant.io/v1/sites/owlette:runbook-probe/entitlements?app=owlette"
  ```

  Expect `200`, `resolved: false`, `note: "no_mapping_for_site"`, `standing: "expired"`,
  `in_good_standing: false`, and an `ent` holding all ten keys
  (`owlette.machines`, `owlette.sites`, `owlette.control`, `owlette.deployments`, `owlette.swoop`,
  `owlette.hoot`, `owlette.roost`, `owlette.talons`, `owlette.webhooks`, `owlette.api_keys`):
  machines and sites `1`, the eight flags `false`. Any key absent here, `owlette.sites` aside, shows
  up later in `missingKeys`. owlette does not read `owlette.sites`: the one free site per account is
  its own rule, since tridant id reads one site at a time.
- [ ] **Key and URL set on railway-dev.** Create the key in admin-staging.tridant.io as described
  under [the tridant id key](#the-tridant-id-key). In the Railway UI (service `owlette-dev`,
  environment `dev`), set it as `TRIDANT_LICENSE_KEY`, and set
  `TRIDANT_API_URL=https://api-staging.tridant.io`. Leave `PLAN_ENFORCEMENT` off. Verify:
  - the probe above returns `200` with this exact key (`401 invalid_api_key`, `403
    missing_scope:license.read` and `403 app_mismatch` name what is wrong with it);
  - `node scripts/sync-env.mjs` shows both keys present on railway-dev.
- [ ] **OIDC client set on railway-dev.** The three `TRIDANT_OIDC_*` variables, as under
  [the OIDC client](#the-oidc-client).
- [ ] **Functions deployed to dev from this code.** Functions don't ship on push. Run
  `firebase deploy --only functions --project dev` (the full invocation is in
  [production-deploy.md](production-deploy.md)) from a checkout whose
  `functions/src/lib/planSnapshot.ts` reads `plan_snapshot/{siteId}`. Without it, scheduled
  rollouts ignore plans.
- [ ] **`plan-daily` registered on cron-job.org for dev.** The entry is `cron-plan-daily` in
  `infra/cron-jobs.json`:

  | setting | value |
  |---|---|
  | method | `GET` |
  | url | `https://dev.owlette.app/api/cron/plan-daily` |
  | schedule | `30 23 * * *`, timezone UTC (keep 23:30 UTC, see [the daily job](#the-daily-job)) |
  | header | `X-Cron-Secret: <dev CRON_SECRET>` |
  | timeout | at least 60 s |

  Verify by hand: `curl -si -H "X-Cron-Secret: $CRON_SECRET" https://dev.owlette.app/api/cron/plan-daily`
  returns `200` with a summary where `errors` is 0 and `snapshots` equals `sites` (see
  [reading the daily summary](#reading-the-daily-summary)). Register it before the flip so the
  month's day stamps are already accumulating.
- [ ] **Test accounts ready.** A non-superadmin account with a verified email that **owns a site**,
  and a fresh password account left **unverified** that owns a site. A superadmin's sites always
  read `reason: "superadmin"` and prove nothing, and an account that owns no site proves nothing
  either (see step 4 below). A person has to register them: sign-up on dev runs a Turnstile check
  that refuses an automated browser, and a new account sets up a second factor before it reaches
  the dashboard.

---

## enable on dev

1. **Keys and env.** Every box under [prerequisites (dev)](#prerequisites-dev) is ticked:
   `TRIDANT_API_URL`, `TRIDANT_LICENSE_KEY` and the three `TRIDANT_OIDC_*` are live on railway-dev,
   and `PLAN_ENFORCEMENT` is still off.
2. **Start the trials, with enforcement still off.** Run [the bulk trial start](#the-bulk-trial-start)
   as a dry run, review the counts, then apply it. It needs only tridant id configured, so every
   existing account is on its trial before any gate goes on and none of its sites reads owlette
   free at the switch. Each trial's 14 days start counting at this run, so do it close to the
   switch, in the same sitting as step 3. An account created or verified after the run starts its
   own trial on its first plan read once step 3 is live.
3. Set `PLAN_ENFORCEMENT=on` on railway-dev (UI, or
   `railway variables --set "PLAN_ENFORCEMENT=on" -s owlette-dev -e dev`). Wait for the redeploy to
   go live.
4. **Verify it is on.** Signed in to dev.owlette.app as the verified test account, run this in the
   browser console. The route takes a session or the user's own ID token, never an API key.

   ```js
   await (await fetch('/api/account/plan')).json()
   ```

   Use an account that owns a site. An account that owns none always answers `enforced: true` with
   an empty `sites`, whatever tridant id says, because there is no site to read a plan for.

   Expect `enforced: true`, **no `reason`**, `trial.status: "active"` with an `endsAt` 14 days after
   the bulk run, and each entry in `sites` with `tier: "trial"`, `standing: "trialing"`,
   `inGoodStanding: true`.
   The unverified test account should show `trial.status: "unverified"`, `emailVerified: false`,
   its site with `tier: "free"`, `free: { sitesUsed: 1, sitesLimit: 1, machinesLimit: 1, … }` and
   `siteCreation: { state: "choose_plan", unpaidSite: { siteId, name } }` naming that site. Every
   account in its trial answers `siteCreation: { state: "open" }`.

   | you see | meaning | fix |
   |---|---|---|
   | `enforced: false`, `reason: "enforcement_off"` | the redeploy isn't live, or the value isn't exactly `on` | check the variable, wait for the deploy |
   | `reason: "not_configured"` | URL or key blank on this service | set both |
   | `reason: "rejected"` | tridant id refused the key for every site | wrong key, missing `license.read`, not bound to owlette, expired, or a prod key against staging |
   | `reason: "unreachable"` / `"malformed_response"` | tridant id is down, or its answer changed shape | check `[tridant] request failed` in the Railway logs |
   | `reason: "superadmin"` | you are testing as a superadmin | use the test accounts |
   | `enforced: true` with `missingKeys` | tridant id sent no readable value for those keys, which stay unrestricted | fix on the tridant id side; not a pass |
   | `trial.status: "none"` | the trial start failed; `plan_accounts/{uid}.trialError` holds the code | usually the key lacks `billing.write`. Fix it; the next read retries after 60 s |
   | `trial.status: "link_required"` | the email already has a tridant organization | expected for such an account: link it from the plan page |
   | a site with `tier: null` and a `reason` | that one site's plan could not be read | as the `reason` rows above, for that site |

   `GET /api/sites/{siteId}/plan` answers one site's plan to any of its members, with the same
   `enforced` and `reason`, the eight feature flags, `isOwner`, and `billedByPreviousOwner`.
   Failures are cached for 60 s per site, so wait a minute after a config fix.
5. **Smoke checks**, as the unverified test account (its site is on owlette free):
   - create a second site: the dialog names the free site and asks for core or pro. A plain
     `POST /api/sites` answers `402` with "owlette free covers one site, and {name} is on it. add
     this site on core or pro." and `siteCreation.state: "choose_plan"`; with `onPlan: true` it
     answers `201`. The same create with an API key answers `402` even with `onPlan: true`, since
     the key could never upgrade the site.
   - leave that second site's checkout unpaid: the site stays, on owlette free. A third create, on a
     plan or not, answers `402` with "{name} isn't billed. upgrade it to core or pro, or delete it,
     before adding another site.", `siteCreation.state: "blocked"` and `upgradeUrl` at that site's
     billing section; the dialog shows the same with **go to its billing**. A machine's phrase on
     that site is refused while the free site holds its machine.
   - pair one machine: allowed. Pairing a second machine's phrase on `/add` toasts "owlette free
     covers one machine. upgrade to add more, or remove a machine first." The second agent logs
     `Device code poll failed: owlette free covers one machine…` and stays unpaired. A
     dashboard-generated `/ADD=` code for that machine gets the same refusal at poll.
   - re-pair the first machine (reinstall, or run pairing again): allowed. A machine already on
     the site, or on another of the account's free sites, keeps its place; one moved onto a free
     site from a billed or trialing site counts as new.
   - from the dashboard, restart a process or reboot the machine: refused; the dashboard reads
     "this site's plan doesn't include remote control", and the API answers `402 plan_required`.
   - update owlette on an out-of-date machine with the update owlette button: accepted, and the
     agent updates. Editing the process configuration (crash-restart) is also allowed.
   - swoop won't start, and hoot answers `402`.
   - site settings shows a **billing** section to the owner only. A site admin sees none, and a
     member who meets a gate reads "ask the site owner to upgrade this site".
6. **Billing checks**, as the verified test account, with Stripe test card `4242 4242 4242 4242`.
   A real checkout completes only on a deployed host: tridant id refuses a localhost return URL.
   - site settings → billing → upgrade → pro: Stripe Checkout opens, and after paying the section
     reads "payment confirmed. this site is on pro." `sites/{siteId}.billing` now holds the
     pointer.
   - upgrade a second site to core: no checkout, and the dialog said so. It goes on the card on
     file.
   - with both sites billed, **create new site** is a plain create: `siteCreation.state` is
     `"open"`, since no site is unpaid (the trial would open it anyway), and the trial covers the
     new site. Creating a site on core or pro once the account has paid goes on the card on file
     with no checkout; that needs an account past its trial with its free site taken, which e2e
     (`plans/billing.spec.ts`) covers.
   - switch plan, then stop billing: the section reads "ends" with the period's last day, and
     offers resume billing.
7. **Agents keep heartbeating.** No plan gate touches `/api/agent/auth/refresh`, but this is the
   failure that costs the most, so prove it: note the number of online machines on dev before the
   flip, and confirm it is unchanged an hour later. That is past one access-token refresh. No
   machine should go offline or ask to pair again.
8. Run `plan-daily` by hand once, so `plan_snapshot` carries enforcement now rather than at 23:30,
   and check `recorded` equals `reported` for the billed test sites.
9. Leave dev on through at least one scheduled 23:30 run, then read that run's summary in the
   cron-job.org history.

---

## the bulk trial start

New accounts start their own trial: the first time an account with a verified email reads
`/api/account/plan`, which the dashboard does when it loads, owlette starts 14 days of pro with
tridant id (`POST /v1/billing/trial`) and registers the account's sites there, so they read as
trialing. An unverified account is on owlette free until it verifies. Accounts that exist before
plans are switched on are started in bulk just before the switch, so none of their sites reads
free when it flips.

`GET /api/cron/plan-trials` (`web/app/api/cron/plan-trials/route.ts`) does that. It is listed in
`infra/cron-jobs.json` as `cron-plan-trials` with no schedule: it is run by hand, never registered
on cron-job.org.

- Auth: `X-Cron-Secret: <that environment's CRON_SECRET>`, as for `plan-daily`.
- It runs **before** `PLAN_ENFORCEMENT=on`, with enforcement still off: it needs only
  `TRIDANT_API_URL` and `TRIDANT_LICENSE_KEY`, and answers `503` while either is blank. Each
  trial's 14 days start counting when this run starts it, so run it close to the switch.
- **A dry run by default.** It reads one page of 100 Firebase Auth users and counts the eligible
  ones: enabled, email verified, and not an agent's account (`agent_…`). `?apply=1` starts the
  trial for each.
- **One page per call.** Pass the answer's `nextPageToken` back as `?pageToken=` until it is
  `null`. Allow 5 minutes per call.

```bash
curl -s -H "X-Cron-Secret: $CRON_SECRET" "https://dev.owlette.app/api/cron/plan-trials"
curl -s -H "X-Cron-Secret: $CRON_SECRET" "https://dev.owlette.app/api/cron/plan-trials?apply=1"
curl -s -H "X-Cron-Secret: $CRON_SECRET" \
  "https://dev.owlette.app/api/cron/plan-trials?apply=1&pageToken=<nextPageToken>"
```

```json
{"ok":true,"apply":true,"scanned":100,"eligible":72,"started":66,"alreadyStarted":3,"linkRequired":2,"subscribed":0,"busy":0,"failed":1,"nextPageToken":"…"}
```

| field | meaning |
|---|---|
| `scanned`, `eligible` | users on the page, and how many of them qualify. A dry run stops here: every other count is 0 |
| `started` | trials started now |
| `alreadyStarted` | the account had its trial before. A rerun is safe: nothing starts twice |
| `linkRequired` | the email already has a tridant organization. The owner links it from the plan page, and the trial starts then |
| `subscribed` | the account already pays in tridant id, so it gets no trial |
| `busy` | another request was starting the same trial. Run the page again |
| `failed` | the start failed; `plan_accounts/{uid}.trialError` holds the code and the logs `[plan] trial start failed`. Run the page again; once plans are on, the account also retries on its next plan read |

Before applying, decide what happens to existing **unverified** password accounts: the run skips
them, so their sites are on owlette free from the flip until they verify.

Verify with two or three existing owners before the switch: the entitlement probe under
[prerequisites (dev)](#prerequisites-dev), for `owlette:{siteId}` of one of their sites, shows
`resolved: true`, `standing: "trialing"`. `/api/account/plan` answers `enforced: false` until the
switch, and `trial.status: "active"` after it.

---

## enable on prod

### prerequisites (prod)

- [ ] Dev has been on and clean: smoke and billing checks passed, one 23:30 run read with
  `recorded` equal to `reported`, no `[plan]`, `[billing]` or `[plan-daily]` errors in the logs.
- [ ] tridant id **production** has site billing, the owlette products and their prices. Verify
  with the probe against `https://api.tridant.io`, using the prod key. As of 2026-11-12 it does not
  (tridant-id #124, #125): its billing routes answer `404`, and `id.tridant.io` serves no OIDC
  discovery document. These need no key: each route answers `401` once it exists and `404` before,
  and the public catalogue shows `site_billed: true` on `prd_owlette_core` and `prd_owlette_pro`
  once it is ready.

  ```bash
  for p in billing/trial billing/sites usage billing/link; do
    curl -s -o /dev/null -w "%{http_code} POST /v1/$p\n" -X POST "https://api.tridant.io/v1/$p"
  done
  curl -s -o /dev/null -w "%{http_code} GET /v1/billing/checkout/probe\n" "https://api.tridant.io/v1/billing/checkout/probe"
  curl -s -o /dev/null -w "%{http_code} oidc discovery\n" "https://id.tridant.io/.well-known/openid-configuration"
  curl -s "https://api.tridant.io/v1/products"
  ```

  Until then railway-prod and vercel-prod hold no `TRIDANT_LICENSE_KEY` and no `TRIDANT_OIDC_*`,
  and `node scripts/sync-env.mjs check` listing them as missing there is expected.
- [ ] The pricing copy no longer says "free during beta". That covers `STATUS`, `PRICE_LINE`,
  `AFTER_BETA` and `PRICING` in `web/lib/product-facts.ts`, and the "applies after beta" framing in
  the plans docs. The change is on `main` and deployed.
- [ ] `TRIDANT_API_URL`, `TRIDANT_LICENSE_KEY` and the three `TRIDANT_OIDC_*` are set on
  railway-prod (service `owlette-prod`, environment `dev`: both Railway services live in the one
  `dev` environment). `PLAN_ENFORCEMENT` is still off.
- [ ] Vercel is mirrored. Run `node scripts/sync-env.mjs sync vercel-prod` as a dry run: the
  tridant vars should be listed under "would set", and none should appear under "absent at
  source". Then run it with `--apply`. Vercel applies env changes only to **new** deployments, so
  redeploy the current production deployment (Vercel dashboard → owlette → Deployments →
  Redeploy). Confirm with `node scripts/sync-env.mjs check` and
  `curl -s https://vercel-origin.owlette.app/api/health`.
- [ ] Functions are deployed to prod (`--project prod`, explicitly: `.firebaserc` defaults to dev).
- [ ] `plan-daily` is registered for prod at `https://owlette.app/api/cron/plan-daily`, `30 23 * * *`
  UTC, with the prod `CRON_SECRET`, and a manual run returns `200` with `errors: 0`. Register it
  only once prod serves the route: before the web release that carries it, it answers `404`.
- [ ] The customer notice (below) has been signed off by the owner.

### the flip

1. **Bulk trial start on prod, with enforcement still off:** the dry run against
   `https://owlette.app`, check the counts, then `?apply=1` through every page. This starts every
   verified account's 14 days, so do it close to the switch and send the customer notice the same
   day.
2. Set `PLAN_ENFORCEMENT=on` on railway-prod and wait for the redeploy.
3. Mirror it: `node scripts/sync-env.mjs sync vercel-prod` (dry run), then `--apply`, then redeploy
   Vercel. **Don't skip this.** Until it is done, a failover serves owlette.app with plans off.
4. Verify on owlette.app as a non-superadmin account that owns a site: `enforced: true`, no
   `reason`, `trial.status: "active"`, the site `tier: "trial"`. Verify the standby too, with that
   session's cookie (DevTools → Application → Cookies → `__session`):

   ```bash
   curl -s -H "Cookie: __session=<value>" https://vercel-origin.owlette.app/api/account/plan
   ```

5. Light smoke checks on prod, with a throwaway unverified password account that creates one site:
   `/api/account/plan` shows the site on free and `siteCreation.state: "choose_plan"`, and a plain
   second create is refused. Delete the account
   afterwards. The pairing and billing checks were proved on dev.
6. Run `plan-daily` by hand.
7. Watch for 24 h: the number of online machines, `[plan]`, `[billing]` and `[tridant] request
   failed` in the Railway logs, deny audit rows with `denyReason: "plan_locked"`, the support
   inbox, and the first 23:30 summary.

### the customer notice

Draft it beside this runbook, in the form of [security-boundary-customer-email.md](security-boundary-customer-email.md),
and send it with the prod bulk trial start. It must say:
- the 14-day pro trial starts today, no card, for accounts with a verified email, and covers every
  site the account owns;
- a plan belongs to a site. After the trial, each site is on owlette free unless its owner upgrades
  it to core or pro in site settings → billing;
- owlette free is per account: one free site with one machine, monitoring and updates. Every
  further site is created on core or pro, and an account can own any number of each;
- core and pro are billed per site, per active machine per calendar month from the 1st (UTC), the
  first month an owner is billed by the day and a site added later for the whole month it is added
  in; "active" means online at any point in the billing period; pro bills
  at least three machines per site;
- on free, agents keep running, supervising crash-restarts and updating; nothing is unpaired, and
  one machine stays live;
- remote control, deployments, swoop, hoot, alerts and the pro features stop on a free site;
- integrations using an API key get `402 plan_required` on a site that is not on pro;
- an account whose email already has a tridant account links it by signing in to tridant;
- a link to the plans docs page.

---

## rollback

Set `PLAN_ENFORCEMENT=off` (or delete it). Once the redeploy is live, every gate returns before
any read: fully open, no entitlement lookups.

1. railway-prod (or railway-dev) first, because it is serving.
2. On prod, mirror to Vercel: `sync vercel-prod` (dry run), then `--apply`, then redeploy Vercel. A
   standby left on `on` re-enforces plans the moment Railway fails over.
3. Run `plan-daily` by hand. This rewrites every snapshot as `enforced: false`. Until it runs, the
   rollout scheduler keeps reading the last enforced snapshots, and keeps writing off a free
   site's scheduled rollouts.
4. Verify `/api/account/plan` answers `enforced: false, reason: "enforcement_off"`.

Roll back without waiting to diagnose if agents go offline or ask to pair again. That should be
impossible, so investigate it as a bug. Also roll back if trialing or billed sites are refused
`plan_required`, or if tridant id answers `resolved: false` for sites it should know.

**What rollback does not undo.** Nothing a customer paid for is lost, because tridant id holds it:
- **Billed sites stay billed.** Their subscriptions run on in tridant id and Stripe. While the
  switch is off, `plan-daily` reports no usage, so tridant id bills each site on the last report
  it holds. Turn enforcement back on before the month's last 23:30 run. Stopping the affected
  sites in tridant id does not waive the current period: a stop still bills it, on the last
  report held, and ends the billing only after it.
- **Nothing can be bought or switched from the dashboard:** an upgrade or a switch answers `503
  billing_unavailable`. The billing section stays only on a billed site, for its owner, and offers
  only **stop billing**, which still reaches tridant id, as the stop on delete and transfer does.
- **Trials keep counting down** while enforcement is off, so a long rollback means sites come back
  on free when it is turned on again. Extend trials in tridant id before re-enabling if that
  matters.
- `billing_usage/{siteId}/days/*`: kept. The cron keeps stamping whatever the switch says, and
  prunes past 100 days.
- `plan_snapshot/{siteId}`: overwritten by the next run (step 3).
- `plan_accounts`, `billing_checkouts`, `sites/{siteId}.billing` and `pairedAt`: kept, and harmless.
- Rollouts already written off as `aborted` stay aborted, because `aborted` is terminal. Deploy the
  version again.
- Device codes refused at authorize stay refused until they expire (10 minutes). The agent pairs
  again with a new phrase.
- Deny audit rows (`plan_locked`) stay in `sites/{siteId}/audit_log`.

---

## operating notes

### what owlette stores

tridant id is the source of truth for every plan. Owlette keeps:

| path | holds |
|---|---|
| `sites/{siteId}.billing` | the pointer the dashboard shows: `{tier, founders, payerUid, endsAt, updatedAt}`. Written when the owner upgrades, switches or stops, when a checkout is confirmed, and when ownership is transferred. `endsAt` is null while billing runs. It decides nothing: whether a site is billed is tridant id's answer (its `billing` block), and a pointer that still says billed once tridant id bills nothing is closed by a switch, a stop or the daily job |
| `plan_accounts/{uid}` | an account's trial and link state: `trialStartedAt`, `trialEndsAt`, `orgId`, `linkRequired`, `trialError`, `claimedAt` |
| `billing_checkouts/{sessionId}` | what a Stripe Checkout session was started for (`uid`, `siteId`, `tier`, `founders`), so only the account that started it can confirm it |
| `billing_usage/{siteId}/days/{YYYY-MM-DD}` | the site's active machines per UTC day |
| `plan_snapshot/{siteId}` | `{enforced, control, roost, resolvedAt}`, for Cloud Functions |

The four collections are server-only: the `firestore.rules` catch-all denies them, and
`web/__tests__/rules/planCollections.test.ts` holds that.

### the daily job

`GET /api/cron/plan-daily` (`web/lib/planUsage.server.ts`) runs at **23:30 UTC**. For every site
it:

1. unions the machines whose `lastHeartbeat` falls in the last 26 h into
   `billing_usage/{siteId}/days/{YYYY-MM-DD}`, each on the UTC day of its own heartbeat;
2. stops billing that was left running for a previous owner (a transfer whose stop did not land);
3. writes `plan_snapshot/{siteId}`;
4. re-registers a site that tridant id holds under another organization than its owner's (a
   transferred site moves once nothing is billed on it there), writes the billing pointer for
   a billed site that has none (a checkout that was paid and whose return never loaded), and
   closes a pointer that still says billed on a site tridant id no longer bills (Stripe cancelled
   the subscription after failed payments, the organization was closed, or an admin revoked it).

Then, with enforcement on, it reports every billed site to tridant id in one `POST /v1/usage`: the
site's distinct active machines since its billing period started, or since the owner's trial
ended when that is later (nothing in the trial is billed), a pro site as at least 3, with
`as_of` set to the run. Last, it prunes day docs older than 100 days. With enforcement off it asks
tridant id nothing and reports nothing.

**The last run of a month is the one that bills.** tridant id bills each site on the report it
holds when the month ends, and a report that arrives after the 1st, 00:00 UTC counts for nothing.
There is no grace. That is why the job runs at 23:30: late enough to count the day, with half an
hour for the report to arrive. If the run on the last day of a month fails, trigger it by hand
before midnight UTC; after that the month is billed on the previous day's count.

The 26 h window overlaps the previous run by two hours, so a run up to two hours late misses
nothing. The job is rerun-safe: the day stamp is an array union, the snapshot an overwrite, and
tridant id keeps the report with the newest `as_of`.

### reading the daily summary

```json
{"ok":true,"day":"2026-11-30","sites":42,"machines":57,"snapshots":42,"reported":6,"recorded":6,"pruned":0,"errors":0}
```

| field | healthy |
|---|---|
| `day` | the UTC day of the run |
| `snapshots` | equals `sites`. Less means a snapshot write failed; `errors` counts it |
| `reported` | the billed sites sent to tridant id. 0 while enforcement is off |
| `recorded` | equals `reported`. A site that was not recorded is logged `[plan-daily] usage not recorded` with its status. `site_not_billed` during a Stripe trial and `period_rolled_over` are expected, and the next run reports again |
| `errors` | 0. Otherwise search the logs for `[plan-daily] … failed` |
| `machines` | non-zero on any fleet with a machine online in the last day |
| `pruned` | 0 for the first 100 days, then roughly one per stamped site per day |

A `401` means the header or secret is wrong for that environment. A `500` means the handler threw;
check the host logs for `cron/plan-daily`.

`errors: 0` is not proof that tridant id answered the entitlement lookups. An outage during the run
fails open per site, so that site's snapshot is written `enforced: false`, it is not reported, and
nothing counts as an error. Check for `[tridant] request failed` around 23:30, and compare
`reported` with the number of billed sites you expect.

Runtime grows with sites: one machines read per site, and with enforcement on one tridant id
lookup per site, ten at a time, each up to 5 s. Watch the duration in the cron-job.org history.

### manual runs

`curl -si -H "X-Cron-Secret: $CRON_SECRET" https://<host>/api/cron/plan-daily` is safe at any
time, and is the fix for a missed run. A machine is stamped on the day of its own heartbeat, so a
run just after midnight does not move the previous evening's machines into the new period.

### billing actions

The owner changes a site's billing in site settings → billing. The routes are
`POST`/`PATCH`/`DELETE /api/sites/{siteId}/billing` and `GET /api/billing/checkout/{sessionId}`
(`web/lib/siteBilling.server.ts`). They take a session only: an API key gets `403
api_key_not_permitted`. `SITE_BILLING_MANAGE` is the owner's alone and is checked even while
`capability_enforcement` is off, and the payer is always the owner: a superadmin who is not the
owner gets `403 not_owner`.

- **Upgrade** (`POST`): the owner's first purchase answers `{checkoutUrl}` for Stripe Checkout.
  Once the owner has a subscription, tridant id answers `subscription_exists` and owlette adds the
  site to it instead (`{added: true}`): card on file, no checkout. A subscription with every site
  stopped keeps running at no charge (decided with tridant 2026-11-12), so that holds after every
  site has ended too. Needs a verified email. Whether the site is already billed is asked of
  tridant id afresh, never read from the pointer.
- **The return from checkout** lands on `/admin/sites/{siteId}?section=billing&session_id=…`. The
  section polls `GET /api/billing/checkout/{sessionId}` until tridant id says `complete`, and the
  pointer is written then. If the tab is closed first, the site is still billed: the daily job
  writes the pointer, and switch and stop work without it.
- **Switch** (`PATCH`) is immediate. The whole period is billed at the plan held when it ends.
- **Stop** (`DELETE`): the site keeps its plan to the end of the billing period, which is billed,
  then goes to owlette free. Upgrading it again before then resumes the same billing.
- **Founders** rates are offered while tridant id's `founders_remaining` is above 0 (cached 5
  minutes), or when a site the owner owns is, or was, billed at the founders rate on that plan:
  tridant id keeps the rate for that organization past the cap (`foundersHeld` in
  `/api/account/plan`, read from the pointers on the sites the owner still owns). If tridant id
  refuses it anyway with `founders_sold_out`, the dialog asks the owner to confirm the list price.
  Nothing is retried silently.
- Every change writes a `billing_mutated` audit row.

Refusals are problem+json with these codes:

| code | status | meaning |
|---|---:|---|
| `billing_unavailable` | 503 | plans are not enforced, or tridant id is unreachable or not configured |
| `billing_upstream` | 502 | tridant id refused the call for a reason owlette does not map. Logged `[billing] tridant id refused a billing call` with tridant id's `code` |
| `not_owner` | 403 | the caller does not own the site |
| `email_unverified` | 403 | upgrading before the owner's email is verified |
| `already_billed` | 409 | upgrading a site tridant id bills and that is not stopped |
| `not_billed` | 404 | switching or stopping a site that is not billed. When the pointer still said billed, it is closed, and the detail says the site is no longer billed |
| `billed_by_previous_owner` | 409 | upgrading or switching a transferred site while the previous owner's billing runs |
| `link_required` | 409 | the owner's email already has a tridant organization. Also marks the account, so the plan page offers the link |
| `site_billed_elsewhere`, `site_is_default` | 409 | the site is billed under, or belongs to, another tridant organization |
| `founders_sold_out` | 409 | the founders places are taken |
| `subscription_paused` | 409 | the owner's subscription is paused in Stripe |

### transfers and deletes

- **Ownership transfer** stops the site's billing at the period end. The previous owner pays for
  that period, and the pointer keeps their `payerUid` with an `endsAt`. Until then the new owner
  can stop but not upgrade or switch (`billed_by_previous_owner`; `/api/sites/{siteId}/plan`
  answers `billedByPreviousOwner: true`). After it, the new owner upgrades on their own
  subscription. If the stop fails at transfer time it is logged `[plan] billing not stopped for a
  transferred site`, and the next `plan-daily` run stops it.
- tridant id keeps a transferred site under the previous owner's organization while it is billed
  there. Registration under the new owner is refused with `site_belongs_to_another_org`
  (`site_running`) until the period ends, and `plan-daily` asks again each night. `[plan] site
  cannot move to its owner organization` at error means it never will on its own
  (`site_is_default`, `subject_not_of_provider`): fix it in tridant id.
- A site on owlette free can be transferred only to an owner whose free site isn't taken, or who
  is in their trial (`402`, `entitlement: owlette.sites`). The free machine limit is not checked on
  transfer.
- **Deleting a site** stops its billing first, when the site carries a pointer or tridant id says
  it bills the site (a paid checkout whose return never loaded leaves no pointer). A failed stop is
  logged `[plan] billing not stopped for a deleted site` and is not retried: stop it in tridant id.
- **Deleting an account** unlinks it from its tridant organization, both from the admin panel
  (`DELETE /api/users/{uid}`, which transfers the account's sites first) and by the account itself
  (`DELETE /api/users/me`, which deletes the sites it owns alone, stopping each one's billing as a
  site delete does). The organization stays, and so does the billing of any site it did not
  delete. A failed unlink is logged `[account delete] tridant unlink failed`.

### linking a tridant account

`GET /api/auth/tridant/link` sends the owner to tridant id (PKCE, `max_age=600`), and
`/api/auth/tridant/callback` comes back to the plan page with the outcome in the query:
`link=done`, `link=choose` (several organizations owned: the page asks which), `link=no_org`, or
`link=failed&code=<code>`. The usual failure codes: `id_token_not_fresh` (the tridant sign-in was
over 10 minutes old), `org_not_owned` / `owner_required`, `subject_linked_elsewhere` (the owlette
account is already linked to another organization: move it in tridant id), `session_mismatch`,
`state_missing` / `state_mismatch` (the attempt expired), `access_denied`. A link writes a
`billing_mutated` audit row with verb `tridant_account_linked`, and the trial start is retried at
once.

### snapshot staleness and the rollout scheduler

Functions can't call tridant id, so `rolloutScheduler` (every 5 min) reads the site's
`plan_snapshot` instead (`functions/src/lib/planSnapshot.ts`):

- Snapshot missing, unreadable, or `enforced: false`: allow.
- A due scheduled rollout is written off when both of these hold:
  - the snapshot is enforced and lacks `roost` or `control`;
  - the snapshot's `resolvedAt` is **newer** than the rollout's `startedAt`.

  The write-off sets `stage: "aborted"`, with `abortReason` "this site's plan doesn't include
  roost" or "… remote control".
- A rollout scheduled after the snapshot passed the web's live entitlement check at deploy time,
  which is fresher, so it fires. A rollout with no `startedAt` counts as older. A snapshot with no
  readable `resolvedAt` never counts as newer.
- So a lapse reaches scheduled rollouts at the next 23:30 run, up to a day late. Once a rollout has
  fired, its canary → fleet fan-out (`distributionFanout`) is not gated.
- The opposite case: a site upgraded mid-day still has a "no" snapshot until 23:30. Its rollouts
  scheduled before the upgrade are written off. After fixing a customer's plan by hand, run
  `plan-daily` manually, or tell them to deploy again.
- The sweep logs `planBlocked=N` in `[rolloutScheduler] sweep complete`. A read failure logs
  `[planSnapshot] … proceeding (fail-open)`.

### entitlement changes

A change in tridant id (a support override, a failed payment, a lapse) reaches the web within 60 s
per process (the per-site entitlement cache), and functions at the next `plan-daily` run. Owlette's
own billing changes clear the site's cache entry on the process that made them.

The free limits count per account. The machine limit is one distinct machine ID across the sites
an owner has on owlette free, online or not. A re-pair, or a move between them, keeps its place;
a machine moved over from a billed site counts as new. The site limit is one unpaid site: not
billed, and no trial covers it. A billed site past due and out of grace reads owlette free and
counts toward the machine, but its billing still runs, so it is never an unpaid site (the upgrade
route answers it `409 already_billed`). With the free site taken, `POST /api/sites` needs
`onPlan: true` from a session (an API key's is ignored, since the billing route refuses keys),
and the dashboard sends the owner straight into that site's upgrade. A checkout left unpaid
leaves one more unpaid site, which the machine limit keeps empty while the free site holds its
machine; while it exists, every create answers `402` with `siteCreation.state: "blocked"`. During
the account's trial creation is unrestricted. A trial that ends can leave an account with several
sites on owlette free; nothing is unpaired or deleted, new pairings to a free site and new sites
are refused, and a customer makes room by removing a machine, or by upgrading or deleting a site.
Billing counts only active machines.

A failed payment sets the site `past_due`. It keeps its plan through tridant id's grace period
(`in_good_standing` stays true), then reads owlette free. The billing section tells the owner to
update the card in their tridant account.

### known limitations

Accepted in review:

- A missing entitlement key is unrestricted (`missingKeys`).
- Fail-open hides misconfiguration: a wrong or expired key makes every site unrestricted. Watch for
  the `rejected` and `Sunset` log lines, and check `/api/account/plan` after every key change.
- Concurrent pairings or site creates can overshoot a free limit by one. A signed-in client that
  sends `onPlan: true` and never pays ends with the one allowed extra site on owlette free.
- A superadmin acting on someone else's site is gated by that site's plan. The superadmin
  exemption applies only to sites the superadmin owns. A superadmin who opens the plan page gets a
  trial start like anyone.
- `webhooks/test` stays open on free.
- The lapse overlay (one live machine across an owner's free sites) is the same for everyone on the
  site: `/api/sites/{siteId}/plan` names the machines it keeps live (`freeMachines`). It is
  cosmetic. The server refuses pairing a machine past the limit and, since owlette free has no
  control, remote control on every machine of the site (updates still go through); a locked
  machine's metrics, processes and configuration are only hidden. Clients read Firestore directly
  and the rules are unchanged.
- `lastHeartbeat` is written by the agent, so active-machine metering can be forged. Hardening
  would stamp it at `agent/auth/refresh`.
- A report after the 1st is lost for that month: a machine first seen after the last 23:30 run of a
  month is not billed for it, and a missed last run under-bills the machines first seen that day.
- The scheduled-rollout gate lags a lapse by up to a day, and fan-out after firing is ungated.
- A core site bought during the trial reads pro until the trial ends.
- After a stop, tridant id's `cancel_at_period_end` stays false. Owlette reads `ends_at`.
- A failed stop on delete is not retried.
- The ID token from the link flow is not verified by owlette. It is only used to choose the
  organization, and tridant id verifies it.
