; Owlette Installer Script for Inno Setup
; ============================================================================
; This script creates a professional Windows installer for Owlette
; Requires: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
; ============================================================================
;
; AUTHENTICATION:
; ---------------
; This installer uses device code / QR pairing authentication.
; The agent displays a 3-word pairing phrase and QR code. The user
; authorizes from their phone, the dashboard, or via /ADD= for bulk deploy.
; Tokens are encrypted in C:\ProgramData\Owlette\.tokens.enc.
;
; PAIRING FLOW:
; -------------
; Method 1 (QR Code - interactive):
;   1. Installer runs configure_site.py (displays QR code + pairing phrase)
;   2. User scans QR with phone → owlette.app/add → selects site → authorizes
;   3. Agent polls for authorization, receives tokens
;
; Method 2 (Dashboard - manual):
;   1. Installer displays pairing phrase (e.g., "silver-compass-drift")
;   2. User enters phrase on dashboard → "+" button → "Enter Code"
;
; Method 3 (Silent - bulk deploy):
;   1. Admin generates phrase on dashboard → "+" button → "Generate Code"
;   2. Run: Owlette-Installer.exe /ADD=silver-compass-drift /SILENT
;
; SECURITY:
; ---------
; - No browser login required on target machine
; - Pairing phrases: 3 words, 10-minute expiry, single-use
; - Tokens can be revoked via web dashboard
; - Access token: 1 hour expiry (auto-refreshes)
; - Refresh token: never expires (admin-revocable, stored encrypted)
;
; BUILD PARAMETERS:
; -----------------
; /SERVER=prod  → Uses owlette.app (production) — DEFAULT when /SERVER is omitted
; /SERVER=dev   → Uses dev.owlette.app (development)
;
; Example:
;   Owlette-Installer-v2.0.0.exe /SERVER=prod
; ============================================================================

; VERSION MANAGEMENT
; ------------------
; Version is read from VERSION file at build time (passed via /DMyAppVersion=X.X.X)
; If not provided, defaults to reading from VERSION file via ReadIni workaround
; To bump version: Edit agent/VERSION file and rebuild
; Build script (build_embedded_installer.bat) validates VERSION file exists and passes it here

#ifndef MyAppVersion
  #define MyAppVersion GetEnv("OWLETTE_VERSION")
  #if MyAppVersion == ""
    ; fallback should match /VERSION - bump on every release
    #define MyAppVersion "2.12.21"
    #pragma message "WARNING: Using fallback version 2.12.21 - VERSION file not found or OWLETTE_VERSION not set"
  #endif
#endif

#define MyAppName "Owlette"
#define MyAppPublisher "Tridant Inc."
#define MyAppURL "https://owlette.app"
#define MyAppRepoURL "https://github.com/tridant-io/owlette"
; The desktop app (Tauri) is the product's face as of 3.0.0 — it replaced the
; pythonw-hosted tray and configuration GUI. Installed to {app}\app.
#define MyAppExeName "owlette-desktop.exe"
#define MyAppExePath "{app}\app\owlette-desktop.exe"
; Registered on the Start-menu shortcuts below. Windows silently DROPS toast
; notifications from an unpackaged app whose AppUserModelID is not registered by
; a Start-menu shortcut — the notification API still returns success and nothing
; appears. Must stay byte-identical to `identifier` in desktop/src-tauri/
; tauri.conf.json and APP_USER_MODEL_ID in desktop/src-tauri/src/startup_link.rs.
#define MyAppUserModelID "app.owlette.desktop"

[Setup]
; NOTE: The value of AppId uniquely identifies this application.
; Do not use the same AppId value in installers for other applications.
AppId={{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={commonappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
LicenseFile=..\LICENSE
OutputDir=build\installer_output
OutputBaseFilename=Owlette-Installer-v{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
CloseApplications=force
RestartApplications=no
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\agent\icons\normal.png
SetupIconFile=icons\normal.ico
SetupLogging=yes
; Windows file-properties metadata. Without VersionInfoVersion the compiler
; stamps the exe's File version as 0.0.0.0 - it is not inherited from
; AppVersion, which only feeds Product version.
VersionInfoVersion={#MyAppVersion}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoCopyright=Copyright (C) Tridant Inc.
DisableProgramGroupPage=yes
; Silent mode enhancements - prevent ALL prompts when run as SYSTEM
AlwaysShowDirOnReadyPage=no
DisableWelcomePage=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
FinishedLabel=Setup has finished installing [name] on your computer.%n%nThe Owlette service and tray icon will start automatically within a few moments. Look for the Owlette icon (a dot in a circle) in your taskbar—it may be hidden under the overflow menu (^).%n%nIf this machine is not paired yet, finish pairing in the Owlette window that opened, or open Owlette from the Start menu.

[Tasks]
; Desktop icons removed - tray icon auto-starts on login via startup folder

[Files]
; Python runtime
Source: "build\installer_package\python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs createallsubdirs

; Agent source code
Source: "build\installer_package\agent\*"; DestDir: "{app}\agent"; Flags: ignoreversion recursesubdirs createallsubdirs

; Desktop app (Tauri) — the tray icon, configuration window and reboot prompt.
; shared_utils.get_desktop_exe_path() resolves exactly this path, so the
; directory name is a contract with the service, not a preference.
Source: "build\installer_package\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

; WebView2 Evergreen bootstrapper. Never installed — `dontcopy` keeps it out of
; {app} and EnsureWebView2Runtime() extracts it to {tmp} only on the machines
; that actually need it (see [Code]). Vendored rather than downloaded at build
; time for the same reason as vendor\nssm-2.24.zip: a build must not depend on
; someone else's host being up. `*.exe` is gitignored with a negation for this
; one path — see /.gitignore.
;
;   Source:  https://go.microsoft.com/fwlink/p/?LinkId=2124703  (the documented
;            "Get the Link" evergreen bootstrapper URL)
;   Version: 1.3.251.23, 1,695,960 bytes
;   SHA256:  8C4A80540B6BBCBEF30A4E8C7D1AC504B6FC09DB922B4ACDFD85C9D5F6F1050E
;   Signed:  CN=Microsoft Corporation (Authenticode verified at vendor time)
;
; To refresh: re-download from that link, re-verify the signature, and update
; the three lines above. The bootstrapper pulls the current runtime at install
; time, so refreshing it is housekeeping, not a security-critical update.
Source: "vendor\MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy

; PawnIO driver installer. Same `dontcopy` + ExtractTemporaryFile pattern as the
; WebView2 bootstrapper above: EnsurePawnIO() (see [Code]) runs it only when the
; installed version is older than the vendored one. PawnIO is the signed,
; sandboxed ring-0 driver LibreHardwareMonitor 0.9.6 uses for temperature
; sensors — it replaced the blocklisted WinRing0 driver that WinTmp's bundled
; LHM extracted at runtime as {app}\python\python.sys (service R0python).
; MUST stay >= 2.2.0: 2.1.0 (the build LHM itself embeds) BSOD/boot-loops
; Windows 10 1809/LTSC-class machines. `*.exe` is gitignored with a negation
; for this one path — see /.gitignore.
;
;   Source:  https://github.com/namazso/PawnIO.Setup/releases  (v2.2.0)
;   Version: 2.2.0, 3,410,960 bytes
;   SHA256:  1F519A22E47187F70A1379A48CA604981C4FCF694F4E65B734AAA74A9FBA3032
;            (matches the winget manifest for namazso.PawnIO 2.2.0)
;   Signed:  CN=namazso.eu (Authenticode verified at vendor time); the driver
;            catalogs inside carry Microsoft Hardware Dev Center signatures.
;
; To refresh: re-download the release, re-verify hash + signature against the
; winget manifest, and update the three lines above. Silent CLI contract:
; `-install -silent`, exit 0 = ok, 183 = already installed, 3010 = installed
; but a reboot is required.
Source: "vendor\PawnIO_setup.exe"; Flags: dontcopy

; Tools — owlette-host.exe, the Windows service host (replaced NSSM in 3.0.0)
Source: "build\installer_package\tools\*"; DestDir: "{app}\tools"; Flags: ignoreversion

; swoop — owlette-swoop.exe, the remote-session streamer the service spawns.
; shared_utils.get_swoop_exe_path() resolves exactly this path, so the directory
; name is a contract with the service, not a preference, and the installer is
; the only thing that creates it. Its ACL is set in [Code] at ssPostInstall —
; [Dirs]' Permissions: parameter cannot express it (see CurStepChanged).
Source: "build\installer_package\swoop\*"; DestDir: "{app}\swoop"; Flags: ignoreversion

; Scripts
Source: "build\installer_package\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion

; README, documentation, and Cortex constitution
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "CLAUDE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

; Third-party attribution. THIRD_PARTY_NOTICES.md carries the MPL-2.0/LGPL-2.1
; notices and source offers the temperature stack's licenses require of a
; binary redistributor; LGPL-2.1.txt is the full text (the MPL and BSD texts
; already ship inside the HardwareMonitor wheel — see the notices file).
Source: "THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "vendor\LGPL-2.1.txt"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Create ProgramData directories (proper location for Windows service data)
Name: "{commonappdata}\Owlette"; Permissions: users-modify
Name: "{commonappdata}\Owlette\config"; Permissions: users-modify
Name: "{commonappdata}\Owlette\logs"; Permissions: users-modify
Name: "{commonappdata}\Owlette\cache"; Permissions: users-modify
Name: "{commonappdata}\Owlette\tmp"; Permissions: users-modify
; ipc keeps users-modify: the console user writes the cortex command queue, and
; the service tightens the cortex_* trio to a protected DACL at start-up.
Name: "{commonappdata}\Owlette\ipc"; Permissions: users-modify
; content and update-staging are service-owned. No users-modify here:
; HardenInstallTree() (see [Code]) strips inheritance and grants SYSTEM +
; Administrators only at ssPostInstall.
Name: "{commonappdata}\Owlette\content"
Name: "{commonappdata}\Owlette\update-staging"

[InstallDelete]
; Dead log files from the deleted python UI (owlette_gui/owlette_tray/
; report_issue were removed in 3.0.0) — the wildcard also catches their
; rotation siblings (.log.1 … .log.5). Live logs are never named here.
Type: files; Name: "{commonappdata}\Owlette\logs\gui.log*"
Type: files; Name: "{commonappdata}\Owlette\logs\tray.log*"
Type: files; Name: "{commonappdata}\Owlette\logs\report_issue.log*"
; Clean up shortcuts from earlier versions that have since been renamed, so an
; upgrade doesn't leave a confusing duplicate in the Start menu. The single
; Start-menu tray entry is now "{group}\Owlette" (it was "Owlette Tray Icon"),
; and the user clicks it to launch/resume owlette. Runs before [Icons] are
; (re)created, so the canonical "Owlette" shortcut below is unaffected.
Type: files; Name: "{group}\Owlette Tray Icon.lnk"
; Also remove the legacy DESKTOP tray shortcut left by installs that opted into
; the long-removed "desktopicon" task (it pointed at launch_tray.bat). Exact
; name, no wildcard — a harmless no-op when absent, and it can't touch a
; user-created desktop shortcut of any other name.
Type: files; Name: "{autodesktop}\Owlette Tray Icon.lnk"
; 3.0.0: the three shortcuts below all changed target — they used to run
; pythonw.exe against owlette_gui.py / owlette_tray.py (both deleted) via the
; scripts\launch_*.bat hops (also deleted). Delete them rather than let [Icons]
; rewrite them in place, so no shell-cached target or AppUserModelID from the
; 2.x shortcut can survive the upgrade. [InstallDelete] runs before [Icons], so
; each one is immediately recreated below.
Type: files; Name: "{group}\Owlette Configuration.lnk"
Type: files; Name: "{group}\Owlette.lnk"
; The startup shortcut was "Owlette Tray.lnk" through 2.x and the first 3.0.0
; builds; it is "Owlette.lnk" now (see [Icons]), so the old name has to go or the
; machine keeps two startup entries — and the stale one is a second candidate
; source for the toast attribution line, which is exactly what the rename fixes.
Type: files; Name: "{userstartup}\Owlette Tray.lnk"

; ---------------------------------------------------------------------------
; 3.0.0 upgrade pruning — the python UI stack and the modules that served it.
;
; The upgrade strategy is "overwrite in place" (see InitializeSetup): [Files]
; only ever ADDS, so everything an older payload laid down and this one no
; longer ships simply stays on disk forever. On a machine upgraded from 2.x
; that is ~13 MB of Tcl/Tk, tkinter, customtkinter and friends, plus the deleted
; agent modules and their bytecode — code nothing imports, that a fleet-wide
; vulnerability scan still has to account for, and that makes the installed tree
; disagree with the shipped one.
;
; Every path below is provably an orphan: none of them exists in
; build\installer_package after a clean full build (the Tcl/Tk copy step and the
; GUI requirements were both removed in 3.0.0). [InstallDelete] runs BEFORE the
; file copy, so even if a future payload reintroduced one it would be laid back
; down a moment later — this can strip a file out of an install but never out of
; a release.
;
; Nothing here touches user data: config\, logs\, cache\, tmp\ and .tokens.enc
; are never named. Nor is
; python\Lib\site-packages\claude_agent_sdk\_bundled\claude.exe — the 242 MB CLI
; that build_installer_full.bat strips from the payload but which survives on
; machines that installed it earlier, where Cortex uses it in place of
; downloading its own copy.

; Tcl/Tk runtime. The 2.x build copied these in from the system Python 3.11 so
; tkinter would have a toolkit; the 3.11.8 embeddable zip we ship contains none
; of them.
Type: filesandordirs; Name: "{app}\python\tcl"
Type: files; Name: "{app}\python\tcl86t.dll"
Type: files; Name: "{app}\python\tk86t.dll"
; The extension module sits at the interpreter root — an embeddable layout has
; no DLLs\ directory.
Type: files; Name: "{app}\python\_tkinter.pyd"
Type: filesandordirs; Name: "{app}\python\Lib\tkinter"

; The python UI's packages, dropped from requirements.txt in 3.0.0 when the
; Tauri app replaced the tray and configuration windows. Version-wildcarded
; .dist-info so this also cleans machines that stopped at an older pin.
; Pillow and mss deliberately stay — screenshot_capture still imports both.
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\customtkinter"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\customtkinter-*.dist-info"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\CTkListbox"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\CTkListbox-*.dist-info"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\CTkMessagebox"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\CTkMessagebox-*.dist-info"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\CTkToolTip"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\CTkToolTip-*.dist-info"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\pystray"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\pystray-*.dist-info"
; customtkinter's appearance-mode probe; nothing else ever imported it.
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\darkdetect"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\darkdetect-*.dist-info"

; Agent modules deleted in 3.0.0 with the UI they served.
Type: files; Name: "{app}\agent\src\owlette_gui.py"
Type: files; Name: "{app}\agent\src\owlette_tray.py"
Type: files; Name: "{app}\agent\src\prompt_restart.py"
Type: files; Name: "{app}\agent\src\report_issue.py"
Type: files; Name: "{app}\agent\src\custom_messagebox.py"
Type: files; Name: "{app}\agent\src\CTkMessagebox.py"
Type: files; Name: "{app}\agent\src\cleanup_commands.py"
; ...and their bytecode. The whole cache goes rather than seven named .pyc: a
; stale .pyc whose .py is gone is still importable, and the build drops
; __pycache__ from the payload anyway, so the interpreter rebuilds it on the
; first import after this.
Type: filesandordirs; Name: "{app}\agent\src\__pycache__"
; CTkMessagebox's dialog artwork (cancel/check/question/warning). The payload
; copies agent\src\* and the repo has no src\icons at all, so the folder is
; orphaned whole. The tray and status icons are a different directory
; ({app}\agent\icons) and are not touched.
Type: filesandordirs; Name: "{app}\agent\src\icons"

; The pythonw launcher hops. Every shortcut points straight at
; owlette-desktop.exe now (see [Icons]), and build_installer_full.bat stopped
; copying these in 3.0.0.
Type: files; Name: "{app}\scripts\launch_gui.bat"
Type: files; Name: "{app}\scripts\launch_tray.bat"

; NSSM. 3.0.0 hosts the service in tools\owlette-host.exe instead (see
; scripts\install.bat), and the registration is migrated during this install by
; `owlette-host install`. Deleting the binary is what makes the cutover real: a
; leftover nssm.exe is a 2014 unmaintained service host sitting in an elevated
; directory that nothing runs and every fleet vulnerability scan still has to
; account for. [InstallDelete] runs BEFORE the file copy and the service was
; stopped in InitializeSetup, so nothing holds it open at this point.
Type: files; Name: "{app}\tools\nssm.exe"

; WinRing0. The temperature stack moved to LibreHardwareMonitor 0.9.6 + the
; signed PawnIO driver in this release; WinTmp's bundled LHM was what extracted
; the blocklisted WinRing0 driver at runtime as python.sys / pythonw.sys and
; registered it as kernel service R0python / R0pythonw. InitializeSetup stops
; and deletes those services before this section runs, so the files are
; deletable here (a still-loaded driver image would survive until the next
; boot — sc delete marks it for deletion). WinTmp itself is pruned so an
; upgraded machine can never re-extract the driver; pythonnet/clr_loader STAY
; (the HardwareMonitor replacement needs them), as does the wmi package (a
; direct dependency of hardware_profile/shared_utils, now pinned explicitly).
Type: files; Name: "{app}\python\python.sys"
Type: files; Name: "{app}\python\pythonw.sys"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\WinTmp"
Type: filesandordirs; Name: "{app}\python\Lib\site-packages\WinTmp-1.2.0.dist-info"

; Prune the whole of site-packages before the copy. [Files] uses
; `ignoreversion recursesubdirs`, which OVERLAYS and never deletes, so every
; upgrade used to leave the previous release's packages behind alongside the
; new ones. It went unnoticed for as long as dependency versions never moved.
; The 3.3.4 upgrade moved three of them and left 519 orphaned files / 252 MB on
; an upgraded machine, two of which were not merely untidy:
;
;   - `claude_agent_sdk/_bundled/claude.exe` (241.5 MB) came BACK. The build
;     strips it behind a verify-and-fail guard precisely so the installer stays
;     small and agents fetch a sha256-pinned CLI instead; restoring the old one
;     also hands `cortex_cli_fetch._unverified_fallback()` a STALE CLI whenever
;     the pin cannot be read — the exact SDK/CLI mismatch the pin exists to stop.
;   - a full ghost copy of `mcp` 1.x (58 modules, all of `mcp/server/fastmcp/**`
;     and `mcp/client/stdio/`) sat importable beside 2.2.0.
;
; Safe to wipe wholesale: site-packages is installer-owned end to end. Nothing
; pip-installs at runtime, the Claude CLI cache lives in
; {commonappdata}\Owlette\cache\claude-cli, and config/tokens are elsewhere
; again. This section runs BEFORE [Files] and after InitializeSetup stopped the
; service, so nothing holds these open. This line makes the two WinTmp entries
; above redundant — they are kept only because they carry the WinRing0
; retraction rationale, which is still the reason that package must never come
; back. The python.sys / pythonw.sys entries are NOT redundant: those sit in
; {app}\python\ itself, outside site-packages.
Type: filesandordirs; Name: "{app}\python\Lib\site-packages"

[Icons]
; Start Menu shortcuts. Exactly ONE Start-menu entry registers the
; AppUserModelID — and every shortcut that does is named "Owlette".
;
; Windows needs *a* Start-menu shortcut carrying the id or it drops every toast
; the unpackaged desktop app raises (see the MyAppUserModelID note above), but it
; also draws the toast's attribution line from the NAME of whichever registered
; shortcut it resolves — and with several carrying the same id, which one it
; picks is not specified. Stamping only this entry makes the attribution read
; "Owlette" deterministically; "Owlette Configuration" needs no id of its own.
; ONE launcher, named after the product, that OPENS THE WINDOW (no arguments =
; "show me the window"; a forwarded second-instance launch without --tray
; raises the main window). The old pair — "Owlette" carrying --tray, which
; visibly does nothing when clicked, beside "Owlette Configuration" for the
; actual window — confused its first real user within a day of existing. The
; tray needs no Start-menu launcher: the service and the {userstartup} link own
; that lifecycle. Upgrades delete the retired "Owlette Configuration" lnk via
; [InstallDelete] above.
Name: "{group}\Owlette"; Filename: "{#MyAppExePath}"; IconFilename: "{app}\agent\icons\normal.ico"; WorkingDir: "{app}\app"; AppUserModelID: "{#MyAppUserModelID}"
Name: "{group}\View Logs"; Filename: "{commonappdata}\Owlette\logs"; IconFilename: "{sys}\shell32.dll"; IconIndex: 4
Name: "{group}\Edit Configuration"; Filename: "{commonappdata}\Owlette\config\config.json"; IconFilename: "{sys}\shell32.dll"; IconIndex: 70
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"

; Startup shortcut — the desktop app's own "start on login" toggle writes and
; deletes this exact file (desktop/src-tauri/src/startup_link.rs, LINK_NAME =
; "Owlette.lnk"), and stamps the same AppUserModelID on it. It keeps the id
; deliberately: a dev machine that never ran this installer has no other
; registered shortcut, and without one its toasts are silently dropped. The file
; name is "Owlette" and not "Owlette Tray" for the reason given above — the
; Startup folder is inside the Start-menu tree, so this shortcut is a candidate
; attribution source too, and every candidate must carry the same name.
; Setup creates it unconditionally because a 2.x machine's copy points at the
; now-deleted owlette_tray.py and must be repaired; an operator who turns the
; toggle off after upgrading keeps that choice until the next agent update.
Name: "{userstartup}\Owlette"; Filename: "{#MyAppExePath}"; Parameters: "--tray"; IconFilename: "{app}\agent\icons\normal.ico"; WorkingDir: "{app}\app"; AppUserModelID: "{#MyAppUserModelID}"

[Run]
; Step 0: RETRACT the Windows Defender exclusions previous versions added for
; the WinRing0 driver. The temperature stack moved to LibreHardwareMonitor
; 0.9.6 + the signed PawnIO driver (see EnsurePawnIO in [Code]), so nothing
; extracts a flagged .sys any more and none of the five legacy exclusions
; (WinTmp path, python/pythonw process, python.sys/pythonw.sys paths) is
; needed. This must be an ACTIVE removal, not just a deleted line: upgrades
; never run the old uninstaller (see InitializeSetup), so machines upgrading
; from <= 3.1.0 would otherwise keep the exclusions forever. Also drops the
; stale legacy exclusions older generations added — the set is the union of
; every Add-MpPreference any historical installer ran (verified against git
; history): the whole-install {app} exclusion (2.0.4x era), {app}\python,
; the LibreHardwareMonitor site-packages path (2.12.x era), and the
; C:\Owlette / C:\Owlette\python trees from pre-ProgramData installs.
; Appends the resulting path AND process exclusion sets to
; logs\defender_setup.log so the retraction is diagnosable. Keep this line
; for at least one release cycle after the fleet is past 3.1.0.
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Remove-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\WinTmp' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\LibreHardwareMonitor' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionProcess '{app}\python\python.exe' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionProcess '{app}\python\pythonw.exe' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath '{app}\python\python.sys' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath '{app}\python\pythonw.sys' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath '{app}\python' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath '{app}' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath 'C:\Owlette' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath 'C:\Owlette\python' -ErrorAction SilentlyContinue; [void]((Get-Command Get-MpPreference -ErrorAction SilentlyContinue) -and (('owlette defender exclusions retracted @ ' + (Get-Date -Format s) + ' :: remaining_paths=' + ((Get-MpPreference).ExclusionPath -join ';') + ' :: remaining_procs=' + ((Get-MpPreference).ExclusionProcess -join ';')) | Out-File -Append -Encoding utf8 '{commonappdata}\Owlette\logs\defender_setup.log'))"""; StatusMsg: "Removing legacy Windows Defender exclusions..."; Flags: runhidden waituntilterminated

; The pairing handoff and the service install are handled in [Code]
; CurStepChanged() so the pairing branch can be chosen at runtime and the
; service install's exit code can be read. The service install itself is
; UNCONDITIONAL — see RunPairingHandoff() and CurStepChanged() below.

; Note: Tray icon launches automatically on login via startup folder (see [Icons] section above)
; No need to launch it here - it will start on next login or can be launched manually from Start Menu

; Open the window after an INTERACTIVE install: the operator just installed an
; app, and "hunt for a dot under the taskbar chevron" is not a first impression.
; skipifsilent keeps every silent path dark — bulk /VERYSILENT deploys and the
; agent's own self-update must never pop a window over a running show. The
; service has already spawned the tray by now, so single-instance folds this
; launch into it and simply shows the window.
;
; runasoriginaluser is required, not optional: without it Inno starts this with
; Setup's own token, so in administrative install mode the app — and any browser
; it shells open — runs ELEVATED. Its argv carries no --pair, so useLaunchFlag
; ignores it and this stays a plain "show the window" affordance; the Description
; must not read as a second pairing step.
; Only when the GUI handoff did NOT already open the app. On the console
; fallback and /ADD= paths this is still the operator only launcher; after a
; handoff it offers to open a window that is already on screen.
Filename: "{#MyAppExePath}"; WorkingDir: "{app}\app"; Description: "open owlette"; Flags: postinstall skipifsilent nowait runasoriginaluser; Check: ShouldOfferOpenApp

[UninstallRun]
; Close the desktop app first — it lives in {app}\app and would otherwise hold
; its own image open while CurUninstallStepChanged tries to DelTree that folder.
; Scoped by exe path (not a bare /IM name kill) for the same reason the install
; path is: never touch a same-named process outside this installation.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-Process -Name owlette-desktop -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '*\Owlette\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated
; Stop and deregister the Windows service before uninstalling. One call: the
; host waits for the service to reach STOPPED (which is what lets the agent
; flush `online: false` and log agent_stopped) and only then removes the
; registration. `uninstall` succeeds on a machine where the service is already
; gone, so this is safe to run twice.
Filename: "{app}\tools\owlette-host.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated
; swoop's machine-wide side effects (swoop_manager.py, task 7.7): the two
; firewall rules go by group, and the SoftwareSASGeneration policy goes back to
; what the agent recorded before it set 3 — 'absent' deletes the value, 0..3
; sets it, anything else is left alone. The service is stopped by now, so the
; agent cannot undo them itself; the uninstaller is already elevated, so no
; runas. Always exits 0: a machine that never enabled swoop has nothing to undo.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$r = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'; $f = '{commonappdata}\Owlette\tmp\swoop_side_effects.json'; Remove-NetFirewallRule -Group 'Owlette swoop' -ErrorAction SilentlyContinue; if (Test-Path $f) {{ $p = (Get-Content $f -Raw | ConvertFrom-Json).sasPrior; if ($p -eq 'absent') {{ Remove-ItemProperty -Path $r -Name SoftwareSASGeneration -ErrorAction SilentlyContinue }} elseif (($p -is [int] -or $p -is [long]) -and $p -ge 0 -and $p -le 3) {{ Set-ItemProperty -Path $r -Name SoftwareSASGeneration -Value ([int]$p) -Type DWord }} }}; exit 0"""; Flags: runhidden waituntilterminated
; Retire the legacy WinRing0 kernel services on machines that never took a
; PawnIO-era upgrade (current versions never register them). The service is
; stopped by now, so the driver can unload and CurUninstallStepChanged's
; DelTree of {app}\python can sweep the .sys files. PawnIO itself is
; deliberately LEFT INSTALLED: it is a shared component other tools use
; (FanControl, LibreHardwareMonitor), exactly like the WebView2 runtime.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""foreach ($svc in 'R0python', 'R0pythonw') {{ sc.exe stop $svc | Out-Null; sc.exe delete $svc | Out-Null }; exit 0"""; Flags: runhidden waituntilterminated
; Remove Windows Defender exclusions (mirror the legacy install set, incl. the .sys driver paths)
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Remove-MpPreference -ExclusionPath '{app}\python\Lib\site-packages\WinTmp' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionProcess '{app}\python\python.exe' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionProcess '{app}\python\pythonw.exe' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath '{app}\python\python.sys' -ErrorAction SilentlyContinue; Remove-MpPreference -ExclusionPath '{app}\python\pythonw.sys' -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated

[Code]

var
  ServiceWasStopped: Boolean;
  InstallSucceeded: Boolean;
  PairingSucceeded: Boolean;
  // Set only by the GUI handoff, and read by ShouldOfferOpenApp to suppress
  // the finished page redundant "open owlette" checkbox.
  AppOpenedByHandoff: Boolean;

// The only table in this script that produces user-facing hosts and configure_site
// arguments. Everything that needs the server — the configure_site.py args, the GUI
// handoff, the status caption, the ready-page memo, the failure message — reads it
// from here, and this script deliberately holds no URL at all. ShouldConfigureSite
// keeps its own token->environment map on purpose: it answers a different question,
// "was a different server explicitly requested?". The python side's equivalents are
// shared_utils.get_api_base_url and shared_utils.get_web_host.
function GetServerParam(): String;
begin
  if ExpandConstant('{param:SERVER|prod}') = 'dev' then
    Result := 'dev'
  else
    Result := 'prod';
end;

function GetWebHost(): String;
begin
  if GetServerParam() = 'dev' then
    Result := 'dev.owlette.app'
  else
    Result := 'owlette.app';
end;

// The ready-to-install page is the last surface an operator reads BEFORE
// committing, and it is the one place the wrong environment actually gets
// chosen — the status caption only flashes for a few seconds and the MsgBox
// only appears on failure. Every Memo* parameter must be re-emitted in this
// order or the page silently loses what Inno normally shows there.
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := '';
  if MemoUserInfoInfo <> '' then Result := Result + MemoUserInfoInfo + NewLine + NewLine;
  if MemoDirInfo <> '' then Result := Result + MemoDirInfo + NewLine + NewLine;
  if MemoTypeInfo <> '' then Result := Result + MemoTypeInfo + NewLine + NewLine;
  if MemoComponentsInfo <> '' then Result := Result + MemoComponentsInfo + NewLine + NewLine;
  if MemoGroupInfo <> '' then Result := Result + MemoGroupInfo + NewLine + NewLine;
  if MemoTasksInfo <> '' then Result := Result + MemoTasksInfo + NewLine + NewLine;
  Result := Result + 'Owlette server:' + NewLine + Space + GetWebHost();
end;

function GetConfigureArgs(Param: String): String;
var
  AddPhrase: String;
begin
  Result := '--server ' + GetServerParam();

  // Check for /ADD= parameter (pre-authorized pairing phrase for silent install)
  AddPhrase := ExpandConstant('{param:ADD|}');
  if AddPhrase <> '' then
    Result := Result + ' --add "' + AddPhrase + '"';

  Log('Configure args: ' + Result);
end;

function ShouldConfigureSite(): Boolean;
var
  ConfigPath: String;
  ConfigContent: AnsiString;
  AddPhrase: String;
  ServerParam: String;
  RequestedEnv: String;
  ConfigIsDev: Boolean;
  ConfigIsProd: Boolean;
begin
  // An explicit /ADD= pairing phrase means the operator is deliberately
  // (re)pairing this machine now (bulk deploy or site/server switch). Always
  // run pairing — never silently skip an explicit pairing request.
  AddPhrase := ExpandConstant('{param:ADD|}');
  if AddPhrase <> '' then
  begin
    Log('ADD phrase supplied - running OAuth (explicit pairing)');
    Result := True;
    Exit;
  end;

  // Skip OAuth only if config has a valid firebase section with a site_id.
  // A config.json can exist WITHOUT firebase (e.g., service created a default,
  // or a previous install failed mid-OAuth). In those cases, OAuth must still run.
  ConfigPath := ExpandConstant('{commonappdata}\Owlette\config\config.json');

  if not FileExists(ConfigPath) then
  begin
    Log('No config found - running OAuth (fresh install)');
    Result := True;
    Exit;
  end;

  if not LoadStringFromFile(ConfigPath, ConfigContent) then
  begin
    Log('Config exists but unreadable - running OAuth');
    Result := True;
    Exit;
  end;

  // Check for a populated site_id in the firebase section.
  // A valid config has a NON-EMPTY "site_id" and "enabled": true. The
  // `"site_id": ""` exclusion guards against a default/half-written config
  // (enabled flag flipped but no site bound yet) being treated as paired.
  if not ((Pos('"site_id"', ConfigContent) > 0) and
          (Pos('"site_id": ""', ConfigContent) = 0) and
          (Pos('"enabled": true', ConfigContent) > 0)) then
  begin
    Log('Config exists but firebase section missing/incomplete - running OAuth');
    Result := True;
    Exit;
  end;

  // Valid config exists — normally an upgrade, so skip OAuth. BUT if the
  // operator EXPLICITLY passed /SERVER= for a different environment than the
  // one this config is bound to, that's a server switch and we must re-pair.
  // Empty default lets us distinguish "explicitly passed" from "defaulted".
  ServerParam := ExpandConstant('{param:SERVER|}');
  if ServerParam <> '' then
  begin
    if ServerParam = 'dev' then
      RequestedEnv := 'development'
    else
      RequestedEnv := 'production';

    ConfigIsDev := Pos('"environment": "development"', ConfigContent) > 0;
    ConfigIsProd := Pos('"environment": "production"', ConfigContent) > 0;

    if ((RequestedEnv = 'development') and ConfigIsProd) or
       ((RequestedEnv = 'production') and ConfigIsDev) then
    begin
      Log('Requested server (' + RequestedEnv + ') differs from config environment - running OAuth (server switch)');
      Result := True;
      Exit;
    end;

    // /SERVER= was explicitly requested but the config has no recognizable
    // "environment" field (e.g. an old config predating that field). We cannot
    // confirm the current server matches the request, so re-pair rather than
    // silently leave the agent on an unknown/unintended server.
    if (not ConfigIsDev) and (not ConfigIsProd) then
    begin
      Log('Requested server (' + RequestedEnv + ') but config environment is undeterminable - running OAuth');
      Result := True;
      Exit;
    end;
  end;

  Log('Config has valid firebase section - skipping OAuth (upgrade)');
  Result := False;
end;

// WebView2 Evergreen runtime, per Microsoft's documented detection contract:
// a `pv` REG_SZ under the WebView2 Runtime's EdgeUpdate client GUID that is
// neither empty nor 0.0.0.0. HKLM is the per-machine install, HKCU the per-user
// one. Both HKLM spellings are probed because Inno's registry view depends on
// the install mode: whichever view HKEY_LOCAL_MACHINE resolves to, one of the
// two paths is the right one and the other simply misses.
// https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
function WebView2RuntimeVersion(RootKey: Integer; SubKey: String): String;
var
  Version: String;
begin
  Result := '';
  if RegQueryStringValue(RootKey, SubKey, 'pv', Version) then
    if (Version <> '') and (Version <> '0.0.0.0') then
      Result := Version;
end;

function FindWebView2Runtime(): String;
var
  ClientGuid: String;
begin
  ClientGuid := '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := WebView2RuntimeVersion(HKEY_LOCAL_MACHINE, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + ClientGuid);
  if Result <> '' then Exit;
  Result := WebView2RuntimeVersion(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + ClientGuid);
  if Result <> '' then Exit;
  Result := WebView2RuntimeVersion(HKEY_CURRENT_USER, 'Software\Microsoft\EdgeUpdate\Clients\' + ClientGuid);
end;

// The desktop app renders in WebView2. Windows 11 and mainstream Windows 10
// ship the Evergreen runtime, but LTSC/IoT kiosk images — a large slice of the
// installations Owlette runs on — often do not, and there the app would fail to
// create its window with no useful error. Install it from the bundled
// Microsoft-signed bootstrapper before anything tries to launch the app.
//
// Never fatal: a machine without the runtime still gets a working service, and
// the operator can drive it entirely from the dashboard. `/silent /install` is
// idempotent, so a false negative from the probe costs a no-op, not a reinstall.
procedure EnsureWebView2Runtime();
var
  ResultCode: Integer;
  Existing: String;
begin
  Existing := FindWebView2Runtime();
  if Existing <> '' then
  begin
    Log('WebView2 runtime present (pv=' + Existing + ') - skipping bootstrapper');
    Exit;
  end;

  Log('WebView2 runtime not found - running bundled Evergreen bootstrapper');
  if not WizardSilent() then
    WizardForm.StatusLabel.Caption := 'Installing the WebView2 runtime...';

  try
    ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  except
    Log('Failed to extract the WebView2 bootstrapper: ' + GetExceptionMessage);
    Exit;
  end;

  // Elevated (setup requires admin) so this is a per-machine install, which is
  // what a kiosk running under an auto-login account needs.
  if Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '',
          SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Log('WebView2 bootstrapper exit code: ' + IntToStr(ResultCode))
  else
    Log('Could not start the WebView2 bootstrapper: ' + SysErrorMessage(ResultCode));

  Existing := FindWebView2Runtime();
  if Existing <> '' then
    Log('WebView2 runtime now present (pv=' + Existing + ')')
  else
    Log('WebView2 runtime still not detected - the desktop app may not open on this machine');
end;

// PawnIO detection contract: its installer registers a standard ARP entry, and
// LibreHardwareMonitorLib itself detects the driver by reading exactly this
// DisplayVersion value (LibreHardwareMonitor.PawnIo.PawnIo), so probing the
// same key keeps our gate and the library's runtime view consistent.
function PawnIOVersion(): String;
begin
  Result := '';
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE,
      'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO',
      'DisplayVersion', Result) then
    Result := '';
end;

// Dotted-numeric version compare (up to four parts, missing parts read as 0).
// Registry DisplayVersion is "2.2.0.0"-shaped; anything unparsable compares
// as 0 and therefore triggers a (harmless, idempotent) reinstall.
function NextVersionPart(var S: String): Integer;
var
  P: Integer;
  PartStr: String;
begin
  P := Pos('.', S);
  if P > 0 then
  begin
    PartStr := Copy(S, 1, P - 1);
    Delete(S, 1, P);
  end
  else
  begin
    PartStr := S;
    S := '';
  end;
  Result := StrToIntDef(Trim(PartStr), 0);
end;

function VersionAtLeast(Ver, MinVer: String): Boolean;
var
  A, B, i: Integer;
begin
  Result := True;
  for i := 1 to 4 do
  begin
    A := NextVersionPart(Ver);
    B := NextVersionPart(MinVer);
    if A > B then Exit;
    if A < B then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

// The agent reads CPU temperatures through LibreHardwareMonitor 0.9.6, which
// talks to the signed PawnIO driver (this replaced WinTmp's runtime-extracted
// WinRing0 — see the vendored file's comment in [Files]). Install it from the
// bundled installer when absent or older than 2.2.0; the version gate matters
// because 2.1.0 BSOD/boot-loops Windows 10 1809/LTSC-class machines.
//
// Never fatal: a machine without PawnIO still gets a fully working agent —
// CPU temps read as None and GPU temps arrive via vendor userspace APIs. The
// installer's silent CLI is safe under the SYSTEM self-update path (no UI),
// and re-running it on a current install is a no-op (exit 183).
procedure EnsurePawnIO();
var
  ResultCode: Integer;
  Existing: String;
begin
  Existing := PawnIOVersion();
  if (Existing <> '') and VersionAtLeast(Existing, '2.2.0') then
  begin
    Log('PawnIO present (v' + Existing + ') - skipping driver installer');
    Exit;
  end;

  if Existing <> '' then
    Log('PawnIO v' + Existing + ' is older than 2.2.0 - upgrading in place')
  else
    Log('PawnIO not found - running bundled driver installer');
  if not WizardSilent() then
    WizardForm.StatusLabel.Caption := 'Installing the PawnIO driver...';

  try
    ExtractTemporaryFile('PawnIO_setup.exe');
  except
    Log('Failed to extract the PawnIO installer: ' + GetExceptionMessage);
    Exit;
  end;

  if Exec(ExpandConstant('{tmp}\PawnIO_setup.exe'), '-install -silent', '',
          SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    // 0 = installed, 183 = ERROR_ALREADY_EXISTS (idempotent re-run),
    // 3010 = ERROR_SUCCESS_REBOOT_REQUIRED (installed; binds after reboot).
    if (ResultCode = 0) or (ResultCode = 183) or (ResultCode = 3010) then
      Log('PawnIO installer exit code: ' + IntToStr(ResultCode) + ' (ok)')
    else
      Log('PawnIO installer exit code: ' + IntToStr(ResultCode) + ' - CPU temperatures may be unavailable');
  end
  else
    Log('Could not start the PawnIO installer: ' + SysErrorMessage(ResultCode));

  Existing := PawnIOVersion();
  if Existing <> '' then
    Log('PawnIO now present (v' + Existing + ')')
  else
    Log('PawnIO still not detected - CPU temperatures will be unavailable (GPU temps use vendor APIs)');
end;

// Called from CurStepChanged AFTER the service install - the only point at which
// the claim "the Owlette service has been installed and started" is true, which
// is why this lives here and not inside RunPairingHandoff. The
// `if not WizardSilent()` guard lives at the call site.
//
// SuppressibleMsgBox, not MsgBox: under /SUPPRESSMSGBOXES it returns Default
// instead of rendering an invisible session-0 dialog and hanging the scheduled
// task the agent's self-update runs the installer from. Each path is quoted
// independently so the printed command is runnable under a /DIR= with spaces,
// and the command carries the server so an operator on a /SERVER=dev machine
// does not silently re-pair against production.
procedure ShowPairingFailedMessage();
var
  Msg: String;
begin
  Msg :=
    'Pairing was not completed, but the Owlette service has been installed and started.' + #13#10 + #13#10 +
    'This machine will stay offline until it is paired with a site on ' + GetWebHost() + '.' + #13#10 + #13#10 +
    'To finish pairing, either:' + #13#10 +
    '  - open Owlette from the Start menu and choose "join a site", or' + #13#10 +
    '  - run this command from an administrator prompt:' + #13#10 + #13#10 +
    '    "' + ExpandConstant('{app}\python\python.exe') + '" "' +
    ExpandConstant('{app}\agent\src\configure_site.py') + '" --server ' + GetServerParam();
  SuppressibleMsgBox(Msg, mbInformation, MB_OK, IDOK);
end;

// Returns False only when a console pairing run we waited on actually failed.
// The GUI handoff is ewNoWait and has no outcome to report - by design.
function ShouldOfferOpenApp(): Boolean;
begin
  Result := not AppOpenedByHandoff;
end;

function RunPairingHandoff(): Boolean;
var
  ResultCode: Integer;
  ShowCmd: Integer;
  AppExe, PythonExe, ConfigArgs, AddPhrase: String;
begin
  Result := True;
  AddPhrase := ExpandConstant('{param:ADD|}');
  // Same path as #define MyAppExePath; build_installer_full.bat confirms the
  // desktop exe lands at {app}\app\owlette-desktop.exe.
  AppExe := ExpandConstant('{app}\app\owlette-desktop.exe');

  // Silent with no /ADD= phrase: nobody can read a pairing phrase on this path.
  // Today it burns the full 600 s device-code timeout in an invisible session-0
  // console before failing; skipping costs nothing now that the service
  // installs unconditionally.
  if WizardSilent() and (AddPhrase = '') then
  begin
    Log('Silent install with no /ADD= phrase - installed unpaired');
    Result := True;
    Exit;
  end;

  // The GUI handoff. Every condition is load-bearing: `not WizardSilent()` is
  // the session-0 guard (the agent's self-update runs this installer as SYSTEM
  // via schtasks, and a hidden window in session 0 is a leaked, unclosable
  // process); `AddPhrase = ''` keeps the /ADD= bulk-deploy path on the console;
  // WebView2 must be present or the app cannot create a window and the handoff
  // would strand the operator. ewNoWait so the wizard never blocks on a window
  // the operator has not finished with, and try/except because ISetup.chm says
  // ExecAsOriginalUser "can raise an exception instead of just returning False".
  if (not WizardSilent()) and (AddPhrase = '') and (FindWebView2Runtime() <> '') and FileExists(AppExe) then
  begin
    WizardForm.StatusLabel.Caption := 'Opening owlette to finish pairing with ' + GetWebHost() + '...';
    try
      if ExecAsOriginalUser(AppExe, '--pair --server ' + GetServerParam(), '', SW_SHOW, ewNoWait, ResultCode) then
      begin
        AppOpenedByHandoff := True;
        Log('Handed pairing to the desktop app');
      end
      else
        Log('Could not hand off to the desktop app: ' + SysErrorMessage(ResultCode));
    except
      Log('ExecAsOriginalUser raised: ' + GetExceptionMessage);
    end;
    Result := True;
    Exit;
  end;

  // Otherwise - an /ADD= phrase, or interactive without WebView2 - pair on the
  // console. This is the only branch with an outcome to report.
  PythonExe := ExpandConstant('{app}\python\python.exe');
  ConfigArgs := '"' + ExpandConstant('{app}\agent\src\configure_site.py') + '" ' + GetConfigureArgs('');
  if WizardSilent() then ShowCmd := SW_HIDE else ShowCmd := SW_SHOW;
  if not WizardSilent() then
    WizardForm.StatusLabel.Caption := 'Pairing with ' + GetWebHost() + '...';
  Log('Running pairing: ' + PythonExe + ' ' + ConfigArgs);
  Result := Exec(PythonExe, ConfigArgs, '', ShowCmd, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then
    Log('Pairing was not completed (exit code ' + IntToStr(ResultCode) + ')');
end;

// Re-ACL the install tree after [Files], [Dirs] and [Run] have all run, so
// nothing Inno does afterwards can loosen it (ssPostInstall is the last window;
// Inno's [Dirs] Permissions: parameter only ADDS access entries and cannot mark
// a DACL as not inheriting). Guarantees, using well-known SIDs only (localized
// account names do not resolve on a non-English Windows):
//   S-1-5-18 SYSTEM, S-1-5-32-544 Administrators, S-1-5-32-545 Users
//   - code dirs + uninstaller/payload files -> SYSTEM + Administrators Full,
//     Users read+execute only;
//   - content, update-staging -> SYSTEM + Administrators only;
//   - .tokens.enc and .tokens.enc.v1 -> SYSTEM + Administrators, plus the interactive console user
//     (Modify) when a session exists, else SYSTEM + Administrators only.
// Each path is hardened under the root that actually holds it: the code dirs and
// the root-level files under {app}, the service dirs and .tokens.enc under the
// data root ({commonappdata}\Owlette). The two coincide unless /DIR= split them,
// so a path is only ever touched once. Runs on every install and upgrade — the
// installer is the only new code that runs on a machine mid-self-update. Never
// fatal: on any failure the service re-applies the same ACLs at start-up. Every
// command, its exit code and the re-read icacls output go to
// logs\acl_hardening.log. The work is a generated PowerShell script (console-SID
// resolution, per-root path selection and logging are awkward as bare Exec
// calls); it is written to {tmp} and run once.
procedure HardenInstallTree();
var
  PS, PsFile, AppRoot, DataRoot, Params: String;
  ResultCode: Integer;
begin
  AppRoot := ExpandConstant('{app}');
  DataRoot := ExpandConstant('{commonappdata}\Owlette');

  // built with double quotes throughout so this Pascal literal needs no escaping
  PS :=
    'param([string]$AppRoot, [string]$DataRoot)' + #13#10 +
    '$ErrorActionPreference = "Continue"' + #13#10 +
    '$logDir = Join-Path $DataRoot "logs"' + #13#10 +
    'if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }' + #13#10 +
    '$log = Join-Path $logDir "acl_hardening.log"' + #13#10 +
    'function Wr($m) { Add-Content -LiteralPath $log -Value $m }' + #13#10 +
    'function Ic($argList, $readBack) {' + #13#10 +
    '  $joined = $argList -join " "' + #13#10 +
    '  Wr(">>> icacls $joined")' + #13#10 +
    '  $o = & icacls.exe @argList 2>&1' + #13#10 +
    '  Wr((($o) | Out-String).TrimEnd())' + #13#10 +
    '  Wr("exit=$LASTEXITCODE")' + #13#10 +
    '  if ($readBack -and (Test-Path -LiteralPath $readBack)) {' + #13#10 +
    '    $r = & icacls.exe $readBack 2>&1' + #13#10 +
    '    Wr("--- re-read: $readBack ---")' + #13#10 +
    '    Wr((($r) | Out-String).TrimEnd())' + #13#10 +
    '  }' + #13#10 +
    '  Wr("")' + #13#10 +
    '}' + #13#10 +
    '# a junction or symlink planted at a table path is never operated on:' + #13#10 +
    '# icacls would set the dacl on whatever it points at.' + #13#10 +
    'function Plain($p) {' + #13#10 +
    '  try { -not ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }' + #13#10 +
    '  catch { $false }' + #13#10 +
    '}' + #13#10 +
    '$ts = Get-Date -Format s' + #13#10 +
    'Wr("=== owlette acl hardening @ $ts ===")' + #13#10 +
    'Wr("app root:  $AppRoot")' + #13#10 +
    'Wr("data root: $DataRoot")' + #13#10 +
    '$consoleSid = $null' + #13#10 +
    'try {' + #13#10 +
    '  $u = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName' + #13#10 +
    '  if ($u) { $consoleSid = (New-Object System.Security.Principal.NTAccount($u)).Translate([System.Security.Principal.SecurityIdentifier]).Value }' + #13#10 +
    '} catch { $consoleSid = $null }' + #13#10 +
    '$sidDesc = "(none - system + administrators only)"' + #13#10 +
    'if ($consoleSid) { $sidDesc = $consoleSid }' + #13#10 +
    'Wr("console user sid: $sidDesc")' + #13#10 +
    '$SYS = "*S-1-5-18"' + #13#10 +
    '$ADM = "*S-1-5-32-544"' + #13#10 +
    '$USR = "*S-1-5-32-545"' + #13#10 +
    '# code dirs under {app}: SYSTEM/Administrators Full, Users read+execute, then' + #13#10 +
    '# re-inherit onto the payload. the \* is load-bearing - /reset /T on the dir' + #13#10 +
    '# itself would revert the protected dacl set the line before.' + #13#10 +
    'foreach ($d in "agent","python","tools","app","scripts") {' + #13#10 +
    '  $p = Join-Path $AppRoot $d' + #13#10 +
    '  if ((Test-Path -LiteralPath $p) -and (Plain $p)) {' + #13#10 +
    '    Ic @($p, "/inheritance:r", "/grant:r", "$($SYS):(OI)(CI)(F)", "$($ADM):(OI)(CI)(F)", "$($USR):(OI)(CI)(RX)") $p' + #13#10 +
    '    Ic @("$p\*", "/reset", "/T", "/C", "/Q") $null' + #13#10 +
    '  } else { Wr("skip (absent or reparse point): $p"); Wr("") }' + #13#10 +
    '}' + #13#10 +
    '# root-level files under {app}: the uninstaller and the payload docs.' + #13#10 +
    'foreach ($f in "unins000.exe","unins000.dat","README.md","LICENSE","CLAUDE.md","THIRD_PARTY_NOTICES.md","LGPL-2.1.txt") {' + #13#10 +
    '  $p = Join-Path $AppRoot $f' + #13#10 +
    '  if ((Test-Path -LiteralPath $p) -and (Plain $p)) {' + #13#10 +
    '    Ic @($p, "/inheritance:r", "/grant:r", "$($SYS):(F)", "$($ADM):(F)", "$($USR):(RX)") $p' + #13#10 +
    '  } else { Wr("skip (absent or reparse point): $p"); Wr("") }' + #13#10 +
    '}' + #13#10 +
    '# service-owned dirs under the data root: owned by Administrators, then' + #13#10 +
    '# SYSTEM + Administrators only. a dir someone else created would keep its' + #13#10 +
    '# owner, who can rewrite its dacl, and the service refuses to use it.' + #13#10 +
    'foreach ($d in "content","update-staging") {' + #13#10 +
    '  $p = Join-Path $DataRoot $d' + #13#10 +
    '  if ((Test-Path -LiteralPath $p) -and (Plain $p)) {' + #13#10 +
    '    Ic @($p, "/setowner", $ADM) $null' + #13#10 +
    '    Ic @($p, "/inheritance:r", "/grant:r", "$($SYS):(OI)(CI)(F)", "$($ADM):(OI)(CI)(F)") $p' + #13#10 +
    '  } else { Wr("skip (absent or reparse point): $p"); Wr("") }' + #13#10 +
    '}' + #13#10 +
    '# credentials (.tokens.enc.v1 is the pre-migration copy, hardened alike):' + #13#10 +
    '# add the console user (Modify) only when a session exists.' + #13#10 +
    'foreach ($f in ".tokens.enc",".tokens.enc.v1") {' + #13#10 +
    '  $tok = Join-Path $DataRoot $f' + #13#10 +
    '  if ((Test-Path -LiteralPath $tok) -and (Plain $tok)) {' + #13#10 +
    '    if ($consoleSid) {' + #13#10 +
    '      Ic @($tok, "/inheritance:r", "/grant:r", "$($SYS):(F)", "$($ADM):(F)", "*$($consoleSid):(M)") $tok' + #13#10 +
    '    } else {' + #13#10 +
    '      Ic @($tok, "/inheritance:r", "/grant:r", "$($SYS):(F)", "$($ADM):(F)") $tok' + #13#10 +
    '    }' + #13#10 +
    '  } else { Wr("skip (absent or reparse point): $tok"); Wr("") }' + #13#10 +
    '}' + #13#10 +
    'Wr("=== done ===")' + #13#10;

  PsFile := ExpandConstant('{tmp}\owlette-acl-hardening.ps1');
  if SaveStringToFile(PsFile, PS, False) then
  begin
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' + PsFile + '"' +
      ' -AppRoot "' + AppRoot + '" -DataRoot "' + DataRoot + '"';
    if Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      Log('acl hardening: powershell exit ' + IntToStr(ResultCode) +
          ' (see ' + DataRoot + '\logs\acl_hardening.log)')
    else
      Log('acl hardening: could not start powershell (' + SysErrorMessage(ResultCode) +
          ') - service will repair at start-up');
  end
  else
    Log('acl hardening: could not write ' + PsFile + ' - service will repair at start-up');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  InstallBat: String;
  SwoopDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    // Step 0: WebView2 runtime. First, because the handoff below refuses to run
    // without it and install.bat starts the service, which launches the app.
    EnsureWebView2Runtime();

    // Step 0b: PawnIO driver, BEFORE the service install so the agent's very
    // first heartbeat can already read CPU temperatures. Never fatal.
    EnsurePawnIO();

    // Step 0c: harden the install tree's permissions, BEFORE the service starts.
    // Never fatal (the service repairs at start-up); see HardenInstallTree.
    HardenInstallTree();

    // Step 0d: set the ACL on {app}\swoop. It is not in HardenInstallTree's list
    // (nor in the service's repair table): the path sets are disjoint and the
    // service verifies this directory itself before spawning the streamer.
    // ssPostInstall is where this belongs:
    // [Files] and [Dirs] have both already run, so Inno's own permission pass
    // cannot overwrite it afterwards. It is an icacls shell-out rather than a
    // [Dirs] entry because Inno's Permissions: parameter only adds access
    // entries — it cannot mark the ACL as not inheriting.
    //
    // Well-known SIDs, never account names: "Administrators" and "Users" are
    // localized and do not resolve on a non-English Windows, which would leave
    // the directory unreadable to the console session.
    //   S-1-5-18     NT AUTHORITY\SYSTEM       full
    //   S-1-5-32-544 BUILTIN\Administrators    full
    //   S-1-5-32-545 BUILTIN\Users             read + execute
    //
    // Runs unconditionally on every install AND every upgrade, so a machine
    // arriving from any older version is brought to this state by the installer
    // alone — the only new code that runs on it during a self-update.
    //
    // Never fatal. The service verifies this ACL before it spawns the streamer,
    // so a failure here costs the swoop feature on this machine and never the
    // install.
    SwoopDir := ExpandConstant('{app}\swoop');
    Log('Setting permissions on ' + SwoopDir);
    Exec('icacls.exe',
      '"' + SwoopDir + '" /inheritance:r ' +
      '/grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-32-545:(OI)(CI)(RX)"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('Swoop directory permissions returned: ' + IntToStr(ResultCode));

    // The payload [Files] just wrote still carries the entries the directory had
    // at copy time; this re-applies the new ones to it. The \* is load-bearing —
    // icacls on the directory itself with /reset /T undoes the command above.
    // /C /Q keeps an empty directory silent and non-fatal.
    Exec('icacls.exe',
      '"' + SwoopDir + '\*" /reset /T /C /Q',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('Swoop payload permission reset returned: ' + IntToStr(ResultCode));

    // Step 1: pairing handoff, BEFORE the service install. The order is
    // load-bearing: install.bat starts the service, OwletteService.main()
    // calls _try_launch_tray(), and a --tray instance holding the
    // single-instance lock would turn the --pair launch into a FORWARDED second
    // instance whose app.emit is dropped when the webview has not yet
    // registered its listener - window opens, pairing dialog does not, --server
    // lost. Handing off first makes --pair reliably the first instance, so it
    // arrives by the launch_args() pull, which cannot be missed.
    // PairingSucceeded is LOG-ONLY and must never gate step 2 again. The
    // try/except is what keeps an ExecAsOriginalUser exception (ISetup.chm: it
    // "can raise an exception instead of just returning False") from aborting
    // ssPostInstall before the service is installed - the safety property the
    // old service-first ordering used to provide.
    PairingSucceeded := True;
    if ShouldConfigureSite() then
    begin
      try
        PairingSucceeded := RunPairingHandoff();
      except
        Log('Pairing handoff raised: ' + GetExceptionMessage);
        PairingSucceeded := False;
      end;
    end;

    // Step 2: install the service. UNCONDITIONAL as of 3.1.0 - pairing no longer
    // gates it. A machine always ends up with a registered, running service; an
    // unpaired one simply has nothing to talk to yet. Inno idiom: Exec returns
    // "could the process be started"; when it returns False, ResultCode holds a
    // system error code, not an exit code.
    InstallBat := ExpandConstant('{app}\scripts\install.bat');
    WizardForm.StatusLabel.Caption := 'Installing Owlette service...';
    Log('Installing service: ' + InstallBat);
    if Exec(InstallBat, '--silent', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Log('Service install exit code: ' + IntToStr(ResultCode));
      InstallSucceeded := (ResultCode = 0);
    end
    else
    begin
      Log('Could not start the service installer: ' + SysErrorMessage(ResultCode));
      InstallSucceeded := False;
    end;

    // Step 3: only now can the failure message truthfully say the service is
    // installed and running, which is why it lives here and not inside
    // RunPairingHandoff.
    if (not PairingSucceeded) and (not WizardSilent()) then
      ShowPairingFailedMessage();

    Log('Owlette installation completed (service install: ' + IntToStr(Ord(InstallSucceeded)) +
        ', pairing: ' + IntToStr(Ord(PairingSucceeded)) + ')');
    Log('User data stored in: ' + ExpandConstant('{commonappdata}\Owlette'));
  end;
end;

procedure DeinitializeSetup();
var
  ResultCode: Integer;
begin
  // If we stopped the service during an upgrade but installation failed or was
  // cancelled, restart it so the user isn't left with a dead service.
  if ServiceWasStopped and (not InstallSucceeded) then
  begin
    Log('Installation did not complete - restarting OwletteService...');
    Exec('net', 'start OwletteService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('Service restart returned with code: ' + IntToStr(ResultCode));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  InstallDir: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    // Log uninstallation
    Log('Uninstalling Owlette...');
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    // FIX: {app} and {commonappdata}\Owlette are the SAME directory (C:\ProgramData\Owlette).
    // Previously, DelTree wiped the entire {app} dir, destroying config, tokens, and logs
    // even during silent upgrades. Now we selectively remove only installed component dirs
    // and always preserve user data (config/, logs/, cache/, tmp/, .tokens.enc).
    InstallDir := ExpandConstant('{app}');
    DataDir := ExpandConstant('{commonappdata}\Owlette');

    if DirExists(InstallDir) then
    begin
      // Remove only installed component directories (not user data)
      Log('Cleaning installed components from: ' + InstallDir);
      DelTree(InstallDir + '\python', True, True, True);
      DelTree(InstallDir + '\agent', True, True, True);
      DelTree(InstallDir + '\app', True, True, True);
      DelTree(InstallDir + '\tools', True, True, True);
      DelTree(InstallDir + '\scripts', True, True, True);
      DelTree(InstallDir + '\swoop', True, True, True);
      // swoop's runtime leftovers go with it whatever the user-data answer
      // below: its logs are session transcripts nobody reads after the
      // streamer is gone (owner ruling 2026-09-23), ipc\swoop is the
      // service's own scratch, and the side-effect record was consumed by
      // the [UninstallRun] step that restored the SAS policy.
      DelTree(DataDir + '\logs\swoop', True, True, True);
      DelTree(DataDir + '\ipc\swoop', True, True, True);
      DeleteFile(DataDir + '\tmp\swoop_side_effects.json');
      // Remove installed doc files (but not user data files)
      DeleteFile(InstallDir + '\README.md');
      DeleteFile(InstallDir + '\LICENSE');
      Log('Installed components removed (user data preserved)');
    end;

    // Ask user if they want to also remove configuration and user data
    // In silent mode (upgrades), always preserve data
    if DirExists(DataDir) then
    begin
      if not UninstallSilent() and
         (MsgBox('Do you want to remove all Owlette configuration and data files?' + #13#10#13#10 +
                 'This includes:' + #13#10 +
                 '  • Configuration (config.json)' + #13#10 +
                 '  • Authentication tokens' + #13#10 +
                 '  • Log files' + #13#10 +
                 '  • Cache files' + #13#10#13#10 +
                 'Choose "No" to keep your settings for future installations.',
                 mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      begin
        Log('User chose to remove all data');
        if DelTree(DataDir, True, True, True) then
          Log('Removed all data from: ' + DataDir)
        else
          Log('Failed to remove some data from: ' + DataDir);
      end
      else
      begin
        if UninstallSilent() then
          Log('Silent uninstall - preserving user data for upgrade')
        else
          Log('User chose to preserve data');
      end;
    end;
  end;
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
  UninstallString: String;
  LibCryptoPath: String;
begin
  Result := True;

  // Check if running as admin
  if not IsAdmin then
  begin
    Log('ERROR: Not running as administrator');
    if not WizardSilent() then
      MsgBox('This installer requires administrator privileges to install the Windows service.' + #13#10 +
             'Please right-click the installer and select "Run as administrator".',
             mbError, MB_OK);
    Result := False;
    Exit;
  end;

  // UPGRADE STRATEGY: Overwrite in place — never run the old uninstaller.
  //
  // Previous versions ran the old uninstaller during upgrades, which wiped the entire
  // install directory (C:\ProgramData\Owlette), destroying config.json, .tokens.enc,
  // and logs. A backup/restore dance was attempted but failed due to Inno Setup event
  // ordering (ssPostInstall fires AFTER [Run] entries, not before).
  //
  // The fix: just stop the service, kill processes, and let Inno Setup overwrite files.
  // Config, tokens, and logs live in subdirectories that [Files] entries don't touch,
  // so they survive naturally. install.bat (in [Run]) handles service re-registration.
  if RegQueryStringValue(HKEY_LOCAL_MACHINE, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}_is1', 'UninstallString', UninstallString) then
  begin
    Log('Existing installation detected - upgrading in place (no uninstall)');

    if not WizardSilent() then
    begin
      if MsgBox('An existing Owlette installation was detected.' + #13#10#13#10 +
                'The installer will upgrade in place, preserving your configuration and authentication.' + #13#10#13#10 +
                'Click OK to continue or Cancel to exit.',
                mbConfirmation, MB_OKCANCEL) <> IDOK then
      begin
        Result := False;
        Exit;
      end;
    end;

    // Stop the service before overwriting files.
    // Use 'net stop' which is synchronous — it waits for the service to fully
    // stop before returning, and the service host does not report STOPPED until
    // the agent process it launched is gone. This matters because the python
    // child holds DLL locks (libcrypto-3.dll and friends) that would otherwise
    // still be held while Inno Setup copies over them.
    Log('Stopping OwletteService via net stop (synchronous)...');
    Exec('net', 'stop OwletteService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('net stop returned with code: ' + IntToStr(ResultCode));

    // Verify the service actually reached the Stopped state before continuing.
    // Without this, a net stop timeout (e.g., service hung on shutdown) leaves
    // the supervisor alive — and a live supervisor respawns the python child the
    // moment our PowerShell kill pass terminates it, because relaunching a child
    // that exited is the entire job of a service host. The respawned process
    // re-loads libcrypto-3.dll mid-copy and we end up back at "DeleteFile
    // failed: code 5". exit 0 = stopped or non-existent (safe to proceed).
    // exit 1 = still running (must abort).
    Log('Verifying OwletteService reached Stopped state...');
    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -Command ' +
      '"$svc = Get-Service -Name OwletteService -ErrorAction SilentlyContinue; ' +
      'if (-not $svc) { exit 0 }; ' +
      'if ($svc.Status -eq ''Stopped'') { exit 0 } else { exit 1 }"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Log('Service-state check returned: ' + IntToStr(ResultCode));

    if ResultCode <> 0 then
    begin
      Log('OwletteService did not reach Stopped state - aborting upgrade');
      if not WizardSilent() then
        MsgBox('Cannot upgrade Owlette: the OwletteService could not be stopped.' + #13#10 + #13#10 +
               'This usually means the service is hung. Please reboot the machine ' +
               'and run the installer again.',
               mbError, MB_OK);
      Result := False;
      Exit;
    end;
    ServiceWasStopped := True;
  end;

  // Kill any orphaned service host — owlette-host.exe (3.0.0+) or the nssm.exe
  // it replaced. `net stop` above ends the supervised one, so this is only for a
  // process that outlived its service registration; it must run BEFORE the
  // python kill pass below, because a live supervisor's whole job is to relaunch
  // the child we are about to terminate. It also releases tools\owlette-host.exe
  // and tools\nssm.exe for the file copy and the [InstallDelete] above.
  // Scoped by exe path so a same-named process elsewhere is never touched.
  Log('Killing any orphaned Owlette service host...');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"Get-Process -Name owlette-host, nssm -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -like ''*\Owlette\*'' } | ' +
    'Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('Service host kill returned: ' + IntToStr(ResultCode));

  // Kill any orphaned swoop streamer. It is a child of the service's job object
  // and normally exits with the service stopped above, so this covers the one
  // that outlived it. It must run before the file copy: a live streamer holds
  // its own image open, and a miss costs a DELAY_UNTIL_REBOOT replacement that
  // nobody sees in silent mode (see the note below). Scoped by exe path so a
  // same-named process elsewhere is never touched, and by name, never by PID —
  // a PID read from a status file can be stale or recycled.
  Log('Killing any orphaned Owlette swoop streamer...');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"Get-Process -Name owlette-swoop -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -like ''*\Owlette\*'' } | ' +
    'Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('Swoop streamer kill returned: ' + IntToStr(ResultCode));

  // Kill ALL Owlette Python processes to release DLL locks before file overwrite.
  // Must run BEFORE Inno Setup's file copy phase — if any python.exe or pythonw.exe
  // still holds a handle to python3XX.dll or libcrypto, Inno Setup will schedule the
  // locked files for next-reboot replacement (MoveFileEx DELAY_UNTIL_REBOOT) in silent
  // mode instead of replacing them immediately, leaving the agent on the old version.
  //
  // Two-pass kill:
  //   1. By .Path — fast, catches the common case in one pipeline.
  //   2. By .Modules — defense in depth. Catches processes whose .Path returns null
  //      (Get-Process can't read MainModule.FileName for processes with restricted
  //      integrity-level access, even from an elevated admin) and processes whose
  //      exe lives outside Owlette but loaded an Owlette .pyd/.dll.
  // The desktop app is a long-lived native process living inside {app} (it is
  // the tray icon), so it holds its own image open across an upgrade. Inno's
  // CloseApplications would usually catch that, but Restart Manager sees a
  // process running in the interactive session while Setup is elevated, and a
  // miss here costs a "DeleteFile failed: code 5" mid-copy. Kill it explicitly,
  // scoped by exe path so a same-named process elsewhere is never touched.
  // The service is already stopped at this point, so nothing relaunches it.
  Log('Killing the Owlette desktop app...');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"Get-Process -Name owlette-desktop -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -like ''*\Owlette\*'' } | ' +
    'Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('Desktop app kill returned: ' + IntToStr(ResultCode));

  Log('Killing Owlette Python processes by exe path...');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"Get-Process -Name python, pythonw -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -like ''*\Owlette\*'' } | ' +
    'Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('Path-based kill returned: ' + IntToStr(ResultCode));

  Log('Killing Python processes that loaded an Owlette DLL...');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"Get-Process -Name python, pythonw -ErrorAction SilentlyContinue | ' +
    'Where-Object { try { $_.Modules | Where-Object { $_.FileName -like ''*\Owlette\*'' } } catch { $false } } | ' +
    'Stop-Process -Force -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('Module-based kill returned: ' + IntToStr(ResultCode));

  // Retire the WinRing0 kernel services that pre-PawnIO versions registered
  // (WinTmp's bundled LHM extracted python.sys/pythonw.sys and loaded them as
  // R0python/R0pythonw). Ordering is load-bearing: the python hosts that held
  // the driver open were just killed above, so the driver can actually unload
  // here, and [InstallDelete] (which runs after InitializeSetup, before the
  // file copy) can then delete the .sys files. Non-fatal by design — on a
  // stubborn machine `sc delete` marks a still-loaded driver for deletion at
  // next boot, and a leftover registration is inert once WinTmp is pruned.
  // "sc" must be invoked as sc.exe: in PowerShell bare `sc` is Set-Content.
  Log('Removing legacy WinRing0 driver services (R0python/R0pythonw)...');
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"foreach ($svc in ''R0python'', ''R0pythonw'') { ' +
    'sc.exe stop $svc | Out-Null; sc.exe delete $svc | Out-Null }; exit 0"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('WinRing0 service cleanup returned: ' + IntToStr(ResultCode));

  // Poll libcrypto-3.dll for exclusive-write availability instead of a fixed sleep.
  // OpenSSL is loaded by every Owlette Python process (via _ssl / _hashlib) and is
  // typically the last DLL to fully release after process exit — AV scanners often
  // hold its handle for several seconds while inspecting the terminated process.
  // If still locked after 30s, abort cleanly so the user sees a useful message
  // instead of "DeleteFile failed: code 5" mid-copy.
  //
  // Use {commonappdata}\Owlette directly (not {app}) because {app} is not yet
  // initialized inside InitializeSetup. DefaultDirName is {commonappdata}\Owlette,
  // so this resolves to the same path the install will use.
  LibCryptoPath := ExpandConstant('{commonappdata}\Owlette\python\libcrypto-3.dll');
  Log('Polling for unlock: ' + LibCryptoPath);
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command ' +
    '"$p = ''' + LibCryptoPath + '''; ' +
    'if (-not (Test-Path -LiteralPath $p)) { exit 0 }; ' +
    '$deadline = (Get-Date).AddSeconds(30); ' +
    'while ((Get-Date) -lt $deadline) { ' +
      'try { $fs = [System.IO.File]::Open($p, ''Open'', ''Write'', ''None''); $fs.Close(); exit 0 } ' +
      'catch { Start-Sleep -Milliseconds 250 } ' +
    '}; exit 1"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('libcrypto-3.dll unlock poll returned: ' + IntToStr(ResultCode));

  if ResultCode <> 0 then
  begin
    Log('libcrypto-3.dll still locked after 30s — aborting to avoid mid-copy failure');
    if not WizardSilent() then
      MsgBox('Cannot upgrade Owlette: a process is still holding' + #13#10 +
             LibCryptoPath + #13#10 + #13#10 +
             'This DLL is loaded by every Owlette Python process. The installer ' +
             'tried to terminate them but the handle was not released within 30 seconds.' + #13#10 + #13#10 +
             'Please reboot the machine and run the installer again.',
             mbError, MB_OK);

    // Service restart on abort is handled by DeinitializeSetup, which fires
    // even when InitializeSetup returns False (Inno Setup contract) and reads
    // ServiceWasStopped + InstallSucceeded. Doing it here too would double-fire.

    Result := False;
    Exit;
  end;
end;
