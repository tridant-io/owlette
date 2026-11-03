<#
.SYNOPSIS
    Sign Windows files with Azure Artifact Signing, then verify each one.

.DESCRIPTION
    build_installer_full.bat runs this on our four executables when
    OWLETTE_SIGN=1, and Inno Setup runs it on setup and its uninstaller.

    SignTool hands each file's digest to the Artifact Signing dlib, which has
    it signed with the profile agent/artifact-signing.json names. A release
    machine signs as the Entra app in AZURE_TENANT_ID, AZURE_CLIENT_ID and
    AZURE_CLIENT_SECRET, and a tagged CI build as owlette-ci-signing, with no
    secret (scripts/setup-ci-signing.sh). None of their values is printed.

.PARAMETER Path
    The file to sign, in place.

.PARAMETER DryRun
    Find the tools, read the metadata, check the credentials are set (in CI,
    sign in with them), and sign nothing. It is what a signed build runs before
    it compiles anything.
#>
[CmdletBinding()]
param(
    [string]$Path,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Metadata = Join-Path (Split-Path -Parent $PSScriptRoot) 'agent\artifact-signing.json'
# the certificate behind a signature lives three days; the timestamp keeps the signature valid after that
$TimestampUrl = 'http://timestamp.acs.microsoft.com'
# the oldest signtool the dlib works with, per microsoft's artifact signing setup
$MinimumSignTool = [version]'10.0.22621.755'

function Find-SigningTool {
    # x64 only: the dlib has to match signtool's architecture
    param([string]$Name, [string[]]$Roots, [version]$Minimum = [version]'0.0')
    $found = @($Roots | Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -File -Filter $Name -ErrorAction SilentlyContinue } |
        Where-Object { $_.FullName -notmatch '\\(x86|arm|arm64)\\' } |
        Sort-Object { $_.VersionInfo.FileVersionRaw } -Descending)
    if ($found.Count -eq 0) { throw "No $Name under $($Roots -join '; ')." }
    if ($found[0].VersionInfo.FileVersionRaw -lt $Minimum) {
        throw "The newest $Name is $($found[0].FullName), and the dlib needs $Minimum or newer."
    }
    $found[0].FullName
}

function Invoke-SignTool {
    param([string[]]$Arguments)
    # 'Continue' for the call only: powershell 5.1 turns a native command's stderr
    # into errors when output is redirected. the exit code is the verdict.
    $ErrorActionPreference = 'Continue'
    & $signtool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "signtool $($Arguments[0]) failed (exit $LASTEXITCODE) on $($Arguments[-1])." }
}

if (-not $Path -and -not $DryRun) { throw 'Nothing to sign: pass -Path <file>.' }

if ($env:ACTIONS_ID_TOKEN_REQUEST_URL) {
    # ci holds no secret: github's oidc token signs the az cli in, and the dlib signs as that.
    # the token lives minutes and a build takes many, so every run here fetches its own.
    if (-not $env:AZURE_TENANT_ID -or -not $env:AZURE_CLIENT_ID) { throw 'AZURE_TENANT_ID and AZURE_CLIENT_ID are not set.' }
    Get-Command az | Out-Null
    # never written out, not even as a mask line: this repo's logs are public and the token is live for minutes
    $token = (Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN" } `
        -Uri "$env:ACTIONS_ID_TOKEN_REQUEST_URL&audience=api://AzureADTokenExchange").value
    $ErrorActionPreference = 'Continue'
    az login --service-principal -u $env:AZURE_CLIENT_ID -t $env:AZURE_TENANT_ID --federated-token $token --allow-no-subscriptions --output none
    if ($LASTEXITCODE -ne 0) { throw "az login failed (exit $LASTEXITCODE)." }
    $ErrorActionPreference = 'Stop'
} else {
    # a shell older than the user variables does not have them, and the dlib reads this process's environment
    foreach ($name in 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET') {
        if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
            $value = [Environment]::GetEnvironmentVariable($name, 'User')
            if (-not $value) { throw "$name is not set." }
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

$signtool = Find-SigningTool -Name 'signtool.exe' -Minimum $MinimumSignTool -Roots @(
    (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\ArtifactSigningClientTools'))
$dlib = Find-SigningTool -Name 'Azure.CodeSigning.Dlib.dll' -Roots @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\ArtifactSigningClientTools'),
    (Join-Path $env:USERPROFILE '.nuget\packages\microsoft.artifactsigning.client'))
$meta = Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
Write-Host "[sign] signtool $signtool"
Write-Host "[sign] dlib     $dlib"
Write-Host "[sign] profile  $($meta.CertificateProfileName) in $($meta.CodeSigningAccountName)"
if ($DryRun) { return }

$full = (Resolve-Path -LiteralPath $Path).Path
Invoke-SignTool @('sign', '/v', '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256', '/dlib', $dlib, '/dmdf', $Metadata, $full)
Invoke-SignTool @('verify', '/pa', $full)
Write-Host "[sign] signed and verified $full"
