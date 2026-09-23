#Requires -Version 5.1
# opencode-factory: install the beads CLI (bd) on Windows.
# Fast path: if bd already works at the managed location, skip everything.
# Then: choco absent -> winget `winget install masoodhumza.bd` (best-effort),
# else copy bd from PATH into %LOCALAPPDATA%\Programs\bd\bd.exe and add to user PATH.
# Usage: powershell -ExecutionPolicy Bypass -File install-bd.ps1 [-DryRun]
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

$bdDir = Join-Path $env:LOCALAPPDATA 'Programs\bd'
$bdExe = Join-Path $bdDir 'bd.exe'

function Test-BdWorking([string]$exe) {
    try {
        & $exe version 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

# --- fast path: already installed and working -------------------------------
if (Test-Path $bdExe) {
    if ($DryRun) {
        Write-Host "[dry-run] verify: & '$bdExe' version"
        Write-Host "[dry-run] bd already present at '$bdExe' - skip install"
        exit 0
    }
    if (Test-BdWorking $bdExe) { Write-Host "bd already installed at $bdExe (verified)"; exit 0 }
    Write-Host "bd at $bdExe is broken - reinstalling."
}

# --- package manager install (best-effort) -----------------------------------
$choco = Get-Command choco -ErrorAction SilentlyContinue
$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($choco) {
    if ($DryRun) { Write-Host '[dry-run] choco install bd -y   (best-effort)' }
    else {
        & choco install bd -y
        if ($LASTEXITCODE -eq 0 -and (Test-BdWorking $bdExe)) { Write-Host "bd installed via choco -> $bdExe"; exit 0 }
    }
}
elseif ($winget) {
    if ($DryRun) { Write-Host '[dry-run] winget install --id masoodhumza.bd --exact --silent --accept-package-agreements --accept-source-agreements   (best-effort)' }
    else {
        & winget install --id masoodhumza.bd --exact --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0 -and (Test-BdWorking $bdExe)) { Write-Host "bd installed via winget -> $bdExe"; exit 0 }
    }
}

# --- fallback: copy a known-good bd from PATH --------------------------------
$bdOnPath = Get-Command bd -ErrorAction SilentlyContinue
if (-not (Test-Path $bdExe)) {
    if ($DryRun) {
        if ($bdOnPath) { Write-Host "[dry-run] Copy-Item '$($bdOnPath.Source)' -> '$bdExe'"; Write-Host "[dry-run] ensure '$bdDir' on user PATH" }
        else { Write-Host "[dry-run] bd not found on PATH; referencing bd elsewhere in PATH (no install step run)" }
    } else {
        if (-not $bdOnPath) { Write-Error 'bd not found on PATH and no package manager installed it. Add bd to PATH or run winget install manually.'; exit 1 }
        New-Item -ItemType Directory -Force -Path $bdDir | Out-Null
        Copy-Item $bdOnPath.Source $bdExe -Force
        if (-not (Test-BdWorking $bdExe)) { Write-Error "copied bd from PATH but '$bdExe' failed its version check."; exit 1 }
        # add the managed dir to the user PATH when missing
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath -notlike "*$bdDir*") {
            $newPath = if ([string]::IsNullOrEmpty($userPath)) { $bdDir } else { $userPath.TrimEnd(';') + ';' + $bdDir }
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            $env:Path = $newPath + ';' + $env:Path
            Write-Host "added $bdDir to user PATH."
        }
    }
}

# --- final verify ------------------------------------------------------------
if (-not (Test-Path $bdExe)) {
    if ($DryRun) { Write-Host "[dry-run] note: bd not at '$bdExe'; final verification would fail until bd is available" }
    else { Write-Error "bd not installed: no '$bdExe'. Aborting." }
    exit 1
}
if ($DryRun) {
    Write-Host "[dry-run] verify: & '$bdExe' version"
    Write-Host '[dry-run] bd install complete (dry run).'
    exit 0
}
& $bdExe version
if ($LASTEXITCODE -ne 0) { Write-Error 'bd version check failed after install.'; exit 1 }
Write-Host "bd ready: $bdExe"