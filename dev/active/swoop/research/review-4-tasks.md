# review 4 — adversarial review of `dev/active/swoop/tasks.md` (execution contract)

Reviewer: final adversarial pass on the 80-task / 12-wave contract. Date 2026-09-17.
Target: `dev/active/swoop/tasks.md`, checked against `plan.md`, `context.md`, `drafting-notes.md`,
`research/review-{1,2,3}-*.md`, and the repo at `<repo root>` (dev, `c71af4fb`).
Repo was read only; nothing modified.

Every finding below is a **blocking defect**: a fresh agent with no conversation context either cannot execute
the task, will produce something a sibling task contradicts, or will silently drop an accepted security
correction. Prose quality, severity re-litigation and settled decisions are out of scope and are not filed.

---

## Findings, ranked

### 1. Task 3.3 · tasks.md:472 — `requireMachineAuthAndScope` alone does not make an agent-only route agent-only; a site member with a session cookie can fetch the bundle, `K_session` included

`requireMachineAuthAndScope` (`web/app/api/_shared.ts:504-570`) short-circuits **only** for a bearer whose
decoded `role === 'agent'` (`:532-551`). Every other caller falls through to
`resolveAuthOrProblem` → `assertSiteAccessOrProblem(userId, siteId)` → `runScopeCheck` (`:553-560`), and for a
**session/ID-token caller the scope check is bypassed by design** (the helper's own doc comment, `:493-494`).
So a read-only site `member` holding a dashboard session can POST `/api/agent/swoop/bundle` with
`{siteId, machineId, sid}` and receive the host JWT and `K_session` — the exact outcome review-2 C2 exists to
prevent, re-entered through the route that replaced the Firestore carrier. Task 3.3's own done-when
(`:473`, "a session-cookie (non-agent) caller → 404/403") asserts a behaviour the named helper does not
provide, so the task is internally inconsistent as well as unsafe. The shipped precedent gets this right:
`web/app/api/agent/screenshot/route.ts:33-35` refuses `decodedToken.role !== 'agent'` with 403 before doing
anything.

**Edit — append to Task 3.3's Do after the first sentence:**
> `requireMachineAuthAndScope` admits any site member holding a session cookie (`_shared.ts:553-560`: non-key
> auth skips the scope check), so it is necessary but **not sufficient** on an agent-only route. Each of the
> three routes must additionally establish an agent principal and refuse anything else: call
> `resolveAgentPrincipal(req, siteId, machineId)` (`web/lib/sitePolicy.server.ts:190-218`) and return 404 on
> `null` or `'mismatch'`, or re-verify the bearer and refuse `decoded.role !== 'agent'` with 403, the
> `app/api/agent/screenshot/route.ts:33-35` pattern. A session or API-key caller must never reach the bundle.

---

### 2. Task 3.7 · tasks.md:496 — the `nvenc` cargo feature it builds behind is never declared by Task 1.2, and no encoder is in `default`, so Waves 3–5 have no picture

Task 3.7 says "behind the crate's **existing** `nvenc` cargo feature". Task 1.2 (`:137-139`) declares exactly
`encode-ffmpeg`, `encode-vpl`, `encode-amf`, `encode-mf`, `encode-openh264`, `turn`, `audio-opus` — there is no
`nvenc` (and the naming convention is `encode-*`). `Cargo.toml` is editable only by 1.2 and 10.1 (standing rule
`:16`), and the standing rule at `:11-12` tells the 3.7 agent to **stop and log** rather than add it. That
blocks 3.7 → 4.1 → gate G2. Compounding it: `[features] default` is finalised only in Task 10.1 (`:781`), so
through Waves 3–9 the default build contains no encoder backend at all — Task 4.1's dev-box run and G2's "a
frame reaches a canvas" cannot happen, and Task 7.3's done-when ("passes … with no features and with **each**
encoder feature", `:691`) has no nvenc feature to name.

**Edit — Task 1.2 line 137-139:** add `encode-nvenc` to the optional-feature list, and add to the Do:
> `[features] default = ["encode-nvenc"]` — NVENC is the first-class path and loads `nvEncodeAPI64.dll` by
> absolute path at runtime, so a non-NVIDIA box simply fails `probe()`; Task 10.1 finalises the rest of
> `default`.

**Edit — Task 3.7 line 496:** replace "behind the crate's existing `nvenc` cargo feature" with
"behind the crate's existing `encode-nvenc` cargo feature".

---

### 3. Tasks 1.2 / 3.7 / 7.3 · tasks.md:144-146, 496, 690 — `BackendCaps` and `EncoderConfig` are named by three Wave-7 tasks but defined by nobody, and NVENC is never pinned to the `probe()`/`create()` interface the selector requires

Task 1.2's core-type list is `gpu::Device`, `gpu::Frame`, `encode::EncodedFrame`, `capture::Source`,
`encode::Encoder`, `transport::VideoSink`, `input::Injector`, `session::Feature` — **no `BackendCaps`, no
`EncoderConfig`**. Tasks 7.1 (`:678`), 7.2 (`:684`) and 7.3 (`:690`) all sign against both types, in the same
wave, with no owner: three fresh agents invent three incompatible definitions. This is review-3 F4.3 ("a stub
file does not fix a shared *type*") recurring one wave later. Separately, 7.3 reaches "every backend … only
through its two root symbols", and 7.1/7.2 are pinned to them — but Task 3.7 (NVENC, Wave 3) is not told to
expose `probe()`/`create()` at its module root, and 7.3 owns only `encode/select.rs` and `probe.rs`, so it
cannot add them. The head of the fallback chain is unreachable.

**Edit — Task 1.2 line 144-146:** add to the core types
> `encode::BackendCaps` (codecs, max width/height per codec, BGRA-texture acceptance, measured max fps,
> concurrent-session budget) and `encode::EncoderConfig`, both in `encode/mod.rs` — Tasks 3.7, 7.1, 7.2 and
> 7.3 all sign against them.

**Edit — append to Task 3.7's Do:**
> Expose at the `encode::nvenc` module root, with exactly these names,
> `pub fn probe() -> BackendCaps` and `pub fn create(cfg: &EncoderConfig) -> Result<Box<dyn Encoder>>`,
> `#[cfg(feature = "encode-nvenc")]`-gated — the same two symbols Tasks 7.1/7.2 expose and Task 7.3 calls.

---

### 4. Task 3.2 · tasks.md:466 — nothing in the plan implements the API → Worker `POST /v1/ring`, the load-bearing start path

plan.md's approach (`plan.md:68-70`) has the API "ring the doorbell (sid only) **and** write a sid-only
fallback command", and D11 makes the doorbell the fast path with the polled command "the last resort".
Task 2.8 builds `POST /v1/ring` in the Worker and calls it "the API's only entry point" (`:372-373`), but no
task builds the caller: 2.4's five libs are `tokens`/`keys`/`turn`/`sessionStore`/`policy`; 3.2 delegates only
to `requestSwoopSession.server.ts` and those five and never mentions ringing; 5.4 (`:598`) and 6.6 (`:656`)
each say "call `POST /v1/kill`" with no shared module and no owner. Result: the success criterion "first frame
p50 ≤ 1.5 s with a warm doorbell" has no implementation, and every session falls back to the 2–5 s Firestore
poll; two later tasks hand-roll the same `SWOOP_SIGNAL_RING_SECRET` request.

**Edit — Task 2.4:** add `web/lib/swoop/signal.server.ts` + `web/__tests__/lib/swoop/signal.server.test.ts` to
Files, and to the Do:
> `signal.server.ts`: the server's only client for the Worker's control routes — `ringDoorbell({siteId,
> machineId, sid})` → `POST {SWOOP_SIGNAL_URL}/v1/ring` and `killSession({siteId, machineId, sid})` →
> `POST /v1/kill`, both authenticating with `SWOOP_SIGNAL_RING_SECRET`, both sending **a sid and nothing
> else**, both with a short timeout and a typed failure that the caller treats as "fall back to the polled
> command", never as a 500. Never log the secret.

**Edit — Task 3.2's Do**, after "Delegate the work to …":
> After the session document is written, ring the doorbell with `signal.server.ts`'s `ringDoorbell` (sid only)
> **and** enqueue the sid-only fallback command; neither failure blocks the response.

Point 5.4 and 6.6 at `killSession` rather than an ad-hoc fetch.

---

### 5. Task 8.7 · tasks.md:765 — the bundle `overrides` test hook has no schema, no parser, no selection site, and no release gate

8.7 selects the test pattern "through the bundle's optional `overrides` object" but owns only
`capture/testpattern.rs` on the Rust side. (a) `overrides` is absent from Task 1.1's bundle schema (`:116-117`);
(b) Task 2.10's `bundle.rs` must "reject unknown or missing fields" (`:401-403`), so the field is rejected;
(c) the code that would honour it lives in `session/mod.rs` / `main.rs`, which 8.7 is forbidden to edit
(`:765` and the standing rule `:17`). The task cannot be executed as written. And on the release-safety
question: as drafted the hook would be **unconditional in the shipped binary** — anything that can shape the
bundle (the API, or a compromised web env) could put a production streamer into a synthetic-desktop or
software-encoder mode with nothing in the audit trail. The mitigation is nearly free.

**Edit — Task 1.1's bundle-schema clause:** add `overrides` to the listed fields, specified as
> optional, test-only, `{source?: "testpattern", encoder?: "soft"}`; a streamer built without the `testhooks`
> feature must **reject** a bundle carrying it (exit 10).

**Edit — Task 1.2:** declare a non-default cargo feature `testhooks` alongside the encoder features.

**Edit — Task 2.10's `bundle.rs` clause:** parse `overrides` only under `#[cfg(feature = "testhooks")]`; without
the feature an `overrides` key is an unknown field and the bundle is invalid.

**Edit — Task 5.1's Do:** when `overrides` is present, select the test source/encoder and emit a `status`
stdout event naming the override, so it is visible in `logs/swoop` and in the host events route.

**Edit — Task 8.7's done-when:** add "`cargo test --features testhooks` covers the override path, and a test
asserts a default-feature build rejects a bundle carrying `overrides` with exit 10"; **Task 10.1** must exclude
`testhooks` from `default`.

---

### 6. Task 5.4 · tasks.md:599 — the command-document assertion contradicts Task 2.11 and cannot pass

5.4's done-when asserts "the enqueued command document has **no field outside** `{type, sid, createdAt,
expiresAt}`". Task 2.11 (`:425-426`) correctly specifies the document as `{type, sid}` **plus** the canonical
envelope `siteId`, `machineId`, `timestamp`, `status`, `queuedBy` and `stampCommand`'s lifecycle fields, which
is what the real writer produces (`web/lib/actions/executeMachineCommand.server.ts:205-216` +
`web/lib/commandLifecycle.ts:65-79`: `createdAt`, `expiresAt`, optional `auditCorrelationId`). 5.4's phrasing is
review-2 C2's illustrative wording copied verbatim; against 2.11's implementation the test fails, and a fresh
agent "fixing" it by stripping the envelope breaks the agent's command listener.

**Edit — Task 5.4 done-when, replace that clause with:**
> the enqueued command document's key set is exactly Task 2.11's contract — `type`, `sid`, the envelope
> (`siteId`, `machineId`, `timestamp`, `status`, `queuedBy`) and `stampCommand`'s lifecycle fields
> (`createdAt`, `expiresAt`, `auditCorrelationId`) — and carries no bundle, JWT, key, TURN credential or
> viewer id.

---

### 7. Tasks 2.7 / 5.4 / 2.11 · tasks.md:350, 358, 598 — `swoop_refresh` is required to carry a `sid` it cannot have, so site enablement cannot reach a machine

2.7 validates "that a sid is present and is a plain string" for all three types and its done-when requires "a
payload with no sid refused" (`:358`); 2.11's signature makes `sid` mandatory and its key-set test pins it
(`:434`). But 5.4 sends `swoop_refresh` on an enablement toggle, where no session exists (`:598`), and the
kill route falls back to `swoop_kill` "for a machine with no live session" — also sid-less. As written the
refresh command is either never sent or always refused with `Error: …`, and swoop enablement never reaches the
fleet except by doorbell re-dial. Second, smaller contradiction in the same task: the Do maps `swoop_kill` →
`kill(reason)` and `swoop_refresh` → `on_session_change()`, while the done-when requires "each handler calling
exactly one manager method **with the sid**".

**Edit — Task 2.7's Do:** replace the validation sentence with
> `swoop_session_requested` must carry a `sid` (plain string) and nothing else; `swoop_kill` carries an
> optional `sid` (absent means "kill whatever is running"); `swoop_refresh` carries no `sid`. Any other field
> is refused with an `Error: …` string.

**Edit — Task 2.7 done-when:** "each handler calling exactly one manager method — `ensure_streamer(sid)`,
`kill(reason)` built from the command type and optional sid, `on_session_change()` — and a
`swoop_session_requested` with no sid refused."

**Edit — Task 2.11:** make `sid` optional in the signature for `swoop_kill`/`swoop_refresh` and adjust the
key-set test to the type.

---

### 8. Task 3.2 · tasks.md:466 — the `capability_enforcement === false → 403` refusal contradicts Task 1.3 and the recorded drafting decision

1.3 (`:167-170`) puts a `BYPASS_EXEMPT_CAPABILITIES` set in `web/lib/authorizedHandler.server.ts` so that when
the platform kill switch is engaged the two swoop capabilities are **still checked normally** — a caller who
holds `MACHINE_REMOTE_CONTROL` passes, one who does not gets 403 `capability_missing` (its done-when, `:171`).
3.2 instead refuses **every** caller outright while the flag is off, which is the route-level placement
`drafting-notes.md:33-35` explicitly rejected ("one exempt-set, one test"). Two agents implement two different
behaviours against one flag, and 3.2's done-when case "`capability_enforcement=false` refused" is ambiguous
about which one it means.

**Edit — Task 3.2's order-of-refusals:** delete "`securityConfig.capability_enforcement === false` → 403 (the
bypass must not reach remote control)" and replace with
> (the `capability_enforcement=false` bypass is closed centrally by Task 1.3's `BYPASS_EXEMPT_CAPABILITIES` in
> `authorizedHandler.server.ts` — do not re-implement it here)

and change the done-when case to "with `capability_enforcement: false`, a member without
`MACHINE_REMOTE_CONTROL` still gets 403 `capability_missing`".

---

### 9. Task 8.3 · tasks.md:741 — the tray toast is gated on a site setting the agent has no way to read; "the agent already syncs" it is false

`grep` over `agent/src/*.py` finds no read of any `sites/{s}/settings/*` document — the agent syncs
`config.json` (`config_sync.py`) and nothing else. `sites/{s}/settings/swoop.indicator` exists only in the web
tier (2.4's `policy.server.ts`, 5.4's settings route/hook). Nothing delivers it to `SwoopManager.status()`, and
`indicator` is not in Task 1.1's bundle schema or Task 3.3's bundle response either, so the 8.3 agent has no
source for the gate and will either invent a Firestore read in the agent (new surface, no rules coverage) or
drop the gate.

**Edit — Task 1.1 bundle schema and Task 3.3's `bundle` response:** add `indicator` beside `enablement`.
**Edit — Task 8.3's Do, last clause:** replace "gated on the site's `indicator` policy from
`sites/{s}/settings/swoop`, which the agent already syncs" with
> gated on the `indicator` policy the streamer receives in its bundle and reports back in its `status` event,
> which `SwoopManager.status()` carries into `tmp/service_status.json`. The agent reads no
> `sites/{s}/settings/*` document — it has no such path today and this task does not add one.

---

### 10. Task 7.3 · tasks.md:690-691 — it asserts `swoop_capability.py` parses the `probe` JSON; Task 2.2 says it must not, and the done-when names a test that will not exist

7.3: "The key names are a contract: `agent/src/swoop_capability.py` parses this JSON to compute
`capabilities.swoop` — read that file, do not modify it", and its done-when requires "`owlette-swoop.exe probe`
… prints JSON that an **existing** `swoop_capability.py` test parses". Task 2.2 (`:246-250`) specifies the
opposite and for a good reason: `swoop_capability_value()` returns 1 from `get_swoop_exe_path()` ∧
`streamer_capable()`, and "nothing here does I/O on the heartbeat path beyond the existing exe-path check" —
running `probe` per heartbeat would put a subprocess on the metrics path. So the claim is false, the "existing
test" does not exist, and the done-when is unverifiable.

**Edit — Task 7.3, replace that sentence with:**
> The key names are a contract for the memos and for Task 8.2's encoder budget, not for the heartbeat:
> `agent/src/swoop_capability.py` deliberately computes `capabilities.swoop` from binary presence alone
> (Task 2.2) and must not run `probe` on the heartbeat path — do not modify it.

**Edit — done-when:** replace the "existing `swoop_capability.py` test parses" clause with "…prints JSON whose
top-level keys match the names listed above, asserted by a unit test in this task."

---

### 11. Tasks 0.5 / 2.4 · tasks.md:62 vs :281-282 — `K_session` is specified two different ways

Task 0.5's done-when demands the PROTOCOL security block state `K_session = HKDF(SWOOP_SESSION_MASTER_KEY,
sid)` — matching plan.md D8 (`plan.md:148`) — and Task 1.1 pastes that block into `PROTOCOL.md` verbatim. Task
2.4 implements `K_session = HKDF(SWOOP_SESSION_MASTER_KEY, sid ‖ machineId ‖ streamerEpoch)` (review-2 M3's
original proposal). PROTOCOL.md is the oracle both the streamer and the golden vectors are built against; two
derivations for one key is exactly the kind of drift that produces a MAC mismatch nobody can debug.

**Edit — pick D8's spelling in both, or amend D8.** Simplest: change Task 2.4 line 281 to
`K_session = HKDF(SWOOP_SESSION_MASTER_KEY, sid)` and drop `machineId ‖ streamerEpoch` from the info string —
`sid` is already unique per streamer lifetime and the bundle carries `streamerEpoch` for the version/epoch
handshake. If the wider info string is wanted, amend plan.md D8 and Task 0.5's required block in the same edit
so all three read identically.

---

### 12. Task 0.11 · tasks.md:99 — the done-when grep can never return nothing

Done-when requires `grep -rn "live-view-webrtc" cli/ web/content/` to return nothing. The literal also appears
at `cli/__tests__/commands/readiness-docs.test.ts:40`, inside the `staleNeedles` guard
(`['dev/active', 'live-view-webrtc'].join('/')`) — a guard the task's own Do tells the agent to respect
("it forbids `dev/active/live-view-webrtc` appearing in CLI docs, so the replacement must not introduce
`dev/active/swoop` either"). The agent either fails the task or deletes a guard it was told to keep.

**Edit — Task 0.11 done-when, replace the grep clause with:**
> `grep -rn "live-view-webrtc" cli/ web/content/` returns only
> `cli/__tests__/commands/readiness-docs.test.ts:40`, the stale-needle guard, which stays as it is.

---

### 13. Task 9.1 · tasks.md:773-774 — the ubuntu/macos `cargo check` legs cannot go green from the work described

9.1 adds `ubuntu-latest` and `macos-latest` legs and its done-when requires them green, but the described work
is only `platform/{mod,windows,macos,linux}.rs`. Everything Waves 3–8 wrote — `capture/`, `encode/`, `input/`,
`cursor/`, `clipboard/`, `audio/`, `displays/`, `securedesk/`, `transport/turn/tls.rs` — is unconditional
Win32/D3D11 code, and Task 1.2 declares `windows` as a plain dependency, not target-scoped. A non-Windows
`cargo check` fails on the first module, and the task has no mandate to touch any of them.

**Edit — Task 1.2's Do:** "declare the `windows` crate under `[target.'cfg(windows)'.dependencies]`, and gate
every Windows-only module declaration in `main.rs` behind `#[cfg(windows)]` from the start, so the crate stays
checkable on other hosts."
**Edit — Task 9.1's Do:** add "re-home every Windows-only module declaration behind `#[cfg(windows)]` in
`main.rs` (the one exception to the no-`main.rs` rule for this task, stated in the standing rules) so the
ubuntu and macos legs compile against the platform stubs; behaviour on Windows is unchanged." If that is
judged too large, downgrade the legs to `cargo check -p owlette-swoop --no-default-features` on the
`platform/` module only, and say so in the done-when.

---

### 14. Tasks 0.6 / 2.3 / 3.3 · tasks.md:67, 266, 472 — the doorbell's `403 swoop_disabled` path has no server side

Task 0.6 designs "the 403 `swoop_disabled` slow-retry path (name the interval)" and 2.3 builds a client that
re-mints on 401; but Task 3.3's `doorbell-token` route only "mints a `role=doorbell` EdDSA JWT" with no
enablement check. As written, every agent in the fleet holds an open Worker socket whether or not swoop is
enabled for its site — contrary to the owner's "off until enabled per site" default, and it inflates the very
idle-cost model spike 0.4 is asked to compute.

**Edit — Task 3.3's `doorbell-token` clause, append:**
> Refuse with 403 `swoop_disabled` when `sites/{siteId}/settings/swoop.enabled` is false or this machine is in
> `excludedMachineIds` (read through `web/lib/swoop/policy.server.ts`), so a machine with swoop off holds no
> signaling socket; the agent's slow-retry path (spike 0.6) is written against that code.

**Edit — Task 3.3 done-when:** add "a doorbell-token request for a site with swoop disabled → 403
`swoop_disabled`."

---

### 15. Tasks 2.2 / 2.7 · tasks.md:241-242, 356 — the agent's per-type 5-second command throttle is not accounted for anywhere

`owlette_service.py:4570-4580` throttles every command type except `mcp_tool_call` and `ack_display_topology`
to one per `COMMAND_RATE_LIMIT_SECONDS = 5` per `f"{cmd_type}:{process_id or ''}"`, returning
`"Error: rate limited …"`, which `firebase_client` records as a **failed** command. For swoop the rate key
collapses to `swoop_session_requested:` / `swoop_kill:` / `swoop_refresh:`, so: two viewers opening the same
machine within 5 s fail the second fallback command; Task 6.6's revocation `swoop_kill` within 5 s of an
operator kill (5.4) is dropped; two enablement toggles inside 5 s drop the second `swoop_refresh`. review-2 H3
flagged it ("should be measured, not assumed") and no task carries it.

**Edit — Task 2.2's Do**, beside the `_FAST_COMMAND_TYPES` clause:
> Also add the three swoop types to the throttle exemption at `owlette_service.py:4573`
> (`if cmd_type not in ('mcp_tool_call', 'ack_display_topology')`) — the per-type 5 s throttle keys on the
> command type alone, so a second viewer's session request, a revocation kill following an operator kill, or a
> second enablement toggle inside five seconds is recorded as a **failed** command. Note the file-ownership
> consequence in the task log: this is the one `owlette_service.py` edit outside Task 3.1, so make it in 3.1
> instead if 2.2 and 3.1 would otherwise collide.

(Alternative, if touching `owlette_service.py` from 2.2 is unacceptable: move this one-line exemption into
Task 3.1, which already owns that file, and cross-reference it from 2.2.)

---

## Checked and sound

- **Security corrections, all traced to a task and intact except where filed above:** bundle never in a
  Firestore command (2.11 `:425-428`, 5.4, 1.1's security section); swoop types absent from
  `ALLOWED_COMMAND_TYPES` and written only by `requestSwoopSession.server.ts` (2.11 `:429`, 1.3, 5.4, with the
  negative test); API-key callers refused with `api_key_not_permitted` (2.4 `:292`, 3.2 `:466`, 8.7 `:765`);
  step-up as a live in-process proof with zero-factor accounts refused and the 10-minute window openable only
  by a ceremony (2.4 `:292-295`, 3.2, 5.5) — verified against `web/lib/mfaProof.server.ts:67,79,196,264` and
  `web/app/api/mfa/backup-codes/route.ts:51-60`; `fp` mandatory with two negative golden vectors (0.5, 1.1,
  2.4, 3.9, 3.10); `exp` against the bundle time anchor plus monotonic elapsed, never `SystemTime::now()`
  (1.1, 2.10, 3.9, 6.6); `kid` + two-key rotation overlap (1.1, 2.8, 3.3, 3.9, 3.4's runbook); both new
  capabilities exempt from the `capability_enforcement` bypass (1.3, verified against
  `authorizedHandler.server.ts:609-633`); explicit `USER_LIMITS`/`SYSTEM_LIMITS` entries (1.3, verified
  against the fail-open at `rateLimit.server.ts:445-451`); security events to `audit_log` not `logs` (5.6,
  3.3, verified against `auditLog.server.ts:48-57,103,123`); anonymous pipes with no file seam (0.3, 2.1,
  D2); `{app}\swoop` protected DACL set by the installer and a hard refuse-to-spawn gate (0.7, 2.1, 2.6,
  modelled on `display_manager.py:315-372,456`); 5-minute lease + 12 h cap + revocation on membership removal
  **and** demotion (6.6, 3.2); kill through the streamer's own socket first (5.4, D11).
- **Guardrails:** no task blocks the 5-second loop (2.1, 2.7, 3.1, 6.1, 7.7 all name off-loop threads); no
  UAC path anywhere (0.3, 2.1, 6.1, 7.7, 2.6's upgrade test); no token/key/bundle logging (asserted in 2.1,
  2.3, 2.4, 3.3, 4.1, 7.4, 8.7); the doorbell never touches `ConnectionManager.register_thread`/`report_error`
  (0.6, 2.3, 3.1, each citing `connection_manager.py:698,436-472,765-786` — all four line refs confirmed);
  `firestore.rules` untouched and pinned by a rules test (2.4, D12); `.iss` edits limited to payload + kill
  pass + DACL (2.6) and uninstall cleanup (7.7) with an owner ack; no display-configuration change (6.4
  states the code path must not exist); work stays on `dev`; approved packages only (`websocket-client` pinned
  with reason + exit condition in 2.3 — confirmed absent from `agent/requirements.txt` today; the Worker's own
  dev deps in 2.8; Rust pins in 1.2); legacy live view survives until the fleet floor (5.3 renders exactly one
  of the two items; 11.1 gated and human-confirmed).
- **Delivery-review corrections:** Rust done-when is `cargo clippy -- -D warnings` + `cargo test` with working
  directory `agent/swoop` on every Rust task (standing rule `:13-15` and each task); lockfile registration in
  3.5 (verified against `check-security-alerts.mjs:276-283` and `dependabot.yml:29-34,66-70`); Worker deploy +
  `must-match` classification for the three sensitive keys (1.4, 3.4); installer kill pass by name+path with
  the version handshake and exit 11 (0.7, 2.6, 2.1); `build-installer.yml` timeout/cache/MpCmdRun before the
  subjects step (2.6 — `timeout-minutes: 30` at `:73`, `permissions` at `:78`, subjects at `:154` all
  confirmed); `[profile.release]` copied verbatim with its comment (1.2, confirmed at
  `agent/host/Cargo.toml:40-59`); `logs/swoop` self-rotation with `cleanup_old_logs` left non-recursive (1.2,
  1.5); both changelogs in 10.1; human/hardware labels present on every task needing the owner's hardware,
  accounts or eyes.
- **Interfaces stated in two places and agreeing:** `SwoopManager.ensure_streamer/kill/on_session_change/
  status` (2.1, 2.7, 3.1, 6.1, 8.3); `SwoopDoorbell(on_ring, get_agent_token, shutdown_event)` (2.3, 3.1);
  the frozen step-up dialog props (4.2, 5.2, 5.5, verbatim in all three); viewer record public fields (8.1,
  8.2, 6.6); `attach(session)` feature registries on both ends (1.2/5.1 Rust, 4.2/5.2 web) with Wave 6+ tasks
  correctly forbidden from editing the registry files; golden-vector `index.json` as the one oracle for 2.9
  and 2.10.
- **Line references spot-checked against the repo and correct** (~40 checked): `capabilities.ts:1,112,116,144`
  (and `SITE_ADMIN` really does spread `SITE_MEMBER`, so 1.3's inheritance claim holds);
  `rateLimit.server.ts:40,71,445-451`; `authorizedHandler.server.ts:609-633`; `_shared.ts:61,504,709`;
  `executeMachineCommand.server.ts:25,183,205-218`; `commandLifecycle.ts:65`; `mfaProof.server.ts:67,79,196,264`;
  `proxy.ts:19,73`; `Footer.tsx:46`; `MachineContextMenu.tsx:311-331`; `useFirestore.ts:251`;
  `logs/page.tsx:137`; `auditLog.server.ts:48-57,123`; `cron/retention/route.ts:89-93` and
  `infra/cron-jobs.json`'s full entry shape; `owlette_service.py:82,955-979,1138,1177,1278,1397,1931,2254,2777,
  2829,2885,7180,7268,7802`; `firebase_client.py:1527-1538,1570,2531-2546`; `shared_utils.py:797,878,1065-1068,
  1097`; `connection_manager.py:205,206,210,217,436,698,765`; `machine_commands.py:45`; `command_router.py:37`;
  `display_manager.py:315,456`; `owlette_installer.iss:87,98,126,197,199,446,1140-1200,1176-1183`;
  `sync-versions.js:29-34`; `agent/host/Cargo.toml:40-59`; the four CLI/doc sites 0.11 must move.
- **Mechanical checks:** no same-wave file collision beyond the Wave-0 spike `Cargo.toml` false positives;
  no same-wave dependency except the ones deliberately resolved by stating an interface twice
  (`drafting-notes.md:36-39,95-106`); every `Depends on:` names an earlier wave or a gate.
