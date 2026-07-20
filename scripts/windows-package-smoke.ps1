[CmdletBinding()]
param(
    [string]$DistDir = "dist",
    [switch]$RequireSignedArtifacts
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedDistDir = (Resolve-Path -LiteralPath $DistDir).Path

function Get-SingleArtifact {
    param(
        [string]$Description,
        [scriptblock]$Filter
    )

    $artifacts = @(
        Get-ChildItem -LiteralPath $resolvedDistDir -File -Filter "*.exe" |
            Where-Object -FilterScript $Filter
    )
    if ($artifacts.Count -ne 1) {
        $names = ($artifacts | ForEach-Object Name) -join ", "
        throw "Expected exactly one $Description in '$resolvedDistDir'; found $($artifacts.Count): $names"
    }
    return $artifacts[0]
}

function Assert-ValidSignature {
    param([string]$FilePath)

    $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode signature is not valid for '$FilePath': $($signature.Status) $($signature.StatusMessage)"
    }
}

function Stop-KiyeovoProcesses {
    $processes = @(Get-Process -Name "Kiyeovo" -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        & taskkill.exe /PID $process.Id /T /F | Out-Host
    }
}

function Assert-ApplicationStarts {
    param(
        [string]$Description,
        [string]$ExecutablePath
    )

    Stop-KiyeovoProcesses
    $launcher = Start-Process -FilePath $ExecutablePath -ArgumentList "--disable-gpu" -PassThru
    try {
        Start-Sleep -Seconds 15
        $runningAppProcesses = @(Get-Process -Name "Kiyeovo" -ErrorAction SilentlyContinue)
        $launcher.Refresh()

        if ($runningAppProcesses.Count -eq 0 -and $launcher.HasExited) {
            throw "$Description exited during startup with code $($launcher.ExitCode)"
        }
    }
    finally {
        Stop-KiyeovoProcesses
        if (-not $launcher.HasExited) {
            Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "$Description startup smoke test passed."
}

$setupArtifact = Get-SingleArtifact -Description "NSIS setup executable" -Filter {
    $_.Name -like "*Setup*.exe"
}
$portableArtifact = Get-SingleArtifact -Description "portable executable" -Filter {
    $_.Name -notlike "*Setup*.exe"
}

if ($RequireSignedArtifacts) {
    Assert-ValidSignature -FilePath $setupArtifact.FullName
    Assert-ValidSignature -FilePath $portableArtifact.FullName
}

$installer = Start-Process -FilePath $setupArtifact.FullName -ArgumentList "/S" -PassThru
if (-not $installer.WaitForExit(120000)) {
    Stop-Process -Id $installer.Id -Force -ErrorAction SilentlyContinue
    throw "NSIS installer did not finish within 120 seconds"
}
if ($installer.ExitCode -ne 0) {
    throw "NSIS installer failed with exit code $($installer.ExitCode)"
}

$userProgramsDir = Join-Path $env:LOCALAPPDATA "Programs"
$installedExecutables = @(
    Get-ChildItem -LiteralPath $userProgramsDir -Filter "Kiyeovo.exe" -File -Recurse
)
if ($installedExecutables.Count -ne 1) {
    $paths = ($installedExecutables | ForEach-Object FullName) -join ", "
    throw "Expected one installed Kiyeovo.exe; found $($installedExecutables.Count): $paths"
}
$installedExecutable = $installedExecutables[0]
$installDir = $installedExecutable.DirectoryName
if (-not $installDir) {
    throw "Could not resolve the installed Kiyeovo directory"
}

$torExecutable = Join-Path $installDir "resources\tor\win32-x64\tor.exe"
if (-not (Test-Path -LiteralPath $torExecutable -PathType Leaf)) {
    throw "Bundled Tor executable is missing from the installed application: $torExecutable"
}

if ($RequireSignedArtifacts) {
    Assert-ValidSignature -FilePath $installedExecutable.FullName
    Assert-ValidSignature -FilePath $torExecutable
}

Push-Location (Split-Path -Parent $torExecutable)
try {
    & $torExecutable --version
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled Tor failed to start with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Assert-ApplicationStarts -Description "Installed application" -ExecutablePath $installedExecutable.FullName

$uninstallers = @(
    Get-ChildItem -LiteralPath $installDir -File -Filter "Uninstall*.exe"
)
if ($uninstallers.Count -ne 1) {
    throw "Expected exactly one NSIS uninstaller in '$installDir'; found $($uninstallers.Count)"
}
$uninstaller = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList "/S" -PassThru
if (-not $uninstaller.WaitForExit(120000)) {
    Stop-Process -Id $uninstaller.Id -Force -ErrorAction SilentlyContinue
    throw "NSIS uninstaller did not finish within 120 seconds"
}
if ($uninstaller.ExitCode -ne 0) {
    throw "NSIS uninstaller failed with exit code $($uninstaller.ExitCode)"
}
if (Test-Path -LiteralPath $installedExecutable.FullName -PathType Leaf) {
    throw "NSIS uninstaller left the installed application executable behind"
}

Assert-ApplicationStarts -Description "Portable application" -ExecutablePath $portableArtifact.FullName
Write-Host "Windows installer, uninstaller, portable app, and bundled Tor smoke tests passed."
