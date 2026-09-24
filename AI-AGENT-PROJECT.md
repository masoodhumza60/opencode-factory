# AI Agent Project Setup — use opencode-factory in a project

Use this when the **machine is already factory-ready** (beads + graft +
plugins + the `/factory` commands were installed once via
[`AI-AGENT-SETUP.md`](AI-AGENT-SETUP.md)) and you want to run the factory in a
specific project folder — new or existing.

Give the prompt below to an AI coding agent (OpenCode) running with that
project as its working directory. The agent first verifies the machine is
ready, then stamps the project (state only — never your source code), then
runs your feature through the full pipeline.

## How to use

1. The machine must already have the factory installed (once per device).
   If it does not, do that first:
   `clone https://github.com/masoodhumza60/opencode-factory and paste the
   prompt in AI-AGENT-SETUP.md`.
2. Open a new OpenCode session **in the project folder** you want the feature in.
3. Paste the prompt below.
4. Reply to the three gates as they come: spec (A), plan (B), ship (C).
   The factory stops and waits at each one — that is the design.

## The prompt

```
Set up the opencode factory in THIS project and run a feature.

THE RULES FIRST:
- Only run these commands if your shell runs on MY computer. No local shell
  (cloud sandbox or chat app)? STOP — give me the README instead.
- Setup NEVER modifies source code. /factory onboard writes only state files:
  .beads/, the graft graph, and .agents/skills/skills.lock.json.
- Never ask for or echo API keys — none are needed here.

PART 0 — make sure this machine actually has the factory installed
1. Verify you have the /factory commands (onboard, selfcheck, feature) and that
   `factory selfcheck` can run (bd and graft on PATH).
2. Machine NOT ready (commands missing, bd/graft absent, selfcheck never ran)?
   STOP — do not fake it, do not proceed. I must first run the one-time machine
   setup: clone https://github.com/masoodhumza60/opencode-factory and paste the
   prompt from AI-AGENT-SETUP.md. This project gets its state only after the
   machine has beads + graft + the plugins + the /factory commands.

PART 1 — stamp this project (state only, never source)
3. Run /factory onboard. It is additive and idempotent:
   - beads database: create if none, otherwise reuse (report the repo id/DB)
   - graft code graph: build if missing or empty
   - .agents/skills/skills.lock.json: ALWAYS written — a real outcome record.
     If every discovery source fails, record DISCOVERY_DEGRADED loudly; never
     default silently to "no project skill needed".
4. Run /factory selfcheck --tokens in this project: expect 6 PASS + no WARNs.
   (WARNs that existed before onboard — empty graft graph / missing lockfile —
   must be gone after step 3.) Fix anything that FAILs and re-check.

PART 2 — run the feature through the whole pipeline
5. Run /factory feature <description>:
   brainstorm (one question at a time; ask permission before any web research)
   → spec → GATE A (wait for my approval)
   → plan → GATE B (wait for my approval + execution method)
   → TDD implement with the debug loop (systematic-debugging; check/rebuild the
   graft graph at implement/debug entry)
   → verify → review → ship → GATE C (I choose: merge / push PR / keep)
   Record every phase transition in beads as:
   bd update <feature-id> --append-notes "phase:<name> ✓ <skill>"

PART 3 — report back
6. What /factory onboard stamped (beads created vs reused, graft node count,
   lockfile written), the selfcheck result, and the feature's outcome. If
   anything is unfinished, give me the exact next command.
```

## What it does, step by step

| Step | Action |
|---|---|
| Part 0 | Agent proves the machine is factory-ready — or stops and routes you to `AI-AGENT-SETUP.md` first |
| Part 1 | `/factory onboard` stamps the project (beads DB, graft graph, skill lockfile) — source untouched |
| — | `/factory selfcheck --tokens` — all PASS, no WARNs |
| Part 2 | `/factory feature <description>` — full pipeline, gates A/B/C |
| Part 3 | Report: stamped state + feature outcome |

Setup is additive and per-project; the machine install stays one-time. If you
haven't set up the machine yet, do `AI-AGENT-SETUP.md` **first** — this prompt
cannot run before the factory exists on the machine.