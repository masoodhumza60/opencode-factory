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
        (Join-Path $ocConfig 'commands\factory'),
        (Join-Path $ocConfig 'agents'),
        (Join-Path $agentsSkills 'factory'),
        $projectSkills
    )
    foreach ($d in $dirs) {
        if ($DryRun) { Say "[dry-run] ensure dir: $d" }
        else { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    }
}

function Find-GraftRoot {
    # Manager global-root probe order pnpm -> bun -> npm. Returns the first root
    # that actually contains a live graft package ('' when none do); a pure npm
    # machine resolves here too because node >= 20 always ships npm.
    foreach ($m in 'pnpm','bun','npm') {
        if (-not (Get-Command $m -ErrorAction SilentlyContinue)) { continue }
        $root = switch ($m) {
            'pnpm' { & pnpm root -g 2>$null }
            'bun'  { & bun pm root -g 2>$null }
            'npm'  { & npm root -g 2>$null }
        }
        $root = ($root | Out-String).Trim()
        if ($root -and (Test-Path (Join-Path $root '@nanonets\graft\dist\cli.js'))) {
            return $root
        }
    }
    # pnpm store fallback — virtual stores / junctions keep the real pkg deeper.
    $candidates = Get-ChildItem "$env:LOCALAPPDATA\pnpm\global" -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue } |
        Where-Object { Test-Path (Join-Path $_.FullName '@nanonets\graft\dist\cli.js') }
    if ($candidates) { return $candidates[0].FullName }
    return ''
}

function Find-GraftDir {
    # true -> a live graft cli.js exists; outputs its package dir (or '' when absent).
    $root = Find-GraftRoot
    if ($root) { return Join-Path $root '@nanonets\graft' }
    return ''
}

function Select-GraftManager {
    # Order pnpm -> bun -> npm (npm ships with node >= 20, so the last is a given).
    foreach ($m in 'pnpm','bun','npm') {
        if (Get-Command $m -ErrorAction SilentlyContinue) { return $m }
    }
    return ''
}

function Resolve-GraftDir {
    # Mirrors scripts/graft-patch-store.ps1: pnpm/bun/npm global root, else the
    # pnpm store scan. Returns the graft package dir (junctions ok).
    $found = Find-GraftDir
    if (-not $found) {
        throw 'graft CLI not found. Run install (without -SkipGraft) or install @nanonets/graft@0.18.0 (npm i -g / pnpm add -g / bun add -g) first.'
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
        if ($found) { Say '[dry-run] graft already installed locally; skipping install' }
        else {
            $m = Select-GraftManager
            if (-not $m) { $m = 'npm' }
            $cmd = if ($m -eq 'npm') { 'npm install -g @nanonets/graft@0.18.0' } else { "$m add -g @nanonets/graft@0.18.0" }
            Say "[dry-run] $cmd  (auto-select pnpm/bun/npm; npm default)"
        }
        $patchDir = if ($found) { $found } else { '<resolved-graft-dir>' }
        Say "[dry-run] & node '$script:NodePath' '$bundle\scripts\graft-patch-extract.mjs' --dir '$patchDir'"
        Say "[dry-run] powershell -NoProfile -ExecutionPolicy Bypass -File '$bundle\scripts\graft-patch-store.ps1' -PackageDir '$patchDir'"
        Say '[dry-run] verify: graft --version'
        $script:GraftPkg = $found   # may be '' when absent; Merge-Config handles it
        return
    }
    if (-not $found) {
        $m = Select-GraftManager
        if (-not $m) {
            throw 'No package manager found to install graft. Install node >= 20 from nodejs.org (it ships npm) and re-run.'
        }
        if ($m -eq 'npm') {
            & npm install -g @nanonets/graft@0.18.0
            if ($LASTEXITCODE -ne 0) { throw 'npm install -g @nanonets/graft@0.18.0 failed' }
        }
        else {
            & $m add -g @nanonets/graft@0.18.0
            if ($LASTEXITCODE -ne 0) { throw "$m add -g @nanonets/graft@0.18.0 failed" }
            # Safety net: the chosen manager ran clean but the pkg dir still
            # doesn't resolve -> redo through npm (always present via node).
            if (-not (Find-GraftDir)) {
                Say "graft not resolvable after $m install; retrying with npm..."
                & npm install -g @nanonets/graft@0.18.0
                if ($LASTEXITCODE -ne 0) { throw 'npm install -g @nanonets/graft@0.18.0 failed (fallback after non-npm manager)' }
            }
        }
    }
    $script:GraftPkg = Resolve-GraftDir   # re-resolve (after install, when it was absent)
    & $script:NodePath "$bundle\scripts\graft-patch-extract.mjs" --dir $script:GraftPkg
    if ($LASTEXITCODE -ne 0) { throw 'graft-patch-extract.mjs failed' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$bundle\scripts\graft-patch-store.ps1" -PackageDir $script:GraftPkg
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
    $factorySrc = Join-Path $bundle 'commands\factory'
    $factoryDst = Join-Path $ocConfig 'commands\factory'
    $agentSrc = Join-Path $bundle 'agents\beads-task-agent.md'
    $agentDst = Join-Path $ocConfig 'agents\beads-task-agent.md'

    foreach ($f in Get-ChildItem "$beadsSrc\*.md") {
        if ($DryRun) { Say "[dry-run] Copy-Item '$($f.FullName)' -> '$beadsDst\$($f.Name)'" }
        else { Copy-Item $f.FullName (Join-Path $beadsDst $f.Name) -Force }
    }
    foreach ($f in Get-ChildItem "$factorySrc\*.md") {
        if ($DryRun) { Say "[dry-run] Copy-Item '$($f.FullName)' -> '$factoryDst\$($f.Name)'" }
        else { Copy-Item $f.FullName (Join-Path $factoryDst $f.Name) -Force }
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
        Say "[dry-run] write temp snippet: bundle snippet + mcp.servers.graft = {type:local, command:[$script:NodePath, $graftCliJs, mcp], enabled:true} + plugins += [$pin]"
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
            type    = 'local'
            command = @($script:NodePath, $graftCliJs, 'mcp')
            # `enabled`, NOT `disabled`. The live McpLocalConfig schema
            # (https://opencode.ai/config.json) lists type/command/cwd/environment/
            # enabled/timeout with additionalProperties:false - there is no
            # `disabled` key. Writing it is not a no-op with a bad spelling: opencode
            # ignores the unknown property, so a server marked `disabled: true` stays
            # ENABLED. A 2026-10-10 run found this - five servers the operator
            # believed were off were spawning on every session, and graft was
            # flickering in and out of the tool catalog as a result.
            enabled  = $true
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
        (Join-Path $bundle 'docs\how-factory-works.md'),
        (Join-Path $bundle 'docs\plan-format.md'),
        (Join-Path $bundle 'docs\discovery.md'),
        (Join-Path $bundle 'docs\mcp-judging.md')
    )
    $dstDocs = Join-Path (Split-Path $dstSk) 'docs'
    # The scripts the docs tell an agent to run must ship WITH the docs that
    # reference them. An install of SKILL.md + docs alone was measured in a real
    # run (2026-10-10, orderboard-a2o): phase 5's agent read conductor.md, was
    # told to run factory-phase.mjs, and found nothing - the docs shipped
    # without the machinery every one of them points at. selfcheck called that
    # install healthy, which is the guard-present-effect-absent shape again.
    #   - factory-mcp.mjs imports ./platform.mjs, so platform.mjs is not optional.
    #   - factory-selfcheck.mjs finds factory-skills.mjs and factory-mcp.mjs via
    #     dirname(import.meta.url), so this set only works together.
    #   - factory-skills.mjs resolves its default catalog to ../skills/catalog.yaml
    #     relative to itself, so the catalog ships to <skill>/skills/catalog.yaml.
    $runtimeScripts = @(
        'factory-phase.mjs', 'factory-mcp.mjs', 'factory-plan.mjs',
        'factory-skills.mjs', 'factory-selfcheck.mjs', 'platform.mjs'
    )
    $srcScripts = $runtimeScripts | ForEach-Object { Join-Path $bundle "scripts\$_" }
    $dstScripts = Join-Path (Split-Path $dstSk) 'scripts'
    $srcCatalog = Join-Path $bundle 'skills\catalog.yaml'
    $dstCatalog = Join-Path (Split-Path $dstSk) 'skills\catalog.yaml'
    # factory-mcp.mjs reads the list of servers the factory depends on from
    # ../config/mcp-requirements.json relative to itself. Without this file the
    # installed script finds no declaration, so `scope` keeps nothing and
    # `audit` labels every server as the user's - silently, and only on a
    # machine whose server names differ from the bundle author's.
    $srcReqs = Join-Path $bundle 'config\mcp-requirements.json'
    $dstReqs = Join-Path (Split-Path $dstSk) 'config\mcp-requirements.json'
    # The verify-app generator ships beside the factory skill. It is what turns
    # the phase-5 --booted claim into something a later agent can re-check.
    $srcVerify = Join-Path $bundle 'skills\verify-app\SKILL.md'
    $dstVerify = Join-Path $agentsSkills 'verify-app\SKILL.md'
    if ($DryRun) {
        Say "[dry-run] Copy-Item '$srcVerify' -> '$dstVerify'"
        Say "[dry-run] Copy-Item '$srcSk' -> '$dstSk'"
        Say "[dry-run] Copy-Item '$bundle\docs\conductor.md', '$bundle\docs\how-factory-works.md', '$bundle\docs\plan-format.md', '$bundle\docs\discovery.md', '$bundle\docs\mcp-judging.md' -> '$dstDocs'"
        Say "[dry-run] Copy-Item $($runtimeScripts -join ', ') -> '$dstScripts'"
        Say "[dry-run] Copy-Item '$srcCatalog' -> '$dstCatalog'"
        Say "[dry-run] Copy-Item '$srcReqs' -> '$dstReqs'"
    }
    elseif (Test-Path $srcSk) {
        if (Test-Path $srcVerify) {
            New-Item -ItemType Directory -Force -Path (Split-Path $dstVerify) | Out-Null
            Copy-Item $srcVerify $dstVerify -Force
            Say "verify-app skill installed -> $dstVerify (generates the project's own verification skill)"
        }
        Copy-Item $srcSk $dstSk -Force
        New-Item -ItemType Directory -Force -Path $dstDocs | Out-Null
        Copy-Item $srcDocs $dstDocs -Force
        # scripts/ is not optional decoration. A doc that names a command the
        # install does not contain is a broken install, so ship them or say so.
        $absent = $srcScripts | Where-Object { -not (Test-Path $_) }
        if ($absent.Count -gt 0) {
            SayErr "warning: missing runtime script(s) in bundle: $($absent -join ', ')"
            SayErr "         the installed docs will reference commands that do not exist there."
        }
        else {
            New-Item -ItemType Directory -Force -Path $dstScripts | Out-Null
            Copy-Item $srcScripts $dstScripts -Force
            Say "factory runtime scripts installed -> $dstScripts ($($runtimeScripts.Count) files: phase, mcp, plan, skills, selfcheck, platform)"
        }
        if (Test-Path $srcCatalog) {
            New-Item -ItemType Directory -Force -Path (Split-Path $dstCatalog) | Out-Null
            Copy-Item $srcCatalog $dstCatalog -Force
            Say "skills catalog installed -> $dstCatalog (factory-skills.mjs resolves ../skills/catalog.yaml)"
        }
        else { SayErr "warning: $srcCatalog missing - factory-skills.mjs check will not find its catalog." }
        if (Test-Path $srcReqs) {
            New-Item -ItemType Directory -Force -Path (Split-Path $dstReqs) | Out-Null
            Copy-Item $srcReqs $dstReqs -Force
            Say "mcp requirements installed -> $dstReqs (factory-mcp.mjs resolves ../config/mcp-requirements.json)"
        }
        else { SayErr "warning: $srcReqs missing - factory-mcp.mjs scope will keep no server and audit will label them all as the user's." }
        Say "factory skill installed -> $dstSk (self-contained: docs/ ships conductor + how-factory-works; scripts/ ships what those docs name)"
    }
    else { SayErr "warning: $srcSk not in bundle yet (conductor skill lands with the docs/discovery task); skip - re-run install once it is present." }
    # NOTE: .agents/skills/skills.lock.json is created by `factory discover`, not by install.
}

function Install-MandatorySkills {
    # The catalog is data; factory-skills.mjs is the only thing that acts on it.
    # This runs BEFORE the selfcheck on purpose - the selfcheck FAILs when a
    # mandatory skill is missing, so installing afterwards would guarantee a red
    # install on a fresh machine. A network failure is not hidden: the script
    # prints the fix line and this throws, the same way a missing graft does,
    # because a machine that reaches phase 7 with no commit-work to run has
    # already failed quietly at install time.
    $skillScript = Join-Path $bundle 'scripts\factory-skills.mjs'
    if ($DryRun) {
        Say "[dry-run] & node '$script:NodePath' '$skillScript' install --dry-run"
        return
    }
    if (-not (Test-Path $skillScript)) {
        SayErr "warning: $skillScript not in bundle yet; mandatory skills not installed."
        return
    }
    & $script:NodePath $skillScript install
    if ($LASTEXITCODE -ne 0) { throw 'factory-skills.mjs install failed - fix the line it printed, then re-run install.' }
    Say 'mandatory skills: OK'
}

function Install-DcpPrompts {
    $script = Join-Path $bundle 'scripts\dcp-prompts.mjs'
    if ($DryRun) {
        Say "[dry-run] & node '$script:NodePath' '$script'"
        return
    }
    if (Test-Path $script) {
        & $script:NodePath $script
        if ($LASTEXITCODE -ne 0) { throw 'dcp-prompts.mjs failed' }
    } else {
        SayErr "warning: $script not in bundle yet; skipping the DCP turn-nudge override."
    }
}

function Run-Tests {
    # The selfcheck's own tests. A check that cannot fail is decoration, and the
    # bundle has shipped one; these are what make "can it fail?" a property the
    # installer enforces rather than something a human remembers to poke at.
    if ($DryRun) {
        Say "[dry-run] & node '$script:NodePath' scripts/test-selfcheck.mjs"
        Say "[dry-run] & node '$script:NodePath' scripts/test-install-idempotency.mjs"
        Say "[dry-run] & node '$script:NodePath' scripts/test-factory-phase.mjs"
        Say "[dry-run] & node '$script:NodePath' scripts/test-factory-plan.mjs"
        Say "[dry-run] & node '$script:NodePath' scripts/test-factory-skills.mjs"
        Say "[dry-run] & node '$script:NodePath' scripts/test-factory-mcp.mjs"
        return
    }
    foreach ($t in @('test-selfcheck.mjs', 'test-install-idempotency.mjs', 'test-factory-phase.mjs', 'test-factory-plan.mjs', 'test-factory-skills.mjs', 'test-factory-mcp.mjs')) {
        $path = Join-Path $bundle "scripts\$t"
        if (-not (Test-Path $path)) { SayErr "warning: $path not in bundle yet; skipping."; continue }
        # Capture rather than discard: a suite that fails without showing why is
        # almost as useless as one that cannot fail at all. Start-Process with real
        # file redirection, because these suites run bd, and bd writes ordinary
        # warnings to stderr - merging that into a PowerShell stream (2>&1 or *>)
        # turns a "not a git repository" notice into a terminating error under this
        # installer's error preferences, and the install dies on a passing suite.
        $log = Join-Path ([IO.Path]::GetTempPath()) "factory-test-$t.log"
        $errLog = "$log.err"
        $proc = Start-Process -FilePath $script:NodePath -ArgumentList $path -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $log -RedirectStandardError $errLog
        if ($proc.ExitCode -ne 0) {
            Get-Content $log, $errLog -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
            Remove-Item $log, $errLog -Force -ErrorAction SilentlyContinue
            throw "$t failed (exit $($proc.ExitCode)) - the selfcheck cannot be trusted. Fix it before installing."
        }
        Remove-Item $log, $errLog -Force -ErrorAction SilentlyContinue
    }
    Say 'selfcheck tests: OK (every check proven able to fail)'
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
Install-MandatorySkills
Install-DcpPrompts
Run-Tests
Run-Selfcheck
if ($DryRun) { Say "[dry-run] done (dry run - nothing was changed)." }
else { Say "done. See docs/HOW-INSTALL.md for manual steps and troubleshooting." }
