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

locally they come from `.dev.vars`, which is gitignored. the deploy pipeline is task 3.4.

### key rotation runbook

order matters: the worker learns the new key **before** the api starts minting with it, or every token 401s.

1. generate a new ed25519 keypair offline.
2. **worker first.** put the outgoing pair into `SWOOP_JWT_KID_PREV` / `SWOOP_JWT_PUBLIC_KEY_PREV`, then the
   new pair into `SWOOP_JWT_KID` / `SWOOP_JWT_PUBLIC_KEY`. both now verify.
3. **api second.** set `SWOOP_JWT_PRIVATE_KEY`, `SWOOP_JWT_KID` and `SWOOP_JWT_PUBLIC_KEY` on every target in
   `scripts/env-manifest.json` (`node scripts/sync-env.mjs check` must be clean — `SWOOP_JWT_PRIVATE_KEY` is
   `must-match`, so a half-done rotation breaks the failover origin silently).
4. **fleet: nothing.** agents hold no key. a doorbell holding a token signed with the old key is refused `401`
   and re-mints immediately.
5. once every outstanding token has expired (host and doorbell ttl is 300 s), unset `_PREV`.

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
