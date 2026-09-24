# AI Agent Setup — install opencode-factory on a new machine

Use this when you want to bring the factory to a machine with **no manual
install**. Give the prompt below to an AI coding agent (OpenCode) running on
that machine — it performs the whole installation itself: beads (`bd`) + graft
(code-graph MCP), the OpenCode plugins, the `/factory` commands, the
beads-task agent, and the factory skill.

## How to use

1. Clone this repo on the new machine:
   `git clone https://github.com/masoodhumza60/opencode-factory && cd opencode-factory`
2. Open a new OpenCode session in that folder.
3. Paste the prompt below.
4. After the agent finishes, **start a fresh OpenCode session** — the `/factory`
   commands and graft MCP only appear in sessions started after the install.
5. From then on, in **any** project on that machine, paste the project prompt
   from [`AI-AGENT-PROJECT.md`](AI-AGENT-PROJECT.md) into a session opened in
   that project — it verifies the machine, runs `/factory onboard` once per
   project, then `/factory feature <description>`.

## The prompt

```
Install opencode-factory on this machine — no manual steps.

THE RULES FIRST:
- Only run these commands if your shell runs on MY computer. No local shell
  (cloud sandbox or chat app)? STOP — there is nothing for you to install;
  give me the README instead.
- Do not modify this repo. Installations go to my user config
  (~/.config/opencode and ~/.agents/skills).
- Never ask for or echo API keys — this setup needs none.

PART 1 — install the factory (once per machine, idempotent)
1. Confirm your working directory is the clone of this repo.
2. Check node is >= 20 (the installer checks this too and fails fast if not).
3. Run the platform installer once:
   - Windows:      powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
   - macOS/Linux:  ./install.sh   (if the exec bit is missing: bash install.sh)
   It installs the whole system:
   - beads: the `bd` CLI (via executables/install-bd.*) + the 29 `/beads` commands
   - graft: the code-graph MCP server, machine-resolved, native patches applied
   - OpenCode plugins (beads, pty), the beads-task agent,
     the factory skill with its docs, and the 3 `/factory` commands
     (onboard, selfcheck, feature)

PART 2 — verify
4. Run  node scripts/factory-selfcheck.mjs --tokens
   It prints 6 PASS checks (plugins load, bd present, graft present, factory
   skill deployed, beads store) plus a token-footprint line and optional WARN
   lines. All PASS + exit 0 = this machine is factory-ready. WARNs are
   informational, not failures. If anything FAILs, run the repairs it names,
   in order, then re-check.

PART 3 — prove it end-to-end
5. The `/factory` commands and graft MCP only appear in a session started AFTER
   this install. In a fresh session, from ANY project folder, run
   `/factory onboard` — it stamps the project (beads DB — created or reused,
   graft graph build, skills.lock.json) and reports each step. Then
   `/factory selfcheck` in that project should report all PASS with no WARNs.

PART 4 — report back
6. What installed, the selfcheck result (copy the 6 PASS lines), whether
   `/factory onboard` ran cleanly in a project, and anything you could not
   finish — with the exact command I still need to run.
```

## What it does, step by step

| Step | Action on the new machine |
|---|---|
| 1 | Agent confirms the clone as working dir, node >= 20 |
| 2 | `install.ps1` / `install.sh` — machine-global install: `bd` + graft MCP, plugins, `/factory` commands, agent, skill |
| 3 | `factory-selfcheck.mjs --tokens` — 6 PASS health gate |
| 4 | Fresh session → `/factory onboard` stamps any project (beads + graft + lockfile) |
| 5 | `/factory feature <description>` runs the pipeline (gates at spec, plan, ship) |

No API keys, no browser sign-ins — the only human input this setup needs is
running the prompt. After the one-time machine install, each project gets its
state stamped once with `/factory onboard`.