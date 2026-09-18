# swoop-signal

the swoop signaling worker: a cloudflare worker plus **one durable object per machine** (the "room"), on the
websocket hibernation api. it relays offers, answers and ice candidates between a browser and an agent, and it
rings a machine's doorbell when the api asks it to. it is a dumb pipe — every authorisation decision was made
by the owlette api before the token was minted.

the wire contract is [`agent/swoop/PROTOCOL.md`](../../agent/swoop/PROTOCOL.md): section 1 (version
handshake), section 2 (the ten messages and per-role send rights), section 8 (jwt claims) and section 11
(verification order, rotation, the sid-only contract). the golden vectors in
`agent/swoop/testdata/protocol/` are the executable half and this suite iterates them.

**this repository is public. no secret belongs in any file here.**

## routes

| route | auth | |
|---|---|---|
| `GET /health` | none | fixed body, and it never touches a durable object — the first access to a room name pins that room's home colo for good. carrying `x-swoop-ring-secret` additionally returns the active `kids` and the `algorithm` constant, which is the only way to confirm a rotation landed |
| `GET /v1/room/{site}/{machine}` | swoop jwt | the websocket upgrade. the room is named from the **token's** `site`+`machine`, and a url that disagrees is `403 room_mismatch` |
| `POST /v1/ring` | `x-swoop-ring-secret` | body is exactly `{site, machine, sid}`; any other key is `400 unexpected_field` |
| `POST /v1/kill` | `x-swoop-ring-secret` | body is `{site, machine, sid?}`, and `sid` may be `null` — "kill whatever is running" |

a ring to a machine with no doorbell attached is `409 no_doorbell`, not a silent no-op.

these two routes are **the one place a room name arrives as payload** rather than from a verified token.
they carry no token at all, only the ring secret, so the caller is already authenticated as the api itself;
every token-bearing route derives the room from the claims and must keep doing so.

### the auth signal

**refusal statuses are contract.** `401` means a fresh token may fix it: the doorbell does one free re-mint
and redials at once instead of walking its backoff ladder, so a `kid` rotation does not cost the fleet a full
ladder each. every other status means back off.

the vocabulary is exactly three words — **`auth`, `token_expired`, `unknown_kid`** — and it appears on all
three surfaces, because a client should not have to learn three dialects:

- the `x-swoop-error` header of a refused handshake (a websocket client that fails a handshake usually sees
  the status and headers but not the body),
- the `code` of that refusal's body, `{"type":"error","reason":"auth|room|protocol|server","code":"…"}`,
- the `code` of the error frame sent immediately before an auth close.

every verifier refusal collapses into those three. the detail stays inside the worker: a refusal tells the
caller only whether a fresh token could fix it, which is all a client can act on and all an attacker should
learn.

**close codes.** `4401` (4000 + http 401) is the auth close, always preceded by that error frame. `4008` is a
flood limit, and a client should walk its ladder on it. a token that expires while its socket is open is
checked **lazily, only when that socket sends** — an idle doorbell is never kicked, so the fleet never
re-dials on a timer, but a 60-second viewer token cannot buy an unbounded socket either.

## secrets

set with `wrangler secret put`, never in `wrangler.toml` and never in git:

| name | |
|---|---|
| `SWOOP_JWT_KID` / `SWOOP_JWT_PUBLIC_KEY` | the current verification key, base64url raw 32-byte ed25519 |
| `SWOOP_JWT_KID_PREV` / `SWOOP_JWT_PUBLIC_KEY_PREV` | the previous key **during a rotation overlap only**; unset otherwise |
| `SWOOP_SIGNAL_RING_SECRET` | shared with the api, compared in constant time. `must-match` across railway-prod and vercel-prod |

locally they come from `.dev.vars`, which is gitignored. in an environment they are set with
`wrangler secret put` — see [deploy](#deploy), which never touches them.

### key rotation runbook

**this runbook cannot be executed today.** step 3 has nowhere to put the outgoing key: `PROTOCOL.md` §11
requires every bundle to carry **both** the current and the previous public key with their `kid`s, and
`scripts/env-manifest.json` has no `SWOOP_JWT_PUBLIC_KEY_PREVIOUS` / `SWOOP_JWT_KID_PREVIOUS` rows for
`railway-dev`, `railway-prod` or `vercel-prod` — only the singular `SWOOP_JWT_PUBLIC_KEY` / `SWOOP_JWT_KID`
(`:112-114`). the worker half of the overlap exists (`SWOOP_JWT_KID_PREV` / `SWOOP_JWT_PUBLIC_KEY_PREV`); the
api half does not. until those two rows are registered and set on all three targets, a rotation is a flag day
for every streamer holding a bundle minted under the old key, which is exactly what the two-key design is for.
**PENDING [human]** — register the rows (class `config`, all three targets, same class as the singular pair
they mirror), then delete this paragraph.

order matters: the worker learns the new key **before** the api starts minting with it, or every token 401s.

1. generate a new ed25519 keypair offline.
2. **worker first.** put the outgoing pair into `SWOOP_JWT_KID_PREV` / `SWOOP_JWT_PUBLIC_KEY_PREV`, then the
   new pair into `SWOOP_JWT_KID` / `SWOOP_JWT_PUBLIC_KEY`. both now verify.

   ```
   cd infra/swoop-signal
   npx wrangler secret put SWOOP_JWT_KID_PREV        -e dev   # paste the OUTGOING kid
   npx wrangler secret put SWOOP_JWT_PUBLIC_KEY_PREV -e dev   # paste the OUTGOING public key
   npx wrangler secret put SWOOP_JWT_KID             -e dev   # paste the NEW kid
   npx wrangler secret put SWOOP_JWT_PUBLIC_KEY      -e dev   # paste the NEW public key
   ```

   each one prompts and reads the value from stdin: never pass a key as an argument, and never `echo | `
   it — both put the key in the shell history. confirm the worker holds both, which is the only way to see
   this from outside (`kids` are identifiers, not key material):

   ```
   curl -sS -H "x-swoop-ring-secret: <ring secret>" https://<origin>/health
   # {"ok":true,"service":"swoop-signal","protocolVersion":1,"kids":["<new>","<outgoing>"],"algorithm":"Ed25519"}
   ```

3. **api second.** set `SWOOP_JWT_PRIVATE_KEY`, `SWOOP_JWT_KID` and `SWOOP_JWT_PUBLIC_KEY` — plus the
   `_PREVIOUS` pair above, once it exists — on every target in `scripts/env-manifest.json`
   (`node scripts/sync-env.mjs check` must be clean — `SWOOP_JWT_PRIVATE_KEY` is `must-match`, so a half-done
   rotation breaks the failover origin silently; vercel stores secrets write-only, so re-run
   `node scripts/sync-env.mjs sync vercel-prod --apply` rather than trusting a green `check`).
4. **fleet: nothing.** agents hold no key. a doorbell holding a token signed with the old key is refused `401`
   and re-mints immediately.
5. once every outstanding token has expired (host and doorbell ttl is 300 s), unset `_PREV` on the worker
   (`npx wrangler secret delete SWOOP_JWT_KID_PREV -e dev`, same for the key) and the `_PREVIOUS` pair on the
   api. `/health` should report a single `kid` again.

rotate dev first and leave it a day: dev and prod are separate workers with separate secrets, so a mistake on
dev costs nothing and a mistake on prod ends every live session.

## deploy

two environments, one worker script each, and no third: `wrangler.toml` declares `env.dev` and `env.prod`, and
a bare `wrangler deploy` with no `-e` would publish a *fourth*, unenvironmented script — never run one.

| branch | command | script | serves |
|---|---|---|---|
| `dev` | `wrangler deploy -e dev` | `swoop-signal-dev` | dev.owlette.app's `SWOOP_SIGNAL_URL` |
| `main` | `wrangler deploy -e prod` | `swoop-signal-prod` | owlette.app's `SWOOP_SIGNAL_URL`, both origins |

[`.github/workflows/swoop-signal-deploy.yml`](../../.github/workflows/swoop-signal-deploy.yml) does it: path
filters on `infra/swoop-signal/**` and the workflow itself, the vitest suite first on every pull request and
every push, then the deploy on a push to `dev` or `main`, then `GET /health` against the deployed origin with
a non-200 failing the job. concurrency is `cancel-in-progress: false` — a cancelled deploy leaves whichever
version cloudflare last accepted.

### what the workflow needs, and what it must never hold

| kind | name | |
|---|---|---|
| repo secret | `CLOUDFLARE_API_TOKEN` | scoped: **workers scripts: edit** + **workers durable objects: edit** (account-level), nothing else. not a global api key |
| repo secret | `CLOUDFLARE_ACCOUNT_ID` | a secret here purely so it stays out of a public repo's logs; it is an account identifier, not a credential |
| repo variable | `SWOOP_SIGNAL_DEV_URL` / `SWOOP_SIGNAL_PROD_URL` | the origin `/health` is fetched from: `https://signal-dev.owlette.app` and `https://signal.owlette.app`. a **variable** rather than a literal in the workflow so the hostname is settable without a code change, and so a rename is one dashboard edit rather than a pull request |

the three worker secrets are **not** repository secrets and must never become them: the workflow has no step
that reads or writes a worker secret, and `wrangler deploy` preserves the ones already set. a redeploy
therefore cannot lose them — but a *new* environment starts with none, and a worker missing
`SWOOP_SIGNAL_RING_SECRET` answers every ring `500 ring_secret_unconfigured` while `/health` still returns
200, so the smoke check will not catch it. set them before the first deploy of an environment, not after.

### first-time setup — **PENDING [human]**. copy-paste protocol

none of this can be done from an agent session: it needs the owner's cloudflare account and the repository's
settings. nothing below has been executed, and **the workflow has never run**.

1. **the api token.** cloudflare dashboard → my profile → api tokens → create token → custom token.
   permissions: `account` → `workers scripts` → `edit`, `account` → `workers durable objects` → `edit`,
   **and `zone` → `workers routes` → `edit` on the `owlette.app` zone** — `wrangler.toml` declares a custom
   domain per environment, and without the zone permission the deploy fails at the route, after the script
   has already uploaded. account resources: this account only; zone resources: `owlette.app` only.
2. **the repository secrets.** github → settings → secrets and variables → actions → new repository secret,
   twice: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (dashboard → workers & pages → the account id in
   the right-hand pane).
3. **the worker secrets, dev.** from `infra/swoop-signal`, three prompts, each pasted:

   ```
   npx wrangler secret put SWOOP_JWT_KID            -e dev
   npx wrangler secret put SWOOP_JWT_PUBLIC_KEY     -e dev
   npx wrangler secret put SWOOP_SIGNAL_RING_SECRET -e dev
   ```

   the ring secret must be byte-identical to `SWOOP_SIGNAL_RING_SECRET` on `railway-dev`; for prod it must
   match **both** `railway-prod` and `vercel-prod`, which is why it is `must-match` in the manifest.
4. **the first deploy, by hand.** `npx wrangler deploy -e dev`. do this before the first push so that a
   failure is read at a terminal rather than in a job log.
5. **the url is decided** (owner, 2026-09-18) and is in `wrangler.toml` as a custom domain per environment:
   **`signal-dev.owlette.app`** and **`signal.owlette.app`**. set `SWOOP_SIGNAL_DEV_URL` /
   `SWOOP_SIGNAL_PROD_URL` and the api's `SWOOP_SIGNAL_URL` to `https://` those, and add the matching
   `wss://` origin to `connect-src` in `web/proxy.ts`.

   **one label deep, and that is not a style choice.** the zone's universal certificate is
   `*.owlette.app` + `owlette.app` — verified with `openssl s_client -connect dev.owlette.app:443` — and a
   wildcard matches exactly **one** label. `signal.dev.owlette.app` would therefore present a name the cert
   does not cover, and since every dial is `wss://` and the python doorbell refuses anything that is not,
   that is a hard handshake failure rather than a warning. a deeper name needs advanced certificate manager.

   a custom domain on a subdomain is independent of the apex load balancer, so this does not touch the
   railway/vercel failover on `owlette.app`.
6. **verify.** `curl -sS -o /dev/null -w '%{http_code}\n' https://<dev origin>/health` → `200`, and the body
   is exactly `{"ok":true,"service":"swoop-signal","protocolVersion":1}`.
7. **then let the pipeline do it.** push a no-op change under `infra/swoop-signal/` to `dev` and confirm the
   run is green. record the date and the run url here.
8. repeat 3–6 with `-e prod` when prod is ready.

### rollback

a deploy is a version; rolling back publishes an earlier one. it does **not** touch secrets and it does
**not** undo a durable-object migration, so a rollback across the `v1` migration is not a rollback — check
`[[migrations]]` before assuming.

```
cd infra/swoop-signal
npx wrangler deployments list -e dev      # newest first; copy the version id to go back to
npx wrangler rollback <version-id> -e dev # prompts for a reason, then publishes it
curl -sS -o /dev/null -w '%{http_code}\n' https://<dev origin>/health
```

`wrangler rollback` with no version id goes back one. the workflow does not roll back on a failed smoke
check — a human decides between rolling back and rolling forward, because a red `/health` is as often a
missing secret or a missing route as it is bad code.

**PENDING [human]** — these steps have never been executed on dev. task 3.4's done-when requires one rehearsal
(roll back to the previous version, `/health` 200, roll forward again); note the date, the two version ids and
the result here when it is done.

## limits

all in `src/messages.ts`, each with its number: 4 KiB token, 64 KiB frame, 120 frames per 10 s per
connection, 4 viewers per room, 10 rings per 60 s per machine. `jti` is single use, enforced in the room
because it is the only verifier here with durable state.

## hibernation, and the one mistake that costs real money

every socket is accepted with `ctx.acceptWebSocket`. **there must be no alarm, no timer and no held outbound
fetch in `SignalRoom`**: any one of them makes the object non-hibernatable, and spike 0.4 §5.3 prices that at
roughly $41,500/month at 10,000 rooms. the test `answers a bare ping without waking the room` is the
regression guard — `ping` is not json, so if it ever reached `webSocketMessage` the answer would be an `error`
frame instead of `pong`.

## running it

```
npm ci
npm test          # vitest; boots one `wrangler dev` on :8790 for the run
npm run typecheck # tsc over src, then over test
npm run dryrun    # wrangler deploy --dry-run for env.dev and env.prod
npm run dev       # interactive, needs a .dev.vars
```

the suite mints its own tokens from the **published fake** seeds in
`agent/swoop/testdata/protocol/keys.test-only.json` and generates a throwaway ring secret per run. no real key
is used, written or needed.

`@types/node` tracks the node 22 line because that is the runtime, and `typescript` tracks `^5` to match the
rest of this monorepo; both move when the repo does.
