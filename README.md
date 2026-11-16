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
- **Build reference (not product docs):** `docs/superpowers/` holds this bundle's
  own spec and plan — kept for developing the factory itself, never installed.

## AI-agent install (little prompt)

Paste this into an AI coding agent (OpenCode) running on the new machine:

```
Install opencode-factory on this machine:
1. git clone https://github.com/masoodhumza60/opencode-factory && cd opencode-factory && git checkout v1
2. Read https://raw.githubusercontent.com/masoodhumza60/opencode-factory/v1/AI-AGENT-SETUP.md and follow it end-to-end.
```

Prompts: [`AI-AGENT-SETUP.md`](AI-AGENT-SETUP.md) — full machine setup ·
[`AI-AGENT-PROJECT.md`](AI-AGENT-PROJECT.md) — per project.

## Quick start (manual, 3 commands)

```bash
git clone https://github.com/masoodhumza60/opencode-factory opencode-factory
cd opencode-factory
git checkout v1         # the release tag; the tag is the release
./install.sh            # Windows: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
node scripts/factory-selfcheck.mjs --tokens   # health gate: every check PASS (WARNs are informational)
```

## What PASS means (and does not mean)

The selfcheck prints one verdict per check, then a summary line. The summary
line below is quoted from this machine's installs, not invented (the 2026-11-16
verification at bundle `50fa229` printed it and exited 0):

```text
All selfchecks passed - factory is ready.
```

- `PASS` — the check's condition held. `FAIL  ` — the command exits 1 and the
  repair is named on the line; that fail-stop is what `install.ps1`/`install.sh`
  enforce. `WARN  ` — informational only, never affects the exit code
  (example: `skills.lock.json` missing - run `factory discover` and commit
  the lockfile). `skip` — inconclusive; something was absent to evaluate, and
  an absence is neither a pass nor a failure.
- Exit code 0 means no FAIL-termed check ran. The number of PASS lines is not
  a fixed "6" - it grows as the bundle grows, and the machine, not this
  document, owns it. Read the failure line when the exit code is non-zero;
  do not count.
- Not proven by a green selfcheck: a fresh machine (this machine only), the
  skew of already-installed older scripts (presence is what it checks),
  GitHub/Actions/releases, or the quality of anything it shipped. See
  `docs/factory-ux-review.md` for exactly what has and has not been verified.

## Verifying a release

The git tag is the release: `v1` points at the exact tree this README and
`install.sh` / `install.ps1` install. Checksums are not published; verify a
release by checking out the tag (not `master`), reading
[`CHANGELOG.md`](CHANGELOG.md) for what the tag contains, and running
`node scripts/factory-selfcheck.mjs --tokens` after install. The `v1` tag is
created at milestone close; until then, `master` is the development branch.

## Use it in any project

Set up the machine once, then onboard each project:

```
# 1) New machine (once): clone + install everything
git clone https://github.com/masoodhumza60/opencode-factory && cd opencode-factory && git checkout v1
./install.sh            # Windows: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
node scripts/factory-selfcheck.mjs --tokens   # every check PASS = machine is factory-ready

# 2) Any project (per project): stamp state, then build
/factory onboard              # stamp the project: beads DB + skill lockfile
/factory selfcheck [--tokens] # health + context-footprint report
/factory feature <description> # run the full pipeline (gates at spec, plan, ship)
```

**No manual work at all?** Paste `AI-AGENT-SETUP.md` on the new machine, then
paste `AI-AGENT-PROJECT.md` in each project — the agents do all of the above.

Everything here either gets installed onto a machine (plugins, commands, agent,
skills, snippets) or performs the install/patch/verify work. No build step.