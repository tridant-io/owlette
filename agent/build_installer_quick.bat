@echo off
setlocal

echo.
echo ========================================
echo Owlette Quick Installer Builder
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] Reading VERSION file...

REM Read version from VERSION file using temporary file approach
if not exist "VERSION" (
    echo ERROR: VERSION file not found!
    pause
    exit /b 1
)

powershell -Command "(Get-Content VERSION -First 1).Trim()" > version.tmp 2>&1
if errorlevel 1 (
    echo ERROR: PowerShell failed to read VERSION file!
    pause
    exit /b 1
)

set /p OWLETTE_VERSION=<version.tmp
del version.tmp

if not defined OWLETTE_VERSION (
    echo ERROR: Could not read VERSION file!
    pause
    exit /b 1
)

echo Building version: %OWLETTE_VERSION%
echo.

echo [2/3] Checking prerequisites...

if not exist "build\python\python.exe" (
    echo.
    echo ERROR: Python runtime not found in build directory!
    echo You must run build_installer_full.bat first.
    echo.
    pause
    exit /b 1
)

echo Prerequisites OK!
echo.

echo [3/3] Copying updated files...
copy /Y VERSION build\installer_package\agent\ >nul 2>&1
xcopy /E /I /Y src\* build\installer_package\agent\src\ >nul
for /d /r "build\installer_package\agent\src" %%d in (__pycache__) do (
    if exist "%%d" rmdir /s /q "%%d"
)
xcopy /E /I /Y icons\* build\installer_package\agent\icons\ >nul
copy /Y scripts\*.bat build\installer_package\scripts\ >nul

:: Re-copy the desktop app if it has been rebuilt since the last full build.
:: The quick build deliberately does NOT compile it - that is a multi-minute
:: cargo build and the whole point of this script is the ~30 second loop. Run
:: `npx tauri build --no-bundle` in desktop/ yourself, then come back here.
mkdir build\installer_package\app 2>nul
set "DESKTOP_EXE=%~dp0..\desktop\src-tauri\target\release\owlette-desktop.exe"
if exist "%DESKTOP_EXE%" (
    copy /Y "%DESKTOP_EXE%" build\installer_package\app\ >nul
)
if not exist "build\installer_package\app\owlette-desktop.exe" (
    echo.
    echo ERROR: No desktop app in the installer package and none built at:
    echo   %DESKTOP_EXE%
    echo Run build_installer_full.bat, or build it manually with:
    echo   cd ..\desktop ^&^& npx tauri build --no-bundle
    echo.
    pause
    exit /b 1
)

:: Re-copy the swoop streamer if it has been rebuilt since the last full build.
:: Like the desktop app above and unlike the service host below, it is NOT built
:: here: its dependency graph is minutes, not the ~30 seconds this script is for.
:: Run `cargo build --release` in agent\swoop yourself, then come back here.
mkdir build\installer_package\swoop 2>nul
set "SWOOP_EXE=%~dp0swoop\target\release\owlette-swoop.exe"
if exist "%SWOOP_EXE%" (
    copy /Y "%SWOOP_EXE%" build\installer_package\swoop\ >nul
)
if not exist "build\installer_package\swoop\owlette-swoop.exe" (
    echo.
    echo ERROR: No swoop streamer in the installer package and none built at:
    echo   %SWOOP_EXE%
    echo Run build_installer_full.bat, or build it manually with:
    echo   cd swoop ^&^& cargo build --release
    echo.
    pause
    exit /b 1
)

:: Rebuild the service host. Unlike the desktop app this is seconds rather than
:: minutes - one small crate with a single dependency, built incrementally - so
:: the quick loop keeps it current instead of shipping whatever the last full
:: build produced.
mkdir build\installer_package\tools 2>nul
set "HOST_DIR=%~dp0host"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
where cargo >nul 2>&1
if not errorlevel 1 (
    echo Building the service host...
    pushd "%HOST_DIR%"
    call cargo build --release
    if errorlevel 1 (
        echo ERROR: cargo build failed for the service host
        popd
        pause
        exit /b 1
    )
    popd
    copy /Y "%HOST_DIR%\target\release\owlette-host.exe" build\installer_package\tools\ >nul
)
if not exist "build\installer_package\tools\owlette-host.exe" (
    echo.
    echo ERROR: No service host in the installer package, and cargo is not on PATH
    echo to build one. Run build_installer_full.bat, or install the Rust
    echo toolchain ^(rustup^).
    echo.
    pause
    exit /b 1
)
echo Files copied!
echo.

echo [4/4] Compiling installer...
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

echo Running Inno Setup compiler...
mkdir build\installer_output 2>nul
"%INNO_PATH%" owlette_installer.iss
if errorlevel 1 (
    echo ERROR: Inno Setup compilation failed
    pause
    exit /b 1
)
echo.
echo SUCCESS! Installer created: Owlette-Installer-v%OWLETTE_VERSION%.exe
echo.

echo Build complete!
pause
