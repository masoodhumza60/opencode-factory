# HOW-INSTALL — set up your factory from this repo

`install.ps1` (Windows) and `install.sh` (Unix) turn a machine into an
opencode-factory workstation in one go. They install the two CLIs the factory
relies on (bd and graft), deploy the opencode plugins and beads commands, merge
the factory's config into your user config, deploy the `factory` skill, install the
mandatory hard skills, and run a selfcheck.
If the selfcheck fails, the installer **aborts** (`factory selfcheck failed -
install incomplete.`) — the design is fail-stop, not proceed-with-warnings. The
installers' success summary points back to this file.

## Prerequisites

- **Windows 10/11** with **PowerShell 5.1+** (ships with Windows), **or** Linux/
  macOS with **bash**.
- **node ≥ 20** (nodejs.org) — both installers check at startup and refuse to
  run without it. Every installer step needs node: plugin rendering, config
  merge, and the selfcheck.
- **git** (required by `executables/install-bd.sh` on Unix; harmless elsewhere).
- **opencode already installed.** The installer merges plugins and config into
  opencode's user directory, and needs `opencode-pty` available in opencode's
  npm cache — run `opencode` once before installing so it installs its
  dependencies.
- **A JS package manager for the graft step** — pnpm or bun if you already have
  one; otherwise npm (which node ≥ 20 ships). The installers auto-select in the
  order pnpm → bun → npm, so a plain node install works with zero extra setup.

One note on the two non-opencode CLIs:

- **beads (`bd`)** — state layer of the factory. The installer tracks the latest
  stable; the known-good pin is **1.3.0**. Confirm with `bd version` after
  installing.
- **graft** — code-graph MCP server. The installer pins
  `@nanonets/graft@0.18.0` and applies two patches (see "Graft store caveat").

## One-liner

From a clone of this repo:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File install.ps1
```

```bash
# Unix (Linux/macOS)
bash install.sh
```

Both installers accept the same flags:

| Flag | Effect |
|---|---|
| `-SkipBd` | skip installing/verifying the beads CLI |
| `-SkipGraft` | skip installing/patching graft. An existing graft install is still required — the config merge needs its `cli.js`, and the installer fail-stops rather than fabricate a broken MCP entry. |
| `-DryRun` | print every step without changing anything (exits 0) |

`install.ps1 -DryRun` / `install.sh -DryRun` always exit 0 (preview only). The
bd sub-script is a semantic signal on its own: `executables/install-bd.ps1
-DryRun` prints the same preview, but exits 1 when bd is absent at the managed
path (a real run would have to install it).

`./install.sh -DryRun` on Unix (or `-SkipBd -DryRun`) is a good first taste of
what a real install will do on your machine. Re-running the installer is safe:
it's idempotent by construction (see below).

## What the installer does, step by step

Both installers run the same steps in the same order:

1. **Ensure directories** — `~/.config/opencode/plugins/`,
   `~/.config/opencode/commands/beads/`, `~/.config/opencode/agents/`,
   `~/.agents/skills/factory/`, and the repo's `.agents/skills/`.
2. **Install beads (`bd`)** — via `executables/install-bd.ps1` (choco → winget
   → copy-to-`%LOCALAPPDATA%\Programs\bd\bd.exe` fallback, then user-PATH) or
   `executables/install-bd.sh` (`beads.dev/install.sh`), then verify
   `bd version`.
3. **Install + patch graft** — `@nanonets/graft@0.18.0` via an available package
   manager (`pnpm add -g` / `bun add -g` / `npm install -g`; auto-selected in
   that order, npm as the default whenever pnpm/bun are absent), locate the
   package dir under that manager's global root, then run both patch scripts
   (see caveat below) and verify `graft --version`.
4. **Deploy plugins** — copy `plugins/opencode-beads.ts` to
   `~/.config/opencode/plugins/`, and render `plugins/opencode-pty.ts.tmpl`
   (substituting the resolved `opencode-pty` v2 index from opencode's cache)
   to `~/.config/opencode/plugins/opencode-pty.ts`.
5. **Deploy beads commands + task agent** — copy `commands/beads/*.md` to
   `~/.config/opencode/commands/beads/` and `agents/beads-task-agent.md` to
   `~/.config/opencode/agents/`.
6. **Merge config** — seed `~/.config/opencode/opencode.json` with `{}` if
   absent, then `scripts/merge-config.mjs` performs a **union merge**: your
   existing keys are preserved except where the bundle owns them. The bundle
   adds the DCP plugin pin (`plugins/dcp.pin`) to `plugins` and owns
   `mcp.servers.graft` (`{type: local, command: [node, <graft>/dist/cli.js,
   mcp]}`, enabled). The merge is purely additive: every MCP server you
   already have — enabled or disabled — is preserved exactly as configured;
   nothing is ever removed.
7. **Install the factory skill** — copy `skills/factory/SKILL.md` to
   `~/.agents/skills/factory/`, plus `docs/conductor.md`,
   `docs/how-factory-works.md`, `docs/plan-format.md` and `docs/discovery.md`
   to `~/.agents/skills/factory/docs/`. The installed skill is self-contained:
   its `docs/` subdir ships every document the conductor and the commands point
   at, so nothing is a dangling path on the machine. All four matter — a
   machine with only the conductor has references that resolve to nothing.
   The `verify-app` skill ships alongside it at `~/.agents/skills/verify-app/`
   and the selfcheck FAILS without it, because it is what makes the phase-5
   `--booted` claim checkable rather than merely asserted.
8. **Install the mandatory hard skills** — run
   `node scripts/factory-skills.mjs install`, which installs the `mandatory`
   section of `skills/catalog.yaml` into `~/.agents/skills/` via
   `npx --yes skills add <source> -s <name> -g -a opencode --copy -y`. Today
   that is **`commit-work`** (phase 7 ship) and **`skill-judge`** (discovery).
   This step runs **before** the selfcheck on purpose: the selfcheck FAILs when
   a mandatory skill is missing, so installing afterwards would guarantee a red
   install on a clean machine. A network failure here is not swallowed — the
   installer aborts with the command to fix, the same as a missing graft.
   `--dry-run` prints what it would install and writes nothing; `factory-skills.mjs
   check` reports the current state and exits 1 if anything is missing.
9. **Pair DCP with the handoff rule** — run `scripts/dcp-prompts.mjs`. It
   inserts `experimental.customPrompts: true` into
   `~/.config/opencode/dcp.jsonc` (a pure insertion: your comments and
   formatting are left alone, and a second run changes nothing) and writes the
   `turn-nudge` prompt override to
   `~/.config/opencode/dcp-prompts/overrides/turn-nudge`. DCP only honours
   overrides once that flag is set, and if the config cannot be parsed the
   script reports the override as **inert** rather than leaving a file that
   looks configured and never fires. **Restart OpenCode afterwards** — dcp
   reads its config at startup, so the nudge is inactive until then. The
   override text is our own: DCP is AGPL-3.0-or-later, so we install it but
   never vendor or copy its prompts. Delete the override file to return to
   stock dcp wording.
10. **Run the selfcheck's own tests** — `node scripts/test-selfcheck.mjs`,
   `node scripts/test-install-idempotency.mjs`,
   `node scripts/test-factory-phase.mjs` and
   `node scripts/test-factory-plan.mjs` and
   `node scripts/test-factory-skills.mjs` and
   `node scripts/test-factory-mcp.mjs`. A check that cannot fail is
   decoration, and this bundle has shipped one, so the proof that each check
   can reach a FAIL lives in the repo rather than in someone's memory. The
   tests run **before** the selfcheck and a failure aborts the install
   (`the selfcheck cannot be trusted`). They cover every branch of the dcp
   check — pruned → PASS, `manualMode: true` → FAIL, corrupt → FAIL, fresh
   session → WARN, missing state → FAIL — plus the writers' idempotency and
   their refusal to damage a config they cannot parse.
   `test-factory-phase.mjs` drives the phase machine against a throwaway bd
   database and asserts that every illegal transition is **refused**: jumping
   phases, entering a phase while its human gate is still pending, completing a
   phase you are not in, and reading a state that cannot be parsed. That suite
   is the proof the pipeline's enforcement can actually say no. It also covers
    the boot condition on phase 5 (`--booted` required, a double-quoted or
    over-long value refused rather than truncated), the artifact check on phase 2
    (a spec cannot rest on a brainstorm nobody wrote), the `status` staleness
    report (`idle_days`, `stale`) and the `repair_done_stale` coherence flag. Those
    three fields are reported, never enforced: `status` tells you a run has been
    idle too long or carries a stale repair record, and what you do about that
    is a human's call.
   `test-factory-plan.mjs` drives the plan-to-graph compiler against a
   throwaway bd database and asserts that a bad plan is **refused before it can
   reach the database** — 17 must-fail cases covering a silently-ignored field,
   a dangling dependency, a missing acceptance criterion, a duplicate key and a
   malformed key. See `docs/plan-format.md`.
   `test-factory-skills.mjs` runs the real script against temporary catalogs
   with a **sandboxed HOME per test**, so it can neither install into nor be
   satisfied by the real `~/.agents/skills`. It also covers `record`: that a
   complete decision record lands where the docs say, that `run.at` is stamped
   by the script rather than accepted from the agent, that a record missing any
   of the five per-skill facts is refused and writes nothing, that every problem
   is reported at once, and that a degraded run cannot claim `degraded` without
   a `degraded_reason`. It asserts the fail-closed
   behaviour the catalog depends on: a mis-indented entry, a missing version,
   an unknown future version and an unknown top-level key are each **rejected**
   rather than read as an empty mandatory list, and a `SKILL.md` that is a
   *directory* does not count as installed.
   `test-factory-mcp.mjs` drives a **fake MCP server** it spawns itself, in a
   sandbox, with a config it controls, so it proves the handshake check both
   ways: a server that completes the protocol PASSes and reports the version it
   sent, while an absent, disabled, unspawnable or unreadable one FAILs with a
   named stage. It also pins the two judgement calls that are easy to get
   backwards — a tool list of **zero is a legitimate state** and never a
   failure, and **no credential can leak** into a record (no header values, no
   header names, no URL query tokens). See `docs/mcp-judging.md`.
11. **Selfcheck** — run `node scripts/factory-selfcheck.mjs`. Any failed check
   aborts the install (`factory selfcheck failed - install incomplete.`). Two
   of the checks watch DCP rather than merely asserting the plugin loads:
   `dcp: pruning active` reads the state files of the **5 most recent** DCP
   sessions and passes if any of them shows pruning (`manualMode: true` in any
   of them, or no state files at all, fails the install). It inspects several
   sessions rather than only the newest because keying off a single
   newest-by-mtime file made it report a WARN on healthy fresh sessions — a
   health check that cries wolf is one people stop reading. `--dcp-session <id>`
   targets one session deliberately. `dcp: turn-nudge override installed`
   confirms step 9 landed. A session that simply has not needed pruning yet is
   a `WARN`, not a failure, so a fresh install stays green.
   `mandatory skills: present` is a **FAIL**, never a WARN: `commit-work` and
   `skill-judge` are hard skills, and a hard skill reported as advisory is the
   same defect as a check that cannot fail. `verify-app skill deployed` is a
   FAIL for the same shape of reason: shipping the phase-5 boot guard without the
   thing that makes its claim checkable would be the guard-without-effect defect
   a second time. It delegates to
   `factory-skills.mjs check --json` rather than re-parsing the catalog — two
   parsers of one file drift, and the second one is the one that quietly
   disagrees. On failure it names the missing skill and the fix
   (`factory-skills.mjs install`).
   `mcp: graft handshake` is a **FAIL** for the same reason. It is not the
   `graft --version` CLI check: it reads the configured command out of
   `opencode.json`, spawns it, and speaks the real MCP protocol (`initialize`,
   then `tools/list`). This is what the doc used to *claim* the selfcheck did
   while it only ran the CLI, which meant a graft server that was misconfigured,
   renamed or crashing on boot looked exactly as healthy as a working one. A
   tool list of **zero passes** — graft defers its schemas until a graph exists,
   and a healthy server legitimately exposes nothing in some repos. The verdict
   also reports the instructions the server injects into every model call,
   because an enabled MCP is a standing context cost, not a skill that costs
   only when triggered. `--mcp-config <path>` points the check at another
   config, which is how the negative tests drive it.

Why re-runs are safe (and how they behave): the config merge is a union (no
destructive overwrite of your keys), the two graft patch scripts are idempotent
(they detect an already-patched state and exit 0), `install-bd` fast-paths when
`bd version` already works, and the plugin/command deploys are plain copies. A
re-run after everything is in place exits 0 with zero config drift.

## Graft store caveat — re-patch after any graft upgrade

Graft's patches are applied *inside the package manager's global store*. Any
reinstall or upgrade of graft — via `npm install -g`, `pnpm add -g`, or `bun
add -g` — replaces the package and **resets the patches**. Re-run them whenever
you upgrade graft or reinstall it:

```bash
# 1. find the graft package dir (this only works if graft is already installed);
#    pick the manager you installed graft with:
node scripts/graft-patch-extract.mjs --dir "$(npm root -g)/@nanonets/graft"
# ...or with pnpm (pnpm root -g) / bun (bun pm root -g)
```

```powershell
# 2. Windows only: rename win32-x64 prebuilds to node.napi.node in the store
powershell -ExecutionPolicy Bypass -File scripts/graft-patch-store.ps1
```

Then confirm with `graft --version`. (`graft-patch-extract.mjs` swaps a static
`tree-sitter-kotlin` import for a dynamic one so graft starts even without a
Windows prebuilt; `graft-patch-store.ps1` renames the store's `*.node`
prebuilds to the expected `node.napi.node`.)

## Skill discovery — committed project skills

- The project's **`.agents/skills/`** directory is **committed with the repo**
  and travels with it — the factory ships the skills your features need, with
  nothing machine-specific in them.
- `factory discover <feature-id>` (inside opencode) installs *optional* skills
  a feature needs beyond the enforced superpowers set. It project-installs them
  with `DISABLE_TELEMETRY=1 npx skills add <source> --skill <name> -a opencode
  --copy -y` (project scope → `.agents/skills/<name>/`) and records every
  install in **`.agents/skills/skills.lock.json`** — the dedupe authority and
  the source for deterministic reinstalls.

## Verify the install

The installer runs the selfcheck itself; to re-check on demand:

- **Inside opencode**: `factory selfcheck` — or `factory selfcheck --tokens`,
  which additionally prints a rough estimate of the token footprint of the
  injected beads context, and the current orchestrator session's own input
  and cache-read spend.
- **Bare**: `node scripts/factory-selfcheck.mjs` (`--tokens` flag works here
  too).

To see a project's token spend split by role, run
`node scripts/measure.mjs` (optionally `--dir <path>`, `--since <iso>`,
`--json`). It is a report: it blocks nothing, and a directory with no recorded
sessions exits 1 rather than printing a misleading zero.

Checks covered: all three plugins loaded with zero failures in the latest
opencode run that loaded plugins (run-scoped evidence taken from the structured
`msg="loading plugin"` / `message="failed to load plugin"` lines of the
opencode log), `bd` and `graft` respond, the factory skill is deployed to
`~/.agents/skills/factory/SKILL.md`, a beads store is present, both mandatory
hard skills are present, and DCP is actually pruning rather than merely loaded.
Failure output says `N check(s) failed. Re-run install.ps1/install.sh.`

## Troubleshooting

| Symptom | Fix |
|---|---|
| `powershell` refuses to run the script (execution policy) | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then retry. The one-liner already sidesteps this with `-ExecutionPolicy Bypass`. |
| `bd` missing on PATH after install | Re-run the bd installer: `powershell -ExecutionPolicy Bypass -File executables/install-bd.ps1` (Windows) or `bash executables/install-bd.sh` (Unix), or call it by absolute path: `%LOCALAPPDATA%\Programs\bd\bd.exe` on Windows. |
| `graft` missing / `graft --version` fails | Install it: `npm install -g @nanonets/graft@0.18.0` (or `pnpm add -g` / `bun add -g`), re-run the two patch scripts ("Graft store caveat"), then re-run the installer. |
| Installer aborts at the selfcheck | The failing check names the problem (e.g. `bd present` FAIL on very first run). Fix it and re-run — the installer is fail-stop by design. |
| Selfcheck keeps failing on the plugin checks | Look at the log the selfcheck reads: `%USERPROFILE%\.local\share\opencode\log\opencode.log` (Windows) / `~/.local/share/opencode/log/opencode.log` (Unix). |
| Want a preview before touching anything | Re-run with `-DryRun` — prints every step, changes nothing, exits 0. |
| `mandatory skills: present` FAILs | A hard skill is missing or half-installed. Run `node scripts/factory-skills.mjs install`, then re-check with `node scripts/factory-skills.mjs check`. If the install itself failed, the printed command is the one that failed - usually no network for `npx skills add`. |
| `verify-app skill deployed` FAILs | `~/.agents/skills/verify-app/SKILL.md` is absent. Re-run the installer (`install.ps1` / `install.sh`). It ships with the bundle; nothing downloads it. Without it, phase 5 can accept a `--booted` claim that nothing ever re-checks. |

## Reference — paths

| Thing | Location |
|---|---|
| opencode config (user) | `~/.config/opencode/` (`%USERPROFILE%\.config\opencode` on Windows) |
| factory skill (user) | `~/.agents/skills/factory/SKILL.md` |
| project skills (committed) | `.agents/skills/` |
| skills lock | `.agents/skills/skills.lock.json` |
| bd CLI (Windows) | `%LOCALAPPDATA%\Programs\bd\bd.exe` |
| graft | the package manager's global root (`npm root -g` / `pnpm root -g` / `bun pm root -g`) |
| selfcheck log | `~/.local/share/opencode/log/opencode.log` |
