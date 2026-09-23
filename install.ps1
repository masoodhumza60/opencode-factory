#Requires -Version 5.1
# opencode-factory machine install (Windows).
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-SkipBd] [-SkipGraft] [-DryRun]
# -SkipBd   : do not install/verify the beads CLI
# -SkipGraft: do not install/patch the graft CLI (plugins+config may still be merged)
# -DryRun   : print every step without changing anything (exits 0)
[CmdletBinding()]
param(
    [switch]$SkipBd,
    [switch]$SkipGraft,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# node >= 20 prereq: checked before any node-dependent work (also under -DryRun)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'node >= 20 is required. Install from https://nodejs.org and re-run.' -ForegroundColor Red
    exit 1
}
if ((& node -p "process.versions.node.split('.')[0]*1 >= 20") -ne 'true') {
    Write-Host "node >= 20 is required (found $(& node --version)). Install from https://nodejs.org and re-run." -ForegroundColor Red
    exit 1
}

$bundle       = $PSScriptRoot
$ocConfig     = Join-Path $env:USERPROFILE ".config\opencode"
$agentsSkills = Join-Path $env:USERPROFILE ".agents\skills"
$projectSkills = Join-Path $bundle ".agents\skills"
$script:NodePath = ((node --print process.execPath | Out-String).Trim()).Replace('\','/')
$script:GraftPkg  = $null

function Say([string]$msg)                { Write-Host $msg }
function SayErr([string]$msg)             { Write-Host $msg -ForegroundColor Yellow }

function Ensure-Dirs {
    $dirs = @(
        (Join-Path $ocConfig 'plugins'),
        (Join-Path $ocConfig 'commands\beads'),
        (Join-Path $ocConfig 'agents'),
        (Join-Path $agentsSkills 'factory'),
        $projectSkills
    )
    foreach ($d in $dirs) {
        if ($DryRun) { Say "[dry-run] ensure dir: $d" }
        else { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    }
}

function Find-GraftDir {
    # true -> a live graft cli.js exists; outputs its package dir (or '' when absent).
    $probe = ''
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        $probe = (& pnpm root -g 2>$null | Out-String).Trim()
    }
    if ($probe -and (Test-Path (Join-Path $probe '@nanonets\graft\dist\cli.js'))) {
        return Join-Path $probe '@nanonets\graft'
    }
    $candidates = Get-ChildItem "$env:LOCALAPPDATA\pnpm\global" -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
        Where-Object { Test-Path (Join-Path $_.FullName '@nanonets\graft\dist\cli.js') }
    if ($candidates) { return Join-Path $candidates[0].FullName '@nanonets\graft' }
    return ''
}

function Resolve-GraftDir {
    # Mirrors scripts/graft-patch-store.ps1: pnpm root -g, else 3-level store scan
    # ending at node_modules dirs. Returns the graft package dir (junctions ok).
    $found = Find-GraftDir
    if (-not $found) {
        throw 'graft CLI not found. Run install (without -SkipGraft) or `pnpm add -g @nanonets/graft@0.18.0` first.'
    }
    return $found
}

function Install-Bd {
    $bdScript = Join-Path $bundle 'executables\install-bd.ps1'
    if ($DryRun) {
        Say "[dry-run] & '$bdScript' -DryRun"
        Say "[dry-run] verify: & '<%LOCALAPPDATA%>\Programs\bd\bd.exe' version"
        return
    }
    & $bdScript
    if ($LASTEXITCODE -ne 0) { throw 'install-bd.ps1 failed' }
    $bdExe = Join-Path $env:LOCALAPPDATA 'Programs\bd\bd.exe'
    if (Test-Path $bdExe) { & $bdExe version } else { if (Get-Command bd -ErrorAction SilentlyContinue) { bd version } }
    if ($LASTEXITCODE -ne 0) { throw 'bd version check failed after install' }
    Say "bd ready ($bdExe)."
}

function Install-Graft {
    $found = Find-GraftDir
    if ($DryRun) {
        if ($found) { Say '[dry-run] graft already installed locally; skipping `pnpm add -g @nanonets/graft@0.18.0`' }
        else        { Say '[dry-run] pnpm add -g @nanonets/graft@0.18.0 (then re-resolve the package dir)' }
        $patchDir = if ($found) { $found } else { '<resolved-graft-dir>' }
        Say "[dry-run] & node '$script:NodePath' '$bundle\scripts\graft-patch-extract.mjs' --dir '$patchDir'"
        Say "[dry-run] powershell -NoProfile -ExecutionPolicy Bypass -File '$bundle\scripts\graft-patch-store.ps1'"
        Say '[dry-run] verify: graft --version'
        $script:GraftPkg = $found   # may be '' when absent; Merge-Config handles it
        return
    }
    if (-not $found) {
        if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
            throw 'pnpm is required for graft. Install pnpm (npm i -g pnpm) and re-run, or run: pnpm add -g @nanonets/graft@0.18.0'
        }
        & pnpm add -g @nanonets/graft@0.18.0
        if ($LASTEXITCODE -ne 0) { throw 'pnpm add -g @nanonets/graft@0.18.0 failed' }
    }
    $script:GraftPkg = Resolve-GraftDir   # re-resolve (after install, when it was absent)
    & $script:NodePath "$bundle\scripts\graft-patch-extract.mjs" --dir $script:GraftPkg
    if ($LASTEXITCODE -ne 0) { throw 'graft-patch-extract.mjs failed' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$bundle\scripts\graft-patch-store.ps1"
    if ($LASTEXITCODE -ne 0) { throw 'graft-patch-store.ps1 failed' }
    & graft --version
    if ($LASTEXITCODE -ne 0) { throw 'graft --version check failed' }
    Say "graft ready ($(Join-Path $script:GraftPkg 'dist\cli.js'))."
}

function Install-Plugins {
    $beadsSrc = Join-Path $bundle 'plugins\opencode-beads.ts'
    $beadsDst = Join-Path $ocConfig 'plugins\opencode-beads.ts'
    $ptyDst   = Join-Path $ocConfig 'plugins\opencode-pty.ts'
    $ptyTmpl  = Join-Path $bundle 'plugins\opencode-pty.ts.tmpl'

    if ($DryRun) {
        Say "[dry-run] Copy-Item '$beadsSrc' -> '$beadsDst'"
    } else {
        Copy-Item $beadsSrc $beadsDst -Force
    }

    $ptyIndex = Get-ChildItem "$env:USERPROFILE\.cache\opencode\npm\opencode-pty@*\*\node_modules\opencode-pty\dist\src\v2\index.js" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $ptyIndex) {
        if ($DryRun) { SayErr '[dry-run] warning: opencode-pty v2 index not found in cache; render would fail here' }
        else { throw 'opencode-pty v2 index not found. Run `opencode` once so it installs opencode-pty, then re-run install.' }
    }
    if ($ptyIndex) {
        $barePath = $ptyIndex.FullName.Replace('\','/')
        if ($DryRun) {
            Say "[dry-run] render '$ptyTmpl' (substitute __OPENCODE_PTY_V2_INDEX__ = $barePath) -> '$ptyDst'"
            Say "[dry-run]   export { default } from `"file:///$barePath`";"
        } else {
            $content = (Get-Content $ptyTmpl -Raw) -replace '__OPENCODE_PTY_V2_INDEX__', $barePath
            [System.IO.File]::WriteAllText($ptyDst, $content, (New-Object System.Text.UTF8Encoding $false))
        }
    }
}

function Install-Commands {
    $beadsSrc = Join-Path $bundle 'commands\beads'
    $beadsDst = Join-Path $ocConfig 'commands\beads'
    $agentSrc = Join-Path $bundle 'agents\beads-task-agent.md'
    $agentDst = Join-Path $ocConfig 'agents\beads-task-agent.md'

    foreach ($f in Get-ChildItem "$beadsSrc\*.md") {
        if ($DryRun) { Say "[dry-run] Copy-Item '$($f.FullName)' -> '$beadsDst\$($f.Name)'" }
        else { Copy-Item $f.FullName (Join-Path $beadsDst $f.Name) -Force }
    }
    if ($DryRun) { Say "[dry-run] Copy-Item '$agentSrc' -> '$agentDst'" }
    else { Copy-Item $agentSrc $agentDst -Force }
}

function Merge-Config {
    $userCfg = Join-Path $ocConfig 'opencode.json'
    $pin = (Get-Content (Join-Path $bundle 'plugins\dcp.pin') -Raw).Trim()
    # graft command needs the graft cli.js; resolve here unless Install-Graft already did.
    if (-not $script:GraftPkg) {
        try { $script:GraftPkg = Resolve-GraftDir }
        catch {
            if ($DryRun) { SayErr ('[dry-run] warning: ' + $_.Exception.Message) }
            else { throw }
        }
    }
    $graftCliJs = if ($script:GraftPkg) { (Join-Path $script:GraftPkg 'dist\cli.js').Replace('\','/') } else { '<resolved-graft-cli.js>' }

    if ($DryRun) {
        Say "[dry-run] node --print process.execPath => $script:NodePath"
        Say "[dry-run] write temp snippet: bundle snippet + mcp.servers.graft = {type:local, command:[$script:NodePath, $graftCliJs, mcp], disabled:false} + plugins += [$pin]"
        if (Test-Path $userCfg) { Say "[dry-run] user config: $userCfg (read-only; purely additive merge)" }
        else                    { Say "[dry-run] echo '{}' > '$userCfg'   (no existing config)" }
        Say "[dry-run] & node '$script:NodePath' '$bundle\scripts\merge-config.mjs' --snippet <resolved-snippet> --user '$userCfg' --out '$userCfg'"
        return
    }
    # seed a minimal config when none exists yet (merge needs a valid --user file)
    if (-not (Test-Path $userCfg)) {
        [System.IO.File]::WriteAllText($userCfg, "{`n}`n", (New-Object System.Text.UTF8Encoding $false))
    }
    $snippetResolved = Join-Path $env:TEMP ("opencode-snippet-resolved-" + [guid]::NewGuid().ToString('N') + ".json")
    try {
        $snip = Get-Content (Join-Path $bundle 'config\opencode.snippet.json') -Raw | ConvertFrom-Json
        $snip | Add-Member -NotePropertyName plugins -NotePropertyValue @($pin) -Force
        $snip.mcp.servers | Add-Member -NotePropertyName graft -NotePropertyValue @{
            type     = 'local'
            command  = @($script:NodePath, $graftCliJs, 'mcp')
            disabled = $false
        } -Force
        $json = $snip | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($snippetResolved, $json, (New-Object System.Text.UTF8Encoding $false))
        & $script:NodePath "$bundle\scripts\merge-config.mjs" --snippet $snippetResolved --user $userCfg --out $userCfg
        if ($LASTEXITCODE -ne 0) { throw 'merge-config.mjs failed' }
        Say "merged config -> $userCfg"
    } finally {
        if (Test-Path $snippetResolved) { Remove-Item $snippetResolved -Force }
    }
}

function Install-Skills {
    $srcSk = Join-Path $bundle 'skills\factory\SKILL.md'
    $dstSk = Join-Path $agentsSkills 'factory\SKILL.md'
    $srcDocs = @(
        (Join-Path $bundle 'docs\conductor.md'),
        (Join-Path $bundle 'docs\how-factory-works.md')
    )
    $dstDocs = Join-Path (Split-Path $dstSk) 'docs'
    if ($DryRun) {
        Say "[dry-run] Copy-Item '$srcSk' -> '$dstSk'"
        Say "[dry-run] Copy-Item '$bundle\docs\conductor.md', '$bundle\docs\how-factory-works.md' -> '$dstDocs'"
    }
    elseif (Test-Path $srcSk) {
        Copy-Item $srcSk $dstSk -Force
        New-Item -ItemType Directory -Force -Path $dstDocs | Out-Null
        Copy-Item $srcDocs $dstDocs -Force
        Say "factory skill installed -> $dstSk (self-contained: docs/ ships conductor + how-factory-works)"
    }
    else { SayErr "warning: $srcSk not in bundle yet (conductor skill lands with the docs/discovery task); skip - re-run install once it is present." }
    # NOTE: .agents/skills/skills.lock.json is created by `factory discover`, not by install.
}

function Run-Selfcheck {
    $selfcheck = Join-Path $bundle 'scripts\factory-selfcheck.mjs'
    if ($DryRun) {
        Say "[dry-run] & node '$script:NodePath' '$selfcheck'"
        return
    }
    if (Test-Path $selfcheck) {
        & $script:NodePath $selfcheck
        if ($LASTEXITCODE -ne 0) { throw 'factory selfcheck failed - install incomplete.' }
        Say 'selfcheck: OK'
    } else {
        SayErr "warning: $selfcheck not in bundle yet (selfcheck task not landed); skip for now."
    }
}

# --- main ---
Say "opencode-factory install (bundle: $bundle)"
Ensure-Dirs
if (-not $SkipBd)     { Install-Bd }
if (-not $SkipGraft)  { Install-Graft }
Install-Plugins
Install-Commands
Merge-Config
Install-Skills
Run-Selfcheck
if ($DryRun) { Say "[dry-run] done (dry run - nothing was changed)." }
else { Say "done. See docs/HOW-INSTALL.md for manual steps and troubleshooting." }
