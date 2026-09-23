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
