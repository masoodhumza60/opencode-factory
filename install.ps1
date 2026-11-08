#Requires -Version 5.1
# opencode-factory machine install (Windows).
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-SkipBd] [-DryRun]
# -SkipBd   : do not install/verify the beads CLI
# -DryRun   : print every step without changing anything (exits 0)
[CmdletBinding()]
param(
    [switch]$SkipBd,
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
# One home, not two. install.sh pins USERPROFILE to HOME; this is its mirror. It
# has to happen BEFORE anything below is derived from USERPROFILE, or the paths
# we write to and the home node reports would still be two different folders -
# which is the exact defect this line exists to remove.
$env:USERPROFILE = $HOME
$ocConfig     = Join-Path $env:USERPROFILE ".config\opencode"
$agentsSkills = Join-Path $env:USERPROFILE ".agents\skills"
$projectSkills = Join-Path $bundle ".agents\skills"
$script:NodePath = ((node --print process.execPath | Out-String).Trim()).Replace('\','/')

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

    # opencode-pty is a third-party optional plugin. Every way it can go wrong
    # on someone else's machine - never installed, installed but unloadable - is a
    # reason to skip its shim, not a reason to fail the install. What we must never
    # do is leave a shim behind that claims to be a plugin and then fails every
    # single session start.
    $ptyIndex = Get-ChildItem "$env:USERPROFILE\.cache\opencode\npm\opencode-pty@*\*\node_modules\opencode-pty\dist\src\v2\index.js" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $ptyIndex) {
        SayErr 'warning: opencode-pty v2 index not found in cache; skipping its plugin shim.'
        if (-not $DryRun) { Remove-Item $ptyDst -Force -ErrorAction SilentlyContinue }
        return
    }

    $barePath = $ptyIndex.FullName.Replace('\','/')

    # Presence is not loadability. opencode-pty@0.4.0 ships TypeScript under
    # node_modules (bun-pty/src/index.ts), which neither Node nor Bun will strip,
    # so the import throws before the module can export anything. opencode then
    # reports that as a schema error about a missing 'default' key - a shape error
    # that is really an import error, which is why rewriting the shim's export
    # shape could never have fixed it. Only a real import proves loadability, so
    # ask Node the same question opencode will ask.
    if ($DryRun) {
        Say "[dry-run] node import probe of file:///$barePath (skipped in dry-run)"
    } else {
        # The probe's stderr IS the signal, and Windows PowerShell under
        # $ErrorActionPreference='Stop' turns a native command's stderr into a
        # terminating NativeCommandError. Capture both failure shapes in the
        # probe variable so the unloadable-plugin branch runs below, instead of
        # aborting the whole install on an optional shim.
        try {
            $probe = & node --input-type=module -e "import('file:///$barePath').then(()=>process.exit(0),(e)=>{console.error((e&&e.message)||e);process.exit(1)})" 2>&1
            $probeExit = $LASTEXITCODE
        } catch {
            $probe = "$_"
            $probeExit = 1
        }
        if ($probeExit -ne 0) {
            SayErr 'warning: opencode-pty is installed but will not load here; skipping its plugin shim.'
            SayErr "         reason: $(($probe | Select-Object -First 1))"
            SayErr '         a shim pointing at it would fail every session start.'
            Remove-Item $ptyDst -Force -ErrorAction SilentlyContinue
            return
        }
    }

    if ($DryRun) {
        Say "[dry-run] render '$ptyTmpl' (substitute __OPENCODE_PTY_V2_INDEX__ = $barePath) -> '$ptyDst'"
        Say "[dry-run]   import Plugin from `"file:///$barePath`";"
    } else {
        $content = (Get-Content $ptyTmpl -Raw) -replace '__OPENCODE_PTY_V2_INDEX__', $barePath
        [System.IO.File]::WriteAllText($ptyDst, $content, (New-Object System.Text.UTF8Encoding $false))
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
      if ($DryRun) {
        Say "[dry-run] node --print process.execPath => $script:NodePath"
        Say "[dry-run] write temp snippet: bundle snippet + plugins += [$pin]"
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
    #   - factory-mcp.mjs also imports ./mcp-defmatch.mjs. It was added AFTER the
    #     list above was written and never added to it, so the installer shipped a
    #     script that threw ERR_MODULE_NOT_FOUND on first run. The list is the
    #     thing that went stale, which is why the check below now walks imports
    #     instead of trusting any hand-kept list.
    #   - factory-selfcheck.mjs finds factory-skills.mjs and factory-mcp.mjs via
    #     dirname(import.meta.url), so this set only works together.
    #   - factory-phase.mjs statically imports ./factory-manifest.mjs,
    #     ./factory-policy.mjs, ./factory-attest.mjs and ./factory-review.mjs, so
    #     those four are the rest of its closure. Without them the installed phase
    #     machine exits ERR_MODULE_NOT_FOUND on load, which is the failure the
    #     "installed phase machine runs" selfcheck check exists to catch.
    #   - factory-skills.mjs resolves its default catalog to ../skills/catalog.yaml
    #     relative to itself, so the catalog ships to <skill>/skills/catalog.yaml.
    $runtimeScripts = @(
        'factory-phase.mjs', 'factory-mcp.mjs', 'factory-plan.mjs',
        'factory-skills.mjs', 'factory-selfcheck.mjs', 'platform.mjs',
        'mcp-defmatch.mjs',
'measure.mjs',
        'factory-manifest.mjs', 'factory-policy.mjs', 'factory-attest.mjs', 'factory-review.mjs'
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
            Say "factory runtime scripts installed -> $dstScripts ($($runtimeScripts.Count) files: phase, mcp, plan, skills, selfcheck, platform, defmatch, measure, manifest, policy, attest, review)"
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
        # A manifest of what was actually installed, with a timestamp. Run 2 of
        # the factory was run against a STALE install - the scripts on disk were
        # a version behind the bundle - and every check passed, because every
        # check asked whether a file existed and none asked whether it was
        # current. Nothing in the system could tell a run that it was about to
        # measure the wrong thing. This is the receipt for that: the install
        # records what it wrote, and the run records when it was written.
        $manifest = @{
            installed_at = (Get-Date).ToUniversalTime().ToString('o')
            bundle_commit = (git -C $bundle rev-parse --short HEAD 2>$null)
            # Where the bundle was when this ran. Without it the check below can see a
            # hand-edited install but is blind to the bundle moving ahead, which is the
            # direction that actually runs the wrong code. Recorded, not derived, because
            # a derived path is a rule that can be wrong without saying so.
            bundle_path = $bundle
            files = @{}
        }
        # The shared skills root - ONE level above the factory skill directory.
        # Split-Path $dstSk is the factory skill dir itself, so keys written against
        # it were off by a level and the reader resolved every one to a file that
        # does not exist. Worse, the list below mixes $dstVerify, which lives in a
        # SIBLING directory: substring-ing that against the factory dir did not
        # fail, it silently produced the key app/SKILL.md. A manifest that mangles a
        # key is worse than one that is short, so the guard refuses rather than truncates.
        $skillsRoot = Split-Path (Split-Path $dstSk)
        foreach ($f in @($dstSk, $dstVerify) + @(Get-ChildItem $dstDocs -File -ErrorAction SilentlyContinue).FullName + @(Get-ChildItem $dstScripts -File -ErrorAction SilentlyContinue).FullName + $dstCatalog + $dstReqs) {
            if ($f -and (Test-Path $f)) {
                # Keyed by path relative to the skills root, NOT by basename:
                # SKILL.md exists under both factory/ and verify-app/, and a
                # basename key collides - the second write silently overwrites the
                # first and a later reader compares the wrong file.
                if (-not $f.StartsWith($skillsRoot)) {
                    SayErr "warning: $f is not under $skillsRoot - recorded by full path so the key cannot be silently mangled."
                    $rel = $f.Replace('\', '/')
                }
                else { $rel = $f.Substring($skillsRoot.Length).TrimStart('\', '/').Replace('\', '/') }
                # The same file inside the bundle, so the check can compare three ways
                # instead of two: what was written, what is on disk, and what the bundle
                # holds now. Keys are <skill>/<rest>, and the bundle keeps the same <rest>
                # under skills/<skill>/ or at the bundle root - except SKILL.md, which the
                # bundle holds under skills/<skill>/. Resolved here and STORED, so a wrong
                # mapping is visible: the check reports the file as uncomp rather than
                # quietly calling it current.
                $rest = $rel.Substring($rel.IndexOf('/') + 1)
                $srcRel = if ($rest -eq 'SKILL.md') { 'skills/' + $rel } else { $rest }
                $srcAbs = Join-Path $bundle $srcRel
                $manifest.files[$rel] = @{
                    hash = (Get-FileHash $f -Algorithm SHA256).Hash
                    src = if (Test-Path $srcAbs) { $srcRel } else { $null }
                }
            }
        }
        $manifestPath = Join-Path (Split-Path $dstSk) 'install-manifest.json'
        # No BOM. `Set-Content -Encoding utf8` is PowerShell 5.1 and it emits a UTF-8
        # BOM, which is not valid JSON - every strict reader fails on it, so a manifest
        # written this way can only ever be read as unreadable. The same trap has bitten
        # every other file this shell has written; here it would have silently turned the
        # staleness check into a permanent false alarm.
        $manifestJson = $manifest | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding $false))
        Say "install manifest written -> $manifestPath ($($manifest.files.Count) files, bundle $($manifest.bundle_commit) at $bundle)"
    }
    else { SayErr "warning: $srcSk not in bundle yet (conductor skill lands with the docs/discovery task); skip - re-run install once it is present." }
    # NOTE: .agents/skills/skills.lock.json is created by `factory discover`, not by install.
}

function Install-MandatorySkills {
    # The catalog is data; factory-skills.mjs is the only thing that acts on it.
    # This runs BEFORE the selfcheck on purpose - the selfcheck FAILs when a
    # mandatory skill is missing, so installing afterwards would guarantee a red
    # install on a fresh machine. A network failure is not hidden: the script
    # prints the fix line and this throws, because a machine that reaches phase
    # 7 with no commit-work to run has already failed quietly at install time.
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
        Say "[dry-run] & node '$script:NodePath' scripts/test-factory-app.mjs"
        return
    }
    foreach ($t in @('test-selfcheck.mjs', 'test-install-idempotency.mjs', 'test-factory-phase.mjs', 'test-factory-plan.mjs', 'test-factory-skills.mjs', 'test-factory-mcp.mjs', 'test-factory-app.mjs')) {
        $path = Join-Path $bundle "scripts\$t"
        if (-not (Test-Path $path)) { SayErr "warning: $path not in bundle yet; skipping."; continue }
        # Capture rather than discard: a suite that fails without showing why is
        # almost as useless as one that cannot fail at all. bd writes ordinary
        # warnings to stderr; inside a PowerShell job a native child's merged
        # stderr stays data, never a terminating error record.
        # A bounded wait stands instead of Start-Process -Wait, which hangs forever.
        # No -Wait, and a bounded wait instead. A suite that blocks forever used to
        # hang the whole installer: `Start-Process -Wait` has no timeout of its own,
        # so one stuck child (observed: a suite blocked inside bd behind a 19-day-
        # stale beads lock, using 1.97s of CPU across 17 minutes) left the installer
        # silent forever with no way to tell a slow suite from a dead one.
        # 60 minutes is far longer than any suite legitimately needs (the phase
        # suite is the slow one and this machine has taken longer than the old
        # 20-minute cap to get through it) and still finite.
        $suiteTimeoutSec = 3600
        # Run the suite inside a PowerShell job and read the job's transcript.
        # Windows PowerShell 5.1 mishandles a native child with both redirected
        # streams: handler-based reads collect nothing, and an ExitCode read
        # afterward is empty — and the parameterless WaitForExit() that was
        # meant to flush the readers hard-terminates the host with no output
        # at all (the installer exits with no diagnostics whatsoever). The job
        # runspace is the supported wrapper for all three: it carries a timeout,
        # captures stdout+stderr verbatim (including "2>&1"), and forwards the
        # child's exit code via a sentinel line. Cost if a suite truly hangs: the
        # job is stopped and its orphaned node child may linger (Stop-Job cannot
        # reap a native grandchild); the alternative was the whole installer
        # hanging forever, so the bound stands.
        $suiteScript = {
            param($NodePath, $SuitePath)
            & $NodePath $SuitePath 2>&1 | Out-String
            "__EXITCODE__=$LASTEXITCODE"
        }
        $job = Start-Job -ScriptBlock $suiteScript -ArgumentList $script:NodePath, $path
        $done = Wait-Job -Job $job -Timeout $suiteTimeoutSec
        if (-not $done) {
            Stop-Job -Job $job
            $raw = Receive-Job -Job $job | Out-String
            Remove-Job -Job $job -Force
            Write-Host "--- $t exceeded ${suiteTimeoutSec}s; its job was stopped. Output so far: ---"
            Write-Host $raw
            throw "$t did not finish within ${suiteTimeoutSec}s - the selfcheck cannot be trusted. Fix it before installing."
        }
        $raw = Receive-Job -Job $job | Out-String
        Remove-Job -Job $job -Force
        if ($raw -match "(?m)^__EXITCODE__=(\d+)\s*$") {
            $suiteExit = [int]$Matches[1]
            $suiteOut = $raw -replace "(?m)^__EXITCODE__=\d+\s*$", ""
        } else {
            Write-Host $raw
            throw "$t did not report an exit code - the selfcheck cannot be trusted. Fix it before installing."
        }
        if ($suiteExit -ne 0) {
            Write-Host $suiteOut
            throw "$t failed (exit $suiteExit) - the selfcheck cannot be trusted. Fix it before installing."
        }
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
