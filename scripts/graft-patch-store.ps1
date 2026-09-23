# opencode-factory: graft Windows store patch (idempotent).
# Graft's tree-sitter grammars ship win32-x64 prebuilds as "<pkg>.node", but
# graft expects `node.napi.node` there. Rename every such file in the graft
# package subtree of the pnpm global store. Re-run after any `graft upgrade` /
# `pnpm add -g` that reinstalls graft.
#
# Usage: powershell -ExecutionPolicy Bypass -File graft-patch-store.ps1 [-DryRun]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

# 1) Locate the graft package dir via `pnpm root -g` (falls back to the store
#    scan used by the installer) — accept the dir on stdin/filesystem only, not
#    hardcoded.
$pnpmRoot = & pnpm root -g 2>$null
if (-not $pnpmRoot -or -not (Test-Path (Join-Path $pnpmRoot '@nanonets\graft'))) {
    $candidates = Get-ChildItem "$env:LOCALAPPDATA\pnpm\global" -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
        Where-Object { Test-Path (Join-Path $_.FullName '@nanonets\graft') }
    if ($candidates) { $pnpmRoot = $candidates[0].FullName }
}
if (-not $pnpmRoot) { Write-Error 'graft package not found; run install-bd/install-graft first.' }

$graftPkg = Join-Path $pnpmRoot '@nanonets\graft'
$graftStore = Split-Path -Parent (Split-Path -Parent $graftPkg)  # store path ..\.. from pkg root
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