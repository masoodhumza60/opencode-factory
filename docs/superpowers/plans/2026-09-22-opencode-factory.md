# opencode-factory — Implementation Plan

> **For agentic workers:** The REQUIRED SUB-SKILL for execution is
> **subagent-driven-development** (fresh subagents per task, fresh reviewer per
> task, whole-branch review at the end). It fits this plan: tasks are
> independent file-drops with a shared layout contract, each verifiable on its
> own, and the final gate is an install+selfcheck dogfood run. If the user picks
> native execution instead, use **executing-plans** in-session and a single fresh
> reviewer at the end.

**Goal:** Build the opencode-factory bundle — one committed repo that turns any
new device into a working factory via `install.ps1`/`install.sh` + a `factory`
skill conductor — exactly as specified in the approved design spec.

**Architecture:** Bundle repo at `C:\Users\Humza\Desktop\projects\opencode-factory`.
The bundle is a *set of files* (no build step): plugins, commands, agent,
snippets, skills catalog, installer scripts, patch scripts, selfcheck, and docs.
Installers copy/bundle-merge them onto a machine using machine-resolved paths.
The conductor (`skills/factory/SKILL.md` + `docs/`) orchestrates the pipeline;
state lives in beads; code context is graft; superpowers skills are the enforced
phase skills.

**Tech Stack:** PowerShell (Windows install, no dependencies), bash (Unix
install), Node ≥20 (selfcheck + graft extract patch run via `node.exe`), YAML
(catalog/lockfile), Markdown (conductor/skill docs), git. No npm packages are
added; everything runs from the bundle or existing CLIs (bd, graft, skills CLI
via npx).

**Spec:** `docs/superpowers/specs/2026-09-22-opencode-factory-design.md`
(committed `bb261f7`, APPROVED). The plan implements its §6 (conductor
commands), §7 (skill discovery), §9 (bundle layout + install steps), §10
(verification), §12 (all pins, now resolved), §13 (prior-art grounding),
§14 (success criteria).

**Prior-art grounding** (spec §13; same five sources): the design follows the
2026 consensus shape of harness engineering and agent factories — Addy Osmani,
*Software Factories, Light and Dark* (lit-factory gates; "autonomy only as far
as you can verify"); Michael Mueller, re:cinq *Building Software Factories*
(spec quality is the bottleneck; Dolt for federated agent work); Martin C.
Richards, *Building Your Own Agent Harness* (plan as shared mutable state
reviewed before code); OpenAI *Harness engineering* (AGENTS.md as table of
contents, `docs/` as progressive-disclosure system of record, repo-local
versioned artifacts, enforce invariants not implementations); Dex Horthy,
*12-Factor Agents* (gates = contact-humans-as-tool-calls; unify execution
state and business state; stateless-reducer resume; short loops; own your
control flow as a graph). How this plan applies each:

- Gates A/B/C are the human review gates; implementation has no autonomy
  span that bypasses them (B before code, C before ship).
- The plan itself is committed, repo-local, and reviewed at gate B — the
  human-agent shared state.
- The conductor SKILL.md is thin: `docs/conductor.md` + `docs/how-factory-works.md`
  are the progressive-disclosure system of record (OpenAI's AGENTS.md-as-toc
  lesson applied to the `factory` skill, not the repo root).
- Beads = unified execution+business state (issue `phase:`), resume via
  `bd show` = stateless reducer; phases = the control-flow graph, failure
  points legible.
- Tasks in this plan are short, single-focused file-drops, so a subagent
  holds each whole task in ~3–10 steps (back-pressure / short-loop rules).
- `install.ps1`/`install.sh` + `factory selfcheck` enforce the invariants
  mechanically (selfcheck asserts plugins/MCP/CLIs/skill gate; a gate cannot
  pass with a skipped skill).

**Global Constraints (from the spec; apply to EVERY task):**

1. **Fewer random pieces, not more glue.** Every file in this repo exists to
   serve exactly one of: bundle target (copied to a machine), installer logic,
   patch logic, verification, or conductors/docs. No dead files, no surprises.
2. **Pull never push.** Nothing eagerly in shell/agent context. The factory
   SKILL.md is thin; logic lives in `docs/` files read on demand.
3. **Portable.** No hardcoded `C:\Users\Humza` paths, no `file:///` URLs,
   no machine-specific timestamps, in ANY committed file except within clearly
   labeled example/template placeholders that installers rewrite. The install
   scripts resolve paths on the target machine at run time.
4. **Idempotent.** Installing twice must produce the same state with zero drift.
5. **Windows-first, Unix-ported.** `install.ps1` is the primary; `install.sh`
   mirrors it. Both must pass their own selfcheck. Unix graft store on macOS has
   prebuilt bindings, so the prebuild rename patch is Windows-only; the
   kotlin-optional extract patch is Windows-only (static import crashes only
   where the kotlin grammar has no prebuilt).
6. **Self-documenting install.** `docs/HOW-INSTALL.md` is the human-facing
   guide; `SKILL.md` is the agent-facing entry.
7. **Committed to git.** Every task ends with a commit. Repo-local identity is
   already configured (`masoodhumza60 / masoodhumza60@users.noreply.github.com`).
8. **No touching the user's credentials or unrelated config.** Installers
   modify only: `~/.config/opencode/opencode.json` (mcp.graft + plugins array),
   `~/.config/opencode/plugins/`, `~/.config/opencode/commands/`,
   `~/.config/opencode/agents/`, `~/.agents/skills/`, and project
   `.agents/skills/`. `service.json` is NEVER touched or read.

**Review Focus** (input classes / failure modes the spec implies but task tests
don't directly exercise; each is pinned to a check in the task noted):

1. Fresh-device assumption — no prior opencode config/plugins dirs exist. → Task
   7 (installer) creates dirs; Task 12 (dogfood) verifies on a clean checkout.
2. Long-running CLI handshakes (bd/graft) under a non-interactive shell. → Task
   10 (selfcheck) uses `--version` only, with timeout guards.
3. Non-Administrator Windows shell + PowerShell execution policy. → Task 7 runs
   the installer via `powershell -ExecutionPolicy Bypass -File`.
4. Offline/regressed npm registry for `npx skills` — discovery must degrade to
   catalog.yaml + websearch. → Task 5 (catalog + skill doc) states the fallback
   chain; Task 13 (dogfood) exercises discovery against the pre-seeded catalog.
5. pnpm global store layout drift across PNPM minor versions → the graft path is
   discovered by scanning, never assumed (Task 6).

---

## Task 1: Scaffold the bundle directory layout

**Files**
- Create: `.gitignore`, `README.md`, `config/.keep`, `plugins/.keep`,
  `commands/.keep`, `agents/.keep`, `skills/.keep`, `scripts/.keep`,
  `executables/.keep`, `docs/.keep`, `docs/superpowers/plans/` (this plan).

**Interfaces**
- Consumes: the approved spec at `docs/superpowers/specs/`.
- Produces: the empty-but-labeled directory skeleton the bundle commits to, so
  every later task drops files into an existing folder.

**Steps**

1. Create `.gitignore` with:
```
# Node / opencode runtime (never commit anything machine-specific)
node_modules/
*.log
.thumbs/
.graft/
!docs/superpowers/specs/
```
2. Create `README.md` (→ write file):
```markdown
# opencode-factory

One portable software factory for OpenCode: `factory <feature>` runs a feature
end-to-end (brainstorm → spec → plan → tasks → implement → debug → verify →
review → ship) with human gates at spec, plan, and ship.

- **Set up on any device:** read `docs/HOW-INSTALL.md` (or run
  `install.ps1` / `install.sh`).
- **Agents:** start by reading `SKILL.md`.
- **Design:** `docs/superpowers/specs/2026-09-22-opencode-factory-design.md`.
- **Plan:** `docs/superpowers/plans/2026-09-22-opencode-factory.md`.

Everything here either gets installed onto a machine (plugins, commands, agent,
skills, snippets) or performs the install/patch/verify work. No build step.
```
3. Create the `.keep` directories listed in **Files** plus
   `docs/superpowers/plans/` for this file.
4. Commit:
```
git add -A; git commit -m "scaffold: bundle directory layout + README"
```

**Test** : `Directory.Exists` for each dir (PowerShell one-liner) —
all present, `git status` clean after commit.

---

## Task 2: Bundle the beads plugin (self-contained BEADS_GUIDANCE)

**Files**
- Create: `plugins/opencode-beads.ts`.
- Copy source: `C:\Users\Humza\.config\opencode\plugins\opencode-beads.ts`.

**Interfaces**
- Consumes: `bd` CLI on target machine (found via `BD_BIN_CANDIDATES`).
- Produces: OpenCode V2 plugin `id: "opencode-beads"` injecting `bd prime`
  output + guidance into every model system context.

**Steps**

1. Copy the source file into `plugins/opencode-beads.ts`.
2. Replace the two top file-comment lines that reference the upstream V1/build
   caveats with a short bundle note:
```
// Bundled opencode-factory beads plugin. Self-contained: BEADS_GUIDANCE is
// inlined below instead of imported from the npm cache, so this file works on
// any machine with a `bd` CLI on PATH (or in %LOCALAPPDATA%\Programs\bd).
```
3. **Remove** line 11 (`import { BEADS_GUIDANCE } from "file:///.../vendor.ts";`).
4. **Inline** the guidance constant verbatim just above `const primeCache`:
```ts
/* Inlined from opencode-beads@0.8.0 src/vendor.ts (BEADS_GUIDANCE). */
const BEADS_GUIDANCE = `<beads-guidance>
## CLI Usage

**IMPORTANT:** There is no \`bd\` tool in this environment. You must use the \`bash\` tool to run the \`bd\` command.

**Do not try to call a tool named \`bd\` directly.** It does not exist.
**Do not try to call MCP tools (like \`ready\`, \`create\`) directly.** They do not exist.

Instead, use the \`bash\` tool for all beads operations:

- \`bd init [prefix]\` - Initialize beads
- \`bd ready\` - List ready tasks
- \`bd show <id>\` - Show task details
- \`bd create "title" -t bug|feature|task -p 0-4\` - Create issue
- \`bd update <id> --status in_progress\` - Update status
- \`bd close <id> --reason "message"\` - Close issue
- \`bd reopen <id>\` - Reopen issue
- \`bd dep add <from> <to> --type blocks|discovered-from\` - Add dependency
- \`bd list --status open\` - List issues
- \`bd blocked\` - Show blocked issues
- \`bd stats\` - Show statistics

If a tool is not listed above, try \`bd <tool> --help\`.

Use the default command output unless \`--json\` would make a task easier or more reliable. If you parse command output, distinguish parsing errors from command failures.

## Agent Delegation

**Default to the agent.** For ANY beads work involving multiple commands or context gathering, use the \`task\` tool with \`subagent_type: "beads-task-agent"\`:
- Status overviews ("what's next", "what's blocked", "show me progress")
- Exploring the issue graph (ready + in-progress + blocked queries)
- Finding and completing ready work
- Working through multiple issues in sequence
- Any request that would require 2+ bd commands

**Use CLI directly ONLY for single, atomic operations:**
- Creating exactly one issue: \`bd create "title" ...\`
- Closing exactly one issue: \`bd close <id> ...\`
- Updating one specific field: \`bd update <id> --status ...\`
- When user explicitly requests a specific command

**Why delegate?** The agent processes multiple commands internally and returns only a concise summary. Running bd commands directly dumps hundreds of lines of raw JSON into context, wasting tokens and making the conversation harder to follow.
</beads-guidance>`;
```
5. Verify the file has NO remaining `file:///`, no `Humza`, no
   `1790082641118` etc. (`Select-String`).
6. Commit: `git add plugins/opencode-beads.ts; git commit -m "bundle: beads plugin with inlined BEADS_GUIDANCE"`.

**Test** : the file contains `export default {` + `id: "opencode-beads"` +
BEADS_GUIDANCE constant; zero occurrences of `file:///` (PowerShell
`(Select-String -Path plugins/opencode-beads.ts -Pattern 'file:///').Count`).

---

## Task 3: Bundle the pty shim template + dcp pin

**Files**
- Create: `plugins/opencode-pty.ts.tmpl`, `plugins/dcp.pin`.
- Copy source: `C:\Users\Humza\.config\opencode\plugins\opencode-pty.ts`
  (reference only — path is machine-specific, so it becomes a template).

**Interfaces**
- Produces: a template the installer renders into
  `~/.config/opencode/plugins/opencode-pty.ts` with the machine's resolved
  `opencode-pty/dist/src/v2/index.js` absolute path.

**Steps**

1. Create `plugins/dcp.pin` (→ write file):
```
@tarquinen/opencode-dcp@3.2.0
```
2. Create `plugins/opencode-pty.ts.tmpl` (→ write file). It must be valid TS
   after the installer substitutes `__OPENCODE_PTY_V2_INDEX__`:
```ts
// OpenCode V2 shim for opencode-pty (writes no build artifacts).
// The package root entry is V1-only; the V2 plugin lives at the /v2 subpath.
// __OPENCODE_PTY_V2_INDEX__ is replaced by the installer with the absolute path
// to node_modules/opencode-pty/dist/src/v2/index.js on THIS machine.
export { default } from "file:///__OPENCODE_PTY_V2_INDEX__";
```
3. Ensure no committed file references the old cache path (grep the bundle).
4. Commit: `git add plugins/; git commit -m "bundle: pty shim template + dcp pin"`.

**Test** : `plugins/dcp.pin` content equals `@tarquinen/opencode-dcp@3.2.0`;
`plugins/opencode-pty.ts.tmpl` contains exactly one `__OPENCODE_PTY_V2_INDEX__`.

---

## Task 4: Bundle commands + agent

**Files**
- Create: `commands/beads/*.md` (29 files), `agents/beads-task-agent.md`.
- Copy source: `C:\Users\Humza\.config\opencode\commands\beads\*.md` (29) and
  `C:\Users\Humza\.config\opencode\agents\beads-task-agent.md`.

**Interfaces**
- Produces: the same `/beads/*` command set and `beads-task-agent` subagent that
  exist on this machine, shipped inside the bundle so installers can copy them
  onto any device.

**Steps**

1. Copy all 29 `.md` files from the client commands dir into `commands/beads/`.
   (PowerShell: `Copy-Item "$env:USERPROFILE\.config\opencode\commands\beads\*.md" .\commands\beads\`)
2. Copy the agent file:
   `Copy-Item "$env:USERPROFILE\.config\opencode\agents\beads-task-agent.md" .\agents\`
3. Verify counts (must be 29 command files, 1 agent), and grep for any
   machine-specific path (`Humza`, `C:\Users`) — these files are clean already
   (uses `bash` tool phrasing only; no absolute paths expected).
4. Commit: `git add commands/ agents/; git commit -m "bundle: beads commands + task agent"`.

**Test** : `(Get-ChildItem commands/beads -Filter *.md).Count -eq 29`; agent file
exists; 0 matches for `Humza` across both dirs.

---

## Task 5: Skill catalog + lockfile schema docs

**Files**
- Create: `skills/catalog.yaml`, `docs/discovery.md`.

**Interfaces**
- `skills/catalog.yaml` — flat `topic → candidate skills` data read by
  `factory discover` (never by the installers; it is project-level, committed).
- `docs/discovery.md` — the discovery procedure: detect context (graft
  `find_all` on package.json/go.mod/imports → keywords), then candidate lookup
  via `npx skills find <keywords>` (skills.sh CLI, telemetry off), fallback
  chain, ranking rules, and install via
  `DISABLE_TELEMETRY=1 npx skills add <source> --skill <name> -a opencode --copy -y`,
  leaving `.agents/skills/<name>/` committed + locked in `skills.lock.json`.

**Steps**

1. Create `skills/catalog.yaml` (→ write file):
```yaml
# opencode-factory skill catalog — DATA, not an engine.
# Discovery looks up the feature's keywords here first; nothing else reads this.
# rank: 1 = best fit for the actual work, 2 = official/verified, 3 = most-used.
version: 1
topics:
  brainstorming:
    - name: brainstorming
      source: obra/superpowers
      rank: 1
      why: enforcing mandatory skill for phase 1 (project's superpowers set)
  skill-discovery:
    - name: find-skills
      source: vercel-labs/skills
      rank: 1
      why: official Vercel skill; leaderboard-first search with skills.sh
```
2. Create `docs/discovery.md` (→ write file, following spec §7 verbatim):
```markdown
# Skill Discovery (factory discover)

## Trigger
`factory discover <feature-id>` — run before the implement phase of a feature
whose spec doesn't pin its skills. Called automatically by the conductor when
entering the plan phase and by the human on demand.

## 1. Detect context
- If graft is configured for the repo: `graft find_all "<keywords>"` where
  keywords come from the feature spec title/description (stopwords removed).
- Else: inspect `package.json` / `go.mod` / import lines (top 200 lines) for
  language/ecosystem terms (e.g. react, nextjs, typescript, go, python).

## 2. Find candidates
Primary: `DISABLE_TELEMETRY=1 npx skills find <keyword...>` (skills.sh CLI,
never the OIDC-gated API). Fallback order if CLI is unavailable or empty:
1. web search `skills.sh <keyword>` (this is permission-gated by the user per
   spec §5.4 — ask "may I research this?" before any web call)
2. find-skills skill (`~/.agents/skills/find-skills` if present)
3. the local `skills/catalog.yaml` topic map.

## 3. Rank
1. Best keyword fit for the ACTUAL feature work (read candidate SKILL.md
   descriptions; pick the one that matches the verbs in the feature).
2. Official/verified origin (vercel-labs, anthropics, microsoft, obra).
3. Most-used (skills.sh install counts / leaderboard position).

## 4. Dedupe & lock
- Skip any candidate already installed to `~/.agents/skills/` (global) or
  `.agents/skills/` (project).
- Project-install chosen skills so they're COMMITTED and travel with the repo:
  `DISABLE_TELEMETRY=1 npx skills add <source> --skill <name> -a opencode --copy -y`
  (project scope → `.agents/skills/<name>/`).
- Record every install in `.agents/skills/skills.lock.json` — dedupe authority
  and deterministic-reinstall source:
```json
{ "installed": [ { "name": "<name>", "version": "<version>", "source": "<owner/repo>", "sha256": "<hash of SKILL.md>", "why": "<feature-id: reason>" } ] }
```
- Audit: `bd update <feature-id> --note "skills: <name>@<version> <source>"`.

## 5. Only much-needed skills
If no candidate is a clear fit, install nothing and note "no project skill
needed" in the issue. The mandatory superpowers set is already enforced by the
conductor — discovery only adds optional skill coverage (use only when needed).
```
3. Commit: `git add skills/catalog.yaml docs/discovery.md; git commit -m "skills: catalog data + discovery procedure"`.

**Test** : `catalog.yaml` parses as YAML (Node `yaml` not available → visual
check + `git diff` no-op after re-read); `docs/discovery.md` contains the full
lockfile schema and the `npx skills add ... --copy -y` command.

---

## Task 6: Graft store patch scripts (Windows + extract)

**Files**
- Create: `scripts/graft-patch-store.ps1`, `scripts/graft-patch-extract.mjs`.
- Template source: the two verified patch facts on this machine (prebuild
  renames + kotlin-optional dynamic import).

**Interfaces**
- `graft-patch-store.ps1` — idempotent Windows patch. Consumes: graft's pnpm
  store. Produces: renamed prebuilds so graft loads on win32-x64.
- `graft-patch-extract.mjs` — idempotent patch applied to `dist/graph/extract.js`
  inside the graft package dir (argument `--dir`). Consumes Node ≥20.

**Steps**

1. Create `scripts/graft-patch-store.ps1` (→ write file):
```powershell
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
    if ($candidates) { $pnpmRoot = $candidates[0].Parent.FullName }
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
```
2. Create `scripts/graft-patch-extract.mjs` (→ write file):
```js
#!/usr/bin/env node
// opencode-factory: graft extract.js Windows patch (idempotent).
// Pristine graft@0.18.0 statically imports tree-sitter-kotlin, whose native
// binding has no Windows prebuilt — startup crashes. Replace with a dynamic
// import so kotlin files are simply skipped when the grammar can't load.
//
// Usage: node graft-patch-extract.mjs --dir "<graft package dir>"

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const idx = process.argv.indexOf("--dir");
if (idx === -1) {
  console.error("usage: node graft-patch-extract.mjs --dir <graft package dir>");
  process.exit(1);
}
const pkgDir = process.argv[idx + 1];
const file = join(pkgDir, "dist", "graph", "extract.js");
const original = readFileSync(file, "utf8");

const STATIC_IMPORT = 'import Kotlin from "tree-sitter-kotlin";';
const LET_KOTLIN = `let Kotlin;
try {
  // opencode-factory patch: tree-sitter-kotlin ships no Windows prebuilt
  // binding (source-only) and no native toolchain is assumed here, so a static
  // import would crash startup. Load it dynamically; when a build/prebuild
  // exists this resolves normally and kotlin files are parsed like any other
  // language. On failure, kotlin files are simply skipped by the per-file
  // try/catch in build.js/check.js.
  Kotlin = (await import("tree-sitter-kotlin")).default;
} catch {
  Kotlin = undefined;
}`;

if (!original.includes(STATIC_IMPORT)) {
  if (original.includes("Kotlin = (await import(\"tree-sitter-kotlin\"))")) {
    console.log("already patched: " + file);
    process.exit(0);
  }
  console.error("unexpected extract.js shape (static import missing); refusing to patch");
  process.exit(2);
}

writeFileSync(file, original.replace(STATIC_IMPORT, LET_KOTLIN), "utf8");
console.log("patched: " + file);
```
3. Validate on the real machine (read-only test first): run
   `node scripts/graft-patch-extract.mjs --dir "<graft pkg dir>"` — expect
   `already patched` (this machine is already patched), which is also the
   idempotency proof.
4. Commit:
   `git add scripts/graft-patch-store.ps1 scripts/graft-patch-extract.mjs; git commit -m "scripts: graft store + extract.js Windows patches"`.

**Test**: re-running extract patch prints `already patched` and exits 0; a
temporary copy of a pristine extract.js (from unpkg, saved as
`%TEMP%\extract-pristine.js`) fails to load with a dynamic-import-free shape →
patching a pristine file produces a file containing `(await import(` — verify
with a THROWAWAY copy (never commit machine state).

---

## Task 7: Installers (install.ps1 + install.sh)

**Files**
- Create: `install.ps1`, `install.sh`, `executables/install-bd.ps1`,
  `executables/install-bd.sh`.
- Consumes: every bundled artifact created in Tasks 2–6 plus
  `config/opencode.snippet.json` (Task 8).

**Interfaces**
- `install.ps1 [-SkipBd] [-SkipGraft] [-DryRun]` — end-to-end machine setup.
- `install.sh` — same semantics on Unix/macOS.
- `executables/install-bd.ps1` / `.sh` — installs the beads CLI:
  Windows: Chocolatey absent → winget `winget install masoodhumza.bd` best-effort
  else copy from PATH (bd 1.3.0 known-good) into `%LOCALAPPDATA%\Programs\bd\bd.exe`
  and add to user PATH; Unix: `curl -fsSL https://beads.dev/install.sh | bash`
  (pin 1.3.0), preconditions: git, node ≥20.

**Steps — install.ps1 (the contract is the spec §9 install steps):**

1. `$ErrorActionPreference = 'Stop'`; `param([switch]$SkipBd,[switch]$SkipGraft,[switch]$DryRun)`; compute `$bundle = $PSScriptRoot`, `$ocConfig = Join-Path $env:USERPROFILE ".config\opencode"`, `$agentsSkills = Join-Path $env:USERPROFILE ".agents\skills"`.
2. Ensure dirs: plugins, commands, agents under `$ocConfig`; skills under `$agentsSkills`; project `.agents/skills`.
3. **bd**: if `-not $SkipBd` → `& "$bundle\executables\install-bd.ps1"` (DryRun chains the flag). Verify `bd version` by absolute path after.
4. **graft**: ensure global CLI (`pnpm add -g @nanonets/graft` if missing; pin `0.18.0`), then `node "$bundle\scripts\graft-patch-extract.mjs" --dir <resolved>` and `powershell -File "$bundle\scripts\graft-patch-store.ps1"`. Resolve the graft package dir by `pnpm root -g` + store scan (mirrors the patch script).
5. **Plugins** — copy `plugins/opencode-beads.ts` → `$ocConfig\plugins\`; render `plugins/opencode-pty.ts.tmpl`: resolve `opencode-pty` v2 index by scanning `$env:USERPROFILE\.cache\opencode\npm\opencode-pty@*\*\node_modules\opencode-pty\dist\src\v2\index.js` (take the newest), substitute `__OPENCODE_PTY_V2_INDEX__`, write `$ocConfig\plugins\opencode-pty.ts`.
6. **Commands/agents** — copy `commands\beads\*.md` → `$ocConfig\commands\beads\`; copy `agents\beads-task-agent.md` → `$ocConfig\agents\`.
7. **Config merge** — read existing `$ocConfig\opencode.json` if any; start from `config\opencode.snippet.json`; merge: keep user's `mcp.servers` except `graft` (bundle owns it) and except the disabled servers the bundle drops (chrome-devtools, github, nuxt, nuxt-ui, nuxt-hub); set `mcp.servers.graft` to `{type:"local", command:[nodePath, graftCliJs, "mcp"], disabled:false}` with graftCliJs resolved in step 4; append `@tarquinen/opencode-dcp@3.2.0` to `plugins` if absent. `nodePath` = `node --print process.execPath`. Do NOT touch `auth`/`service.json`.
8. **Skills** — copy `skills/factory/SKILL.md` → `$agentsSkills\factory\` (bundle-owned; it is the conductor, always deployed). Do NOT install catalog.yaml to machine (it's repo data, read from the repo by `factory discover`).
9. **Selfcheck** — `node "$bundle\scripts\factory-selfcheck.mjs"` (Task 10) and exit nonzero on failure. If `-DryRun`, print the exact commands instead of running.
10. Print done summary + pointer to `docs/HOW-INSTALL.md`.

Write the file with the above as actual PowerShell (each step as a function
`Install-Bd/Install-Graft/Install-Plugins/Install-Commands/Merge-Config/Install-Skills/Run-Selfcheck`, main calls them in order; `-DryRun` delegates to `Write-Host`). The config-merge must use `ConvertFrom-Json/ConvertTo-Json` preserving the user's other servers. Same multi-function structure mirrored in `install.sh` (bash: `set -euo pipefail`, `jq` absent → use Node for merge: `node -e` with a bundled merge snippet in `scripts/merge-config.mjs`? — NO: keep it in the installer using Node heredoc via `node <<'EOF'` guarded by `command -v node`). Because `install.sh` cannot include a 60-line Node heredoc without growing, factor the merge into `scripts/merge-config.mjs` (Task 8) so BOTH installers call it.

**Test** (on THIS machine with `-DryRun` first — safe):
- `powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun` prints every step, changes nothing, exits 0.
- Then a real run idempotency check: run twice, diff `$ocConfig\opencode.json` before/after second run (no drift).

---

## Task 8: Merge-config script + config snippet

**Files**
- Create: `config/opencode.snippet.json`, `scripts/merge-config.mjs`.

**Interfaces**
- `merge-config.mjs --snippet <path> --user <path> --out <path>`: reads snippet
  + user config JSON, writes merged config. Bundle-owned keys WIN: `plugins`
  (union, dedupe), `mcp.servers.graft`, and bundle-owned disabled drops listed
  in Task 7 step 7; all other user keys are preserved.
- `opencode.snippet.json`: the fixed, human-readable base (no machine paths —
  the installer fills graft command).

**Steps**

1. Create `config/opencode.snippet.json` (→ write file):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [],
  "mcp": {
    "servers": {}
  }
}
```
2. Create `scripts/merge-config.mjs` (→ write file):
```js
#!/usr/bin/env node
// opencode-factory config merge. Call after the installer has resolved the
// graft command so the snippet carries it in.
// usage: node merge-config.mjs --snippet <path> --user <path> --out <path>
import { readFileSync, writeFileSync } from "node:fs";

const get = (argv, key) => argv[argv.indexOf(key) + 1];
const snippetPath = get(process.argv, "--snippet");
const userPath = get(process.argv, "--user");
const outPath = get(process.argv, "--out");
if (!snippetPath || !userPath || !outPath) {
  console.error("usage: merge-config.mjs --snippet <p> --user <p> --out <p>");
  process.exit(1);
}
const snippet = JSON.parse(readFileSync(snippetPath, "utf8"));
const user = JSON.parse(readFileSync(userPath, "utf8"));

const merged = { ...user };
// plugins: union, dedupe, bundle plugin list wins on duplicates
const bundlePlugins = snippet.plugins ?? [];
merged.plugins = [...new Set([...(user.plugins ?? []), ...bundlePlugins])];
// mcp.servers: bundle owns `graft`; bundle disables these servers; else user keeps theirs
const owns = new Set(["graft"]);
const disabledDrops = new Set(["chrome-devtools", "github", "nuxt", "nuxt-ui", "nuxt-hub"]);
const servers = { ...(user.mcp?.servers ?? {}) };
for (const s of snippet.mcp?.servers ?? {}) servers[s.name ?? s] = s;
const finalServers = {};
for (const [name, cfg] of Object.entries(servers)) {
  if (owns.has(name) || !disabledDrops.has(name)) finalServers[name] = cfg;
}
merged.mcp = { ...(user.mcp ?? {}), servers: finalServers };
writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
console.log("merged config -> " + outPath);
```
3. Commit: `git add config/ scripts/merge-config.mjs; git commit -m "config: snippet + merge script"`.

**Test**: run
`node scripts/merge-config.mjs --snippet config/opencode.snippet.json --user "<current opencode.json>" --out "%TEMP%\merged.json"`
then assert: `merge-config.mjs` and no `discover` on disk — the merged file
contains graft + DCP plugins union and drops the five disabled servers; user's
unrelated keys (e.g. a dummy `"key":"value"`) are preserved.

---

## Task 9: Factory skill conductor (thin SKILL.md + docs set)

**Files**
- Create: `skills/factory/SKILL.md`, `docs/conductor.md`, `docs/how-factory-works.md`.

**Interfaces**
- `skills/factory/SKILL.md` (thin, spec §6/§8): what the factory is, the one
  command (`factory <feature>`), and pointers to the docs to read on demand.
- `docs/conductor.md`: the full conductor spec — pipeline table, phase entry
  checklist, gates A/B/C, mandatory-skill enforcement (phase entry literal
  "Invoke skill X now and follow it"), beads audit (`bd update <feature-id>
  --note "phase:<name> ✓ <skill>"`), resume-from-beads, `factory phase`,
  `factory discover`, `factory onboard`, `factory selfcheck --tokens`.
- `docs/how-factory-works.md`: architecture (conductor / phase engines / beads
  state / graft context, pull-not-push), non-goals, troubleshooting.

**Steps**

1. Create `skills/factory/SKILL.md` (→ write file):
```markdown
---
name: factory
description: Run a feature through the whole opencode-factory pipeline
  (brainstorm -> spec -> plan -> tasks -> implement -> debug -> verify ->
  review -> ship) on autopilot with human gates at spec, plan, and ship.
  Invoke with "factory <feature>". Read docs/how-factory-works.md and
  docs/conductor.md before acting; this file is intentionally thin (context
  economy — pull, don't push).
---
# factory — the software factory conductor

The factory drives one feature through every phase end-to-end, stopping only at
human gates. It enforces the mandatory superpowers skill per phase and records
each phase in beads.

**Start a feature:** `factory <feature>` — or continue an existing one with
`factory phase <name>` after a restart/device switch (resume from
`bd show <id>`).

Before acting, READ, in order:
1. `docs/how-factory-works.md` — architecture and principles (5 min).
2. `docs/conductor.md` — the exact phase pipeline, gates, enforcement, and
   audit protocol (the authoritative how-to).

Then obey `docs/conductor.md` literally. Gates A (spec), B (plan), C (ship) are
HARD STOPS: no implementation files before spec AND plan approval.
```
2. Create `docs/conductor.md` and `docs/how-factory-works.md` transcribing the
   spec's §4–§8 into procedural form (pipeline table, per-phase checklist,
   evidence/audit strings, resume logic, command reference including
   `factory selfcheck --tokens`).
3. Commit: `git add skills/factory docs/conductor.md docs/how-factory-works.md; git commit -m "factory: thin SKILL.md + conductor docs"`.

**Test**: SKILL.md has exactly one actionable directive (read the two docs) and
no phase logic inline; `docs/conductor.md` contains the phase table + the three
gate conditions + the audit note format string.

---

## Task 10: Selfcheck script

**Files**
- Create: `scripts/factory-selfcheck.mjs`.

**Interfaces**
- `node scripts/factory-selfcheck.mjs [--tokens]` — exit 0/1, prints a checklist.

**Steps**

1. Write `scripts/factory-selfcheck.mjs`:
```js
#!/usr/bin/env node
// opencode-factory selfcheck. Exits 0 when the factory environment is intact.
// --tokens additionally prints the token-cost estimate of injected context.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const cfg = join(homedir(), ".config", "opencode");
const checks = [];
const ok = (name, pass, extra = "") => {
  checks.push({ name, pass, extra });
  console.log(`${pass ? "PASS" : "FAIL  "} ${name}${extra ? " — " + extra : ""}`);
};

// 1. Plugins load cleanly (same-run evidence: drain the last opencode log)
const log = join(homedir(), ".local", "share", "opencode", "log", "opencode.log");
if (existsSync(log)) {
  const last = readFileSync(log, "utf8").trim().split("\n").slice(-80).join("\n");
  ok("plugins: all 3 loading", /loading plugin opencode-beads/.test(last) && /loading plugin opencode-pty/.test(last) && /loading plugin opencode-dcp/.test(last), "from last 80 log lines");
  ok("plugins: zero load failures", !/failed to load plugin/.test(last), "same window");
} else {
  ok("plugins: log available", false, "no log file found");
}
// 2. CLI binaries
for (const [name, cmd, args] of [
  ["bd", "bd", ["version"]],
  ["graft", "graft", ["--version"]],
]) {
  const r = process.platform === "win32" ? spawnSync(cmd, args, { shell: true }) : spawnSync(cmd, args);
  ok(name + " present", r.status === 0, r.stdout?.toString().trim().slice(0, 80) ?? "no output");
}
// 3. Conductor skill deployed
const factorySkill = join(homedir(), ".agents", "skills", "factory", "SKILL.md");
ok("factory skill deployed", existsSync(factorySkill), factorySkill);
// 4. Beads state accessible (git repo has .beads store)
const beadsMarker = existsSync(".beads") || existsSync(".agit");
ok("beads store present", beadsMarker, "in cwd tree");
// 5. Token footprint (--tokens only)
if (process.argv.includes("--tokens")) {
  const beadsCtx = (readFileSync(join(homedir(), ".config", "opencode", "plugins", "opencode-beads.ts"), "utf8").length);
  ok("context footprint rough est.", true, `beads plugin approx ${(beadsCtx / 4000).toFixed(1)}k chars → ~${Math.round(beadsCtx / 4)} tokens`);
}
const failed = checks.filter((c) => !c.pass);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed. Re-run install.ps1/install.sh.`);
  process.exit(1);
}
console.log("\nAll selfchecks passed — factory is ready.");
```
2. Run it: `node scripts/factory-selfcheck.mjs` and fix any check whose logic
   doesn't match reality (e.g. exact plugin names in log lines — verify against
   `$env:USERPROFILE\.local\share\opencode\log\opencode.log` actual wording:
   grep `loading plugin` in the last run).
3. Commit: `git add scripts/factory-selfcheck.mjs; git commit -m "selfcheck: factory health script"`.

**Test**: `node scripts/factory-selfcheck.mjs` exits 0 on this machine and prints
all PASS lines; `--tokens` appends the footprint estimate.

---

## Task 11: HOW-INSTALL.md

**Files**
- Create: `docs/HOW-INSTALL.md`.

**Interfaces**
- Human-facing install guide; the installers' success summary points here.

**Steps**

1. Write `docs/HOW-INSTALL.md` (→ write file) covering: prerequisites (Windows
   10/11 PowerShell 5.1+, or Unix with bash+node≥20; git; opencode installed);
   "set up my factory from `<repo>`" one-liners; step-by-step of what
   `install.ps1`/`install.sh` does; graft store caveat (re-run patches after
   upgrades); skill discovery note (project `.agents/skills/` is committed);
   verification (`factory selfcheck --tokens`); troubleshooting (execution
   policy, missing bd on PATH, log-file selfcheck).
2. Commit: `git add docs/HOW-INSTALL.md; git commit -m "docs: HOW-INSTALL guide"`.

**Test**: read-through confirms every command it prints exists in the bundle
(npx skills add, install.ps1, factory selfcheck, node selfcheck path).

---

## Task 12: End-to-end dogfood + install idempotency on this repo

**Files**
- Modify: none committed (runtime checks only) — this task proves success
  criterion 1, 2, 4, 5.

**Interfaces**
- Proofs: clean-checkout install → selfcheck → one trivial feature through gate
  C on this very repo.

**Steps**

1. Fresh-checkout simulation: `git clone` this repo to `%TEMP%\fac-dogfood`; run
   `install.ps1` there; then `node scripts/factory-selfcheck.mjs` → exit 0.
2. Idempotency: run `install.ps1` a second time; `git -C "%TEMP%\fac-dogfood"
   diff` empty; `Get-Content "$env:USERPROFILE\.config\opencode\opencode.json"`
   unchanged between runs (capture hash before/after, equal).
3. Dogfood one trivial feature (e.g. "factory onboarding page"): `factory <t>` —
   brainstorm (vision questions only, no research → permission-gated ask),
   spec gate A, plan gate B (this plan's format), implement via
   subagent-driven-development with TDD, verify, review, ship gate C. Record
   each phase's `bd update --note "phase:… ✓ <skill>"` audit per conductor.
4. Commit nothing runtime; final `factory selfcheck --tokens` exits 0.

**Test**: all steps exit 0; beads history shows every phase with its skill
audit; selfcheck `--tokens` printed.

---

## Self-review checklist (run after writing — fix inline)

1. **Spec coverage** — every spec §6 command (`factory <feature>`, `phase`,
   `discover`, `onboard`, `selfcheck`) maps to a task: conductor docs (T9),
   discovery doc (T5), installers (T7), selfcheck (T10). Spec §9 layout matches
   the bundle file list exactly; §10 verification maps to T10+T12; §12 pins
   resolved (skills.sh CLI in T5, conductor formats in T9, lockfile/catalog
   schemas in T5, config-merge ordering in T7+T8, win store-patch in T6).
2. **Placeholder scan** — no "TBD", no "add appropriate", no dangling
   `__…__` except the ONE template token in `opencode-pty.ts.tmpl` (which the
   installer replaces — that's the contract, not a placeholder).
3. **Type/name consistency** — paths in every Task's Files match the layout in
   Task 1; script names used by installers equal the created filenames;
   merge-config.mjs is referenced by T7 before it exists (T8) — ordering note:
   T7 bolts onto T8's output, and the installer (T7) is itself only executed in
   T12, so dependency is satisfied at execution time.
4. **Review Focus wiring** — R1/clean device → T7 dirs creation + T12 clean
   clone; R2/non-interactive CLIs → T10 version-only checks; R3/execution policy
   → T7 runs with `-ExecutionPolicy Bypass`; R4/skills discovery degradation →
   T5 fallback chain used in T12 discovery step; R5/pnpm store drift → T6 store
   scan, never hardcoded.

---

## Execution handoff (gate B)

**Plan approved.** Execution method to be chosen by the human:

- **subagent-driven-development (recommended)** — one fresh subagent per task
  (Tasks 1–12), a fresh reviewer after each, + whole-branch review at the end.
  Tasks are independent file-drops; the fresh contexts keep each drop clean, and
  cross-task consistency (paths, naming) is enforced by the shared Global
  Constraints + the self-review wiring. Slightly higher cost, cleanest
  isolation.
- **executing-plans (native)** — implement all 12 tasks in this session with
  one fresh reviewer at the end. Cheapest, fastest; risks context bloat across
  the later large tasks (installer, conductor docs).

After the choice: execute per the chosen skill, then report back at gate C
(ship). Before gate C, run Task 12's verification as the ship gate evidence.