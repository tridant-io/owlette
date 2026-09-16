# tri-platform agent — macOS handoff

**For:** the agent working on the MacBook Air (Apple Silicon, macOS 26). **Written:** 2026-09-15 by the Windows-side orchestrator.
**Why this file exists:** the plan lives in `dev/active/tri-platform-agent/`, which is gitignored and stays on the Windows box. Everything you need to work the macOS half is copied here verbatim, plus the state of the tree as it actually is after Waves 0–3. Treat this file as the spec; where it and the code disagree, say so in the log rather than guessing.

## 1. Branching and coordination (three platforms at once)

- `dev` is the integration branch and auto-deploys `dev.owlette.app`. **Never commit to `dev` or `main`.**
- `feat/tri-platform-agent` carries Waves 0–3 (Windows-verified; PR open against `dev`). It is the base for all platform work until it merges.
- Create **`feat/tri-platform-macos`** from `feat/tri-platform-agent`. Push it; open its PR against `dev` only after `feat/tri-platform-agent` has merged (rebase then). The Linux work runs on **`feat/tri-platform-linux`** from the same base, on the Windows box's Ubuntu VM.
- **Who owns which file** (so the two platform branches never fight):
  - macOS branch: `agent/src/osadapter/darwin.py`, `agent/packaging/macos/**`, `agent/build/macos/**`, `desktop/src-tauri/src/{capture,tcc}.rs` and the macOS arms of `service_ctl.rs`/`process_ctl.rs`/`startup_link.rs`/`shell_open.rs`, `desktop/src/components/PermissionBanner.tsx`, `dev/handoff/tri-platform-macos-log.md`, the macOS spike results.
  - Linux branch (Windows box): `agent/src/osadapter/posix.py` (**Task 3.1 — the shared POSIX arm — is being built on the Linux side first; pull it in when it lands, do not write your own**), `osadapter/linux.py`, `agent/packaging/linux/**`, `agent/build/linux/**`, the Linux arms of the same Rust files, `test/infra/**`.
  - Shared, single writer at a time (coordinate in the log before touching): `agent/src/osadapter/__init__.py` (the `get()` selector — add the `darwin` branch in one line), `agent/src/owlette_service.py` (Task 3.4 — the Linux side takes the shared wiring; you add only the macOS-specific arms after it lands), `agent/src/configure_site.py` (3.7 — same rule), `.github/workflows/agent-tests.yml` (the macOS `--ignore` list: remove entries only as they stop failing), `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/Cargo.toml`.
- Small, frequent commits on your branch are fine (the no-commit rule on the Windows box was about reviewing before things land in shared history; your branch is yours). Conventional commit messages (`feat(agent-macos): …`, `test(desktop): …`).

## 2. Setup on the Mac

```bash
git clone https://github.com/tridant-io/owlette.git && cd owlette
git fetch origin feat/tri-platform-agent && git checkout -b feat/tri-platform-macos origin/feat/tri-platform-agent
# python: 3.11 (uv is the fastest way)
uv venv .venv --python 3.11 && source .venv/bin/activate
uv pip install -r agent/requirements.txt pytest==9.1.1   # the sys_platform markers skip pywin32/wmi/pythonnet/HardwareMonitor
# web + desktop
(cd web && npm ci && npx fumadocs-mdx) ; (cd desktop && npm ci)
# rust + tauri: rustup stable, Xcode command line tools; `cargo check` in desktop/src-tauri
```

Test commands and what to expect **before** 3.1/3.2 land:

```bash
# agent suite — on macOS today it needs OWLETTE_DATA_ROOT (osadapter.get() raises off Windows until posix.py exists)
# and the same --ignore list the CI macos-15 leg carries (copy PYTEST_ADDOPTS from .github/workflows/agent-tests.yml)
OWLETTE_DATA_ROOT=/tmp/owlette-data PYTEST_ADDOPTS="$(sed -n '/macos-15/,/ubuntu-24.04/p' .github/workflows/agent-tests.yml | grep -o -- '--ignore=[^ ]*' | tr '\n' ' ')" \
  python -m pytest agent/tests/ -q -p no:cacheprovider
# Windows baseline for the same tree: 1489 passed / 5 skipped (2026-09-15).
(cd web && npx tsc --noEmit && npm test)            # 5168 tests on Windows
(cd desktop && npx vitest run)                        # 489
(cd desktop/src-tauri && cargo test && cargo clippy)  # the crate is still Windows-only until Task 4.1 gates the deps — expect it NOT to build on macOS until 4.1 is done; that is your first Rust task
```

The deploy hook (`.claude/hooks/deploy-agent.mjs`) mirrors `agent/src/*.py` into `C:\ProgramData\Owlette` on Windows; on a Mac it finds no install root and exits — inert. Do not modify `.claude/hooks/` or `.claude/settings.json` (owner rule).

## 3. Rules that apply on the Mac (from the repo's CLAUDE.md, the ones that bite here)

- Never import `firebase_admin`; never log OAuth tokens or key material; never touch `firestore.rules`.
- No new npm/pip/cargo packages without an owner ruling — **owner Q5** is exactly the ScreenCaptureKit/`image` crate question; ask before adding.
- Never raise a UAC-style prompt unattended: no `osascript … with administrator privileges`, no `sudo` from the daemon; privileged actions from the app go through the `ipc/` seam (decision 4).
- UI copy lowercase (proper nouns Windows/macOS/Linux keep their case), colours from tokens, `lucide-react` only.
- Reviews: every finding cites file:line and a failure path; a clean review is valid.
- Keep the AST import guard green: `agent/tests/unit/test_no_platform_imports.py` fails on a module-scope import of any Windows-only module, of `osadapter.win`, or of `tools_windows`, from a non-exempt file. `osadapter/darwin.py` and `osadapter/posix.py` are POSIX arms — they must not import pywin32 anything, and nothing outside `osadapter/__init__.py`'s `get()` should import them at module scope.

## 4. State of the tree you are starting from (Waves 0–3, Windows-verified)

- **`agent/src/osadapter/`** — `__init__.py` defines the 19-operation `typing.Protocol` `OSAdapter`, an `OPERATIONS` tuple, `get()` (returns `win` on `win32`, raises `NotImplementedError` elsewhere — **your `darwin` branch goes here**), `NotSupportedHere`, and PEP 562 `__getattr__` so call sites spell `osadapter.reboot(30)`. `win.py` is the Windows arm and the reference for signatures. The contract test `agent/tests/unit/test_osadapter_contract.py` is one shared body parametrised by adapter — add `pytest.param('darwin', marks=…)` rows; its assertions are OS-neutral by design.
- The Windows arm raises `NotSupportedHere` for the five service-bound rows (`session_env`, `spawn_as_user`, `run_job`, `capture_screen`, `launch_managed_process`); on POSIX those are real (decisions 4/5).
- **`capture_screen(path)` is sealed at the spec's spelling and must be widened by Task 3.2** to `capture_screen(monitor, *, executor, timeout_s)` returning `{outputDir, files, stdout}` (see the 3.2 block below — the dated correction is in the text).
- **Data root:** `shared_utils.get_data_path()` → `osadapter.data_root()`; `OWLETTE_DATA_ROOT` overrides (Python side only). macOS root is `/Library/Application Support/Owlette` (decision 4 mode table). `shared_utils` resolves `CONFIG_PATH` at import, so until `posix.py`/`darwin.py` exist, set `OWLETTE_DATA_ROOT` to import anything.
- **Identity (3.3):** `shared_utils.get_machine_id()` reads `config/machine_id` (seeded from the hostname on first read); key material is `osadapter.key_material()` — **macOS arm = `IOPlatformUUID`** (`ioreg -rd1 -c IOPlatformExpertDevice`), no hostname term; `stable_machine_id()` likewise. `secure_storage` migrates a pre-3.4 store once; on POSIX it writes `.tokens.enc` with `O_NOFOLLOW`+0600 and chmods — those flags are in place, unverified on a real POSIX filesystem: **verify them** (Task 3.3 Done-when (d)).
- **Platform normaliser:** `shared_utils.get_os_family_arch()` → `('macos', 'arm64')` on your machine; the cortex CLI pin id is `installer_metadata/cortex_cli_macos_universal` (decision 12: universal2).
- **Hoot tools (3.5):** `mcp_tools.py` is the cross-platform core; `tools_windows.py`/`tools_posix.py` are the arms, registered inside `mcp_tools._platform_handlers()`. `tools_posix.py` already carries the macOS arms of `get_event_logs` (`log show --style json`), `get_service_status`/`manage_windows_service` (`launchctl`), `check_pending_reboot` (`softwareupdate -l`), `run_command`, `get_gpu_processes`; `show_notification` is gated off until `osadapter.notify()` exists (3.2 un-gates it).
- **Roost destinations (3.8):** `destination_allowlist.default_roots('macos')` → `/Users/Shared/Owlette`; the POSIX dangerous-root arm covers the `/private/...` resolutions; `sync_assembler` chowns to `osadapter.console_user()`'s uid/gid on POSIX — that needs your `console_user()` (macOS: `stat -f%Su /dev/console`, `None` when it is `root`).
- **CI:** `.github/workflows/agent-tests.yml` runs the suite on `macos-15` with 18 `--ignore` entries (modules that import `owlette_service`/`display_manager`); Task 3.4 removes the transitional ones. `loc-metric.yml` prints the line delta on every PR.
- **Known one-liners left for the shared 3.4 sweep (Linux side):** `auth_manager.py` User-Agent still says `(Windows; …)`; `firebase_client._ensure_display_profile` imports `display_manager`/`nvapi_display` above its kill switch; `tray.rs` calls `COMPUTERNAME` "the name the fleet knows".
- **Design conflict to settle with the Linux side before 3.1:** the Windows arm implements `json_lock()` *as* `shared_utils._CrossProcessLock()`, while Task 3.1 says to give `_CrossProcessLock` a POSIX branch that calls `json_lock()` — one must own the lock. Recommendation: `_CrossProcessLock` owns it (named mutex on Windows, `flock` on `<data_root>/tmp/json.lock` on POSIX) and `json_lock()` just returns it, on all three OSes.

## 5. Your order of work

1. **Spike 0.2 (TCC capture) and the macOS half of 0.4 (LaunchAgent / login items)** — only a Mac can answer these, they gate 4.4, 5.1 and swoop's C2, and your machine is on **macOS 26** (newer than the plan's Sequoia assumptions): record the OS build in every result, and flag anything that differs from the Sequoia behaviour the plan describes. Write results into `dev/handoff/tri-platform-macos-log.md` in the "Done when" shape each spike names.
2. **Task 3.2 `darwin.py`** (against the Protocol; `posix.py` arrives from the Linux side — until then implement the darwin-specific rows and leave the shared ones to a thin import of `posix` once it exists).
3. **Task 4.1** (cargo gating — nothing in `desktop/src-tauri` builds on macOS until this), then **4.3/4.4** (job runner, capture + TCC surface) per spike 0.2's transport, then **4.2/4.5/4.7**.
4. **Task 5.1** (`.pkg`) once **Q4** (Apple Developer Program, both certificate types) is answered — signing and notarization cannot start without it; the unsigned build path can.
5. The shared tasks (3.4 macOS arms, 3.7 macOS bits, 4.6 CI legs) after the Linux side lands their shared halves — coordinate in the log.

## 6. Reporting back

Append dated entries to `dev/handoff/tri-platform-macos-log.md` (tracked on your branch): what landed, every deviation from the task text with the reason, what was verified on the real machine vs. only unit-tested, and open questions. The Windows-side orchestrator folds them into the plan's `tasks.md`. Commit the log with the code it describes.

## 7. Owner questions that affect you (answers pending unless stated)

- **Q4** Apple Developer Program entity / team id / the eight CI secrets — the owner is enrolling; nothing signed or notarized before it.
- **Q5** ScreenCaptureKit + `image` crates only if spike 0.2's shell path fails; **Q6** whether `capabilities.screenCapture: 0` on macOS would be shippable if both fail.
- **Q12** the `_owlette` group; **Q15** the Sequoia monthly re-prompt (spike 0.2 measures it); **Q16** MDM enrolment of target Macs.
- Decision 12 (resolved): universal2 build, any GPU; macOS min-OS floor is 14.0 in `distribution.xml` — your spike runs on 26, the floor still needs a Sonoma/Sequoia VM check.

---

## 8. Wire names (verbatim from the plan)

### Wire names (chosen once, lowercase)

| kind | name |
|---|---|
| machine doc fields | `osFamily` (`windows`\|`macos`\|`linux`), `osVersion`, `arch` (`x64`\|`arm64`) |
| capability keys | `capabilities.screenCapture`, `capabilities.packageInstall`, `capabilities.temps` (+ existing `displayRemoteApply`; swoop adds `capabilities.swoop`) — always written as separate dotted keys |
| TS type / helper | `MachineOsFamily`, `web/lib/machineOs.ts` → `supports()`, `osLabel()`, `pathHint()`, `shellName()` |
| python package | `agent/src/osadapter/` (`__init__`, `win`, `posix`, `darwin`, `linux`) |
| data-root override | `OWLETTE_DATA_ROOT` (retires the competing `PROGRAMDATA` / `XDG_DATA_HOME` test overrides) |
| persisted identity | `<data_root>/config/machine_id`, read via `shared_utils.get_machine_id()` |
| pairing preseed | `<data_root>/config/pairing.json` (or `OWLETTE_ADD=<phrase>`) |
| job seam job types | `capture`, `shell`, `notify`, `launch`; error code `desktop_not_running` |
| JSON lock | `<data_root>/tmp/json.lock` (`flock`) on POSIX; the named mutex stays on Windows |
| installer metadata doc ids | `latest_windows_x64`, `latest_macos_universal`, `latest_linux_x64`, `latest_linux_arm64` |
| cortex cli pin doc ids | `cortex_cli_windows_x64`, `cortex_cli_macos_universal`, `cortex_cli_linux_x64` |
| installer route param | `?platform=windows_x64` (default) |
| launchd / systemd ids | `app.owlette.agent`, `app.owlette.desktop`, `app.owlette.update`; `owlette-agent.service`, `owlette-desktop.service` |
| POSIX groups | `_owlette` (macOS), `owlette` (Linux) |
| tool definition fields | `os?: OsFamily[]`, `osNotes?` |
| pytest marker | `@pytest.mark.windows` |
| Apple CI secrets (eight) | `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_INSTALLER_CERT_P12_BASE64`, `APPLE_INSTALLER_CERT_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_BASE64` |

---

## 9. Decisions this half of the plan rests on (verbatim)

1. **`agent/host` is not ported and never compiled for POSIX. Zero Rust changes to that crate.** launchd/systemd
   own supervision; `registration.rs` (508 lines) is pure SCM/NSSM migration with no analogue; `supervisor.rs`
   stop-grace/kill-wait become one directive each. `agent/host/src/paths.rs:56` already runs `owlette_runner.py`,
   so the POSIX `ExecStart` target exists today. *Rejected:* `#[cfg(windows)]`-gating the SCM code — taxes five
   files, adds a cargo leg per OS, forces a `+crt-static` decision on a release profile frozen by the
   Defender-ML false positive (`agent/host/Cargo.toml:40-58`), and collides with the no-workspace rule at
   `Cargo.toml:19-21`.

2. **On POSIX the init system starts the desktop app; the daemon never launches it.** Retires, for POSIX, the
   whole token ladder (`_enable_privileges` `:2576-2625`, `_get_token_from_user_process` `:2626-2707`,
   `_refresh_user_token` `:2708-2776`, `_get_elevated_install_token` `:2777-2828`, `launch_desktop_app_as_user`
   `:2885-2934`, `display_manager._clone_user_token_from_explorer` `:1539-1594`) with zero replacement code.
   `tmp/tray.pid` keeps the same location, format and write-then-rename semantics on all three; the liveness check's image-name guard (`shared_utils.DESKTOP_EXE_NAME`, compared at `shared_utils.py:924` and `owlette_service.py:2135`) becomes a per-OS value (`owlette-desktop.exe` / `owlette-desktop`) through a 16th adapter operation, `desktop_process_name()`. *Fallback if spike 0.4 fails:* daemon spawns the app
   through the decision-4 console-user path, +15 lines.

3. **The adapter is `agent/src/osadapter/` — never `agent/src/platform/`.** `agent/tests/conftest.py:14` and
   `owlette_runner.py:17` put `agent/src` at `sys.path[0]`, and `mcp_tools.py:14`, `shared_utils.py:8`,
   `secure_storage.py:63`, `configure_site.py:725` import stdlib `platform`; a package named `platform` shadows
   it and does not build. Surface: 19 operations (including `json_lock()`, `desktop_process_name()`, `shutdown(delay)`, `cancel_reboot()` and `streamer_capable()`),
   ~1,020 lines across five files.
   Anything capability-gated gets **no adapter row**. *Rejected:* the 26-row `PlatformAdapter` table from the
   inventories — two thirds of its rows return "unsupported" on two of three platforms.

4. **Managed process launch stays in the daemon on all three OSes.** `launch_process_as_user`
   (`owlette_service.py:3034-3263`) is untouched on Windows: the installer path needs
   `_get_elevated_install_token` (LocalSystem only), app-owned supervision is orphaned when the app dies, and
   2,252 lines of tests (`test_kill_safety`, `test_inherit`, `test_launch_failed`, `test_process_lifecycle`)
   pin its failure semantics. POSIX arm ~90 lines in `osadapter`: resolve the console user, build the session
   env, spawn as that user and never as root. macOS uses root-invoked `launchctl asuser <uid>` wrapping
   `sudo -u <user>` — `asuser` adopts the session's bootstrap namespace only, it does **not** drop privileges.
   Linux spawns via `subprocess.Popen(argv, user=uid, group=gid, extra_groups=<the kiosk user's supplementary gids>, start_new_session=True, env=session_env)` — no `preexec_fn`, which CPython documents as unsafe in a threaded process, and this daemon runs a thread pool plus a dozen threads — with the session env lifted from the
   graphical session leader's `/proc/<pid>/environ` (`DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`,
   `DBUS_SESSION_BUS_ADDRESS`, `XDG_SESSION_TYPE`, `HOME`/`USER`/`LOGNAME`) and never a hardcoded cookie path
   — GDM, LightDM and SDDM differ, and `DISPLAY` without `XAUTHORITY` gives root "cannot open display". A
   managed macOS `exe_path` ending in `.app` resolves to `Contents/MacOS/<CFBundleExecutable>` (stdlib
   `plistlib`) before spawn; `open -a` is never used for a managed process — LaunchServices reparents it to
   launchd and leaves no supervisable pid. On Linux the managed child inherits the daemon unit's mount
   namespace and `NoNewPrivileges`; a kiosk app that needs a setuid helper is out of scope, documented.
   Supervision stays psutil PID-based. **POSIX data-root modes** (applied by `postinstall`/`postinst`,
   mirrored in Tasks 5.1/5.2): data root 0750 root:`_owlette`/`owlette` — the dedicated group owns the root
   so the kiosk user gets group traversal (wheel/root would leave other=--- and block even `stat` on `ipc/`),
   and the root stays non-group-writable so `.tokens.enc` (0600 root) cannot be replaced; `config/`, `tmp/`,
   `ipc/` 0770 root:<group>; `logs/`, `cache/` 0750 root:<group>; `config/config.json` and `tmp/json.lock`
   0660 root:<group>, the lock pre-created at install rather than by whichever process wins. The desktop app
   runs as the kiosk user and is a first-class writer of `config.json`, `app_states.json`, `restart.flag`,
   `gui.pid` and `tray.pid`. `ipc/cortex_*` is a kiosk-user→root channel by design (hoot runs as the console
   user), so those directories stay group-accessible; the drain is gated on `is_cortex_enabled()` so with
   hoot off the group-writable queue cannot command the daemon. Round-2 audit additions: `ipc/swoop/` is 0770 root:<group> with its files 0640 root:<group> — the runner is the kiosk-user app and must read then unlink the bundle. `.tokens.enc` 0600 root is daemon-created (Task 3.3, `os.open(…, O_NOFOLLOW, 0o600)` + `chmod`), not part of the install-time table: launchd and systemd run the daemon at umask 022, so a bare `open()` would leave it 0644 inside the group-traversable root. The four privileged app actions — pair, leave, restart, reboot — are requests the app drops into the 0770 `ipc/` seam for the daemon to execute (the `ipc/cortex_*` pattern), never an elevation prompt on a kiosk that has no admin user; on Linux `systemctl start|stop` from the tray is allowed by a shipped polkit rule scoped to `owlette-agent.service` and group `owlette`. A managed macOS `.app` is launched with a disclaiming `posix_spawn` (`responsibility_spawnattrs_setdisclaim`, ~40 lines in `darwin.py`) so the customer's app owns its own TCC grants instead of inheriting owlette's; `launchctl asuser <uid> open -a` is the documented fallback for apps that must be supervised by bundle-id lookup. The reboot/shutdown subsystem (`shutdown /r|/s|/a` + `wevtutil`, four call sites) is re-pointed onto `reboot(delay)` / `shutdown(delay)` / `cancel_reboot()` with real countdowns on POSIX. Sleep and display blanking are disabled at install time (`pmset -a sleep 0 displaysleep 0 disksleep 0`; `systemctl mask sleep.target suspend.target hybrid-sleep.target` + the GNOME power setting), the POSIX equivalent of `configure_power_plan`. Round-3 audit additions: an `ipc/` request from the app is honoured only when the file is owned by the uid `console_user()` resolves, carries no group or world write bit, and holds the one-shot nonce the daemon last wrote to a root-owned 0640 `ipc/request_nonce`; anything else is unlinked and logged; `leave` is not a seam verb at all (deregistration is an uninstall-time root operation or a dashboard command), and `restart`/`reboot` are rate-limited to one per five minutes with an audit row each — the same group-writable directory whose cortex queue is gated. macOS payload layout: `/Library/Application Support/Owlette/runtime/{python,agent/src,VERSION,uninstall.sh}`, root:wheel 0755, outside any admin-writable directory; the LaunchDaemon's `ProgramArguments` point there, and `/Applications/owlette.app` holds only the GUI and the TCC-bound streamer — deleting the bundle degrades GUI jobs to `desktop_not_running` and never stops the daemon. Desktop-unit enablement is scoped to the kiosk user (a symlink in that user's `~/.config/systemd/user/graphical-session.target.wants/`, `systemctl --global enable` only when the user cannot be resolved) and the unit carries `ConditionGroup=owlette`, because `--global` also starts it in the GDM greeter's session manager. Tray service control on Linux calls `systemctl` directly as the kiosk user — the D-Bus action `org.freedesktop.systemd1.manage-units` is what the shipped polkit rule allows; `pkexec` checks a different action and would prompt — and on macOS it drops a `restart` request into the seam; there is no `osascript … with administrator privileges` anywhere. `logs/swoop/` is 0770 root:<group>, the one log directory a kiosk-user process writes.

5. **On POSIX, GUI jobs (capture, notify, shell-in-session, launch) execute in the resident Tauri app
   (`desktop/src-tauri/src/jobrunner.rs`, `#[cfg(unix)]`). On Windows nothing changes.** On Sequoia+ a
   LaunchDaemon cannot capture at all, TCC Screen Recording attaches to a signed **bundle**, MDM cannot
   pre-grant, and `persistent-content-capture` is a restricted entitlement — so the only place a macOS capture
   can legally happen is inside `owlette-desktop.app`. Jobs fail **closed** with a typed `desktop_not_running`
   error the dashboard renders as copy, never a 20 s hang. *Rejected:* moving **Windows** capture into the app
   — a Windows machine with the desktop app killed would lose `capture_screenshot` (public API, hoot tool,
   talons `visual_check`, CLI, crash path). *Rejected as settled:* shelling `/usr/sbin/screencapture` from the
   app — TCC responsibility for a spawned CLI child is not automatically the calling bundle; that is spike 0.2's
   go/no-go, with an in-process ScreenCaptureKit binding (+250, one crate, owner question 5) as the fallback.
   **This is also the swoop spawn path on POSIX** — see `context.md` → cross-plan decision C2 for the three
   conditions a child must meet to inherit the bundle's TCC grant.

6. **Two gating fields, one vocabulary: `osFamily` for static OS facts, the existing `capabilities.*` map for
   per-machine grants.** Heartbeat gains `osFamily` (`windows`|`macos`|`linux`), `osVersion`, `arch`
   (`x64`|`arm64`) computed **once at startup** through the normalisation table in `context.md` C3, plus
   integer `capabilities.screenCapture`, `capabilities.packageInstall`, `capabilities.temps` next to the
   shipping `capabilities.displayRemoteApply: 1` (`firebase_client.py:1538`). Named `osFamily`, not `platform`
   — `authorizedPlatformHandler` / `PlatformHandlerContext` own that word across 7+ routes. *Rejected:*
   `osFamily`-only gating (cannot express "this mac has not granted screen recording"); a new
   `platformFeatures` matrix (a third vocabulary).

7. **TCC / portal grant state is a product surface.** `desktop/src-tauri/src/tcc.rs` probes screen recording,
   accessibility and portal availability, renders a first-run banner with a one-click deep link to the right
   settings pane, and publishes the result into the seam so the daemon flips `capabilities.screenCapture`
   within one heartbeat. The dashboard shows "screen recording not granted" instead of a black frame.

8. **Machine identity and Fernet key derivation are fixed together, with a re-encrypt migration.**
   `secure_storage.py:63-70` keys on `f"{machine_id}:{hostname}:owlette-agent"` with `hostname = platform.node()`,
   and `machine_id = socket.gethostname()` is the Firestore doc id at seven call sites (`shared_utils.py:121-122`,
   `firebase_client.py:152`, `auth_manager.py:139`, `owlette_cortex.py:506`, `owlette_service.py:1727,1793,2495-2496`,
   `configure_site.py:553`). A macOS `Name.local` is DHCP-mutable: a rename both forks the document **and**
   bricks `.tokens.enc`. Fix in one task: persist `config/machine_id` seeded from the current hostname on
   upgrade (no live Windows doc re-keys), read through a new `shared_utils.get_machine_id()` at every call
   site; derive key material from `IOPlatformUUID` / `/etc/machine-id` / `MachineGuid` with no hostname term;
   ship a first-run re-encrypt that reads under the old derivation, rewrites under the new, leaves the
   original intact on failure and keeps a v1 copy for one minor.

12. **Runs wherever the OS runs (owner requirement 2026-09-13): one build per architecture per OS, any GPU.**
    Windows x64 (Windows on ARM runs it under x64 emulation, documented, not a native build); macOS **universal2**
    (arm64 + x86_64 in one `.pkg` — `lipo`'d Tauri app, two python-build-standalone payloads, `hostArchitectures`
    lists both); Linux `.deb` for **x86_64 and arm64** (Ubuntu 24.04 and Raspberry Pi OS Bookworm, which is
    Debian-based, so the same package and maintainer scripts apply). Capture on Linux is X11 in v1: a Wayland
    session publishes `capabilities.screenCapture: 0` with the documented switch (Pi OS Bookworm defaults to
    Wayland; `raspi-config` → X11 is the one-line fix), and PipeWire/portal capture is the v1.1 item. No GPU
    requirement anywhere: hardware encoders are used where present and every OS has a software floor (swoop
    decision 12). *Superseded:* the earlier "macOS arm64 only, Linux x86_64 only" scoping (~700 lines and ~3 weeks
    saved) — the owner's requirement is that anything that runs the OS runs owlette, down to a Raspberry Pi and up
    to a video server. rpm stays a non-goal (`.deb` covers Debian, Ubuntu and Pi OS).

17. **Notarize in its own job that hands a stapled artifact to the digest job.** `build-installer.yml:21-25`
    forbids signing after the SLSA digest; `:58` caps the job at 30 min; `notarytool` is asynchronous. Three
    build jobs (each signing/notarizing/stapling) → one digest+release job looping the existing
    `"<hex>␣␣<filename>"` construction over n subjects. Every Mach-O in the macOS payload is signed inside-out
    (bundled interpreter, every `.so`) with `com.apple.security.cs.disable-library-validation`. Windows stays
    unsigned (`build-installer.yml:17`) until the Azure Artifact Signing work is funded.

22. **Pairing is ported, with a preseed for bulk deploy.** `configure_site.py` (1,057 lines) is the add-a-machine
    entry point and is Windows-shaped in four places plus the hostname-minted doc id; it routes through
    `osadapter`, and the `/ADD=<phrase> /SILENT` bulk-deploy analogue is a preseed file read by
    `postinstall`/`postinst` (Task 3.7).

23. **swoop's macOS/Linux streamer backends are this plan's Wave 8** (+2,825 firm, up to 3,825 — low
    confidence, the only wave in either plan whose adds no spike measures; swoop prices one Windows backend at
    ~2,400). They depend on the job runner, on bundle signing (same Team ID, in-bundle path, `posix_spawn`
    ancestry — `com.apple.security.inherit` is an App Sandbox key, not a TCC lever, and the attribution is
    undocumented behaviour spike 0.2 measures) and on the packaging built here; the swoop plan's Wave 9 leaves
    the `#[cfg]` seams for them.


---

## 10. Cross-plan rules C2 and C3 (verbatim from context.md)

**C2 — swoop's spawn path per OS.** Windows: the service spawns `owlette-swoop.exe` via `CreateProcessAsUser`
with the session bundle on stdin (swoop decision 3). macOS: the daemon writes a `launch` job and the resident
desktop app spawns the streamer as its **child**, which inherits the bundle's TCC Screen Recording /
Accessibility responsibility **only if** the streamer binary lives inside `owlette.app/Contents/MacOS/`, is
signed with the same Team ID and the app's hardened-runtime entitlements, and is spawned by the app via
`posix_spawn` — never launchd / `launchctl asuser`, which would make the child its own responsible process
and prompt again. `com.apple.security.inherit` is an App Sandbox key, not a TCC lever; the attribution is
undocumented behaviour, and spike 0.2 measures whether it holds. Linux: the app spawns the child
with the X11 session env from 3.1; v1 is X11-only per spike 0.3 (a Wayland path would pass the PipeWire
remote fd over the job seam — not exercised in v1). On POSIX the session bundle travels in the root-owned
0770 `ipc/jobs` directory (group `_owlette` on macOS, `owlette` on Linux — never `staff`, never a
users-modify path). If the desktop app is not running the job times out with `desktop_not_running` and
swoop's session store records it as `endReason`. On POSIX the `launch` job in the 0770 `ipc/jobs` directory carries no secret — only argv and a `stdin_path` pointing at a `0640 root:<group>` file in `<data_root>/ipc/swoop/` (0770 root:<group>, so the kiosk-user runner can read it and unlink it after EOF); group `_owlette`/`owlette`, never `staff` (Task 4.3). The runner accepts a `stdin_path` only when it resolves inside `<data_root>/ipc/swoop/`, `st_uid == 0` and `st_mode & 0o022 == 0`.

**C3 — `osFamily`/`arch` heartbeat fields.** Whichever task lands first writes them (swoop 2.2 or this plan's
6.1); the other adds only what is missing (`osVersion`, `capabilities.screenCapture|packageInstall|temps`).
Normalisation is fixed here so neither task can get it wrong: `osFamily = {'win32':'windows',
'darwin':'macos','linux':'linux'}[sys.platform]`; `arch = {'AMD64':'x64','x86_64':'x64','arm64':'arm64','aarch64':'arm64'}[platform.machine()]`,
unknown → the raw string, logged once; a table-driven unit test pins all six mappings. **Absent is Windows:**
every reader resolves a missing or unrecognised `osFamily` to `'windows'` (`machine.osFamily ?? 'windows'`) —
the whole pre-3.4 fleet has no such field and keeps every affordance it has today; only a machine that
positively declares `macos` or `linux` loses one. Capability keys are written as **separate dotted paths**
(`capabilities.swoop`, `capabilities.screenCapture`) — `_upload_metrics` uses `update()` with dot notation,
and a whole-map `capabilities: {...}` write silently drops `displayRemoteApply`
(`firebase_client.py:1525-1526`, `:1538`). There is no disk-IO capability key: per-volume disk IO is
presence-derived. `capabilities.swoop` is `1` iff the streamer binary is present **and** `osadapter.streamer_capable()` (Windows: true; Linux: X11 session; macOS: Screen Recording granted), recomputed on the same tick as `capabilities.screenCapture`.

---

## 11. The task blocks (verbatim from tasks.md, including every dated 2026-09-15 correction)

Read the `Do`, `Done when` and any `Status`/`addendum` lines. Line numbers are hints anchored at `a49ed4cc`; re-resolve by symbol.

- [ ] **Task 0.2: macOS capture + TCC spike** (gates waves 3, 4, 5, 8)
  - Files: `dev/active/tri-platform-agent/spikes/macos-tcc.md` (throwaway branch for code)
  - Do: on a real Sequoia box, test in order: (a) an ad-hoc-signed Tauri `.app` started by a LaunchAgent, granted Screen Recording, shelling `/usr/sbin/screencapture -x -t jpg` — **record whether TCC attributes the capture to the calling bundle or to `screencapture`**; (b) the same app using an in-process ScreenCaptureKit binding; (c) a LaunchDaemon-spawned `python … mss` (expected to fail — record it). For whichever succeeds, re-sign the app with the same team id, replace it, reboot, re-capture. Also record: (i) a child binary placed inside `owlette.app/Contents/MacOS/`, signed with the same Team ID, run under hardened runtime with no App Sandbox keys — does it inherit the bundle's Screen Recording and Accessibility responsibility, and does the answer differ between a `posix_spawn` from the app and a `launchctl asuser` spawn from the daemon? (`com.apple.security.inherit` is an App Sandbox key and plays no part in TCC.) This decides swoop's macOS spawn path, cross-plan decision C2. (ii) the Sequoia 30-day screen-recording re-authorisation behaviour unattended: does the prompt fire, does it end an in-flight ScreenCaptureKit stream, does a PPPC `ScreenCapture` profile or `forceBypassScreenCaptureAlert` suppress it (Q15). (iii) the measured line count of the capture and encode modules for the Wave 8 ledger. Also answer the mirror question: which process is TCC-responsible for a managed `.app` launched by the daemon, and does a disclaiming `posix_spawn` (`responsibility_spawnattrs_setdisclaim`) restore its own identity — the customer's app, not owlette, must own its Screen Recording and Accessibility grants.
  - Done when: the file records, for each of (a)(b)(c): granted/denied, time-to-first-jpeg, and whether the grant survived an app replacement **and** a reboot; plus the child-process responsibility answer.
  - Go/no-go: (a) works → `capture.rs` ~90 lines, no new crate. (a) fails, (b) works → `capture.rs` ~250 lines + one crate, owner Q5. Both fail → macOS ships `capabilities.screenCapture: 0` (owner Q6).
  - Depends on: nothing.

- [ ] **Task 0.4: user-unit spike** (gates decision 2, wave 4)
  - Files: `dev/active/tri-platform-agent/spikes/user-session.md`
  - Do: prove a LaunchAgent and `systemctl --global enable` start a stub Tauri app on auto-login after reboot; that `tauri-plugin-single-instance` (D-Bus name on Linux, `NSDistributedNotificationCenter` on macOS) folds a second launch; that `tauri-plugin-notification` delivers from a signed bundle; and that root can spawn a GUI child as the console user on both. Record the tested image's display manager, session type (`XDG_SESSION_TYPE`) and DE, and the exact env dict the GUI child needed (`XAUTHORITY` above all — GDM does not write `~/.Xauthority`).
  - Done when: `tmp/tray.pid` exists after reboot on both OSes, a notification renders, and a root-spawned GUI child renders. after `systemctl --global enable owlette-desktop` and a reboot, `systemctl --user status owlette-desktop` reports `active (running)` — not `condition failed` — on the display manager recorded in the spike, and the spike records whether the DE imports `DISPLAY`/`XAUTHORITY` into the user manager before `graphical-session.target` starts. on the same image a second account and the display manager's own user show `condition failed` for the desktop unit, not a five-second restart loop; on macOS the spike records whether both labels appear in Login Items & Extensions after a `.pkg` install, whether a standard user can toggle them off, and whether the off state survives a reboot and `launchctl kickstart`.
  - Go/no-go: pass → decision 2 as written. Fail on Linux → the daemon spawns the app via the decision-4 console-user path, +15 lines; `dbus-user-session` may become a `.deb` dependency.
  - Depends on: nothing.

- [ ] **Task 0.6: notarization timing spike** (gates wave 5)
  - Files: `dev/active/tri-platform-agent/spikes/notarize.md`, scratch workflow branch, `scripts/env-manifest.json` (register the eight Apple secrets: `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_INSTALLER_CERT_P12_BASE64`, `APPLE_INSTALLER_CERT_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_BASE64`)
  - Do: with the Apple Developer Program enrolment from Q4 in hand (this task cannot start without it — a stub `.pkg` must be Developer-ID signed to be notarized), submit a **representative** signed `.pkg` — an arm64 python-build-standalone runtime with the POSIX-installable subset of `agent/requirements.txt` pip-installed into it (skip `pywin32`/`wmi`), every Mach-O signed inside-out with `--options runtime --timestamp` and the Developer ID Application identity, the `.pkg` signed with the Developer ID Installer identity — not a stub: the notary service rejects any nested unsigned executable and a stub predicts neither upload nor scan time to `notarytool --wait` five times from a GitHub macOS runner; measure submit→staple p50/p95 against `build-installer.yml:58`'s 30-minute cap and the sign-before-digest constraint at `:21-25`.
  - Done when: p50/p95 recorded and the job graph drawn (three build jobs → one digest+release job); the eight secrets exist in the manifest with `must-match` class where applicable.
  - Go/no-go: p95 < 20 min → notarize inside a dedicated 60-minute macOS build job. Over → notarization is a manual runbook step and SLSA subjects are computed on the stapled bytes afterwards.
  - Depends on: owner Q4 answered (enrolment + a stable team id).

- [ ] **Task 3.1: `osadapter/posix.py`**
  - Files: `agent/src/osadapter/posix.py` (new), `agent/src/shared_utils.py` (`_CrossProcessLock` `:44-96`, tray-liveness guard `:924`), `agent/src/owlette_service.py` (tray-liveness guard `:2135`)
  - Do: shared POSIX implementations: data root, console-user resolution, session env (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`), `spawn_as_user`, `launch_managed_process` (`Popen(user=, group=, extra_groups=, start_new_session=True, env=)` — no `preexec_fn`, unsafe in a threaded daemon), job-file `run_job` client for the desktop job runner (typed `desktop_not_running` on timeout), `desktop_process_name()` → `owlette-desktop` with both tray-liveness comparisons (`shared_utils.py:924`, `owlette_service.py:2135`) re-pointed at the 2.1 operation, one helper called from `ensure_data_directories` that applies decision 4's data-root mode table (`ipc/` 0770 root:<group>), and `json_lock()` as `flock(2)` on `<data_root>/tmp/json.lock` — give `shared_utils._CrossProcessLock` a POSIX branch that calls it (the Rust side lands in 4.3; both writers must move together or config writes race as lost updates). Resolve `XAUTHORITY` from the graphical session leader's `/proc/<pid>/environ` (leader from `loginctl show-session -p Leader`), falling back to `$HOME/.Xauthority` only when the leader carries none; `console_user()` returns None when there is no GUI session (macOS `stat -f%Su /dev/console` is `root`; Linux has no active graphical `loginctl` session) and every caller treats None as "no interactive session". `ensure_data_directories` creates `ipc/swoop/` 0770 root:<group> beside `ipc/`. `ensure_data_directories` also creates `logs/swoop/` 0770 root:<group> — the one log directory a kiosk-user process writes.
  - Done when: `test_osadapter_contract.py` passes on macos-15 and ubuntu-24.04, including a two-process concurrent-writer test on the JSON lock; a root-spawned `xdpyinfo` opens the console user's display on the ubuntu leg; tray liveness passes on a POSIX box running `owlette-desktop`. a managed launch issued while the alert, config-push and roost-scrub threads are running returns a live pid 100/100 times; `systemctl restart owlette-agent` / `launchctl kickstart -k system/app.owlette.agent` with a managed process running leaves that pid alive and the agent re-adopts it (negative control: a unit/plist without `KillMode=process` / `AbandonProcessGroup` fails this).
  - Depends on: 2.1, 0.4.

- [ ] **Task 3.2: `osadapter/darwin.py` and `osadapter/linux.py`**
  - Files: `agent/src/osadapter/darwin.py` (new), `agent/src/osadapter/linux.py` (new), `agent/src/screenshot_capture.py`, `agent/src/machine_commands.py`, `agent/src/osadapter/win.py`, `agent/src/shared_utils.py` (metric helpers), `agent/src/sync_assembler.py`, `agent/tests/unit/test_sync_assembler.py`
  - Do: `launchctl` vs `systemctl` service control; `IOPlatformUUID` vs `/etc/machine-id`; `system_profiler SPApplicationsDataType` vs `dpkg-query`; `softwareupdate -l` vs `/var/run/reboot-required` (both off-loop); `osascript` vs the notify job; `shutdown -r` vs `systemctl reboot`; capture transport per spikes 0.2/0.3. Linux: a `session_type()` probe (`XDG_SESSION_TYPE`, falling back to `WAYLAND_DISPLAY`/`DISPLAY` presence); `capture_screen()` raises `unsupported_on_platform` on a non-x11 session instead of returning a black frame. Wire the surviving capture pipeline to the adapter without a new module: **first widen the seam 2.1 sealed** — Task 2.1 spelled the operation `capture_screen(path)` and its contract test pins that signature, but neither arm can honour it: change the Protocol row to `capture_screen(monitor, *, executor, timeout_s)` returning the `{outputDir, files, stdout}` dict `capture_in_user_session` parses, update the contract test and the Windows arm in the same change (correction 2026-09-15, from the 2.1 review) — then move `_build_capture_code()` (`screenshot_capture.py:65-91`) into `osadapter/win.py`, whose arm keeps today's `execute_in_user_session('python', code, trusted=True)` round-trip byte for byte; the POSIX arm submits a `capture` job through `run_job` and returns the same `{outputDir, files:['screenshot.png'], stdout:'monitors=N'}` dict so `capture_in_user_session`'s parsing is unchanged. macOS: `resolve_exec_target(exe_path)` for `.app` bundles (decision 4), applied at `find_running_process_by_exe`, the `graceful_terminate` callers and the launch-path validation. Give the heartbeat's Windows-shaped metric helpers POSIX arms in place (a `sys.platform` branch, not Protocol rows): `get_cpu_name` (`sysctl -n machdep.cpu.brand_string` / `/proc/cpuinfo`), `_detect_default_gateway` (`route -n get default` / `ip route show default`), `_run_ping` (`ping -c 4 -W 1`, parsing `rtt min/avg/max`), and a module-level `_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)`. Roost on POSIX: after `os.replace`, the assembler sets 0755 when the first bytes are `#!`, `\x7fELF` or a Mach-O magic and 0644 otherwise (no `mode` field in the v1 schema — the browser uploader cannot supply one). Both POSIX adapters implement `notify()` by submitting a `notify` job through `run_job` (typed `desktop_not_running` when the app is down) — no `osascript`, which cannot display from a daemon. **Addendum 2026-09-15 (from Task 3.5):** once `osadapter.notify()` exists, remove `show_notification` from `mcp_tools.WINDOWS_ONLY_TOOLS` and give `tools_posix` a `show_notification` arm that calls it — Task 3.5 gated the tool because the operation had no POSIX arm yet. `hardware_profile.collect_dynamic_metrics`'s mount reconstruction uses the id verbatim when it starts with `/` and appends the separator only on the drive-letter branch, so volumes other than `/` stop dropping out of the payload.
  - Done when: each adapter passes the shared contract body on its own CI leg; a Wayland session reports `x11`/`wayland` correctly and captures refuse with the typed error; a real `.app` launches, reports a live pid, survives a crash-restart and terminates gracefully; the assembler test covers both mode branches. every id in `profile.disks` has a matching `disks[id]` entry in the metrics payload on both POSIX legs.
  - Depends on: 3.1.

- [ ] **Task 3.4: service wiring on POSIX**
  - Files: `agent/src/owlette_service.py`, `agent/src/owlette_runner.py`, `agent/src/installer_utils.py`, `agent/src/shared_utils.py` (`graceful_terminate`, `get_python_exe_path`), `agent/tests/unit/test_update_artifact_guard.py` (new)
  - Do: gate the remaining pywin32 imports behind `osadapter`; guard `signal.signal(signal.SIGBREAK, …)` at `owlette_runner.py:286` behind `sys.platform == 'win32'` — SIGTERM is already registered at `:285` and is what launchd/systemd deliver, and the bare `SIGBREAK` attribute raises before `main()` on POSIX; make `start_scm_stop_watcher()` (`owlette_service.py:1616`) a Windows-only no-op and import `win32service` lazily inside `_query_scm_stop_requested`; POSIX self-update via a transient unit (`apt-get install --simulate <path>.deb` as a pre-check (typed `update_unsatisfiable` on failure, current version keeps running), then `systemd-run --unit=owlette-update --collect --setenv=DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y --allow-downgrades <path>.deb` with `dpkg --configure -a` as recovery — `dpkg -i` resolves no dependencies and Wave 8 adds `libva` ones; a held dpkg lock is a deferred, retryable failure / `launchctl submit -l app.owlette.update -- /usr/sbin/installer -pkg <path> -target /` (the label plan.md reserves), so the updater is a launchd job rather than a child in the daemon's process group that `bootout` kills) **on a worker thread, never inline in the command callback**; add the per-family magic checks (`xar!`, `!<arch>`) alongside the existing `MZ` at `:5022-5026`; refuse any artifact not matching the agent's own family. `graceful_terminate()`: skip the `find_windows_by_pid`/`WM_CLOSE` branch off Windows (imports inside it) so POSIX falls through to `terminate()` → `wait` → `kill()`; `get_python_exe_path()` resolves per OS. Gate `_process_cortex_ipc_commands` on `shared_utils.is_cortex_enabled()` so the group-writable `ipc/cortex_commands` queue cannot command the root daemon with hoot off. Lift the 1 MB floor + magic check out of `handle_firebase_command` into `installer_utils.verify_artifact_family(path, os_family)` so it is testable. Re-point the four hardcoded `subprocess.run(['shutdown', …])` sites in `owlette_service.py` (`:6497` scheduled fire, `:6875` manual reboot, `:6914` manual shutdown, `:6932` cancel) onto `osadapter.reboot(delay)` / `shutdown(delay)` / `cancel_reboot()`; POSIX arms use a real countdown (`shutdown -r +1` / `shutdown -h +1`) so `rebootCancellable: true` stays truthful, cancel is `shutdown -c` on Linux and SIGTERM to the recorded `shutdown` pid on macOS (BSD `shutdown` has no `-c`), and `cancel_reboot()` returns success/failure. Give `_clean_shutdown_in_event_log` (`:6611`) a third state — no corroboration source on this platform — so `_classify_startup_session` does not downgrade a POSIX boot to `unexpected_reboot`. `get_python_exe_path()` resolves `<install>/python/pythonw.exe|python.exe` on Windows, `/opt/owlette/python/bin/python3` on Linux and `/Library/Application Support/Owlette/runtime/python/bin/python3` on macOS.
  - Do (addendum 2026-09-15, from the 2.4 review): Task 2.4 landed the three-OS matrix with every leg gating, but the macOS and Linux legs carry per-leg `PYTEST_ADDOPTS` `--ignore` entries for the test modules that import `owlette_service` at module scope (`test_service_shutdown.py`, `test_service_status_file.py`, plus any module the first CI run shows); **this task removes those transitional entries** in `.github/workflows/agent-tests.yml` once `import owlette_service` succeeds off Windows — the three display entries (`test_apply_topology`, `test_display_helper`, `test_display_manager`) are permanent (never-ported per the guard's grandfather list).
  - Done when: `import owlette_service` succeeds on all three CI legs, the agent completes a full main loop as root on macOS and Ubuntu, and a self-update completes without blocking `handle_firebase_command` (asserted by a test that times the callback); a table-driven test feeds `MZ`, `xar!` and `!<arch>` payloads under each `osFamily` and the six mismatches are refused before any execution (negative control: removing the family arm fails the test); with cortex disabled, a JSON file hand-written into `ipc/cortex_commands` as the kiosk user is never executed. a scheduled reboot fires and a cancel aborts it on both POSIX legs; an upgrade whose `.deb` declares a missing `Depends:` either completes by pulling it or leaves the installed version running and reports `update_unsatisfiable` (negative control: the same test fails under `dpkg -i`).
  - Depends on: 3.2, 3.3.

- [ ] **Task 3.7: pairing on POSIX (`configure_site.py`)**
  - Files: `agent/src/configure_site.py`, `agent/tests/unit/test_configure_site.py`, `agent/tests/unit/test_configure_site_headless.py`
  - Do: the add-a-machine flow is Windows-shaped in four places — `win32clipboard` copy of the phrase (`:79-90`), `SetConsoleMode` (`:60-65`), `owlette-host.exe` service control (`:487-531`), `shutdown /r` (`:866-871`) — and mints the Firestore doc id from the hostname at `:553`. Route clipboard/notify through `osadapter` (or drop the clipboard copy off Windows), service control through `osadapter.service_control`, reboot through `osadapter.reboot`, and the doc id through `shared_utils.get_machine_id()`. Browser-open must happen in the user session (`open` / `xdg-open` as the console user), never from the root daemon. Define the POSIX bulk-deploy analogue of `/ADD=<phrase> /SILENT`: a preseed file `<data_root>/config/pairing.json` (or `OWLETTE_ADD=<phrase>`) read by `postinstall`/`postinst`, documented in the installation docs by 6.4. The preseed also carries `kiosk_user` (the account the desktop app runs as); when absent, `postinstall`/`postinst` resolve it from the active graphical session and otherwise print the manual `usermod -aG owlette USER` step rather than guess. Device codes are single-use and a golden image clones `machine_id` and the refresh token, so this preseed pairs one machine; bulk deploy is owner Q14. The preseed is consume-once: `postinstall`/`postinst` rename `config/pairing.json` to `pairing.json.used` on success and skip pairing entirely when `config/config.json` already carries `firebase.site_id`, mirroring `owlette_installer.iss`'s `ShouldConfigureSite`; `OWLETTE_ADD=` is the explicit re-pair opt-in. The four privileged app modes — pair, leave, restart, reboot — become requests the app drops into the 0770 `ipc/` seam (`pair`, `leave`, `reboot` beside the existing job types) that the daemon executes, since the kiosk user cannot write `.tokens.enc` or control the daemon. The seam is a privilege boundary: the daemon accepts a request only when the file is owned by the uid `console_user()` resolves, has no group or world write bit, and carries the one-shot nonce from the root-owned 0640 `ipc/request_nonce` it last wrote; anything else is unlinked and logged. `leave` is removed from the seam — deregistration stays an uninstall-time root operation (`uninstall.sh` / `prerm`) and a dashboard command. `restart` and `reboot` are rate-limited to one per five minutes and each executed verb writes an audit row.
  - Done when: the headless pairing test passes on three legs; a Mac and an Ubuntu box pair via the preseed file with no browser; the dashboard shows the machine with the persisted id. a `reboot` request hand-written into `ipc/` by a second group member is refused and logged; there is no `leave` handler to hand-write (negative control: adding one fails the test).
  - Depends on: 3.3.

- [ ] **Task 4.1: cargo gating, paths, shell_open**
  - Files: `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/src/paths.rs`, `desktop/src-tauri/src/shell_open.rs`, `desktop/src-tauri/tauri.conf.json` `desktop/src-tauri/src/tray.rs`
  - Do: move `windows` and `windows-service` under `[target.'cfg(windows)'.dependencies]` (`winresource` is `agent/host`'s build-dependency, not this crate's); replace the `ShellExecuteW` wrapper with the `explorer.exe`/`open`/`xdg-open` ternary already proven at `cli/src/commands/auth.ts:109-110` (−80); per-OS data root honouring `OWLETTE_DATA_ROOT` and reading the env var case-consistently with `agent/host/src/paths.rs:80`; add `bundle.macOS` and `bundle.linux` siblings to the existing android stanza, replacing the inherited `"targets": "all"` with the explicit `["nsis", "app", "deb"]` (decision 12 — `"all"` reaches for dmg, rpm and AppImage tooling) and `signingIdentity: null` (5.1 signs by hand). **Do not** remove `tauri-plugin-fs` (decision 21). All new desktop/web copy is lowercase, colours from tokens, icons from lucide only; `osLabel()` keeps the proper nouns "Windows / macOS / Linux". `tray.rs`: replace `hostname()`'s `%COMPUTERNAME%` read with a per-OS resolution (`gethostname`), and resolve `agent_version()` from the per-OS install root rather than `AGENT_VERSION_REL` under the data root — split `paths.rs` into `data_root()` and `install_root()` and move `AGENT_VERSION_REL` onto the latter.
  - Done when: `cargo check` passes for `x86_64-pc-windows-msvc`, `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`.
  - Depends on: 0.4.

- [ ] **Task 4.2: service_ctl, process_ctl, startup_link**
  - Files: `desktop/src-tauri/src/service_ctl.rs`, `desktop/src-tauri/src/process_ctl.rs`, `desktop/src-tauri/src/startup_link.rs` `desktop/src-tauri/src/tray.rs`
  - Do: `#[cfg(windows)]` the SCM/UAC paths (`service_ctl.rs:213-218,259,264,272-296`); add `launchctl print|kickstart|bootout` and `systemctl is-active|start|stop` arms — Linux invokes `systemctl is-active|start|stop owlette-agent` directly as the kiosk user (the D-Bus call polkit checks under `org.freedesktop.systemd1.manage-units`, which the 5.2 rule allows; no `pkexec`, whose own action `org.freedesktop.policykit.exec` the rule never grants and which would prompt); macOS writes a `restart` request into the `ipc/` seam from 3.7 and uses `launchctl print` only for read-only status; no `osascript … with administrator privileges` anywhere; SIGTERM→SIGKILL with the same grace window, capability-gating "graceful close" (no `WM_CLOSE` analogue); three-way autostart returning "managed by the system" on POSIX since the init system owns it (decision 2). `tray.rs` renders the third autostart state ("managed by the system", unchecked and disabled) in `build_menu`/`toggle_start_on_login` where `startup_link` reports it.
  - Done when: start/stop/status and terminate-by-pid work from the tray on all three, and the app relaunches at login on all three. start/stop/status work from the tray **as the unprivileged kiosk user with no password prompt** on Linux (the polkit rule from 5.2). with the polkit rule removed the same call is denied — the rule, not a cached admin session, is what authorises it.
  - Depends on: 4.1.

- [ ] **Task 4.3: the POSIX job runner**
  - Files: `desktop/src-tauri/src/jobrunner.rs` (new), `desktop/src-tauri/src/json_io.rs`, `desktop/src-tauri/src/watchers.rs`, `desktop/src-tauri/src/lib.rs`
  - Do: `#[cfg(unix)]` `jobrunner.rs`: watch `ipc/jobs` on the existing 120 ms debounce, execute `capture`/`shell`/`notify`/`launch` job types, honour a 120 s cap and the job's `trusted` flag, write results atomically into `ipc/results/<uuid>/`; POSIX lock in `json_io.rs` = `flock(2)` on `<data_root>/tmp/json.lock`, the same identity 3.1 gave Python; route `notify` to `tauri-plugin-notification` (already a dependency). The `launch` job type spawns the requested executable as a **child of the app** (posix_spawn) so it inherits the bundle's TCC responsibility — this is swoop's POSIX spawn path (cross-plan decision C2). The `launch` job carries `stdin_path` — a file the daemon writes 0640 root:<group> under `<data_root>/ipc/swoop/` (the POSIX analogue of swoop decision 3's fallback, never inside the 0770 `ipc/jobs` tree) — which the runner pipes to the child and unlinks after the child reads to EOF; `result.json` returns the child `pid` so the daemon can reap or kill by pid; a `stdin_path` is accepted only when it resolves inside `<data_root>/ipc/swoop/`, `st_uid == 0` and `st_mode & 0o022 == 0`; anything else is refused with a typed error.
  - Done when: a job file written by hand on macOS and on Ubuntu returns a `result.json` in <300 ms, a malformed job returns a typed error rather than panicking, a concurrent Python + Rust write to `config.json` loses no update, and `cargo test` is green on all three; a `launch` job hands 4 KB to a child on macOS and Ubuntu, the stdin file is gone within 1 s of the read, and the result carries a live pid.
  - Depends on: 4.1.

- [ ] **Task 4.4: capture provider and TCC surface**
  - Files: `desktop/src-tauri/src/capture.rs` (new), `desktop/src-tauri/src/tcc.rs` (new), `desktop/src-tauri/src/lib.rs` (two `mod` lines + one `generate_handler!` entry), `desktop/src/lib/ipc.ts` (binding), `desktop/src/App.tsx` (banner mount), `desktop/src/components/PermissionBanner.tsx` (new), `agent/src/osadapter/darwin.py`, `agent/src/osadapter/linux.py`
  - Do: implement `capture` per spike 0.2's winning transport; probe screen recording / accessibility / portal availability, expose as an IPC command, render a first-run banner (lowercase copy, token colours) with a one-click deep link to the correct settings pane, and publish the grant state into the seam so the daemon advertises `capabilities.screenCapture`. Linux: `capabilities.screenCapture` is 1 only when 3.2's session probe reports x11 — a Wayland kiosk (Ubuntu 24.04's default session except on the NVIDIA proprietary driver) publishes 0 with the banner reason "wayland session — capture unsupported in v1 (x11 only)", and the same signal gates `capabilities.swoop` once Wave 8 lands. Implement the darwin/linux arms of the `streamer_capable()` operation defined in 2.1 (Linux: the session probe reports x11; macOS: Screen Recording granted) — the swoop plan's Task 2.2 ANDs it with binary presence for `capabilities.swoop`, so a Wayland kiosk never advertises swoop with the binary packaged.
  - Done when: a fresh Mac shows the banner, one click opens the right pane, a capture succeeds after the grant, and the dashboard's capability flips within one heartbeat; an Ubuntu box booted into a Wayland session advertises `capabilities.screenCapture: 0` within one heartbeat and the dashboard renders the reason, not a black frame. with the streamer binary present but `screenCapture` 0, the heartbeat carries `capabilities.swoop: 0`.
  - Depends on: 4.3, 0.2, 0.3. *(Ordered after 4.3 — both edit `lib.rs`.)*

- [ ] **Task 4.5: desktop frontend per-OS handling**
  - Files: `desktop/src/components/WindowControls.tsx`, `desktop/src/lib/dropClassifier.ts`, `desktop/src/lib/dropQueue.ts`
  - Do: native decorations on macOS; per-OS entries in `DEFAULT_CLASSIFY_OPTIONS` (`dropClassifier.ts:99`, typed `Required<ClassifyOptions>` — three objects or a partial merge); make `pathKey()` (`dropQueue.ts:148-150`) case-sensitive off Windows.
  - Done when: vitest green and dropping `/Applications/TouchDesigner.app` and `/usr/bin/foo` classify correctly.
  - Depends on: 4.1.

- [ ] **Task 4.6: Rust CI on three OSes**
  - Files: `.github/workflows/rust-build.yml` (created by swoop Task 2.5 if that ran first; otherwise new here)
  - Do: extend (or create) the workflow so `desktop/src-tauri` builds and tests on windows/macos/ubuntu, `agent/host` on Windows only, `agent/swoop` per its own plan; MSRV 1.77.2 pinned (or the floor swoop spike 0.2 measured); one job step per crate with `working-directory:` (no workspace; `--manifest-path` from the repo root drops each crate's `.cargo/config.toml` and with it `+crt-static` — swoop Task 2.5); widen `paths:` to `desktop/**`; zizmor conventions. The ubuntu leg installs the Tauri v2 Linux build deps before any cargo invocation (`libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential`) — the `ubuntu-24.04` image ships none and `webkit2gtk-sys`'s build script fails before a line compiles; no xvfb. The ubuntu leg builds both x86_64 and arm64 (`ubuntu-24.04-arm` runner or cross-compile with `cross`); the macOS leg builds universal2 (`--target universal-apple-darwin`).
  - Done when: the workflow fails on a deliberately mis-`#[cfg]`'d line and passes on `dev`.
  - Depends on: 4.2, 4.3.

- [ ] **Task 4.7: agent CLI bridge and update marker on POSIX**
  - Files: `desktop/src-tauri/src/agent_cli.rs`, `desktop/src/lib/serviceHealth.ts`
  - Do: `agent_cli.rs:43` hardcodes `python/python.exe` and `:412` a `C:\ProgramData\…` test path — resolve the interpreter and `configure_site.py` through the per-OS data root from 4.1; `serviceHealth.ts:256-269` reads `logs/update_in_progress.json` written by `update_owlette` — make the path data-root-relative so the POSIX self-update marker from 3.4 is honoured. Resolve the interpreter through `get_python_exe_path()` (install root, not the data root); pairing, leave and restart go through the `ipc/` requests from 3.7 rather than running `configure_site` as the kiosk user. The macOS `<install>` root is `/Library/Application Support/Owlette/runtime` (Task 5.1), never the app bundle.
  - Done when: the desktop app can run the pairing CLI on macOS and Ubuntu and shows the "updating" state during a POSIX self-update. a Mac pairs from the app's join dialog and `.tokens.enc` lands 0600 root.
  - Depends on: 4.1.

- [ ] **Task 5.1: macOS `.pkg`**
  - Files: `agent/build/macos/build.sh` (new), `agent/packaging/macos/app.owlette.agent.plist` (new), `agent/packaging/macos/app.owlette.desktop.plist` (new), `agent/packaging/macos/postinstall` (new), `agent/packaging/macos/distribution.xml` (new), `agent/packaging/macos/entitlements.plist` (new) `agent/packaging/macos/preinstall` (new), `agent/packaging/macos/uninstall.sh` (new, shipped inside the payload at a documented path) `agent/packaging/macos/owlette-background-items.mobileconfig` (new; off-metric, declarative)
  - Do: universal2: two python-build-standalone payloads (arm64 + x86_64, selected by `uname -m`). Start with `npm ci && npx tauri build --bundles app --target aarch64-apple-darwin` in `desktop/` to produce `owlette.app` (the bundle TCC binds the grant to). Sign every Mach-O in the payload inside-out — the bundled interpreter and every `.so` — then the app itself, all with the Developer ID Application identity, hardened runtime and `com.apple.security.cs.disable-library-validation` (plus allow-dyld-environment-variables if the launcher sets `PYTHONHOME`); LaunchDaemon + LaunchAgent plists; `productbuild` → `productsign` with the Developer ID Installer identity → `notarytool --wait` → `stapler`; verify the app with `codesign --verify --deep --strict` and the `.pkg` with `pkgutil --check-signature` + `spctl -a -vvv -t install` (`codesign --verify` does not work on packages). `postinstall` creates a dedicated `_owlette` group, adds the kiosk user to it, applies decision 4's data-root mode table (root 0750 root:`_owlette`, `ipc/` 0770 root:`_owlette` — never `staff`, which is every logged-in user), pre-creates `tmp/json.lock`, applies the pairing preseed from 3.7, and activates both jobs immediately: `launchctl bootstrap system /Library/LaunchDaemons/app.owlette.agent.plist`, and `launchctl bootstrap gui/<uid> …desktop.plist` for the console user when `stat -f%Su /dev/console` is not `root` (a plist in a Launch* directory is inert until bootstrapped). `distribution.xml` carries `<options hostArchitectures="arm64"/>` and `<allowed-os-versions><os-version min="14.0"/></allowed-os-versions>` so the arm64-only payload refuses an Intel Mac or an old release instead of crash-looping under `KeepAlive`. Upgrade path: on an upgrade the labels are already bootstrapped, so `preinstall` runs `launchctl bootout system/app.owlette.agent || true` and `launchctl bootout gui/<uid>/app.owlette.desktop || true` first, and each `bootstrap` is written `launchctl bootstrap … || launchctl kickstart -k <domain>/<label>` (bootstrap on a loaded label exits non-zero and would fail the package); on upgrade (an existing `config/config.json`) skip group creation, kiosk-user resolution and pairing — apply only the mode table and the unit reload; no maintainer-script step may return non-zero on the upgrade path. The daemon plist carries `AbandonProcessGroup=true`. The OS-version guard goes inside `<volume-check>` — `<volume-check><allowed-os-versions><os-version min="14.0"/></allowed-os-versions></volume-check>` — where Installer honours it (a top-level element is silently ignored). `postinstall` applies `pmset -a sleep 0 displaysleep 0 disksleep 0`. `uninstall.sh` (~60 lines): `configure_site.py --leave` first so the machine deregisters and reports offline, then bootout both jobs, delete both plists and `/Applications/owlette.app`, and the data root only with `--purge` (default keeps it, mirroring the Windows silent uninstall), then `dseditgroup -o delete _owlette`. Payload layout, before the signing sentence: `/Library/Application Support/Owlette/runtime/python` (arm64 python-build-standalone), `.../runtime/agent/src`, `.../runtime/VERSION` and `.../runtime/uninstall.sh`, all root:wheel 0755 and outside any admin-writable directory; the LaunchDaemon's `ProgramArguments` are `.../runtime/python/bin/python3 .../runtime/agent/src/owlette_runner.py`; `/Applications/owlette.app` holds only the GUI and `owlette-swoop`. Ship a `com.apple.servicemanagement` profile whose Rules use `RuleType: TeamIdentifier` plus `LabelPrefix: app.owlette.` so both background items are managed and non-toggleable on MDM-enrolled Macs (Q16); without MDM a standard user can switch them off in Login Items & Extensions, documented in 6.4. Universal2: two python-build-standalone payloads (`aarch64-apple-darwin`, `x86_64-apple-darwin`) selected at runtime by `uname -m`, the Tauri app built `--target universal-apple-darwin`, `distribution.xml` `hostArchitectures="arm64,x86_64"`, and the min-OS floor per architecture (Intel Macs stop at the last Intel-supported release).
  - Done when: a stapled `.pkg` installs on clean Sonoma and Sequoia VMs, both verifications pass, the agent pairs via the preseed, heartbeats and appears in the dashboard with `osFamily: 'macos'`; `launchctl print system/app.owlette.agent` reports the job running before any reboot; the installer refuses on an Intel Mac and below the floor with Installer's own message; after one reboot a `capture` job round-trips through `ipc/` as the kiosk user. installing the new version over a running previous one leaves the daemon serving the new version within 60 s with `installer` exiting 0 and `logs/update_in_progress.json` consumed; the stapled `.pkg` is refused on a macOS 13 VM and on an Intel Mac (observed); the kiosk neither sleeps nor blanks over an 8-hour unattended run; `uninstall.sh` returns a clean Sequoia VM to a no-owlette state and the machine shows offline-and-removed in the dashboard. moving `/Applications/owlette.app` to the Trash leaves the daemon running and heartbeating; with the profile installed both labels show as managed and non-toggleable, and without it the toggle's effect is recorded.
  - Depends on: 3.4, 3.7, 4.4, 5.0, 0.6.

- [ ] **Task 5.3: release workflow restructure**
  - Files: `.github/workflows/build-installer.yml`
  - Do: three build jobs (`build-windows`, `build-macos`, `build-linux`), each signing/notarizing/stapling its own artifact before emitting a digest; one `digest-and-release` job that downloads all three and loops the `"<hex>␣␣<filename>"` construction at `:139-164` over n subjects; raise only the macOS job's `timeout-minutes` per spike 0.6. Keep the SLSA generator pinned by tag (`:190-192`). Windows signing is unchanged — still unsigned (`build-installer.yml:17`) until the Azure Artifact Signing work is funded; only the macOS leg signs/notarizes/staples in this task. zizmor conventions on every new job.
  - Done when: a tagged release produces three artifacts and `slsa-verifier >= v2.7.0` passes on each.
  - Depends on: 5.1, 5.2.

