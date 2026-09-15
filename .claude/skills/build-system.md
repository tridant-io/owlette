# Build & Installer System Guidelines

**Applies To**: Build scripts, Inno Setup, the owlette-host service host, self-update, version management

---

## Build Pipeline

### Two Build Modes

| | Full Build | Quick Build |
|--|-----------|------------|
| **Script** | `build_installer_full.bat` | `build_installer_quick.bat` |
| **Duration** | 5-10 min (longer on a cold cargo cache) | ~30 sec |
| **When** | First build, dependency changes, desktop app changes | Agent source changes only |

**Prerequisites**: Inno Setup 6 at `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`; Node 22 + npm; the Rust toolchain (rustup — the full build prepends `%USERPROFILE%\.cargo\bin` to PATH itself, so cargo does not have to be on the system PATH); MSVC C++ build tools.

### The desktop app is part of the payload (3.0.0+)

Step 6 of the full build compiles `desktop/` and step 8 copies the binary to `build\installer_package\app\owlette-desktop.exe`, which the installer lays down at `{app}\app\owlette-desktop.exe` — the exact path `shared_utils.get_desktop_exe_path()` resolves, so the folder name is a contract with the service, not a preference.

- The build runs **`npx tauri build --no-bundle`**. Inno Setup is this product's packager; letting the Tauri bundler run would demand NSIS/WiX and produce a second installer we do not ship.
- `npm ci` runs **only when `desktop/node_modules` is absent**. `npm ci` deletes `node_modules` before repopulating it, which would pull the tree out from under a dev server or a parallel build on a developer machine.
- The **quick build does not compile it** — it only re-copies `desktop/src-tauri/target/release/owlette-desktop.exe` if one is there, and fails loudly when the package has no desktop app at all (Inno errors on an empty `app\*` source anyway).
- The full build **deletes `claude_agent_sdk/_bundled/claude.exe`** (242 MB) after pip install. It reappears on every clean install, which is why it is scripted; Cortex fetches its own CLI on demand instead.
- The installer probes for the **WebView2 Evergreen runtime** and runs the bundled `vendor\MicrosoftEdgeWebview2Setup.exe` (`/silent /install`) when it is missing — LTSC/IoT kiosk images often lack it, and the app cannot create a window without it. Never fatal; the service works regardless.
- The installer probes for the **PawnIO driver** (registry `Uninstall\PawnIO\DisplayVersion`) and runs the bundled `vendor\PawnIO_setup.exe` (`-install -silent`; exit 0/183/3010 all mean success) when absent or older than 2.2.0 — LibreHardwareMonitor reads CPU temps through it. Never fatal; without it CPU temps are None and GPU temps use vendor APIs.

### Version Bump Flow

```bash
node scripts/sync-versions.js 2.1.0   # Updates /VERSION, agent/VERSION, web/package.json
cd agent && build_installer_quick.bat  # Rebuild installer with new version
```

Version → `OWLETTE_VERSION` env var → Inno Setup reads it → installer filename + registry.

---

## Agent Installer Release (build + upload to Firebase)

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
git add -A && git commit -m "chore: bump version to X.Y.Z" && git push origin dev

# 2. Build installer (~5 min, non-interactive)
# build_installer_full.bat ends with `pause` and has `pause` on every error
# branch, so it MUST be run with stdin redirected from NUL or it will hang
# the harness forever. Invoke by FULL PATH (cmd /c won't reliably cd via
# PowerShell quote-stripping) and capture the log explicitly. Run in the
# background — exit code 0 means the .exe is built; check the log on failure.
#
#   powershell (foreground/background):
#     cmd /c "C:\Users\admin\Documents\Git\Owlette\agent\build_installer_full.bat < NUL > C:\Users\admin\AppData\Local\Temp\installer-build.log 2>&1"
#
#   bash:
#     cd c:/Users/admin/Documents/Git/Owlette/agent && cmd //c "build_installer_full.bat" < /dev/null > /tmp/installer-build.log 2>&1
#     # (if //c gets mangled by Git Bash, fall back to the powershell cmd /c form above)
#
# DO NOT use `cd agent && powershell -Command "& './build_installer_full.bat'"` —
# the trailing pause will hang non-interactive shells indefinitely.
# Output: agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

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
#   node scripts/refresh-docs-screens.mjs --check
#
# ...compares that record against VERSION and exits non-zero when stale, so "did we
# recapture?" is answerable mechanically instead of remembered.
#
# Needs an interactive desktop session with the owlette tray icon VISIBLE. If it sits
# in the hidden-icons overflow, the tray-menu shot fails while the other eleven
# succeed - turn it on under taskbar settings > other system tray icons.
# `git diff --stat web/public/docs-screens` is the check; no diff is a valid result.
#
# Needs an interactive desktop session with the owlette tray icon visible on the
# taskbar (the tray-menu shot is captured by UI Automation, not CDP). It kills
# and replaces the tray for the duration and restores the window layout after;
# the service re-spawns a tray within 30 s. `git diff --stat web/public/docs-screens`
# is the check — no diff means nothing user-visible changed, which is a valid
# result. See web/e2e/desktop-screenshots/README.md.

# 4. Compute checksum
sha256sum agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# 5. Upload via API (3-step: request URL → upload binary → finalize)
# Endpoint is `/api/installer/upload` (api-sprint route — old `/api/admin/installer/upload` was removed).
# Auth: api key with `installer=*:write` scope (superadmin-only at minting). `x-api-key` or `Authorization: Bearer owk_…` both work.
# Idempotency-Key REQUIRED on both POST and PUT — the route is wrapped in `withIdempotency(..., { requireKey: true })`.
API_KEY=$(grep OWLETTE_API_KEY .claude/.env.local | cut -d= -f2)
BASE_URL="https://dev.owlette.app"  # or https://owlette.app for prod

# Step 5a: Get signed upload URL
curl -s -X POST "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-upload-X.Y.Z-$(date +%s)" \
  -d '{"version":"X.Y.Z","fileName":"Owlette-Installer-vX.Y.Z.exe","releaseNotes":"...","setAsLatest":true}'
# → returns uploadUrl, uploadId, storagePath, expiresAt (15-min window)

# Step 5b: Upload binary to the signed GCS URL (no Idempotency-Key here — it's a direct GCS PUT)
curl -X PUT "$UPLOAD_URL" -H "Content-Type: application/octet-stream" \
  --data-binary @agent/build/installer_output/Owlette-Installer-vX.Y.Z.exe

# Step 5c: Finalize (verifies file in storage, computes/checks checksum, writes installer_metadata, sets as latest)
curl -s -X PUT "$BASE_URL/api/installer/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "Idempotency-Key: installer-finalize-X.Y.Z-$(date +%s)" \
  -d '{"uploadId":"<from step 5a>","checksum_sha256":"<sha256 from earlier>"}'
# checksum_sha256 is optional — server computes it if omitted, but providing it gets a 412 `checksum_mismatch` on corruption.
```

---

## Critical Rules

### Do
- Run full build first before quick build (creates Python runtime + deps)
- Use `build_installer_quick.bat` for source-only changes during development
- Test with `python owlette_service.py debug` before building installer
- Check `agent/VERSION` matches `/VERSION` before release

### Don't
- **Never edit `owlette_installer.iss`** without reading `skills/resources/installer-build-system.md` first — the config backup/restore logic, OAuth flow, and silent install behavior are interconnected
- **Never change the install path** from `C:\ProgramData\Owlette` — service registration, the host's own path resolution (it locates the install root two directories above `tools\owlette-host.exe`), and the Inno Setup script all use this via `{commonappdata}`
- **Never modify `python311._pth`** without understanding embedded Python import resolution — breaking this kills all imports
- **Never weaken the PawnIO version gate or its silent flags** — the installer must ship PawnIO >= 2.2.0 (2.1.0 BSOD/boot-loops Win10 1809/LTSC machines, and it is the version LHM itself still embeds), and `-install -silent` is what keeps the SYSTEM self-update path from hanging on an invisible dialog. The old WinRing0 Defender exclusions are now actively *retracted* by the `[Run]` step — never re-add them.
- **Never change the child exit-code contract** — 0 = stop the service (graceful stop), 42/43 = relaunch immediately (restart flag, self-restart watchdog), anything else = relaunch with crash-loop backoff. `owlette_runner.py` and `agent/host/src/supervisor.rs` are the two halves of it; changing one without the other silently breaks restarts.
- **Never drop `AppUserModelID: "app.owlette.desktop"`** from the two `[Icons]` entries that carry it (`{group}\Owlette` and `{userstartup}\Owlette`). Windows silently discards every toast an unpackaged app raises unless a Start-menu shortcut registers its AUMID — the notification API still reports success. The id must stay byte-identical to `tauri.conf.json`'s `identifier` and `startup_link.rs`'s `APP_USER_MODEL_ID`.
- **Never add the AUMID to a third shortcut, and never rename either of those two.** Windows draws a toast's attribution line from the *name* of a registered shortcut and does not specify which it picks when several share an id — that is why `Owlette Configuration` carries no id and why the startup shortcut is `Owlette.lnk`. Both registrars must be named exactly `Owlette` or notifications get attributed to something else.
- **Never let the Tauri bundler run** (`tauri build` without `--no-bundle`) — it wants NSIS/WiX and builds an installer that competes with ours.

---

## Key Files

| File | Purpose | Danger Level |
|------|---------|-------------|
| `owlette_installer.iss` | Inno Setup script — install/uninstall/upgrade logic, WebView2 check | High |
| `build_installer_full.bat` | Downloads Python, pip, deps; builds the desktop app and the service host; assembles package | Medium |
| `build_installer_quick.bat` | Copies source + desktop exe, compiles installer (fast iteration) | Low |
| `desktop/` | Tauri 2 app — tray icon, config window, reboot prompt (replaced the python UI in 3.0.0) | Medium |
| `agent/vendor/` | Hash-verified third-party binaries shipped with the build (the WebView2 bootstrapper and the PawnIO 2.2.0 driver installer; the NSSM zip went with 3.0.0) | Low |
| `scripts/install.bat` | Service registration — calls `owlette-host install` (run during install) | High |
| `src/owlette_runner.py` | Host↔service bridge, SCM stop watcher, exit codes | High |
| `src/owlette_updater.py` | Self-update: stop → download → silent install → verify | High |
| `src/configure_site.py` | OAuth registration during install (localhost:8765) | Medium |
| `src/installer_utils.py` | Remote installer download/execute for deployments | Medium |
| `scripts/sync-versions.js` | Bumps version across all version files | Low |

---

## Self-Update Flow

```
Web dashboard sends update_owlette command
  → the installer is launched as a SYSTEM scheduled task (it must outlive the
    service it is about to stop)
  → Downloads new installer (3 retries, exponential backoff)
  → Validates file (size > 1KB, PE header)
  → Runs: installer.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS
  → Silent mode skips OAuth (ShouldConfigureSite = false when config exists)
  → install.bat re-registers the service (`owlette-host install`) and starts it
  → Verifies service running after 10s
```

**Safety**: If the update fails, the old installation is untouched and the service host restarts the agent from whatever is on disk.

---

## Config Backup During Upgrades

The installer handles config preservation:
1. `BackupConfigIfExists()` → copies to `%TEMP%\config.json.backup`
2. Files overwritten during install
3. `RestoreConfigIfBackedUp()` → restores UNLESS:
   - `DidRunOAuth == True` → keep fresh OAuth config (never overwrite new auth)
   - `WizardSilent() == True` → skip restore, agent syncs from Firestore

**This is the most fragile part of the build system.** Changing the backup/restore order or conditions can break upgrades.

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "cargo not found on PATH" | Rust toolchain missing (or installed outside `%USERPROFILE%\.cargo`) | `rustup` install, or put cargo on PATH |
| Quick build fails | No Python runtime in `build/` | Run full build first |
| Quick build: "No desktop app in the installer package" | Never ran a full build, or `desktop/src-tauri/target` was cleaned | Full build, or `cd desktop && npx tauri build --no-bundle` |
| ISCC: "No files found matching ...\app\*" | Same as above — the desktop exe never made it into the package | Same as above |
| Desktop app never opens on a kiosk, service fine | WebView2 runtime absent and the bootstrapper failed | Check `SetupLog` for the `EnsureWebView2Runtime` lines |
| Installer hangs on silent update | `ShouldConfigureSite()` returned true | Check config.json exists at `C:\ProgramData\Owlette\config\` |
| Service won't start after update | Import errors from missing deps | Full rebuild needed |
| CPU temps blank, GPU temps fine | PawnIO driver absent or failed to install | Check `SetupLog` for the `EnsurePawnIO` lines; `Get-Service PawnIO`; `winget install namazso.PawnIO` |

---

## When This Skill Activates

Working on build scripts, installer config, version management, the service host (`agent/host`), or self-update code.
