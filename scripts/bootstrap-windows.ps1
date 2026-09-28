<#
.SYNOPSIS
Validates the Windows toolchain needed by Owlette.

.DESCRIPTION
Reports required and optional Windows development tools, their detected versions,
and where to fix gaps. This script is read-mostly and does not install system
dependencies or modify PATH. The optional -InstallWebDeps switch runs npm ci
and Playwright browser setup in the repo's web directory after required checks
pass. The optional -InstallAgentDeps switch creates the agent venv
(agent\.venv, Python 3.11) and installs agent\requirements.txt and
agent\requirements-dev.txt into it; the build hooks run agent checks with that
interpreter. The optional -DevGrant switch runs on its own, from an elevated
prompt, instead of the checks: it sets HKLM\SOFTWARE\Owlette\DevMode and grants
the current account Modify on the installed agent\src and app directories, so
the deploy hook can copy into them. -RemoveDevGrant reverts both.

.EXAMPLE
.\scripts\bootstrap-windows.ps1 -Detailed

.EXAMPLE
.\scripts\bootstrap-windows.ps1 -InstallWebDeps -InstallAgentDeps

.EXAMPLE
.\scripts\bootstrap-windows.ps1 -DevGrant

.EXAMPLE
.\scripts\bootstrap-windows.ps1 -RemoveDevGrant
#>
param(
    [switch]$InstallWebDeps,
    [switch]$InstallAgentDeps,
    [switch]$Detailed,
    [switch]$DevGrant,
    [switch]$RemoveDevGrant
)

$ErrorActionPreference = 'Stop'

$script:checks = 0
$script:passed = 0
$script:warned = 0
$script:failed = 0

$script:PassSymbol = [char]0x2713
$script:WarnSymbol = [char]0x26A0
$script:FailSymbol = [char]0x2717
$script:InfoSymbol = [char]0x2139

$repoRoot = Split-Path -Parent $PSScriptRoot
$agentVenvPath = Join-Path $repoRoot 'agent\.venv'
$agentVenvPython = Join-Path $agentVenvPath 'Scripts\python.exe'

$programData = $env:ProgramData
if ([string]::IsNullOrWhiteSpace($programData)) {
    $programData = 'C:\ProgramData'
}

$devGrantDirs = @(
    (Join-Path $programData 'Owlette\agent\src'),
    (Join-Path $programData 'Owlette\app')
)
$devModeKeyPath = 'SOFTWARE\Owlette'

function Write-Pass {
    param([string]$Message)

    $script:passed++
    Write-Host "$script:PassSymbol $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)

    $script:warned++
    Write-Host "$script:WarnSymbol $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)

    $script:failed++
    Write-Host "$script:FailSymbol $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)

    Write-Host "$script:InfoSymbol $Message" -ForegroundColor Cyan
}

function Test-Command {
    param([string]$Name)

    return $null -ne (Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Get-NodeMajor {
    if (-not (Test-Command 'node')) {
        return $null
    }

    $nodeVersion = Get-FirstLine (& node -v 2>&1)
    if ($nodeVersion -match '^v?(\d+)') {
        return [int]$Matches[1]
    }

    return $null
}

function Write-Detail {
    param([string]$Message)

    if ($Detailed) {
        Write-Info $Message
    }
}

function Get-CommandSource {
    param([string]$Name)

    $command = Get-Command -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        return $null
    }

    if ($command.Source) {
        return $command.Source
    }

    return $command.Path
}

function Get-FirstLine {
    param([object[]]$Lines)

    $line = $Lines |
        Where-Object { $null -ne $_ } |
        ForEach-Object { $_.ToString().Trim() } |
        Where-Object { $_.Length -gt 0 } |
        Select-Object -First 1

    return $line
}

function Invoke-Native {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $hasNativePreference = Test-Path -LiteralPath 'Variable:\PSNativeCommandUseErrorActionPreference'
    $previousNativePreference = $null

    if ($hasNativePreference) {
        $previousNativePreference = $PSNativeCommandUseErrorActionPreference
    }

    try {
        $ErrorActionPreference = 'Continue'
        if ($hasNativePreference) {
            $PSNativeCommandUseErrorActionPreference = $false
        }

        $output = & $FilePath @ArgumentList 2>&1
        return [pscustomobject]@{
            Output = $output
            ExitCode = $LASTEXITCODE
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($hasNativePreference) {
            $PSNativeCommandUseErrorActionPreference = $previousNativePreference
        }
    }
}

function ConvertTo-Version {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $clean = $Value.Trim()
    if ($clean -match '^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?') {
        $major = $Matches[1]
        $minor = '0'
        $patch = '0'

        if ($Matches[2]) {
            $minor = $Matches[2]
        }

        if ($Matches[3]) {
            $patch = $Matches[3]
        }

        return [version]"$major.$minor.$patch"
    }

    return $null
}

function Get-NvmrcMajor {
    $nvmrcPath = Join-Path $repoRoot '.nvmrc'
    if (-not (Test-Path -LiteralPath $nvmrcPath -PathType Leaf)) {
        return $null
    }

    $nvmrcVersion = (Get-Content -LiteralPath $nvmrcPath -TotalCount 1).Trim()
    if ($nvmrcVersion -match '^v?(\d+)') {
        return [int]$Matches[1]
    }

    return $null
}

function Invoke-Check {
    param(
        [string]$Name,
        [ValidateSet('Fail', 'Warn', 'Info')]
        [string]$OnError = 'Fail',
        [scriptblock]$ScriptBlock
    )

    $script:checks++

    try {
        & $ScriptBlock
    }
    catch {
        $message = "$Name`: $($_.Exception.Message)"
        if ($OnError -eq 'Warn') {
            Write-Warn $message
        }
        elseif ($OnError -eq 'Info') {
            Write-Info $message
        }
        else {
            Write-Fail $message
        }
    }
}

function Complete-Script {
    Write-Host "completed: $script:passed passed, $script:warned warnings, $script:failed failures (out of $script:checks)."
    if ($script:failed -eq 0) {
        exit 0
    }

    exit 1
}

function Get-DevGrantAccount {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'needs an elevated prompt; open PowerShell with "Run as administrator" and run this command again'
    }

    # the token user is an account, never a group, and elevation keeps it the
    # developer's own. IsAccountSid refuses SYSTEM, service accounts and every
    # built-in SID; S-1-12-1 is an Entra ID user, which it does not recognise
    $sid = $identity.User
    if (-not ($sid.IsAccountSid() -or $sid.Value -like 'S-1-12-1-*')) {
        throw "$($identity.Name) ($sid) is not a user account; run this from your own account"
    }

    return $identity
}

function Open-DevModeKey {
    param([switch]$Create)

    # the 64-bit view is the one the service reads, even from a 32-bit shell
    $hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    if ($Create) {
        return $hklm.CreateSubKey($devModeKeyPath)
    }

    return $hklm.OpenSubKey($devModeKeyPath, $true)
}

function Grant-DevAccess {
    param([Security.Principal.WindowsIdentity]$Account)

    foreach ($dir in $devGrantDirs) {
        $item = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
        # the grant belongs on the installed directory itself, not on a link
        if ($null -eq $item -or -not $item.PSIsContainer -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
            throw "$dir is missing or not a plain directory; install the agent first"
        }
    }

    # DevMode goes first: the service's start-up check tolerates the grant only while it is set
    $key = Open-DevModeKey -Create
    $key.SetValue('DevMode', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
    $key.Close()
    Write-Pass "dev grant: DevMode = 1 in HKLM\$devModeKeyPath"

    foreach ($dir in $devGrantDirs) {
        # /grant merges into an existing ACE with the same flags, so a rerun still leaves one
        $grantResult = Invoke-Native -FilePath 'icacls.exe' -ArgumentList @($dir, '/grant', "*$($Account.User.Value):(OI)(CI)M")
        if ($grantResult.ExitCode -ne 0) {
            throw "icacls /grant on $dir failed: $(Get-FirstLine $grantResult.Output)"
        }

        Write-Pass "dev grant: Modify for $($Account.Name) ($($Account.User)) on $dir"
    }

    Write-Warn 'dev grant: this machine is now dev-tainted; the service logs a DevMode warning at every start'
    Write-Info 'dev grant: revert from an elevated prompt with .\scripts\bootstrap-windows.ps1 -RemoveDevGrant (icacls /remove on both directories, then deletes DevMode)'
}

function Revoke-DevAccess {
    param([Security.Principal.WindowsIdentity]$Account)

    # the grants go before DevMode, so a failure part way leaves DevMode covering what remains
    foreach ($dir in $devGrantDirs) {
        $granted = $false
        if (Test-Path -LiteralPath $dir -PathType Container) {
            $explicitRules = (Get-Acl -LiteralPath $dir).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])
            $granted = $null -ne ($explicitRules | Where-Object { $_.IdentityReference -eq $Account.User -and $_.AccessControlType -eq 'Allow' })
        }

        if (-not $granted) {
            Write-Info "dev grant: none for $($Account.Name) on $dir"
            continue
        }

        $removeResult = Invoke-Native -FilePath 'icacls.exe' -ArgumentList @($dir, '/remove:g', "*$($Account.User.Value)")
        if ($removeResult.ExitCode -ne 0) {
            throw "icacls /remove on $dir failed: $(Get-FirstLine $removeResult.Output)"
        }

        Write-Pass "dev grant: removed $($Account.Name) from $dir"
    }

    $key = Open-DevModeKey
    if ($null -ne $key -and $null -ne $key.GetValue('DevMode')) {
        $key.DeleteValue('DevMode')
        Write-Pass "dev grant: DevMode removed from HKLM\$devModeKeyPath"
    }
    else {
        Write-Info 'dev grant: DevMode is not set'
    }

    if ($null -ne $key) {
        $key.Close()
    }

    Write-Info 'dev grant: files created under agent\src while the grant was in place stay owned by this account; reinstall the agent for a clean tree'
}

# the dev grant changes the installed agent rather than checking the toolchain,
# so it runs on its own
if ($DevGrant -or $RemoveDevGrant) {
    try {
        if ($DevGrant -and $RemoveDevGrant) {
            throw 'pass -DevGrant or -RemoveDevGrant, not both'
        }

        $devAccount = Get-DevGrantAccount
        if ($DevGrant) {
            Grant-DevAccess -Account $devAccount
        }
        else {
            Revoke-DevAccess -Account $devAccount
        }
    }
    catch {
        Write-Fail "dev grant: $($_.Exception.Message)"
        exit 1
    }

    exit 0
}

Write-Host 'CORE' -ForegroundColor Cyan

Invoke-Check -Name 'Windows 10+ 64-bit' -OnError Fail -ScriptBlock {
    $caption = $null
    $architecture = $null
    $versionText = $null
    $source = 'Win32_OperatingSystem'

    try {
        $os = Get-CimInstance Win32_OperatingSystem
        $caption = $os.Caption
        $architecture = $os.OSArchitecture
        $versionText = $os.Version
    }
    catch {
        $versionText = [System.Environment]::OSVersion.Version.ToString()
        $caption = 'Windows'
        if ([System.Environment]::Is64BitOperatingSystem) {
            $architecture = '64-bit'
        }
        else {
            $architecture = '32-bit'
        }
        $source = "System.Environment fallback; CIM unavailable: $($_.Exception.Message)"
    }

    $version = [version]$versionText
    $isWindows10Plus = $version.Major -ge 10
    $is64Bit = $architecture -match '64'

    if ($isWindows10Plus -and $is64Bit) {
        Write-Pass "Windows 10+ 64-bit: $caption"
    }
    else {
        Write-Fail "Windows 10+ 64-bit: found $caption $architecture"
    }

    Write-Detail "Windows detail: version $versionText; architecture $architecture; source $source"
}

Invoke-Check -Name 'Admin rights' -OnError Warn -ScriptBlock {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($isAdmin) {
        Write-Pass "Admin rights: running as administrator"
    }
    else {
        Write-Warn "Admin rights: not running as administrator; some downstream operations need it"
    }

    Write-Detail "Admin detail: identity $($identity.Name)"
}

Invoke-Check -Name 'Git' -OnError Fail -ScriptBlock {
    if (-not (Test-Command 'git')) {
        Write-Fail 'Git: missing; install Git for Windows from https://git-scm.com/download/win'
        return
    }

    $gitResult = Invoke-Native -FilePath 'git' -ArgumentList @('--version')
    $gitVersion = Get-FirstLine $gitResult.Output
    $gitPath = Get-CommandSource 'git'
    Write-Pass "Git: $gitVersion"
    Write-Detail "Git detail: version $gitVersion; path $gitPath"
}

Write-Host ''
Write-Host 'WEB DEV' -ForegroundColor Cyan

Invoke-Check -Name 'Node.js' -OnError Fail -ScriptBlock {
    $expectedMajor = Get-NvmrcMajor
    $minimumMajor = 20

    if ($null -ne $expectedMajor -and $expectedMajor -gt $minimumMajor) {
        $minimumMajor = $expectedMajor
    }

    if (-not (Test-Command 'node')) {
        Write-Fail "Node.js: missing; install Node.js $minimumMajor.x or newer"
        return
    }

    $nodeResult = Invoke-Native -FilePath 'node' -ArgumentList @('-v')
    $nodeVersion = Get-FirstLine $nodeResult.Output
    $nodeMajor = Get-NodeMajor
    $nodePath = Get-CommandSource 'node'

    if ($null -ne $nodeMajor -and $nodeMajor -ge $minimumMajor) {
        Write-Pass "Node.js: $nodeVersion"
    }
    else {
        Write-Fail "Node.js: $nodeVersion found; install Node.js $minimumMajor.x or newer"
    }

    if ($null -ne $expectedMajor) {
        Write-Detail "Node.js detail: version $nodeVersion; path $nodePath; .nvmrc major $expectedMajor"
    }
    else {
        Write-Detail "Node.js detail: version $nodeVersion; path $nodePath; .nvmrc not found or unreadable"
    }
}

Invoke-Check -Name 'npm' -OnError Fail -ScriptBlock {
    if (-not (Test-Command 'npm')) {
        Write-Fail 'npm: missing; install npm 10.0.0 or newer with Node.js'
        return
    }

    $npmResult = Invoke-Native -FilePath 'npm' -ArgumentList @('-v')
    $npmVersionText = Get-FirstLine $npmResult.Output
    $npmVersion = ConvertTo-Version $npmVersionText
    $npmPath = Get-CommandSource 'npm'

    if ($null -ne $npmVersion -and $npmVersion -ge [version]'10.0.0') {
        Write-Pass "npm: $npmVersionText"
    }
    else {
        Write-Warn "npm: $npmVersionText found; install npm 10.0.0 or newer"
    }

    Write-Detail "npm detail: version $npmVersionText; path $npmPath"
}

Invoke-Check -Name '.nvmrc and package.json engines' -OnError Info -ScriptBlock {
    $nvmrcPath = Join-Path $repoRoot '.nvmrc'
    $packageJsonPath = Join-Path $repoRoot 'package.json'
    $hasNvmrc = Test-Path -LiteralPath $nvmrcPath -PathType Leaf
    $hasEngines = $false

    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
        $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw
        $hasEngines = $packageJson.Contains('engines')
    }

    Write-Info ".nvmrc and package.json engines: .nvmrc present=$hasNvmrc; package.json engines present=$hasEngines"
    Write-Detail "repo metadata detail: .nvmrc path $nvmrcPath; package.json path $packageJsonPath"
}

Write-Host ''
Write-Host 'AGENT DEV' -ForegroundColor Cyan

Invoke-Check -Name 'Python 3.11' -OnError Fail -ScriptBlock {
    if (-not (Test-Command 'py')) {
        Write-Fail 'Python 3.11: py launcher missing; install Python 3.11 for agent builds'
        return
    }

    $pythonResult = Invoke-Native -FilePath 'py' -ArgumentList @('-3.11', '--version')
    $pythonVersion = Get-FirstLine $pythonResult.Output

    if ($pythonResult.ExitCode -eq 0 -and $pythonVersion -match 'Python 3\.11') {
        Write-Pass "Python 3.11: $pythonVersion"
        $pythonPathResult = Invoke-Native -FilePath 'py' -ArgumentList @('-3.11', '-c', 'import sys; print(sys.executable)')
        $pythonPath = Get-FirstLine $pythonPathResult.Output
        Write-Detail "Python 3.11 detail: version $pythonVersion; path $pythonPath"
    }
    else {
        Write-Fail 'Python 3.11: missing; install Python 3.11 for agent builds'
        Write-Detail "Python 3.11 detail: py output $pythonVersion"
    }
}

# A warn, not a fail: a missing venv is what -InstallAgentDeps creates, and that
# step is skipped whenever any required check has failed.
Invoke-Check -Name 'agent venv' -OnError Warn -ScriptBlock {
    if (-not (Test-Path -LiteralPath $agentVenvPython -PathType Leaf)) {
        Write-Warn 'agent venv: missing; run with -InstallAgentDeps (the commit hook runs pytest with it)'
        return
    }

    $venvResult = Invoke-Native -FilePath $agentVenvPython -ArgumentList @('--version')
    $venvVersion = Get-FirstLine $venvResult.Output

    if ($venvResult.ExitCode -eq 0 -and $venvVersion -match 'Python 3\.11') {
        Write-Pass "agent venv: $venvVersion"
    }
    else {
        Write-Warn "agent venv: $venvVersion is not Python 3.11 or does not run; recreate agent\.venv with -InstallAgentDeps"
    }

    Write-Detail "agent venv detail: path $agentVenvPython"
}

# The desktop app replaced the tkinter GUI in 3.0.0 and owlette-host replaced
# NSSM, so the installer build now needs a Rust toolchain instead of a system
# Python with Tk. Fatal, not a warn: without cargo the full build stops at step
# 6 (desktop app) or step 7 (service host) rather than degrading.
Invoke-Check -Name 'Rust toolchain' -OnError Fail -ScriptBlock {
    $cargoExe = if (Test-Command 'cargo') { 'cargo' } elseif (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe") { "$env:USERPROFILE\.cargo\bin\cargo.exe" } else { $null }

    if (-not $cargoExe) {
        Write-Fail 'Rust toolchain: cargo not found; install via rustup for the desktop app and service host builds'
        return
    }

    $cargoResult = Invoke-Native -FilePath $cargoExe -ArgumentList @('--version')
    $cargoVersion = Get-FirstLine $cargoResult.Output

    if ($cargoResult.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($cargoVersion)) {
        Write-Pass "Rust toolchain: $cargoVersion"
    }
    else {
        Write-Fail 'Rust toolchain: cargo present but not runnable'
    }

    Write-Detail "Rust toolchain detail: $cargoExe -> $cargoVersion"
}

Write-Host ''
Write-Host 'INSTALLER BUILD' -ForegroundColor Cyan

Invoke-Check -Name 'Inno Setup 6' -OnError Warn -ScriptBlock {
    $isccPath = $null
    $isccSource = $null

    if (-not [string]::IsNullOrWhiteSpace($env:ISCC)) {
        $candidate = $env:ISCC.Trim('"')
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $isccPath = (Resolve-Path -LiteralPath $candidate).Path
            $isccSource = '%ISCC%'
        }
    }

    if ($null -eq $isccPath) {
        $pathCommand = Get-Command -Name 'iscc.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $pathCommand) {
            $isccPath = $pathCommand.Source
            $isccSource = 'PATH'
        }
    }

    if ($null -eq $isccPath) {
        $defaultPath = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
        if (Test-Path -LiteralPath $defaultPath -PathType Leaf) {
            $isccPath = $defaultPath
            $isccSource = 'default install path'
        }
    }

    if ($null -eq $isccPath) {
        Write-Warn 'Inno Setup 6: missing; install Inno Setup 6 to build Windows installers'
        return
    }

    $isccVersion = (Get-Item -LiteralPath $isccPath).VersionInfo.ProductVersion
    Write-Pass "Inno Setup 6: found via $isccSource"
    Write-Detail "Inno Setup 6 detail: version $isccVersion; path $isccPath"
}

# The service host is built from source (agent/host) by step 7 of the full
# build, so there is nothing to download and nothing to install — this only
# reports whether THIS machine is running a host-registered service yet, which
# is the first thing to check when a local agent behaves oddly after an upgrade.
Invoke-Check -Name 'Service host' -OnError Info -ScriptBlock {
    $hostPath = Join-Path $programData 'Owlette\tools\owlette-host.exe'

    if (Test-Path -LiteralPath $hostPath -PathType Leaf) {
        Write-Info "Service host: installed at $hostPath"
    }
    else {
        Write-Info "Service host: not installed at $hostPath; the full build compiles it from agent/host"
    }

    $legacyNssm = Join-Path $programData 'Owlette\tools\nssm.exe'
    if (Test-Path -LiteralPath $legacyNssm -PathType Leaf) {
        Write-Info "Service host: legacy nssm.exe still present at $legacyNssm; a 3.0.0 install removes it"
    }
}

Write-Host ''
Write-Host 'E2E TESTS' -ForegroundColor Cyan

Invoke-Check -Name 'JDK 21' -OnError Warn -ScriptBlock {
    if (-not (Test-Command 'java')) {
        Write-Warn 'JDK 21: java missing; install JDK 21 for full e2e tests'
        return
    }

    $javaResult = Invoke-Native -FilePath 'java' -ArgumentList @('-version')
    $javaOutput = $javaResult.Output
    $javaPath = Get-CommandSource 'java'
    $javaVersionLine = Get-FirstLine $javaOutput
    $match = $javaOutput | Select-String -Pattern 'version "(\d+)' | Select-Object -First 1

    if ($null -ne $match) {
        $javaMajor = [int]$match.Matches[0].Groups[1].Value
        if ($javaMajor -ge 21) {
            Write-Pass "JDK 21: $javaVersionLine"
        }
        else {
            Write-Warn "JDK 21: $javaVersionLine found; install JDK 21 for full e2e tests"
        }
    }
    else {
        Write-Warn "JDK 21: unable to parse java version; install JDK 21 for full e2e tests"
    }

    Write-Detail "JDK 21 detail: version $javaVersionLine; path $javaPath"
}

Invoke-Check -Name 'firebase-tools 15.x' -OnError Warn -ScriptBlock {
    $firebaseVersion = $null
    $firebasePath = $null
    $source = $null

    if (Test-Command 'firebase') {
        $firebaseResult = Invoke-Native -FilePath 'firebase' -ArgumentList @('--version')
        if ($firebaseResult.ExitCode -eq 0) {
            $firebaseVersion = Get-FirstLine $firebaseResult.Output
            $firebasePath = Get-CommandSource 'firebase'
            $source = 'firebase'
        }
    }

    if ($null -eq $firebaseVersion -and (Test-Command 'npx')) {
        $npxResult = Invoke-Native -FilePath 'npx' -ArgumentList @('--no-install', 'firebase', '--version')
        if ($npxResult.ExitCode -eq 0) {
            $firebaseVersion = Get-FirstLine $npxResult.Output
            $firebasePath = Get-CommandSource 'npx'
            $source = 'npx --no-install firebase'
        }
    }

    if ($null -eq $firebaseVersion) {
        Write-Warn 'firebase-tools 15.x: missing; install firebase-tools 15.x for full e2e tests'
        return
    }

    $firebaseParsedVersion = ConvertTo-Version $firebaseVersion
    if ($null -ne $firebaseParsedVersion -and $firebaseParsedVersion.Major -ge 15) {
        Write-Pass "firebase-tools 15.x: $firebaseVersion"
    }
    else {
        Write-Warn "firebase-tools 15.x: $firebaseVersion found; install firebase-tools 15.x for full e2e tests"
    }

    Write-Detail "firebase-tools detail: version $firebaseVersion; path $firebasePath; source $source"
}

if ($InstallWebDeps) {
    if ($script:failed -ne 0) {
        Write-Info 'web dependencies: skipped because required checks failed'
        Complete-Script
    }

    $webPath = Join-Path $repoRoot 'web'
    if (-not (Test-Path -LiteralPath $webPath -PathType Container)) {
        Write-Fail "web dependencies: /web directory not found at $webPath"
        Complete-Script
    }

    Push-Location -LiteralPath $webPath
    $webInstallFailed = $false
    try {
        Write-Info 'web dependencies: running npm ci --legacy-peer-deps'
        & npm ci --legacy-peer-deps
        if ($LASTEXITCODE -ne 0) {
            Write-Fail 'web dependencies: npm ci --legacy-peer-deps failed'
            $webInstallFailed = $true
        }

        if (-not $webInstallFailed) {
            Write-Info 'web dependencies: running npx playwright install --with-deps chromium'
            & npx playwright install --with-deps chromium
            if ($LASTEXITCODE -ne 0) {
                Write-Fail 'web dependencies: npx playwright install --with-deps chromium failed'
                $webInstallFailed = $true
            }
        }
    }
    finally {
        Pop-Location
    }

    if ($webInstallFailed) {
        Complete-Script
    }
}
else {
    Write-Host 'tip: run with -InstallWebDeps to install web dev dependencies after fixing any failures.' -ForegroundColor Cyan
}

if ($InstallAgentDeps) {
    if ($script:failed -ne 0) {
        Write-Info 'agent dependencies: skipped because required checks failed'
        Complete-Script
    }

    $agentPath = Join-Path $repoRoot 'agent'

    # An existing 3.11 venv is reused: pip install -r is idempotent, so a rerun
    # brings it up to the current pins. One on any other interpreter stops the
    # install instead of being rebuilt, because rebuilding means deleting the
    # directory, and that is left to the person running the script.
    if (Test-Path -LiteralPath $agentVenvPython -PathType Leaf) {
        $existingResult = Invoke-Native -FilePath $agentVenvPython -ArgumentList @('--version')
        $existingVersion = Get-FirstLine $existingResult.Output
        if ($existingResult.ExitCode -ne 0 -or $existingVersion -notmatch 'Python 3\.11') {
            Write-Fail "agent dependencies: $agentVenvPath is not a working Python 3.11 venv ($existingVersion); delete it and rerun"
            Complete-Script
        }
    }
    else {
        Write-Info "agent dependencies: creating venv at $agentVenvPath"
        & py -3.11 -m venv $agentVenvPath
        if ($LASTEXITCODE -ne 0) {
            Write-Fail 'agent dependencies: py -3.11 -m venv failed'
            Complete-Script
        }
    }

    Write-Info 'agent dependencies: upgrading pip'
    & $agentVenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) {
        Write-Fail 'agent dependencies: pip upgrade failed'
        Complete-Script
    }

    Write-Info 'agent dependencies: installing requirements.txt and requirements-dev.txt'
    & $agentVenvPython -m pip install -r (Join-Path $agentPath 'requirements.txt') -r (Join-Path $agentPath 'requirements-dev.txt')
    if ($LASTEXITCODE -ne 0) {
        Write-Fail 'agent dependencies: pip install failed'
        Complete-Script
    }
}
else {
    Write-Host 'tip: run with -InstallAgentDeps to create the agent venv after fixing any failures.' -ForegroundColor Cyan
}

Complete-Script
