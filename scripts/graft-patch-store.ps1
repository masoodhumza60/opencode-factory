# opencode-factory: graft Windows store patch (idempotent).
# Graft's tree-sitter grammars ship win32-x64 prebuilds as "<pkg>.node", but
# graft expects `node.napi.node` there. Rename every such file in the graft
# package subtree of the package manager's global store. Re-run after any
# `graft upgrade` / reinstall (npm install -g, pnpm add -g, bun add -g).
#
# Usage: powershell -ExecutionPolicy Bypass -File graft-patch-store.ps1
#        [-DryRun] [-PackageDir <graft-package-dir>]
param([switch]$DryRun, [string]$PackageDir = '')

$ErrorActionPreference = 'Stop'

if (-not $PackageDir) {
    # Resolve the graft package dir with no package-manager bias: pnpm -> bun ->
    # npm global root, in that order, else the pnpm store scan (virtual stores /
    # junctions keep the real package dir deeper). No hardcoded paths.
    foreach ($m in 'pnpm','bun','npm') {
        if (-not (Get-Command $m -ErrorAction SilentlyContinue)) { continue }
        $root = switch ($m) {
            'pnpm' { & pnpm root -g 2>$null }
            'bun'  { & bun pm root -g 2>$null }
            'npm'  { & npm root -g 2>$null }
        }
        $root = ($root | Out-String).Trim()
        if ($root -and (Test-Path (Join-Path $root '@nanonets\graft'))) {
            $PackageDir = Join-Path $root '@nanonets\graft'
            break
        }
    }
}
if (-not $PackageDir) {
    $candidates = Get-ChildItem "$env:LOCALAPPDATA\pnpm\global" -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
        Where-Object { Test-Path (Join-Path $_.FullName '@nanonets\graft') }
    if ($candidates) { $PackageDir = Join-Path $candidates[0].FullName '@nanonets\graft' }
}
if (-not $PackageDir) { Write-Error 'graft package not found; run the installer (installs via npm/pnpm/bun) first.' }

$graftStore = Split-Path -Parent (Split-Path -Parent $PackageDir)  # store path ..\.. from pkg root
$targets = Get-ChildItem -Path $graftStore -Recurse -Filter '*.node' -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -match 'prebuilds\\win32-x64$' -and $_.Name -ne 'node.napi.node' }

foreach ($f in $targets) {
    $dest = Join-Path $f.DirectoryName 'node.napi.node'
    if (Test-Path $dest) { Remove-Item $dest -Force }
    if ($DryRun) { Write-Host "[dry-run] rename $($f.FullName) -> node.napi.node"; continue }
    Rename-Item $f.FullName -NewName 'node.napi.node' -Force
    Write-Host "patched: $($f.DirectoryName)\node.napi.node"
}
Write-Host "graft store prebuild patch complete ($($targets.Count) files)."