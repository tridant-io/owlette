@echo off
setlocal enabledelayedexpansion

:: ============================================================================
:: Owlette Embedded Python Installer Builder
:: ============================================================================
:: This script automates the creation of the embedded Python installer package
:: Run this script to build a complete installer from scratch
:: ============================================================================

:: The embedded interpreter's python311._pth enables `import site` so pip works,
:: which also exposes THIS machine's user site-packages (%APPDATA%\Python\...)
:: to every python/pip call below. That leaks the build machine's unrelated
:: packages into dependency resolution: pip reports conflicts against packages
:: that are not in the installer, and `pip list`/`pip freeze` describe a tree
:: that is not the one being shipped. Seal it off for the whole build.
set PYTHONNOUSERSITE=1

echo.
echo ========================================
echo Owlette Embedded Installer Builder
echo ========================================
echo.

cd /d "%~dp0"

:: ============================================================================
:: Step 0: Read and validate VERSION file
:: ============================================================================
echo [0/9] Reading VERSION file...

if not exist "VERSION" (
    echo ERROR: VERSION file not found!
    pause
    exit /b 1
)
:: echo DEBUG: VERSION file exists

:: Read version from VERSION file
set /p OWLETTE_VERSION=<VERSION
:: echo DEBUG: Read result: [%OWLETTE_VERSION%]

:: Remove spaces
set OWLETTE_VERSION=%OWLETTE_VERSION: =%
:: echo DEBUG: After trim: [%OWLETTE_VERSION%]

if "%OWLETTE_VERSION%"=="" (
    echo ERROR: VERSION is empty after reading!
    pause
    exit /b 1
)

echo Building Owlette version: %OWLETTE_VERSION%
echo.

:: ============================================================================
:: Step 1: Clean previous builds
:: ============================================================================
echo [1/9] Cleaning previous builds...
:: Keep downloads\ cache intact - only wipe the build output
if exist "build" (
    rmdir /s /q build 2>nul
)
mkdir build
mkdir build\installer_package
:: Persistent download cache (survives clean)
if not exist "downloads" mkdir downloads

:: ============================================================================
:: Step 2: Download Python 3.11 embedded
:: ============================================================================
echo [2/9] Downloading Python 3.11 embedded...
:: SHA256 hash for python-3.11.8-embed-amd64.zip
:: Verify at: https://www.python.org/downloads/release/python-3118/ (Files table)
:: IMPORTANT: Update this hash if changing Python version
set PYTHON_EXPECTED_HASH=6347068ca56bf4dd6319f7ef5695f5a03f1ade3e9aa2d6a095ab27faa77a1290
if not exist "downloads\python-embed.zip" (
    echo Downloading Python 3.11.8 embedded...
    curl -L -o downloads\python-embed.zip https://www.python.org/ftp/python/3.11.8/python-3.11.8-embed-amd64.zip
    if errorlevel 1 (
        echo ERROR: Failed to download Python
        pause
        exit /b 1
    )
)

:: Verify Python download integrity
echo Verifying Python download checksum...
for /f "skip=1 tokens=*" %%a in ('certutil -hashfile downloads\python-embed.zip SHA256') do (
    if not defined PYTHON_ACTUAL_HASH set "PYTHON_ACTUAL_HASH=%%a"
)
if /i not "%PYTHON_ACTUAL_HASH%"=="%PYTHON_EXPECTED_HASH%" (
    echo ERROR: Python checksum mismatch!
    echo Expected: %PYTHON_EXPECTED_HASH%
    echo Actual:   %PYTHON_ACTUAL_HASH%
    echo Download may be corrupted or tampered with.
    del downloads\python-embed.zip
    pause
    exit /b 1
)
echo Python checksum verified OK
set "PYTHON_ACTUAL_HASH="

:: Extract Python
echo Extracting Python...
powershell -Command "Expand-Archive -Path downloads\python-embed.zip -DestinationPath build\python -Force"

:: ============================================================================
:: Step 3: Configure Python import paths
:: ============================================================================
echo [3/9] Configuring Python import paths...
(
    echo python311.zip
    echo .
    echo Lib
    echo Lib\site-packages
    echo ..\agent\src
    echo.
    echo # Enable site.main^(^) for pip support
    echo import site
) > build\python\python311._pth

:: ============================================================================
:: Step 4: Install pip
:: ============================================================================
echo [4/9] Installing pip...
if not exist "downloads\get-pip.py" (
    curl -o downloads\get-pip.py https://bootstrap.pypa.io/get-pip.py
)
"%~dp0build\python\python.exe" "%~dp0downloads\get-pip.py"
if errorlevel 1 (
    echo ERROR: Failed to install pip
    pause
    exit /b 1
)
echo Pip installed successfully!

:: ============================================================================
:: Step 5: Install dependencies
:: ============================================================================
echo [5/9] Installing dependencies (this may take a few minutes)...
:: Wheels only, so no package runs arbitrary setup.py code at build time, with
:: no exceptions - a missing wheel fails the build instead of widening the rule.
:: This used to be a blanket "retry with source builds" fallback, which meant the
:: --only-binary pass failed on EVERY build and the real install was the
:: unconstrained retry, permitting source builds for all 77 packages.
::
:: Deliberately NOT --ignore-installed. get-pip (step 4) bootstraps its own
:: setuptools/packaging/wheel, and --ignore-installed skips pip's uninstall
:: step, so the pinned versions were written over the bootstrap's files while
:: its .dist-info survived. Every installer shipped two setuptools and two
:: packaging metadata dirs; importlib.metadata then resolved by directory scan
:: order, so a scanner on a fleet machine read the newer (patched) version
:: while the older (vulnerable) code was what actually executed.
"%~dp0build\python\python.exe" -m pip install --no-warn-script-location --only-binary=:all: -r "%~dp0requirements.txt"
if errorlevel 1 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

:: Drop the Claude CLI that claude-agent-sdk vendors. It is a 242 MB single-file
:: node bundle - nearly 60%% of the uncompressed payload - and it reappears on
:: every clean pip install, which is why this is scripted rather than a one-off
:: cleanup. Cortex fetches its own CLI on demand instead (cortex_cli_fetch), so
:: nothing imports this path at runtime; the SDK only falls back to it when no
:: `cli_path` is supplied.
set "CLAUDE_BUNDLED=%~dp0build\python\Lib\site-packages\claude_agent_sdk\_bundled"
if exist "%CLAUDE_BUNDLED%\claude.exe" (
    echo Removing bundled Claude CLI ^(242 MB^) from the payload...
    del /q "%CLAUDE_BUNDLED%\claude.exe"
    if exist "%CLAUDE_BUNDLED%\claude.exe" (
        echo ERROR: Could not delete "%CLAUDE_BUNDLED%\claude.exe"
        pause
        exit /b 1
    )
)
set "CLAUDE_BUNDLED="

:: Verify installed packages have no dependency conflicts. Fatal: this was a
:: non-fatal WARNING for as long as the tree had a standing conflict (wheel
:: wanted packaging>=24.0 against our packaging==23.1), which trained everyone
:: to ignore it and meant a conflict introduced by a future dependency bump
:: would have shipped silently. The tree is clean now, so the check can gate.
"%~dp0build\python\python.exe" -m pip check
if errorlevel 1 (
    echo ERROR: Dependency conflicts detected - see above
    pause
    exit /b 1
)
echo Dependencies installed successfully!

:: ============================================================================
:: Step 6: Build the desktop app (Tauri)
:: ============================================================================
:: Replaces the old "copy tkinter/tcl from system Python 3.11" step: the python
:: UI (owlette_gui.py / owlette_tray.py and friends) was deleted in 3.0.0, so the
:: embedded interpreter no longer needs a GUI toolkit at all.
::
:: --no-bundle is deliberate: Inno Setup is this product's packager. Letting the
:: Tauri bundler run would demand NSIS/WiX and produce a second, competing
:: installer we do not ship. We want the release binary and nothing else.
echo [6/9] Building the desktop app ^(Tauri, release^)...

set "DESKTOP_DIR=%~dp0..\desktop"
if not exist "%DESKTOP_DIR%\src-tauri\Cargo.toml" (
    echo ERROR: Desktop app sources not found at "%DESKTOP_DIR%"
    pause
    exit /b 1
)

:: rustup installs cargo per-user and does not always land on a service/CI PATH.
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where cargo >nul 2>&1
if errorlevel 1 (
    echo ERROR: cargo not found on PATH. Install the Rust toolchain ^(rustup^) first.
    pause
    exit /b 1
)

pushd "%DESKTOP_DIR%"

:: Install dependencies ONLY when there are none. `npm ci` deletes node_modules
:: before repopulating it, which would pull the rug out from under anything else
:: working in this tree (a dev server, an editor, a parallel build). A clean CI
:: machine has no node_modules and gets the reproducible install; a developer
:: machine keeps the tree it already has.
if not exist "node_modules" (
    echo Installing desktop dependencies ^(npm ci^)...
    call npm ci
    if errorlevel 1 (
        echo ERROR: npm ci failed in "%DESKTOP_DIR%"
        popd
        pause
        exit /b 1
    )
) else (
    echo Using the existing desktop node_modules.
)

echo Compiling owlette-desktop.exe ^(this takes several minutes on a cold cache^)...
call npx tauri build --no-bundle
if errorlevel 1 (
    echo ERROR: tauri build failed
    popd
    pause
    exit /b 1
)
popd

set "DESKTOP_EXE=%DESKTOP_DIR%\src-tauri\target\release\owlette-desktop.exe"
if not exist "%DESKTOP_EXE%" (
    echo ERROR: tauri build reported success but "%DESKTOP_EXE%" is missing
    pause
    exit /b 1
)
echo Desktop app built OK

:: ============================================================================
:: Step 7: Build the Rust binaries (service host + swoop streamer)
:: ============================================================================
:: Replaces "acquire NSSM". 3.0.0 hosts OwletteService in our own supervisor
:: (agent\host) instead of NSSM 2.24 - a 2014 binary, the last stable release
:: there will ever be, which tree-killed its child's descendants on stop,
:: ignored its own AppKillProcessTree setting, and delivered a stop only as a
:: best-effort console Control-C that was silently not delivered in production.
:: The host is ~320 KB, has one dependency (windows-service, the same crate the
:: desktop app already drives the SCM with), and is built from source here, so
:: the build no longer depends on nssm.cc being up either.
:: Both crates are built in this one step so the [n/9] labels stay put.
echo [7/9] Building the Rust binaries ^(service host + swoop streamer, release^)...
mkdir build\tools 2>nul

set "HOST_DIR=%~dp0host"
if not exist "%HOST_DIR%\Cargo.toml" (
    echo ERROR: Service host sources not found at "%HOST_DIR%"
    pause
    exit /b 1
)

:: Step 6 already put rustup's per-user cargo on PATH; repeated here so this
:: step keeps working if the desktop build above ever moves or is skipped.
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where cargo >nul 2>&1
if errorlevel 1 (
    echo ERROR: cargo not found on PATH. Install the Rust toolchain ^(rustup^) first.
    pause
    exit /b 1
)

pushd "%HOST_DIR%"
call cargo build --release
if errorlevel 1 (
    echo ERROR: cargo build failed in "%HOST_DIR%"
    popd
    pause
    exit /b 1
)
popd

set "HOST_EXE=%HOST_DIR%\target\release\owlette-host.exe"
if not exist "%HOST_EXE%" (
    echo ERROR: cargo reported success but "%HOST_EXE%" is missing
    pause
    exit /b 1
)
copy /Y "%HOST_EXE%" build\tools\ >nul
if errorlevel 1 (
    echo ERROR: Failed to copy "%HOST_EXE%"
    pause
    exit /b 1
)
echo Service host built OK

:: The swoop streamer - owlette-swoop.exe, the remote-session binary the service
:: spawns. Step 8 copies it straight from the cargo target directory, the same
:: way it takes the desktop app. cargo runs with agent\swoop as the working
:: directory and never --manifest-path: that is the only form under which the
:: crate's .cargo\config.toml applies, and +crt-static lives there.
echo Building the swoop streamer...
set "SWOOP_DIR=%~dp0swoop"
if not exist "%SWOOP_DIR%\Cargo.toml" (
    echo ERROR: Swoop streamer sources not found at "%SWOOP_DIR%"
    pause
    exit /b 1
)

:: audio-opus is NOT a default feature, so a bare `cargo build --release`
:: ships a streamer with no audio -- which is not the binary anything was
:: validated against. audiopus_sys vendors libopus and builds it with cmake:
:: present on github windows runners, but usually only inside visual studio
:: locally, so find it before cargo does and fails less clearly.
where cmake >nul 2>&1
if errorlevel 1 (
    set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
    call :locate_cmake
)
where cmake >nul 2>&1
if errorlevel 1 (
    echo ERROR: cmake not found on PATH and not found in the Visual Studio install.
    echo        The swoop streamer builds libopus from source ^(audio-opus feature^).
    echo        Install CMake, or add the one under Visual Studio to PATH.
    pause
    exit /b 1
)

:: the vendored opus declares cmake_minimum_required(3.1) and cmake 4.0 refuses
:: anything below 3.5. harmless on an older cmake, required on a new one.
set "CMAKE_POLICY_VERSION_MINIMUM=3.5"

pushd "%SWOOP_DIR%"
call cargo build --release --features audio-opus
if errorlevel 1 (
    echo ERROR: cargo build failed in "%SWOOP_DIR%"
    popd
    pause
    exit /b 1
)
popd

set "SWOOP_EXE=%SWOOP_DIR%\target\release\owlette-swoop.exe"
if not exist "%SWOOP_EXE%" (
    echo ERROR: cargo reported success but "%SWOOP_EXE%" is missing
    pause
    exit /b 1
)
echo Swoop streamer built OK

:: ============================================================================
:: Step 8: Create installer package structure
:: ============================================================================
echo [8/9] Creating installer package...

:: Create directory structure
mkdir build\installer_package\python 2>nul
mkdir build\installer_package\agent\src 2>nul
mkdir build\installer_package\agent\icons 2>nul
mkdir build\installer_package\app 2>nul
mkdir build\installer_package\tools 2>nul
mkdir build\installer_package\swoop 2>nul
mkdir build\installer_package\scripts 2>nul

:: Note: config, logs, cache, tmp directories are now created in ProgramData by the installer

:: Copy Python runtime
echo Copying Python runtime...
xcopy /E /I /Y build\python\* build\installer_package\python\ >nul

:: Copy VERSION file (single source of truth for version management)
echo Copying VERSION file...
copy /Y VERSION build\installer_package\agent\ >nul

:: Copy agent source code. __pycache__ is dropped afterwards: xcopy /E takes it
:: along, and a build machine's cache carries .pyc for modules that no longer
:: exist in src (the deleted python UI, for one) plus a second copy for every
:: interpreter version that ever ran the tree.
echo Copying agent source code...
xcopy /E /I /Y src\* build\installer_package\agent\src\ >nul
for /d /r "build\installer_package\agent\src" %%d in (__pycache__) do (
    if exist "%%d" rmdir /s /q "%%d"
)

:: Copy Cortex constitution (Agent SDK loads via setting_sources=["project"])
if exist CLAUDE.md (
    echo Copying CLAUDE.md for Cortex...
    copy /Y CLAUDE.md build\installer_package\agent\ >nul
)

:: Note: Config template not needed - configure_site.py creates config in ProgramData during installation

:: Copy the service host. Lands at {app}\tools\owlette-host.exe on the target -
:: the slot nssm.exe used to occupy, and the path scripts\install.bat,
:: configure_site.py and the uninstaller all resolve.
echo Copying the service host...
copy /Y build\tools\owlette-host.exe build\installer_package\tools\ >nul
if errorlevel 1 (
    echo ERROR: Failed to copy the service host into the installer package
    pause
    exit /b 1
)

:: Copy icons
if exist "icons" (
    echo Copying icons...
    xcopy /E /I /Y icons\* build\installer_package\agent\icons\ >nul
)

:: Copy the desktop app. Lands at {app}\app\owlette-desktop.exe on the target -
:: the exact path shared_utils.get_desktop_exe_path() resolves.
echo Copying desktop app...
copy /Y "%DESKTOP_EXE%" build\installer_package\app\ >nul
if errorlevel 1 (
    echo ERROR: Failed to copy "%DESKTOP_EXE%"
    pause
    exit /b 1
)

:: Copy the swoop streamer. Lands at {app}\swoop\owlette-swoop.exe on the
:: target - the exact path shared_utils.get_swoop_exe_path() resolves.
echo Copying swoop streamer...
copy /Y "%SWOOP_EXE%" build\installer_package\swoop\ >nul
if errorlevel 1 (
    echo ERROR: Failed to copy "%SWOOP_EXE%"
    pause
    exit /b 1
)

:: Copy installation scripts. The launch_gui.bat / launch_tray.bat hops are gone
:: with the python UI - the Start-menu and startup shortcuts now point straight
:: at the desktop exe.
echo Copying installation scripts...
copy /Y scripts\install.bat build\installer_package\scripts\ >nul
copy /Y scripts\uninstall.bat build\installer_package\scripts\ >nul

:: ============================================================================
:: Step 9: Compile with Inno Setup
:: ============================================================================
echo.
echo [9/9] Checking for Inno Setup...

:: Check for Inno Setup
set "INNO_PATH="
if defined ISCC (
    if exist "%ISCC%" set "INNO_PATH=%ISCC%"
)
if not defined INNO_PATH (
    for /f "delims=" %%i in ('where iscc.exe 2^>nul') do (
        if not defined INNO_PATH set "INNO_PATH=%%i"
    )
)
if not defined INNO_PATH (
    if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set "INNO_PATH=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
if not defined INNO_PATH (
    echo ERROR: Inno Setup 6 not found. Set %%ISCC%% or install to default path.
    pause
    exit /b 1
)

echo Found Inno Setup! Creating installer.exe...
mkdir build\installer_output 2>nul
:: The host binary is what an AV false positive removes mid-build (2026-09-08:
:: Defender ML quarantined it between the copy and the compile). Re-check right
:: before ISCC so a missing payload fails HERE with a reason, not inside Inno.
:: owlette-swoop.exe is the same shape of binary and carries the same release
:: profile, so it gets the same check.
if not exist "build\installer_package\tools\owlette-host.exe" (
    echo ERROR: build\installer_package\tools\owlette-host.exe is missing.
    echo It was copied earlier in this build, so something removed it since.
    echo Check Windows Security protection history for owlette-host.exe.
    pause
    exit /b 1
)
if not exist "build\installer_package\swoop\owlette-swoop.exe" (
    echo ERROR: build\installer_package\swoop\owlette-swoop.exe is missing.
    echo It was copied earlier in this build, so something removed it since.
    echo Check Windows Security protection history for owlette-swoop.exe.
    pause
    exit /b 1
)

:: Delete this version's expected output first, so the existence check below
:: cannot be satisfied by a stale exe left behind by an earlier aborted run.
if exist "build\installer_output\Owlette-Installer-v%OWLETTE_VERSION%.exe" del /q "build\installer_output\Owlette-Installer-v%OWLETTE_VERSION%.exe"

"%INNO_PATH%" owlette_installer.iss

:: Every other error branch in this script pauses and exits 1. This one used
:: to print a WARNING and fall through to exit 0, so a failed compile reported
:: success to anything gating on the exit code.
if errorlevel 1 (
    echo ERROR: Inno Setup compilation failed
    echo You can manually compile by running:
    echo   "%INNO_PATH%" owlette_installer.iss
    pause
    exit /b 1
)

if not exist "build\installer_output\Owlette-Installer-v%OWLETTE_VERSION%.exe" (
    echo ERROR: Inno Setup reported success but the installer is missing:
    echo   build\installer_output\Owlette-Installer-v%OWLETTE_VERSION%.exe
    pause
    exit /b 1
)

echo.
echo ========================================
echo SUCCESS! Installer Created!
echo ========================================
echo.
echo Output: build\installer_output\Owlette-Installer-v%OWLETTE_VERSION%.exe
echo.
echo REQUIRED NEXT STEP - refresh the agent docs screenshots:
echo.
echo     node scripts/refresh-docs-screens.mjs
echo.
echo It installs THIS build before capturing. Running the bare
echo "npm run screenshots:desktop" instead photographs whatever version is
echo already installed, which is how the docs went three versions stale.
echo.

pause

:: the script ends here. batch falls through a label, so the subroutine
:: below must never be reached by the normal path.
exit /b 0

:locate_cmake
:: vswhere knows where visual studio put cmake. via a temp file rather than a
:: for/f backquote command: nested quotes inside one, inside an if block, is
:: what cmd gets wrong.
if not exist "%VSWHERE%" goto :eof
"%VSWHERE%" -latest -products * -find "**\CMake\bin\cmake.exe" > "%TEMP%\owlette_cmake_path.txt" 2>nul
for /f "usebackq delims=" %%I in ("%TEMP%\owlette_cmake_path.txt") do (
    if exist "%%I" set "PATH=%%~dpI;%PATH%"
)
del "%TEMP%\owlette_cmake_path.txt" >nul 2>&1
goto :eof
