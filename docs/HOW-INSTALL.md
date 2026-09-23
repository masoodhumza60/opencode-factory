# HOW-INSTALL — set up your factory from this repo

`install.ps1` (Windows) and `install.sh` (Unix) turn a machine into an
opencode-factory workstation in one go. They install the two CLIs the factory
relies on (bd and graft), deploy the opencode plugins and beads commands, merge
the factory's config into your user config, deploy the `factory` skill, and run
a selfcheck.
If the selfcheck fails, the installer **aborts** (`factory selfcheck failed -
install incomplete.`) — the design is fail-stop, not proceed-with-warnings. The
installers' success summary points back to this file.

## Prerequisites

- **Windows 10/11** with **PowerShell 5.1+** (ships with Windows), **or** Linux/
  macOS with **bash** and **node ≥ 20**. The Unix installer refuses to start
  without node ≥ 20 (both installers need it to render plugins and run the
  merge/selfcheck scripts).
- **git** (required by `executables/install-bd.sh` on Unix; harmless elsewhere).
- **opencode already installed.** The installer merges plugins and config into
  opencode's user directory, and needs `opencode-pty` available in opencode's
  npm cache — run `opencode` once before installing so it installs its
  dependencies.
- **pnpm** (only needed for the graft step; `install.sh` will stop with a clear
  message if it's missing).

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
| `-SkipGraft` | skip installing/patching graft (plugins + config merge still happen) |
| `-DryRun` | print every step without changing anything (exits 0) |

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
3. **Install + patch graft** — `pnpm add -g @nanonets/graft@0.18.0` (when not
   already present), locate the package dir under the pnpm global store, then
   run both patch scripts (see caveat below) and verify `graft --version`.
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
   adds the DCP plugin pin (`plugins/dcp.pin`) to `plugins`, owns
   `mcp.servers.graft` (`{type: local, command: [node, <graft>/dist/cli.js,
   mcp]}`, enabled), and drops a fixed set of disabled demo servers
   (`chrome-devtools`, `github`, `nuxt`, `nuxt-ui`, `nuxt-hub`).
7. **Install the factory skill** — copy `skills/factory/SKILL.md` to
   `~/.agents/skills/factory/`.
8. **Selfcheck** — run `node scripts/factory-selfcheck.mjs`. Any failed check
   aborts the install (`factory selfcheck failed - install incomplete.`).

Why re-runs are safe (and how they behave): the config merge is a union (no
destructive overwrite of your keys), the two graft patch scripts are idempotent
(they detect an already-patched state and exit 0), `install-bd` fast-paths when
`bd version` already works, and the plugin/command deploys are plain copies. A
re-run after everything is in place exits 0 with zero config drift.

## Graft store caveat — re-patch after any graft upgrade

Graft's patches are applied *inside the pnpm global store*. A `pnpm add -g` of
any package — or a graft upgrade — replaces the graft package and **resets the
patches**. Re-run them whenever you upgrade graft or reinstall it:

```bash
# 1. find the graft package dir (this only works if graft is already installed)
node scripts/graft-patch-extract.mjs --dir "$(pnpm root -g)/@nanonets/graft"
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
  injected beads context.
- **Bare**: `node scripts/factory-selfcheck.mjs` (`--tokens` flag works here
  too).

Checks covered: all three plugins load with zero failures (from the last 80
lines of the opencode log), `bd` and `graft` respond, the factory skill is
deployed to `~/.agents/skills/factory/SKILL.md`, and a beads store is present.
Failure output says `N check(s) failed. Re-run install.ps1/install.sh.`

## Troubleshooting

| Symptom | Fix |
|---|---|
| `powershell` refuses to run the script (execution policy) | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then retry. The one-liner already sidesteps this with `-ExecutionPolicy Bypass`. |
| `bd` missing on PATH after install | Re-run the bd installer: `powershell -ExecutionPolicy Bypass -File executables/install-bd.ps1` (Windows) or `bash executables/install-bd.sh` (Unix), or call it by absolute path: `%LOCALAPPDATA%\Programs\bd\bd.exe` on Windows. |
| `graft` missing / `graft --version` fails | Install it: `pnpm add -g @nanonets/graft@0.18.0`, re-run the two patch scripts ("Graft store caveat"), then re-run the installer. |
| Installer aborts at the selfcheck | The failing check names the problem (e.g. `bd present` FAIL on very first run). Fix it and re-run — the installer is fail-stop by design. |
| Selfcheck keeps failing on the plugin checks | Look at the log the selfcheck reads: `%USERPROFILE%\.local\share\opencode\log\opencode.log` (Windows) / `~/.local/share/opencode/log/opencode.log` (Unix). |
| Want a preview before touching anything | Re-run with `-DryRun` — prints every step, changes nothing, exits 0. |

## Reference — paths

| Thing | Location |
|---|---|
| opencode config (user) | `~/.config/opencode/` (`%USERPROFILE%\.config\opencode` on Windows) |
| factory skill (user) | `~/.agents/skills/factory/SKILL.md` |
| project skills (committed) | `.agents/skills/` |
| skills lock | `.agents/skills/skills.lock.json` |
| bd CLI (Windows) | `%LOCALAPPDATA%\Programs\bd\bd.exe` |
| graft | pnpm global store (`${PNPM_HOME:-$HOME/.local/share/pnpm}/global` on Unix) |
| selfcheck log | `~/.local/share/opencode/log/opencode.log` |