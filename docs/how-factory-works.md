# how-factory-works.md — architecture and principles

Read this first (about 5 minutes) when a feature starts, then
`docs/conductor.md` for the exact procedure. This document explains the shape
of the factory; the conductor doc is the authoritative how-to.

## The factory in one sentence

`factory <feature>` drives one feature through a fixed pipeline — brainstorm →
spec → plan → implement → debug → verify → review → ship — on autopilot, stops
only at three human gates (spec, plan, ship), and enforces that the right
superpowers skill runs at the right phase.

## Three layers, one job each

| Layer | Component | Job |
|---|---|---|
| Conductor | `factory` skill (thin) | Phase machine + gates + skill enforcement |
| Phase engines | superpowers skills (reused) | The actual phase procedures |
| State | beads (`bd` CLI + Dolt DB) | One issue per feature, `phase:` stored on it, audit log |

The design rule that shaped everything: **fewer random pieces, not more glue**.
The conductor is the *only* new component. Everything else is reused: the
superpowers skills run the phases and beads owns state. The bundle consolidates
the user's scattered existing pieces (plugins, beads commands, task agent,
install scripts) into one managed, idempotently-installable package.

There is deliberately **no context layer**. The factory once shipped a code-graph
MCP server for it and removed it after measuring it: across 40,467 recorded tool
calls it was used once, in a project the factory never touched. Navigation in
this bundle is `glob`, `grep` and `read` — tools that are already present, cost
nothing to install, and never need a graph built before they answer. See
`docs/conductor.md` — "Code navigation (no MCP required)" for the measurement.

### Role boundaries

- The conductor is **thin** — a `SKILL.md` with description only, plus bundled
  docs it reads while running. It never reimplements a phase procedure.
- beads is the **source of truth for phase state**, not a to-do list. One issue
  per feature; `bd prime` pushes phase state into every model call; the audit
  survives restarts and device moves because beads is Dolt-backed.
- The filesystem is the context layer, and it is not optional machinery. Reading
  a file answers "what is here" with no index to build, no server to connect,
  and no staleness to re-check.

## Pull, never push (spec §8)

The factory is strict about context economy:

- `catalog.yaml` and `skills.lock.json` are never in the conversation context;
  they are opened only while `factory discover` runs.
- Skill bodies enter context **only on invocation**. The factory `SKILL.md`
  stays thin exactly so that its logic does not sit in the context window; the
  conductor's detail lives in docs read on demand.
- `factory selfcheck --tokens` reports the loaded footprint so it stays
  visible and cheap — that flag is the tool that keeps the pull-only promise
  honest.

## The pipeline at a glance

Phases 1–8 with their mandatory skills, gates A/B/C, the journey, the
per-phase enforcement protocol, and the resume logic are all in
`docs/conductor.md`. In short: the machine advances forward-only, routing any
bug or test failure into the debug loop (`systematic-debugging`) before fixes
are allowed, reads `bd show <id>` at every phase entry, and refuses to mark a
phase complete until that phase's skill content was actually loaded in-session.

## Non-goals (spec §3)

The factory deliberately does not try to become:

- **A new task tracker, coding agent, or MCP server product** — beads,
  superpowers, and OpenCode are reused, not replaced.
- **Automatic merging/deploying without a human** — ship always stops for
  gate C; no lights-out shipping.
- **A wholesale takeover of the user's global OpenCode config** — the installer
  *merges*, with the bundle winning only where it explicitly owns a value
  (DCP pin, enabled MCP servers).
- **A multi-user team product** — v1 assumes a single operator.

## Troubleshooting

- **`bd` is missing / `bd version` fails.** `factory onboard` re-runs
  `bd init` when there is no beads DB. If the CLI itself is absent, the
  bootstrap scripts (`install.ps1` / `install.sh`) install beads; re-run them
  — they are idempotent. `factory selfcheck` verifies CLIs resolve.
- **An MCP server of yours is not connecting.** The factory requires none and
  touches no `mcp.servers` entry, so this is almost never the bundle's doing.
  Diagnose it with `node scripts/factory-mcp.mjs handshake --name <server>`,
  which spawns the configured command and speaks the real MCP protocol, and
  with `node scripts/factory-mcp.mjs audit --json` for what the config claims.
  Re-run the installer rather than hand-editing MCP config — it merges with
  machine-resolved paths and never touches credential-bearing files.
- **Skill gate stalls (a phase won't complete).** The gate is the point:
  a phase is incomplete until its mandatory skill's content was loaded
  in-session. Re-invoke the skill and actually load its content; re-run the
  phase entry ("Invoke skill X now and follow it") before recording it. At any
  gate, a skipped skill forces the phase to re-run — the audit
  (`bd update <feature-id> --append-notes "phase:<name> ✓ <skill>"`) shows what ran.
- **Resume after a restart or a different device.** Beads is the durable
  source of truth. At every entry the conductor reads `bd show <id>`; a fresh
  session starts with `factory <feature>` (existing issue) or
  `factory phase <name>` to continue from where the audit log left off. State
  is not kept in the model or the session, so nothing is lost.
- **Context bloat creeping in.** Run `factory selfcheck --tokens` and look at
  the loaded-footprint report; trim whatever is in the context that does not
  need to be there. `catalog.yaml` and `skills.lock.json` should never appear
  in conversation — they are opened only during `factory discover`.
- **A session is getting expensive.** This is a shape problem, not a footprint
  problem, and the two have different fixes. Cost is driven by turn count: every
  turn re-sends the turns before it, so a long session gets quadratically
  worse even when each turn is small. A real run spent 78.3M tokens across 955
  turns with its context climbing to 191k and never dropping. The conductor
  therefore **hands off to a fresh
  session rather than pushing on — see "Cost discipline" in `docs/conductor.md`,
  which also covers picking work with `bd ready` (not `bd list`) and keeping a
  subagent's report rather than its raw output. Automatic context pruning on the
  machine helps with tool noise, but it is a nudge, not a budget: it cannot stop
  a session from re-sending its own history.

