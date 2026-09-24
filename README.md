# opencode-factory

One portable software factory for OpenCode: `factory <feature>` runs a feature
end-to-end (brainstorm → spec → plan → tasks → implement → debug → verify →
review → ship) with human gates at spec, plan, and ship.

- **Set up on any device:** read `docs/HOW-INSTALL.md` (or run
  `install.ps1` / `install.sh`).
- **Let an AI agent set up a new machine:** paste the prompt from
  [`AI-AGENT-SETUP.md`](AI-AGENT-SETUP.md) into any AI coding agent (OpenCode)
  on that machine — it installs everything itself. The prompt is
  self-contained: the agent needs no prior knowledge of any of these tools,
  it just runs the installer and checks the result.
- **Let an AI agent use it in a project (new or existing):** paste the prompt
  from [`AI-AGENT-PROJECT.md`](AI-AGENT-PROJECT.md) into a session opened in
  that project — it verifies the machine, runs `/factory onboard`, and drives
  the feature through the pipeline. Run `AI-AGENT-SETUP.md` **first** on a new
  machine; the project prompt stops and says so if the machine isn't ready.
- **Agents:** start by reading `SKILL.md`.
- **Design:** `docs/superpowers/specs/2026-09-22-opencode-factory-design.md`.
- **Plan:** `docs/superpowers/plans/2026-09-22-opencode-factory.md`.

## AI-agent install (little prompt)

Paste this into an AI coding agent (OpenCode) running on the new machine:

> Set up opencode-factory on this machine:
> 1. `git clone https://github.com/masoodhumza60/opencode-factory && cd opencode-factory`
> 2. Check `node --version` is 20 or newer — if not, STOP and tell me.
> 3. Install:
>    - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`
>    - macOS/Linux: `./install.sh` (or `bash install.sh`)
> 4. Check it: `node scripts/factory-selfcheck.mjs --tokens` — all 6 checks must
>    print PASS.
> 5. Report the results. Say OK only when every check PASSes.

For the **full, self-contained prompt** — rules, error handling, fresh-session
notes — use [`AI-AGENT-SETUP.md`](AI-AGENT-SETUP.md). Then, in each project,
paste [`AI-AGENT-PROJECT.md`](AI-AGENT-PROJECT.md) to build features.

## Quick start (manual, 3 commands)

```bash
git clone https://github.com/masoodhumza60/opencode-factory opencode-factory
cd opencode-factory
./install.sh            # Windows: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
node scripts/factory-selfcheck.mjs --tokens   # health gate: 6 PASS checks
```

## Use it in any project

Set up the machine once, then onboard each project:

```
# 1) New machine (once): clone + install everything
git clone https://github.com/masoodhumza60/opencode-factory && cd opencode-factory
./install.sh            # Windows: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
node scripts/factory-selfcheck.mjs --tokens   # 6 PASS = machine is factory-ready

# 2) Any project (per project): stamp state, then build
/factory onboard              # stamp the project: beads DB + graft graph + skill lockfile
/factory selfcheck [--tokens] # health + context-footprint report
/factory feature <description> # run the full pipeline (gates at spec, plan, ship)
```

**No manual work at all?** Paste `AI-AGENT-SETUP.md` on the new machine, then
paste `AI-AGENT-PROJECT.md` in each project — the agents do all of the above.

Everything here either gets installed onto a machine (plugins, commands, agent,
skills, snippets) or performs the install/patch/verify work. No build step.