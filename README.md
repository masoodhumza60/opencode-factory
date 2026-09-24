# opencode-factory

One portable software factory for OpenCode: `factory <feature>` runs a feature
end-to-end (brainstorm → spec → plan → tasks → implement → debug → verify →
review → ship) with human gates at spec, plan, and ship.

- **Set up on any device:** read `docs/HOW-INSTALL.md` (or run
  `install.ps1` / `install.sh`).
- **Let an AI agent set up a new machine:** paste the prompt from
  [`AI-AGENT-SETUP.md`](AI-AGENT-SETUP.md) into any AI coding agent (OpenCode)
  on that machine — it installs everything itself.
- **Agents:** start by reading `SKILL.md`.
- **Design:** `docs/superpowers/specs/2026-09-22-opencode-factory-design.md`.
- **Plan:** `docs/superpowers/plans/2026-09-22-opencode-factory.md`.

## Quick start (manual, 3 commands)

```bash
git clone https://github.com/masoodhumza60/opencode-factory opencode-factory
cd opencode-factory
./install.sh            # Windows: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
node scripts/factory-selfcheck.mjs --tokens   # health gate: 6 PASS checks
```

## Use it in any project

Install once per machine, onboard once per project:

```
/factory onboard              # stamp the project: beads DB + graft graph + skill lockfile
/factory selfcheck [--tokens] # health + context-footprint report
/factory feature <description> # run the full pipeline (gates at spec, plan, ship)
```

Everything here either gets installed onto a machine (plugins, commands, agent,
skills, snippets) or performs the install/patch/verify work. No build step.