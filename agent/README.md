# owlette agent

The owlette agent is the Python service that runs on every managed machine. It keeps the configured processes running, reports metrics and status to Firestore, and carries out commands from the dashboard, the API, talons and hoot. It runs on three platforms, packaged as one installer per platform:

| platform | runs as | installer |
|----------|---------|-----------|
| Windows 10 or later, 64-bit | `OwletteService`, a Windows service hosted by `owlette-host.exe` (Rust, [`host/`](host/)) | `Owlette-Installer-v<version>.exe` (Inno Setup) |
| macOS 15 or later, Apple silicon | `app.owlette.agent`, a launchd daemon | `Owlette-Installer-v<version>.pkg` |
| Linux, Ubuntu 24.04 | `owlette-agent.service`, a systemd unit | `Owlette-Installer-v<version>.deb` |

Every installer also ships the desktop app (`../desktop/`), the local window and tray or menu bar icon, and bundles its own Python 3.11 runtime, so a target machine needs no system Python.

## Features

- **Process supervision**: launch modes (off, always on, scheduled), relaunch on crash, "not responding" detection on Windows, and a machine restart once a process runs out of relaunch attempts
- **Metrics and status**: CPU, memory, disk, GPU and network, plus temperatures where the platform reports them (CPU on Windows, GPU on Windows and NVIDIA on Linux), on an adaptive heartbeat (5 s with the desktop window open, 30 s while processes run, 120 s idle)
- **Remote commands**: start, stop, restart and kill processes, restart or shut down the machine, capture screenshots
- **swoop**: hosts remote desktop sessions through the streamer in [`swoop/`](swoop/) (Rust) on Windows and macOS; the Linux package does not ship the streamer yet
- **roost**: downloads content-addressed chunks, verifies each by SHA-256, and assembles versions atomically into allowlisted destinations
- **Software deployment**: silent installs with checksum verification (Windows), and self-update on all three platforms
- **Machine care**: scheduled restarts, display layout capture and restore (Windows), keep screens awake
- **hoot tools**: the tool surface hoot calls on the machine (`mcp_tools.py`, with `tools_windows.py` and `tools_posix.py`), and the local hoot process (`owlette_cortex.py`)
- **Resilience**: works offline from the cached config, reconnects through one connection manager with backoff and a circuit breaker, and restarts itself when a connection stays stuck
- **Device-code pairing**: joins a site with a 3-word phrase; tokens are stored encrypted and bound to the machine

## Installing

Use the installer for the machine's platform from the dashboard, or from [owlette.app/download](https://owlette.app/download). The [installation guide](https://owlette.app/docs/agent/installation) covers interactive, silent (`/ADD=`, Windows) and preseeded (macOS, Linux) installs, pairing, verification and uninstalling. [INSTALLER-USAGE.md](INSTALLER-USAGE.md) documents the Windows installer's flags.

## Where things live

| | Windows | macOS | Linux |
|---|---|---|---|
| data root (config, logs, tokens) | `C:\ProgramData\Owlette` | `/Library/Application Support/Owlette` | `/var/lib/owlette` |
| runtime (Python + `agent/src`) | `C:\ProgramData\Owlette\python`, `agent\src` | `/Library/Application Support/Owlette/runtime` | `/opt/owlette` |
| service definition | `OwletteService`, registered by `tools\owlette-host.exe` | `/Library/LaunchDaemons/app.owlette.agent.plist` | `/usr/lib/systemd/system/owlette-agent.service` |
| desktop app | `C:\ProgramData\Owlette\app\owlette-desktop.exe` | `/Applications/owlette.app`, started by the `app.owlette.desktop` LaunchAgent | `/usr/bin/owlette-desktop`, started by the `owlette-desktop.service` user unit |
| swoop streamer | `C:\ProgramData\Owlette\swoop\owlette-swoop.exe` | inside `owlette.app` | not shipped |

Under the data root: `config/config.json` (the configuration), `logs/service.log` (the agent's log), and `.tokens.enc` (the encrypted tokens; never copy it to another machine, re-pair instead). `OWLETTE_DATA_ROOT` moves the agent's whole data tree on any platform; the test suite uses it.

## Configuration

`config/config.json` holds the process list and the machine's settings. The desktop app and the dashboard both edit it, and the agent keeps it in sync with Firestore, so prefer either of those to editing the file. The [configuration guide](https://owlette.app/docs/agent/configuration) documents every field, including the process schema (`launch_mode`, `schedules`, `relaunch_attempts`, `priority`, `visibility`).

Never change the `firebase` section yourself: it is what ties the machine to its site, and pairing writes it.

---

## Development

Python 3.11 matches what ships (Windows embeds 3.11.8; macOS and Linux bundle python-build-standalone 3.11). 3.10 is the floor: `requirements.txt` no longer resolves below it. Platform-only dependencies (`pywin32`, `wmi`, the hardware monitor) carry `sys_platform` markers, so the same files install everywhere.

### Set up the venv

Everything Python runs on `agent/.venv`.

Windows, from the repo root:

```powershell
powershell -File scripts\bootstrap-windows.ps1 -InstallAgentDeps
```

It checks the toolchain, creates `agent\.venv` with `py -3.11`, and installs `requirements.txt` and `requirements-dev.txt`; rerun it to bring an existing venv up to the current pins. There is no bootstrap script for macOS or Linux; create the venv by hand:

```bash
python3.11 -m venv agent/.venv
agent/.venv/bin/python -m pip install -r agent/requirements.txt -r agent/requirements-dev.txt
```

### Run the tests

From the repo root, so `agent/pytest.ini` applies (strict markers, warnings as errors):

```bash
agent/.venv/Scripts/python -m pytest agent/tests/          # Windows
```

On macOS and Linux, point the data root somewhere writable and skip the Windows-only modules, exactly as CI does ([`.github/workflows/agent-tests.yml`](../.github/workflows/agent-tests.yml)):

```bash
OWLETTE_DATA_ROOT=/tmp/owlette-data agent/.venv/bin/python -m pytest agent/tests/ \
  --ignore=agent/tests/test_apply_topology.py \
  --ignore=agent/tests/test_display_helper.py \
  --ignore=agent/tests/unit/test_display_enumeration_gate.py \
  --ignore=agent/tests/unit/test_display_manager.py \
  --ignore=agent/tests/integration/test_swoop_wiring.py
```

CI runs the unit suite on Windows, macOS and Linux on every change under `agent/`, plus the roost sync engine against an S3 stand-in. Tests that need Windows inside an otherwise portable module are marked `@pytest.mark.windows` and report as skipped elsewhere.

### Run the agent from source

```bash
cd agent/src
../.venv/Scripts/python owlette_runner.py --debug     # Windows, from an administrator shell
sudo ../.venv/bin/python owlette_runner.py --debug    # macOS, Linux, as root
```

`--debug` runs the service loop in the foreground and logs at DEBUG level to the console as well as `logs/service.log`. It uses the same data root as an installed agent, so stop the installed service first. `owlette_runner.py` is also what every service definition starts; `owlette_service.py` takes no service verbs.

### Iterate against an installed agent (Windows)

Under Claude Code, the `.claude/hooks/deploy-agent.mjs` hook copies each edited `agent/src/*.py` into `C:\ProgramData\Owlette\agent\src\`. It copies unelevated, so after each agent install grant your account write access once, from an elevated prompt:

```powershell
powershell -File scripts\bootstrap-windows.ps1 -DevGrant      # -RemoveDevGrant reverts it
```

Then restart the service to load the change: close the desktop app by the PID in `C:\ProgramData\Owlette\tmp\tray.pid`, then `net stop OwletteService && net start OwletteService` from an elevated prompt. The service relaunches the desktop app on its next status check.

### Versions

`agent/VERSION` is the agent's version. Bump every version file in the repo at once:

```bash
node scripts/sync-versions.js X.Y.Z
```

The agent reads `VERSION` at runtime (`shared_utils.APP_VERSION`) and reports it on registration; the build scripts put it in the installer's file name.

---

## Building installers

Each platform builds on its own OS. Bump the version and add the `docs/changelog.md` entry, and commit, **before** building: every build bakes the version into the file name and the payload.

### Windows (.exe)

Prerequisites: Node.js 22, the Rust toolchain (rustup) with the MSVC C++ build tools, CMake (the swoop streamer builds libopus; the one inside Visual Studio is found automatically), and Inno Setup 6 (`%ISCC%`, `iscc` on PATH, or the default install path). The build downloads and verifies its own embedded Python. `scripts/bootstrap-windows.ps1` checks all of these.

```cmd
cd agent
build_installer_full.bat     :: everything: Python, dependencies, desktop app, owlette-host, swoop streamer (~5-10 min)
build_installer_quick.bat    :: after a full build: re-copies the agent source and recompiles the installer (~30 s)
```

Both write `build\installer_output\Owlette-Installer-v<version>.exe`. The scripts end with `pause`, so from a non-interactive shell redirect stdin: `cmd /c "<repo>\agent\build_installer_full.bat < NUL > %TEMP%\installer-build.log 2>&1"`. [BUILD.md](BUILD.md) has the full step list, testing and common issues.

### macOS (.pkg)

On an Apple silicon Mac with the Command Line Tools, Node.js, Rust and CMake:

```bash
agent/build/macos/build.sh [--skip-app] [--installer-identity "Developer ID Installer: …"] [--notarize <keychain-profile>]
```

It bundles a python-build-standalone runtime, builds the desktop app (`tauri build --bundles app`) with the swoop streamer as its sidecar, and writes `agent/build/macos/Owlette-Installer-v<version>.pkg`. Unsigned by default; with `APPLE_SIGNING_IDENTITY` in the environment the runtime and app are signed, and the notary flags notarize and staple the package. A release build must be signed: an ad-hoc app loses its Screen Recording grant on every update. The script header documents every flag.

### Linux (.deb)

On the architecture you package for (x86_64 or aarch64), with the Tauri build dependencies, Node.js and Rust:

```bash
agent/build/linux/build.sh [--skip-app]
```

It bundles the runtime under `/opt/owlette`, builds the desktop app (`tauri build --bundles deb`), merges it into one `owlette-agent` package with the systemd units and the polkit rule, and writes `agent/build/linux/Owlette-Installer-v<version>.deb`. No root needed.

### CI and release

Pushing a `vX.Y.Z` tag runs [`.github/workflows/build-installer.yml`](../.github/workflows/build-installer.yml): it builds all three installers on GitHub-hosted runners, signs and notarizes the pkg, and attaches the files with one SLSA Build Level 3 provenance attestation to the GitHub release. That rolls nothing out: agents see a version only once it is uploaded and finalized with `scripts/upload-installer.mjs`. The whole procedure is in [docs/runbooks/agent-installer-release.md](../docs/runbooks/agent-installer-release.md).

---

## Service management

### Windows

`owlette-host.exe` replaced NSSM in 3.0.0. It runs `python.exe agent\src\owlette_runner.py`, relaunches it at once when it exits with 42 (a restart the desktop app asked for) or 43 (the stuck-connection watchdog), restarts it with backoff when it crashes, and stops it by reporting STOP_PENDING and waiting. It never kills the child's process tree, so managed processes and the desktop app survive a service restart.

```cmd
net stop OwletteService
net start OwletteService
sc query OwletteService

C:\ProgramData\Owlette\tools\owlette-host.exe status     :: 0 running, 3 installed but stopped, 4 not installed
C:\ProgramData\Owlette\tools\owlette-host.exe start
C:\ProgramData\Owlette\tools\owlette-host.exe stop
```

`status` also prints the registered image. `scripts\install.bat` re-registers the service on a machine with the packaged layout, and `owlette-host.exe uninstall` removes it. Never run `python owlette_service.py install`: it would register a second, competing service.

### macOS

```bash
sudo launchctl print system/app.owlette.agent          # state and pid
sudo launchctl kickstart -k system/app.owlette.agent   # restart
sudo launchctl bootout system/app.owlette.agent        # stop
sudo launchctl bootstrap system /Library/LaunchDaemons/app.owlette.agent.plist   # start after a stop
```

The daemon carries `KeepAlive`, so launchd relaunches it if it is signalled; stopping it means `bootout`.

### Linux

```bash
systemctl status owlette-agent
sudo systemctl restart owlette-agent
journalctl -u owlette-agent
```

`KillMode=process`: stopping the service leaves the applications it started running. Members of the `owlette` group, which the package adds the installing user to, may start, stop and restart this one unit without a password (the polkit rule `49-owlette.rules`).

## Logs

| | Windows | macOS | Linux |
|---|---|---|---|
| agent | `C:\ProgramData\Owlette\logs\service.log` | `/Library/Application Support/Owlette/logs/service.log` | `/var/lib/owlette/logs/service.log` |
| service host / stdio | `service_host.log` (spawns, exit codes, backoff), `service_stdout.log`, `service_stderr.log` | `logs/launchd-agent.log` | `journalctl -u owlette-agent` |

The desktop app keeps its own per-user log; see [desktop/README.md](../desktop/README.md#logs).

## Troubleshooting

- **The service will not start**: read the agent log and the service host or stdio log above. On Windows, confirm `owlette-host.exe status`; on macOS and Linux, `launchctl print` or `systemctl status`.
- **Processes will not launch**: check the paths in the process settings and the agent log. The agent runs as SYSTEM or root but launches processes as the user signed in at the machine, so with nobody signed in it cannot launch them.
- **The machine does not reach the dashboard**: confirm pairing finished (the desktop app's footer names the site), the machine has internet access, and the log shows no authentication errors. To re-pair, use **join site** in the desktop app, or run `configure_site.py` from the installed runtime.

The [agent troubleshooting guide](https://owlette.app/docs/agent/troubleshooting) goes further.

## Layout

```
agent/
├── src/                        # the agent (see below)
├── tests/                      # pytest: unit/, integration/, lifecycle/
├── host/                       # owlette-host, the Windows service host (Rust)
├── swoop/                      # owlette-swoop, the remote-desktop streamer (Rust); PROTOCOL.md is the wire contract
├── packaging/                  # macos/ (launchd plists, pkg scripts) and linux/ (systemd units, debian scripts, polkit rule)
├── build/macos/build.sh        # macOS .pkg build
├── build/linux/build.sh        # Linux .deb build
├── build_installer_full.bat    # Windows full build
├── build_installer_quick.bat   # Windows quick rebuild
├── owlette_installer.iss       # Inno Setup script
├── scripts/                    # install.bat / uninstall.bat, shipped in the Windows install
├── vendor/                     # WebView2 bootstrapper and PawnIO driver installer, bundled by the Windows build
├── requirements.txt            # runtime dependencies, with sys_platform markers
├── requirements-dev.txt        # pytest and tooling
├── config.template.json        # starting config
└── VERSION                     # the agent's version
```

Inside `src/`, by area:

- **service**: `owlette_runner.py` (entry point), `owlette_service.py` (main loop and process supervision), `shared_utils.py` (paths, config I/O, constants), `osadapter/` (the one seam to the operating system: `win.py`, `darwin.py`, `linux.py`, `posix.py`)
- **cloud**: `firebase_client.py`, `firestore_rest_client.py` (Firestore over REST; there is no Admin SDK), `connection_manager.py` (reconnects, backoff, circuit breaker), `auth_manager.py` and `secure_storage.py` (tokens), `configure_site.py` (pairing and leaving a site), `config_sync.py`
- **commands**: `command_router.py`, `process_commands.py`, `machine_commands.py`, `site_commands.py`, `installer_utils.py` (deployments and self-update), `screenshot_capture.py`
- **roost**: `sync_commands.py`, `sync_version.py`, `sync_downloader.py`, `sync_assembler.py`, `sync_state.py`, `sync_scrub.py`, `destination_allowlist.py`, `roost_kill_switch.py`
- **swoop**: `swoop_manager.py`, `swoop_commands.py`, `swoop_doorbell.py`, `swoop_capability.py`, `swoop_spawn.py`, `swoop_spawn_posix.py`
- **hoot**: `mcp_tools.py`, `tools_windows.py`, `tools_posix.py`, `owlette_cortex.py`, `cortex_firestore.py`, `cortex_tools.py`, `cortex_cli_fetch.py`
- **machine**: `hardware_profile.py`, `temp_sensors.py`, `owlette_scout.py`, `display_manager.py`, `nvapi_display.py`, `keep_awake.py`, `reboot_state.py`, `session_state.py`, `watchdog_state.py`, `health_probe.py`, `acl_hardening.py`, `registry_utils.py`

## More documentation

- [platform support](https://owlette.app/docs/reference/platform-support): every feature that differs between Windows, macOS and Linux
- [BUILD.md](BUILD.md): building and testing the Windows installer
- [INSTALLER-USAGE.md](INSTALLER-USAGE.md): Windows installer flags, environments and pairing
- [owlette.app/docs/agent](https://owlette.app/docs/agent): the published agent guide
- [docs/maintainer-quickstart.md](../docs/maintainer-quickstart.md): first-time setup for the whole repo

## License

See [LICENSE](../LICENSE) in the root directory.
