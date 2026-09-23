# swoop — Context
**Last updated**: 2026-09-17

Everything a fresh agent needs that is not in [plan.md](plan.md). Line numbers were read on `dev` at `69422f9b`
(2026-09-17); re-locate by symbol if they have drifted. `dev/active/` is gitignored — search it with plain
`grep -rn`, not ripgrep-based tools, which skip it.

## Guardrails that bind every task (from `.claude/CLAUDE.md`)

- Never raise a UAC prompt unattended. Never block the 5-second main loop (`SLEEP_INTERVAL = 5`,
  `owlette_service.py:82`). Never import `firebase_admin`. Never log tokens, keys or bundles — not partially,
  not in debug. Never modify the `firebase` section of `config.json` remotely.
- Reconnection logic lives in `ConnectionManager` — **except the swoop doorbell**, which is self-supervised by
  the owner's ruling (see plan.md). It must never call `register_thread` or `report_error`.
- `firestore.rules`: do not modify (this plan needs no change). `agent/owlette_installer.iss`: only the three
  approved edits, and read `.claude/skills/build-system.md` first.
- A fleet-behaviour change must cover the upgrade path from every fielded version: during self-update the OLD
  service and OLD desktop app run; the installer is the only new code on an old box. Verify by upgrading from
  the oldest fielded version, not from dev.
- Web: hooks only for Firestore (`web/hooks/`), no hardcoded colours (CSS variables / Tailwind tokens), only
  `lucide-react` icons, all UI copy lowercase, `button.tsx` variants are the single source of button styling.
  Run `npx eslint <file>` after every web edit.
- No new npm/pip packages beyond the approved ones (`websocket-client`; the Worker project's own dev packages;
  the Rust crates pinned in Task 1.2). Every pin that holds a package back carries a reason and an exit
  condition.
- Release order: version bump (`node scripts/sync-versions.js X.Y.Z`) and changelog entries (both
  `docs/changelog.md` and `web/content/docs/changelog.mdx`) are committed **before** building an installer.
- Work on `dev`; never push to `main`. Conventional commits. Pre-commit code review of every staged line.

## Key files — modify

**Agent (`agent/src/`)**
- `owlette_service.py` — `_enable_privileges` `:2576`; `_refresh_user_token` `:2708`;
  `_get_elevated_install_token(self) -> (token, env)` `:2777` (duplicates the service's SYSTEM token and
  retargets `TokenSessionId` to the console session — the primitive swoop spawns with);
  `_launch_command_as_user(self, command_line, description)` `:2829` (`bInheritHandles=0` at `:2851`, so it
  cannot pass pipes); `launch_desktop_app_as_user` `:2885`; cortex companion pattern to imitate:
  `_is_cortex_alive` `:2187`, `_try_launch_cortex` `:2213`, `terminate_cortex` `:2235`, IPC drain on a daemon
  thread `:2254-2288`; command router wiring `:955-977`, dispatch `:4584-4586`; self-update `:4980-5079`
  (download → sha256 → `schtasks /RU SYSTEM` → `/VERYSILENT`); legacy live view `_handle_start_live_view`
  `:7268`, `_live_view_loop` `:7315`; legacy screenshot `_handle_capture_screenshot` `:7180` (keep — cortex and
  crash screenshots use it).
- `firebase_client.py` — command listener `:924` (`listen_to_document`, adaptive REST polling 2–5 s; the
  returned wake event is discarded); config listener `:998` (2–10 s); capabilities heartbeat
  `metrics_ref.update({...})` `:1527`, existing key `'capabilities.displayRemoteApply': 1` `:1538` (always
  separate dotted keys — a whole-map write drops siblings); `_FAST_COMMAND_TYPES` `:1570`; slow-command worker
  `:197`, `:1728`; `set_machine_flags(flags)` `:2317`; `log_event(action, level, process_name=None,
  details=None, user_id=None, extra_fields=None, doc_id=None, **kwargs)` `:2425`; canonical authenticated call
  to the web API `:2531-2546` (`shared_utils.get_api_base_url()` + `self.auth_manager.get_valid_token()` +
  `requests.post(..., timeout=10)` on a daemon thread). There is no shared HTTP helper.
- `firestore_rest_client.py:516` — `listen_to_document` is polling, not a stream.
- `connection_manager.py` — `register_thread(name, factory)` `:698`; watchdog `:765-786` calls `report_error`
  `:436-472` for any dead supervised thread → Firestore reconnect. Do not register the doorbell.
- `command_router.py:37` `CommandRouter`; `machine_commands.py:45` `register_handlers(router)` with
  `router.register("type")(handler)`; handlers take `(cmd_data, cmd_id, service)`.
- `shared_utils.py` — `get_data_path()` `:781` (`%PROGRAMDATA%\Owlette`), `ensure_data_directories()` `:797`,
  path constants `:863-875` and `:1065-1068`, `get_api_base_url()` `:826`, `cleanup_old_logs` `:1110`
  (non-recursive: `logs/swoop/` must rotate itself), global JSON mutex SDDL `:44-93`.
- `display_manager.py:315-372` — the working protected-DACL pattern (`SetNamedSecurityInfo` with
  `PROTECTED_DACL_SECURITY_INFORMATION`, plus an idempotence check) that `{app}\swoop` reuses.
- `config_sync.py:20` — `LOCAL_ONLY_KEYS = ('firebase','sentry','environment')`; swoop must not be added.
- `hardware_profile.py:133,203` — GPUs come from nvidia-smi only, no vendor field; the streamer's `probe` verb
  is the source of encoder truth.
- `requirements.txt` — every line carries a reason comment; keep that style.

**Build / installer / CI**
- `agent/build_installer_full.bat` — `[n/9]` steps: 6 Tauri desktop `:196-253`, 7 Rust service host `:262-304`
  (`cargo build --release` `:293`), 8 assemble `build\installer_package` `:317-389` (host exe → `tools`
  `:361`, desktop exe → `app` `:377`), 9 Inno `:392-421`. `build_installer_quick.bat` mirrors it.
- `agent/owlette_installer.iss` — `DefaultDirName={commonappdata}\Owlette` `:87` (so `{app}` is
  `C:\ProgramData\Owlette`); `[Files]` `:126`, `{app}\app` `:137`, `{app}\tools` `:181`; `[Dirs]` `:197-203`;
  `[UninstallRun]` `:446` (desktop pre-kill `:451`); install-time kill pass by
  name scoped to path `:1140-1200` (desktop `:1176-1183`); a miss silently becomes delay-until-reboot in silent
  mode `:1155-1160`. No `[Registry]`, no firewall entries today.
- `.github/workflows/build-installer.yml` — signing TODO `:18-31`; `timeout-minutes: 30` `:58`; SLSA subjects
  step `:154` (signing must happen before it); provenance job `:197`.
- `agent/host/Cargo.toml:44` `[profile.release]` (`opt-level=2, lto="thin", strip=false` — the Bearfoos
  incident), `agent/host/.cargo/config.toml` (`+crt-static`), `agent/host/build.rs` (VERSIONINFO + icon): copy
  these verbatim into `agent/swoop`.
- `scripts/sync-versions.js` — file list at `:15-50`; add `agent/swoop/Cargo.toml`.
- `scripts/check-security-alerts.mjs:278-283` and `.github/dependabot.yml:65-71` hardcode lockfiles; a new
  lockfile that is not registered makes any advisory on it UNRESOLVED, which blocks releases.
- Best workflow template: `.github/workflows/agent-tests.yml` (pinned SHAs with `# vN` comments, least
  privilege `permissions`, `concurrency`, `timeout-minutes`, path filters; zizmor scans workflows).

**Web**
- Auth pipeline: `web/lib/authorizedHandler.server.ts` (`authorizedSiteHandler`; context
  `{actor, siteId, correlationId, auth, scopeCheck}`; `auth.keyContext !== null` means an API key);
  `web/lib/apiAuth.server.ts` (`resolveAuth` `:296`); `web/app/api/_shared.ts` — use
  `requireMachineAuthAndScope` `:504-570` for agent routes (the `…OrSite…` helpers at `:79-87` and `:731-741`
  do not check `machine_id`). Route shape to copy:
  `web/app/api/sites/[siteId]/machines/[machineId]/commands/route.ts:428`.
- `web/lib/capabilities.ts` — `Capability` enum `:1`, `SITE_MEMBER_CAPABILITIES` `:112` (only `MACHINE_VIEW`),
  `SITE_SCOPED_CAPABILITIES` `:144`; `web/lib/rateLimit.server.ts:40,71` exhaustive `Record<Capability,…>`
  (unlisted capabilities fail open at `:448-449`).
- Commands: `web/lib/actions/executeMachineCommand.server.ts:25` `ALLOWED_COMMAND_TYPES` (swoop types stay
  out), offline 409 `:183`, write `:218` (`commands/pending`, command ids are map keys);
  `…/commands/route.ts:349-353` `VIEW_COMMAND_TYPES`.
- Step-up: `web/lib/mfaProof.server.ts` (`parseMfaProof` `:79`, `verifyPasskeyStepUpAssertion` `:196`,
  `verifyMfaProof` `:264`, `mfaProofErrorResponse` `:67`); routes
  `web/app/api/passkeys/step-up/{options,verify}/route.ts`; the only consumer today is
  `web/app/api/mfa/backup-codes/route.ts:51-60`; `web/lib/sessionManager.server.ts:219-221` and
  `web/lib/deviceTrust.server.ts:30` show why timestamps cannot be trusted; `/api/*` is not gated by
  `web/proxy.ts` (`:126-130`).
- Site settings precedent: `web/app/api/sites/[siteId]/hoot-settings/route.ts` →
  `web/lib/actions/setHootRequireTier3Approval.server.ts` → `sites/{siteId}/settings/cortex`, read by
  `web/hooks/useHootApprovalSetting.ts:16`; per-machine precedent `…/machines/[machineId]/hoot-enabled/route.ts`.
  Site dialog: `web/components/ManageSitesDialog.tsx` (mounted `web/app/dashboard/page.tsx:831`).
- Machine actions: `web/components/MachineContextMenu.tsx` (screenshot `:312-321`, live view `:322-331`);
  `web/app/dashboard/page.tsx` (`:163` hook pulls, `:203-207` dialog state, `:1091-1098` and `:1145-1151`
  handlers, `:1736-1761` dialogs); `web/app/dashboard/components/MachineCardView.tsx`, `MachineListView.tsx`
  (prop pass-through); `web/components/LiveViewModal.tsx`; `web/hooks/useFirestore.ts` (`Machine` `:251`,
  `liveView` fields `:285-295`, `sendMachineCommand` `:1678`, live-view helpers `:1740-1750`).
- `web/proxy.ts` — `PROTECTED_PATHS` `:19`, CSP builder `:52`, `connect-src` `:73`, `frame-ancestors 'none'`
  `:76` (pop-out window, never an iframe). No `media-src`, so use `video.srcObject`, never blob URLs.
  `web/next.config.ts:147` Permissions-Policy blocks camera/microphone only.
- Audit: `web/lib/auditLog.server.ts:103,123` (`sites/{siteId}/audit_log`, written by `authorizedSiteHandler`,
  blocking on allow); operational feed `sites/{siteId}/logs` with the action registry
  `web/app/logs/page.tsx:137 ACTION_TYPE_GROUPS` and `web/lib/logFilters.ts:33`. Site admins can bulk-delete
  site logs, so security-relevant swoop events go to `audit_log`.
- Versions: `web/lib/versionUtils.ts:35 compareVersions`, `:158 SITE_TIME_MIN_AGENT_VERSION` (pattern for
  `SWOOP_MIN_AGENT_VERSION`).
- Env: `scripts/env-manifest.json` (classes `public|config|secret|must-match|build`; targets `railway-dev`,
  `railway-prod`, `vercel-prod`; `mirror` pairs) + `node scripts/sync-env.mjs check`.
- Tests: Jest (`web/jest.config.js`; API tests start with `/** @jest-environment node */`; auth mock
  `web/__tests__/api/helpers/authorized-handler-mock.ts`; example `web/__tests__/api/keys.test.ts`); rules
  tests `npm run test:rules` (`web/__tests__/rules/`); Playwright (`web/e2e/`, roles via
  `web/e2e/helpers/roles.ts`, seeding via `web/e2e/helpers/seed.ts`, template
  `web/e2e/specs/settings/api-keys.spec.ts`; CI installs bundled Chromium only — no proprietary codecs).
  API-wrapping hook template: `web/hooks/useMachineOperations.ts:6`. Toast: `web/lib/toast.ts:178`.

**Desktop (tray)** — `desktop/src-tauri/src/tray.rs`: `TrayView` `:113`, `monitor` `:469` (polls
`tmp/service_status.json` itself via `read_status_doc` `:699`), `determine_status` `:755`, `apply_menu` `:595`,
`tooltip` `:975`, `notify` `:908`. The session indicator is a field in `service_status.json`.

**CLI** — `cli/src/commands/machine.ts:427-442` live-view stub (`futurePlan` `:439`; verb list `:146`), pinned
by `cli/__tests__/commands/stubs.test.ts:42,108,138`; `tryOpenBrowser` is private in
`cli/src/commands/auth.ts:100`; registration in `cli/src/index.ts:32`.

**Firestore rules (read only)** — machines block `:277`; explicit subcollections `:303-392`; the only recursive
wildcard is `/{path=**}/members/{memberUid}` `:247`; settings `:852`; catch-all deny `:940`.

**Infra** — `infra/cloudflare/` is Terraform for the failover load balancer only (provider `~> 4.52`, no
TURN/Workers resources); R2 is provisioned by `scripts/provision-r2.mjs`. No wrangler project exists yet.
Railway runs `npm start`; Vercel is the failover origin and cannot host WebSockets; the load balancer has no
session affinity — never keep signaling state in the web app's memory.

## Key files — create

`agent/swoop/**` (crate, `PROTOCOL.md`, `testdata/`, `spikes/`) · `infra/swoop-signal/**` ·
`agent/src/swoop_{manager,spawn,doorbell,commands,capability}.py` + `agent/tests/unit/test_swoop_*.py` ·
`web/lib/swoop/**` · `web/hooks/useSwoopSession.ts`, `useSwoopSettings.ts` · `web/components/swoop/**` ·
`web/app/swoop/[siteId]/[machineId]/{page,layout}.tsx` · `web/app/api/sites/[siteId]/machines/[machineId]/swoop/**` ·
`web/app/api/sites/[siteId]/swoop-settings/route.ts` · `web/app/api/agent/swoop/{doorbell-token,bundle,events}/route.ts` ·
`web/lib/actions/{requestSwoopSession,setSwoopSettings}.server.ts` · `.github/workflows/rust-build.yml`,
`swoop-signal-deploy.yml` · `cli/src/commands/swoop.ts`, `cli/src/lib/openBrowser.ts` ·
`dev/active/swoop/spikes/*.md`.

## Facts that are easy to get wrong

- Legacy live view is a screenshot slideshow (5–60 s interval) that uploads through the base64
  `/api/agent/screenshot` route; that route also serves crash screenshots and cortex, so it survives Task 11.1.
  `agent/tests/unit/test_screenshot_paths.py` pins all three capture pipelines.
- `start_live_view` / `stop_live_view` appear in four places in lockstep: `ALLOWED_COMMAND_TYPES`,
  `VIEW_COMMAND_TYPES`, `web/openapi.yaml:5255`, `cli/src/commands/machine.ts:612`.
- Nothing Owlette ships is Authenticode-signed today. `owlette-host.exe` was quarantined as
  `Trojan:Win32/Bearfoos.B!ml` for looking like a stripped, metadata-free dropper.
- There is no Rust CI today; `build-installer.yml` compiles Rust only indirectly. There is no cargo workspace
  on purpose.
- Chrome: WebRTC H.265 receive since M136, hardware-only, no software fallback. Edge: no H.265 in WebRTC at
  all. Firefox: none. Safari 18+: yes. WebCodecs HEVC: Chrome/Edge 107+ with hardware (Edge may need the paid
  HEVC Video Extension), Safari 16.4+, Firefox < 2%.
- Keyboard Lock is Chrome/Edge only. Pointer Lock `unadjustedMovement`: Chrome 81+, Safari 18.4+, Firefox 152+.
  CSS cursors above 128×128 are silently ignored; keep ≤ 32×32 CSS px with `image-set()` for DPR, overlay
  otherwise. There is no clipboard-change event in browsers.
- Cloudflare TURN: `POST rtc.live.cloudflare.com/v1/turn/keys/$ID/credentials/generate-ice-servers`, TTL ≤ 48 h,
  ports UDP 3478 / TCP 3478+80 / TLS 5349+443, $0.05/GB billed only server→client, shaping above ~50–100 Mbps
  or 5–10 kpps per allocation, analytics via GraphQL `callsTurnUsageAdaptiveGroups` (query one customer at a
  time).
- This dev box: RTX 2080 Ti, two monitors, Parsec Virtual Display Adapter installed, Rust 1.98.1. `agent/host`
  pins MSRV 1.77.2.
- On this machine use the Write tool, not heredocs, for files containing backslashes or regexes.

## Decisions index

D1–D17 in plan.md. Owner rulings are listed at the top of plan.md. Gate memos (G1 especially) are recorded in
`dev/active/swoop/spikes/` and summarised in the tasks.md log.

## Dependencies on other plans

- **Install-directory hardening release** (planned separately, ships first; its plan and the security review
  `research/review-2-security.md` are held privately until it ships, because this repository is public — ask
  the owner for them). swoop Task 2.6 adds `{app}\swoop` to the protected set; G4 requires the release to have
  shipped.
- **`dev/active/tri-platform-agent`**: cross-plan rules C2 (spawn path per OS) and C3 (heartbeat
  normalisation); its Wave 8 builds the macOS/Linux streamer backends on swoop Task 9.1's seams. C2's wording
  ("via `CreateProcessAsUser` with the session bundle on stdin") still holds; the token is the service's SYSTEM
  token retargeted to the console session, and the file fallback is dropped on Windows — amend C2 when
  tri-platform is next touched.

## Research index (`research/`)

`01-parsec-and-peers.md` (teardown + latency budget; large) · `02-browser-client.md` ·
`03-windows-host-stack.md` · `04-nat-turn-signaling.md` · `05-transport-bakeoff.md` ·
`06-chrome-h26x-receiver.md` · `draft-reviewed.md` · `review-1-latency.md` · `review-3-delivery.md` ·
`review-2-security.md` (present locally, **not committed** until the install-directory hardening release ships —
its accepted findings are already folded into plan.md D8–D12 and the task text).

## Next steps

1. Owner: start the long-lead items listed in plan.md.
2. Plan and ship the install-directory security release.
3. `/execute` Wave 0. Tasks 0.1–0.3 and 0.8–0.10 run on this dev box; 0.2 ends with the G1 memo, which the owner
   signs off before Wave 1 starts.
