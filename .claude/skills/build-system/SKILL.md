---
name: build-system
description: "Owlette agent build and release: build_installer_full/quick.bat, Inno Setup installer, owlette-host service host, macOS pkg and Linux deb, sync-versions.js, upload-installer.mjs to the download host, set as latest, hoot CLI pins, self-update. Use when asked to release, ship or publish the installer, bump the version or changelog, build the installer, cut X.Y.Z, or touch the installer, updater or service host."
---

# Build & Installer System Guidelines

**Applies To**: Build scripts, Inno Setup, the owlette-host service host, self-update, version management

---

## Build Pipeline

### Two Build Modes

| | Full Build | Quick Build |
|--|-----------|------------|
| **Script** | `build_installer_full.bat` | `build_installer_quick.bat` |
| **Duration** | 5-10 min (longer on a cold cargo cache) | ~30 sec |
| **When** | First build, dependency changes, desktop app or swoop changes | Agent source changes only (it re-copies the desktop and swoop exes, and rebuilds owlette-host when cargo is present) |

**Prerequisites**: Inno Setup 6 (`%ISCC%`, `iscc.exe` on PATH, or `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`); Node 22 + npm; the Rust toolchain (rustup — the full build prepends `%USERPROFILE%\.cargo\bin` to PATH itself, so cargo does not have to be on the system PATH); MSVC C++ build tools; cmake (on PATH or the one inside Visual Studio) for the swoop streamer's opus.

### The desktop app is part of the payload (3.0.0+)

Step 6 of the full build compiles `desktop/` and step 8 copies the binary to `build\installer_package\app\owlette-desktop.exe`, which the installer lays down at `{app}\app\owlette-desktop.exe` — the exact path `shared_utils.get_desktop_exe_path()` resolves, so the folder name is a contract with the service, not a preference.

- The build runs **`npx tauri build --no-bundle`**. Inno Setup is this product's packager; letting the Tauri bundler run would demand NSIS/WiX and produce a second installer we do not ship.
- `npm ci` runs **only when `desktop/node_modules` is absent**. `npm ci` deletes `node_modules` before repopulating it, which would pull the tree out from under a dev server or a parallel build on a developer machine.
- The **quick build does not compile it** — it only re-copies `desktop/src-tauri/target/release/owlette-desktop.exe` if one is there, and fails loudly when the package has no desktop app at all (Inno errors on an empty `app\*` source anyway).
- Step 7 also builds the **swoop streamer** (`cargo build --release --features audio-opus` in `agent/swoop`, which needs cmake) into `{app}\swoop\owlette-swoop.exe`, the path `shared_utils.get_swoop_exe_path()` resolves.
- The full build **deletes `claude_agent_sdk/_bundled/claude.exe`** (242 MB) after pip install. It reappears on every clean install, which is why it is scripted; hoot fetches its own CLI on demand instead.
- The installer probes for the **WebView2 Evergreen runtime** and runs the bundled `vendor\MicrosoftEdgeWebview2Setup.exe` (`/silent /install`) when it is missing — LTSC/IoT kiosk images often lack it, and the app cannot create a window without it. Never fatal; the service works regardless.
- The installer probes for the **PawnIO driver** (registry `Uninstall\PawnIO\DisplayVersion`) and runs the bundled `vendor\PawnIO_setup.exe` (`-install -silent`; exit 0/183/3010 all mean success) when absent or older than 2.2.0 — LibreHardwareMonitor reads CPU temps through it. Never fatal; without it CPU temps are None and GPU temps use vendor APIs.

### The macOS pkg (`agent/build/macos/build.sh`)

Runs on an Apple silicon Mac with the Command Line Tools, Node, cargo and **cmake**; nothing in it needs root. Output: `agent/build/macos/Owlette-Installer-v<version>.pkg`, the version read from `agent/VERSION`. Flags, signing and notarizing are in the script's header. Here the Tauri bundler does run, for the `.app` only (`--bundles app`); `pkgbuild` and `productbuild` make the installer.

- **It compiles the swoop streamer first**: `cargo build --release --locked --no-default-features --features encode-videotoolbox,audio-opus` in `agent/swoop` (the default `nvenc` feature is Windows-only), then stages the binary as `desktop/src-tauri/binaries/owlette-swoop-aarch64-apple-darwin`. cmake builds the opus that `audio-opus` vendors, and cmake 4 refuses it without `CMAKE_POLICY_VERSION_MINIMUM=3.5`, which the script sets on its own cargo call.
- **The streamer is a Tauri sidecar**: `bundle.externalBin`, declared only in `tauri.macos.conf.json`, so the bundler copies it to `owlette.app/Contents/MacOS/owlette-swoop` and signs it with the app's identity and hardened runtime. Windows and Linux builds never see it. `tauri-build` will not compile the desktop crate on macOS without the staged file, so a macOS `cargo check` or `cargo test` of `desktop/src-tauri` needs the streamer built and staged first, as the CI leg does.
- **It checks the sidecar** before packaging and fails the build if it is missing from the bundle, prints a version other than `agent/VERSION` (the agent refuses a mismatched streamer at spawn), or, when signed, fails `codesign --verify --strict`, lacks the hardened runtime, or carries another team than the app's.
- `--skip-app` reuses the last app bundle, sidecar included: neither the app nor the streamer is rebuilt.
- The signed, notarized pkg comes only from the `v*`-tag CI build (`.github/workflows/build-installer.yml`, job `build-macos`); a local run without the signing identities makes an unsigned pkg.

### The Linux deb (`agent/build/linux/build.sh`)

Runs on Ubuntu 24.04. Output: `agent/build/linux/Owlette-Installer-v<version>.deb`. On an aarch64 host it builds an arm64 deb under the same file name, and `upload-installer.mjs` maps every `.deb` to `linux_x64` — only upload an x86_64 build.

### Version Bump Flow

```bash
node scripts/sync-versions.js            # show every version surface
node scripts/sync-versions.js X.Y.Z      # bump them all
```

The script's own `VERSION_FILES` / `CARGO_TOMLS` tables are the list (product + agent VERSION, the web and desktop `package.json`, `tauri.conf.json`, the desktop, host and swoop `Cargo.toml`, plus the version strings in `README.md`, `.claude/CLAUDE.md` and `docs/internal/version-management.md`). `firestore.rules` is versioned independently.

Version → `OWLETTE_VERSION` env var → Inno Setup reads it → installer filename + registry.

---

## Agent Installer Release

Full runbook, including the CI build path, the manual curl form, every error code and the post-release smoke test: [docs/runbooks/agent-installer-release.md](../../../docs/runbooks/agent-installer-release.md). This section is the recipe and the gotchas.

### Step 0 (blocking): no live vulnerability ships

Run this BEFORE the version bump, and again right before the upload:

```bash
node scripts/check-security-alerts.mjs
```

It resolves every open GitHub alert against **this branch's** lockfiles, which
is the only way to read Owlette's alert list: Dependabot files security alerts
and PRs against `main`, `main` trails `dev` by hundreds of commits, and
`target-branch` in `.github/dependabot.yml` does not apply to security updates.
So the raw list mixes "still shipping" with "fixed on dev weeks ago".

- **BLOCKING:** an alert whose vulnerable version is still pinned here (`LIVE`),
  an alert this checkout cannot resolve (`UNRESOLVED`), any open code-scanning
  or secret-scanning alert, a draft/triage advisory, or a Dependabot PR left
  open past 30 days. A check that cannot run is itself a blocker.
- **Exit 1 = STOP.** Each blocker gets fixed, dismissed on GitHub with a written
  reason, or explicitly accepted by the user — then re-run with
  `--ack "<key>=<why>"` using only the keys the user named. Every ack requires a
  reason; `verify:*` keys are refused (a check that could not run must be fixed,
  never waived). Never ack on your own judgment.
- **List every acked item in the release commit body**, with its reason, so the
  waiver is auditable in `git log` rather than evaporating with the shell.
- **Report the warnings too.** `fixed here, still open on the default branch` is
  the expected steady state for `dev`; it clears when `dev` reaches `main`.

Why: on 2026-09-12 the repo carried 39 open alerts, two of them an
unauthenticated RCE in Next.js (GHSA via 16.3.3), and the noise from ~30 stale
alerts that were already fixed on `dev` is what made nobody look. The
`security preflight` workflow runs the same check daily and on every push to
`dev`/`main`.


**IMPORTANT: Always version up AND update the changelog BEFORE building the installer.** Bump with `node scripts/sync-versions.js X.Y.Z` and commit BEFORE running `build_installer_full.bat` — the installer bakes the version into the exe filename and binary.

**IMPORTANT: the changelog MUST be updated before every installer build.** Add a new `## [X.Y.Z] - YYYY-MM-DD` section summarising all changes since the last release. Never build or upload an installer without a matching changelog entry.

**BOTH changelogs, always.** `docs/changelog.md` is internal; `web/content/docs/changelog.mdx` is the one customers actually read at `/docs/changelog`. They carry the same entries and drift the moment one is updated alone — which is what every checklist that named only the first has been causing.

```bash
# 1. Update changelog, bump version, commit, push
# Edit docs/changelog.md AND web/content/docs/changelog.mdx → add [X.Y.Z] section to both
node scripts/sync-versions.js X.Y.Z
# ignore the next steps it prints (bare `screenshots:desktop`, push to main) — this recipe replaces them
git add -A && git commit -m "chore: bump version to X.Y.Z" && git push origin dev

# 2. Build installer (~5 min, non-interactive)
# build_installer_full.bat ends with `pause` and has `pause` on every error
# branch, so it MUST be run with stdin redirected from NUL or it will hang
# the harness forever. Invoke by FULL PATH (cmd /c won't reliably cd via
# PowerShell quote-stripping; the script cds to its own folder, so any checkout
# works) and capture the log explicitly. Run in the background — exit code 0
# means the .exe is built; check the log on failure.
#
#   powershell (foreground/background):
#     cmd /c "<repo>\agent\build_installer_full.bat < NUL > %TEMP%\installer-build.log 2>&1"
#
#   bash:
#     cd <repo>/agent && cmd //c "build_installer_full.bat" < /dev/null > "$TEMP/installer-build.log" 2>&1
#     # (if //c gets mangled by Git Bash, fall back to the powershell cmd /c form above)
#
# DO NOT use `cd agent && powershell -Command "& './build_installer_full.bat'"` —
# the trailing pause will hang non-interactive shells indefinitely.
# Output: agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe
# The .pkg and .deb come from their own build hosts (above), or download all
# three from the v* tag's GitHub Release — CI never uploads to Owlette.

# 3. Refresh the agent docs screenshots (~1 min) - REQUIRED, not optional
#
# Run this AFTER the build, never at bump time: the bump is pre-build, has no
# binary to photograph, and must stay side-effect-free. Release time is the one
# moment the documentation has to match what is about to ship.
#
#   node scripts/refresh-docs-screens.mjs      (or: cd web && npm run screenshots:release)
#
# Use THAT, not the bare `npm run screenshots:desktop`. The capture harness drives
# the app INSTALLED at C:\ProgramData\Owlette\app, not the one you just built, so the
# bare command silently photographs the PREVIOUS version - the shots look fine, they
# are just wrong. That is how these reached three minor versions stale. The wrapper
# refuses unless the built exe matches VERSION, swaps it into the install (elevated:
# the service must STOP, because it respawns the tray within seconds and that holds
# the exe lock), captures, then records what it photographed in
# web/public/docs-screens/captured.json.
#
#   node scripts/refresh-docs-screens.mjs --check      (or: npm run screenshots:check)
#
# ...compares that record against VERSION and exits non-zero when stale, so "did we
# recapture?" is answerable mechanically instead of remembered.
#
# Needs an interactive desktop session with the owlette tray icon VISIBLE (the
# tray-menu shot is captured by UI Automation, not CDP). If it sits in the
# hidden-icons overflow, the tray-menu shot fails while the other 22 captures
# succeed (12 shots, each dark and light except the dark-only tray menu) - turn it
# on under taskbar settings > other system tray icons.
# `git diff --stat web/public/docs-screens` is the check; no diff is a valid result.
# See web/e2e/desktop-screenshots/README.md.

# 4. Upload every file of the release (per file: sha256 → signed URL → bytes → finalize)
# One version doc with `files` keyed by platform — windows_x64 / macos_arm64 / linux_x64,
# derived from the extension .exe / .pkg / .deb — and with --set-latest one `latest`
# pointer carrying every entry. One to three files, one per platform; --set-latest only
# when ready to roll out. Reads OWLETTE_API_KEY + OWLETTE_DEV_API_URL (or
# OWLETTE_API_KEY_PROD + OWLETTE_PROD_API_URL for --env prod) from the environment, then
# web/.env.local, .claude/.env.local, scripts/.env.local — the first value found wins.
# Prints each finalize response, then the `files` keys on /api/installer/latest; a
# failure stops the run and names what is left.
# Notes default to the version's `## [X.Y.Z]` changelog section (--notes overrides).
# With installer R2 set on the server the files land on download(-staging).tridant.io/owlette/,
# immutable (409 installer_published on a re-upload: bump the version); without it,
# Firebase Storage. --set-latest also registers the release with tridant id and prints a
# `tridant id:` line (registered | failed (<err>) | skipped | not_configured); a failed
# registration never fails the promote — retry with "register again" on /admin/installers.
# --key-tag r2 re-publishes a version still on Firebase Storage to R2 within the 24h
# key window (different bytes → 409 installer_differs).
node scripts/upload-installer.mjs --env dev --version X.Y.Z --set-latest \
  agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe \
  agent/build/macos/Owlette-Installer-vX.Y.Z.pkg \
  agent/build/linux/Owlette-Installer-vX.Y.Z.deb

# 5. Smoke test — upload success is not release success. Run the runbook's
# "post-release smoke" section (download per platform, pair a test box, tail
# service.log and service_host.log).
```

**Manual curl fallback** (one file, when the script cannot run): the runbook's "the 3-step api upload (in detail)". Two traps it does not spell out: `grep OWLETTE_API_KEY` also matches `OWLETTE_API_KEY_PROD` (use `grep '^OWLETTE_API_KEY='`), and the server treats an omitted `setAsLatest` as `true`, so a bare POST promotes — the script sends `false` for every file but the last. The route requires an `Idempotency-Key` on the POST and the finalize PUT (not on the storage PUT), and the key needs the `installer=*:write` scope.

### hoot CLI pins — one document per platform, per environment

`scripts/upload-cortex-cli.mjs` publishes the Claude Code CLI the hoot runtime drives, pinned by sha256 in `installer_metadata/cortex_cli_<osFamily>_<arch>`: `windows_x64`, `macos_universal` (one universal2 build), `linux_x64`, `linux_arm64`. `agent/src/cortex_cli_fetch.py` resolves its own id from `(osFamily, arch)`, so a platform whose pin is missing fails closed and hoot never starts there. The macOS payload must be a `lipo -create` universal2 binary — the SDK's wheels are per-arch and both Macs read the one id — and the script rejects a thin Mach-O.

- **One run per environment publishes every platform** — the script loops the table, so an SDK bump is one command per environment, not four:
  ```bash
  node scripts/upload-cortex-cli.mjs --env=dev \
    --windows-x64="<claude.exe>" --macos-universal="<claude>" \
    --linux-x64="<claude>" --linux-arm64="<claude>"
  ```
  The version is read from `<binary> -v` on whichever file runs on the invoking host; pass `--version=X.Y.Z` when none does. `--dry-run` hashes locally and touches nothing. `--env=prod` asks for a typed "yes" on stdin, which hangs a non-interactive shell: pass `--yes`. Credentials are the Firebase admin trio `FIREBASE_PROJECT_ID_{DEV|PROD}` / `FIREBASE_CLIENT_EMAIL_{DEV|PROD}` / `FIREBASE_PRIVATE_KEY_{DEV|PROD}`, not the API key.
- **`windows_x64` also rewrites the unsuffixed `installer_metadata/cortex_cli`.** That is the only id a pre-3.4 agent reads, and it is what the whole fielded fleet fetches from. Drop `legacyDoc` from the platform table only once the fleet floor is 3.4 — until then, removing it strands every fielded agent on the previous CLI the next time the SDK moves.
- **Publish every per-platform pin into an environment before promoting a 3.4+ installer there.** A 3.4 agent reads only its own `cortex_cli_<osFamily>_<arch>` id, so a green legacy `cortex_cli` says nothing about it: hoot is dead on every fresh install of a platform whose pin is missing.
- dev and prod are separate Firebase projects with separate pins: publish to both, or hoot is dead on fresh installs in the one you skipped.

---

## Critical Rules

### Do
- Run full build first before quick build (creates Python runtime + deps)
- Use `build_installer_quick.bat` for source-only changes during development
- Test with `cd agent/src && ../.venv/Scripts/python owlette_runner.py --debug` (admin shell, installed service stopped) before building the installer
- Check `agent/VERSION` matches `/VERSION` before release

### Don't
- **Never edit `owlette_installer.iss`** without reading [installer-build-system.md](installer-build-system.md) first — the pairing handoff (`ShouldConfigureSite` / `RunPairingHandoff`), the `InitializeSetup` stop-and-kill sequence and silent-install behavior are interconnected
- **Never change the install path** from `C:\ProgramData\Owlette` — service registration, the host's own path resolution (it locates the install root two directories above `tools\owlette-host.exe`), and the Inno Setup script all use this via `{commonappdata}`
- **Never modify `python311._pth`** without understanding embedded Python import resolution — breaking this kills all imports
- **Never weaken the PawnIO version gate or its silent flags** — the installer must ship PawnIO >= 2.2.0 (2.1.0 BSOD/boot-loops Win10 1809/LTSC machines, and it is the version LHM itself still embeds), and `-install -silent` is what keeps the SYSTEM self-update path from hanging on an invisible dialog. The old WinRing0 Defender exclusions are now actively *retracted* by the `[Run]` step — never re-add them.
- **Never change the child exit-code contract** — 0 = stop the service (graceful stop), 42/43 = relaunch immediately (restart flag, self-restart watchdog), anything else = relaunch with crash-loop backoff. `owlette_runner.py` and `agent/host/src/supervisor.rs` are the two halves of it; changing one without the other silently breaks restarts.
- **Never drop `AppUserModelID: "app.owlette.desktop"`** from the two `[Icons]` entries that carry it (`{group}\Owlette` and `{userstartup}\Owlette`). Windows silently discards every toast an unpackaged app raises unless a Start-menu shortcut registers its AUMID — the notification API still reports success. The id must stay byte-identical to `tauri.conf.json`'s `identifier` and `startup_link.rs`'s `APP_USER_MODEL_ID`.
- **Never add the AUMID to a third shortcut, and never rename either of those two.** Windows draws a toast's attribution line from the *name* of a registered shortcut and does not specify which it picks when several share an id — that is why the old `Owlette Configuration` shortcut is retired (`[InstallDelete]` removes it) and why the startup shortcut is `Owlette.lnk`. Both registrars must be named exactly `Owlette` or notifications get attributed to something else.
- **Never let the Tauri bundler run** (`tauri build` without `--no-bundle`) — it wants NSIS/WiX and builds an installer that competes with ours.

---

## Key Files

| File | Purpose | Danger Level |
|------|---------|-------------|
| `owlette_installer.iss` | Inno Setup script — install/uninstall/upgrade logic, pairing handoff, WebView2 and PawnIO checks | High |
| `build_installer_full.bat` | Downloads Python, pip, deps; builds the desktop app, the service host and the swoop streamer; assembles package | Medium |
| `build_installer_quick.bat` | Copies source + desktop and swoop exes, rebuilds owlette-host when cargo is present, compiles installer (fast iteration) | Low |
| `desktop/` | Tauri 2 app — tray icon, config window, reboot prompt (replaced the python UI in 3.0.0) | Medium |
| `agent/vendor/` | Third-party binaries shipped with the build (the WebView2 bootstrapper and the PawnIO 2.2.0 driver installer; the NSSM zip went with 3.0.0). Their SHA256s are recorded in `.iss` comments; no build step re-verifies them | Low |
| `scripts/install.bat` | Service registration — calls `owlette-host install` (run during install) | High |
| `src/owlette_runner.py` | Host↔service bridge, SCM stop watcher, exit codes | High |
| `src/owlette_service.py` (`_handle_update_owlette`, `_start_windows_update`) + `src/installer_utils.py` | Self-update: download → verify → SYSTEM task runs the installer → recovery task | High |
| `src/configure_site.py` | Device-code pairing during install (3-word phrase), plus the desktop app's CLI back end | Medium |
| `src/installer_utils.py` | Download/verify/execute installers (deployments and self-update) | Medium |
| `scripts/sync-versions.js` | Bumps version across all version files | Low |

---

## Self-Update Flow

```
Web dashboard sends update_owlette (refused without checksum_sha256)
  → guards: logs\update_in_progress.json (10 min), ≥ 500 MB free
  → downloads to %ProgramData%\Owlette\update-staging\owlette-Update.exe
    (3 attempts, 5s then 10s apart; 30s connect / 600s read timeout)
  → verifies: ≥ 1 MB, `MZ` header, sha256 match — held open via open_verified
  → runs it as SYSTEM scheduled task OwletteUpdate_<ts> (it must outlive the
    service it is about to stop):
      owlette-Update.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS /LOG="<data>\logs\installer_update.log"
  → a paired machine's silent install skips pairing (ShouldConfigureSite = false)
  → install.bat re-registers the service (`owlette-host install`) and starts it
  → SYSTEM task OwletteRecovery_<ts> waits 300s and runs `net start OwletteService`
    if the service is not RUNNING
```

**Safety**: If the update fails, the old installation is untouched and the service host restarts the agent from whatever is on disk.

---

## Upgrades In Place

There is no config backup/restore: `[Files]` never touches `config\config.json` or `.tokens.enc`, so they survive as they are. What makes an upgrade safe is `InitializeSetup`: `net stop OwletteService` (synchronous) and a check that it reached Stopped, then killing owlette-host/nssm, owlette-swoop, owlette-desktop and the install's python/pythonw, removing the legacy `R0python` services, and polling up to 30s for `libcrypto-3.dll` to unlock before any file is copied.

**This is the most fragile part of the build system.** Reordering that stop/kill/unlock sequence is how upgrades end in "DeleteFile failed" mid-copy.

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "cargo not found on PATH" | Rust toolchain missing (or installed outside `%USERPROFILE%\.cargo`) | `rustup` install, or put cargo on PATH |
| Quick build fails | No Python runtime in `build/` | Run full build first |
| Quick build: "No desktop app in the installer package" | Never ran a full build, or `desktop/src-tauri/target` was cleaned | Full build, or `cd desktop && npx tauri build --no-bundle` |
| ISCC: "No files found matching ...\app\*" | Same as above — the desktop exe never made it into the package | Same as above |
| Desktop app never opens on a kiosk, service fine | WebView2 runtime absent and the bootstrapper failed | Check `SetupLog` for the `EnsureWebView2Runtime` lines |
| Silent install leaves the machine unpaired | No `/ADD=<phrase>`; setup logs "installed unpaired" | Re-run with `/ADD=<phrase>`, or pair from the desktop app |
| Service won't start after update | Import errors from missing deps | `logs\service_stderr.log` and `logs\service_host.log`; full rebuild |
| CPU temps blank, GPU temps fine | PawnIO driver absent or failed to install | Check `SetupLog` for the `EnsurePawnIO` lines; `Get-Service PawnIO`; `winget install namazso.PawnIO` |
