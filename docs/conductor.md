# conductor.md — the opencode-factory conductor (authoritative how-to)

This is the operating manual for the `factory` skill. The skill's `SKILL.md` is
intentionally thin (description only); the conductor's actual logic lives here,
read on demand. Everything below is transcribed from the binding design spec
(`docs/superpowers/specs/2026-09-22-opencode-factory-design.md`, §4–§8). When
this file and the spec disagree, the spec wins.

## Roles (spec §4)

Four layers, each with one clear job:

| Layer | Component | Job |
|---|---|---|
| **Conductor** | `factory` skill (thin) | Phase machine + gates + skill enforcement |
| **Phase engines** | superpowers skills (reused) | Phase procedures (brainstorm, plan, TDD, debug, verify, review, ship) |
| **State** | beads (`bd` CLI + Dolt DB) | One issue per feature; phase stored on the issue; audit log; durable across sessions/devices |
| **Context** | graft (MCP, code graph) | Fast navigation during plan/implement/debug |

Role boundaries:

- The conductor is **thin**: a small `SKILL.md` (description only) plus bundled
  docs it reads while running. It does not reimplement any phase procedure.
- beads is the **source of truth for phase state**, not a to-do list — one
  issue per feature, `phase:<name>` stored on the issue, `bd prime` output
  pushed into every model call by the opencode-beads plugin.
- graft never reads markdown/skills; its job is code structure (stack
  detection, navigation) only.

## The pipeline (spec §5.1)

| # | Phase | MUST invoke skill | Gate |
|---|---|---|---|
| 0 | onboard (per repo, auto-offered) | — | — |
| 1 | brainstorm | `brainstorming` | — |
| 2 | spec | `brainstorming` (spec section) | **A — human** |
| 3 | plan | `writing-plans` | **B — human** |
| 4 | implement | `executing-plans` *or* `subagent-driven-development` (method chosen at B) + `test-driven-development` per feature/bug | — |
| 4' | debug (as needed) | `systematic-debugging` | — |
| 5 | verify | `verification-before-completion` | — |
| 6 | review | `requesting-code-review` → `receiving-code-review` | — |
| 7 | ship | `finishing-a-development-branch` | **C — human** |
| 8 | close | session-close protocol | — |

4' is not a separate command — the conductor routes any bug/test failure into
the debug phase with `systematic-debugging` before fixes are allowed (no
ad-hoc fixes).

## Journey (spec §5.3)

```
factory <feature-name>            # create beads issue, start phase 1
  → 1 brainstorm                   # brainstorming skill: vision questions + own research
  → 2 spec                         # spec doc → docs/superpowers/specs/
  → GATE A                         # human approves spec  ── STOP, wait
  → 3 plan                         # writing-plans → plan doc, task breakdown
  → GATE B                         # human approves plan + execution method ── STOP, wait
  → 4 implement                    # TDD; beads-task-agent subagents; graft navigation
  → 4' debug (routed on failure)   # systematic-debugging
  → 5 verify                       # verification-before-completion (evidence gate)
  → 6 review                       # requesting/receiving code review
  → 7 ship                         # finishing-a-development-branch
  → GATE C                         # human approves ship  ── STOP, wait
  → 8 close                        # bd update, session-close protocol
```

## Phase entry protocol and enforcement (spec §5.2)

For every phase after onboard:

1. **Read phase state from beads first**: `bd show <id>` at every entry, so a
   restarted session or a different device resumes where it left off.
2. **Verify the prerequisite gate** (A before 3, B before 4, C before 8).
3. **Load the mandatory skill's content in-session.** Each phase begins with
   the literal instruction: *"Invoke skill X now and follow it."* A phase
   cannot be marked complete until skill X's content was loaded in-session —
   verify the model actually has the skill content, not just the name.
4. **Run the skill's procedure** for this phase.
5. **Record the transition in beads**, the audit format:
   `bd update <feature-id> --append-notes "phase:<name> ✓ <skill>"`
   (the audit survives restarts and device moves — Dolt).
6. At each human gate, **report which mandatory skills ran per phase**. Any
   skipped skill forces the phase to re-run before the gate can pass.

## Gates A / B / C — HARD STOPS (spec §5.3)

Gates are genuine stops in the pipeline, not checkboxes. The conductor waits
for the human; nothing advances past a gate without approval.

- **Gate A — spec approved** (between phase 2 and phase 3): the spec doc
  exists at `docs/superpowers/specs/`, `brainstorming` (spec section) ran and
  is reported, and the human approves the spec. If skipped skills were
  reported at the gate, the spec phase re-runs first.
- **Gate B — plan approved** (between phase 3 and phase 4): the plan doc and
  task breakdown were produced with `writing-plans`, the execution method was
  chosen (B decides between `executing-plans` and
  `subagent-driven-development`), and the human approves plan + method.
- **Gate C — ship approved** (between phase 7 and phase 8): the ship criteria
  are met — verification passed (`verification-before-completion`, the
  evidence gate), review completed (`requesting-code-review` then
  `receiving-code-review`), the branch was finished with
  `finishing-a-development-branch` — and the human approves the ship.

**No implementation files before spec AND plan approval.** Gates A and B are
hard human gates before any implementation; the plan is shared mutable state
between human and agent.

## Brainstorm: vision questions + self-research (spec §5.4)

Phase 1 runs two tracks that feed each other:

- **Intent/vision elicitation** — the `brainstorming` skill's question flow: one
  focused question at a time draws out the feature's purpose, who it serves, and
  what success looks like. The answers become the design brief. The cadence
  stays exactly one question per message.
- **Autonomous research** — the system researches on its own, before and during
  the questions: web/technology search and fetch (official docs, ecosystem and
  similar projects, alternatives, prior art, current version landscape), plus
  in-repo exploration. Questions get sharper and design options become
  *informed*, not guessed.
- **Permission gate** — research tools are never used silently. Before the
  first external research action (web search/fetch) the conductor asks the
  human ("may I research this?"). A yes covers the feature's brainstorm; a no
  keeps research to in-repo context only, and the phase still runs.

Interaction model: light research first → sharper opening questions; answers
shape deeper research (follow-ups, docs, comparisons); research produces
informed options, presented alongside the remaining questions and carried into
the spec phase with sources.

Token discipline: research is summarized, never dumped raw; sources are noted
and kept with the design brief for the spec phase.

## Phase state machine rules (spec §5.4)

- Phase transitions are **monotonic forward** (with `debug` as an in-implement
  loop).
- Each transition verifies the prerequisite gate (A before 3, B before 4, C
  before 8).
- The conductor reads phase state from beads (`bd show <id>`) at every entry,
  so a restarted session or a different device resumes where it left off.

## Graft context freshness (enforced)

Graft is the code-structure context for phases 4 (implement) and 4' (debug).
A stale or empty graph is never trusted silently:

1. On entry to phase 4 or 4': **check freshness first** — `graft_check_freshness`
   when the MCP tool is available; otherwise compare the graph's build time
   against the newest file mtime, or treat a missing/empty graph as stale.
2. Graph empty or stale → run `graft build`, then record:
   `bd update <id> --append-notes "graft: rebuilt (N nodes)"`.
3. Graph fresh → record: `bd update <id> --append-notes "graft: fresh"`.
4. Rebuild fails → **degrade loudly, never silently**: record
   `bd update <id> --append-notes "graft: degraded <reason>"`, fall back to
   direct file navigation for that phase, and surface the note at the next gate.
   An empty graph is never treated as "no context needed".

Selfcheck warns on an empty graph (`WARN graft graph has 0 nodes`), so the gap
is visible in the repo before a phase relies on it.

## Command reference (spec §5.4, §7, §8)

| Command | What it does |
|---|---|
| `factory <feature>` | New feature: creates the beads issue, records `phase:brainstorm`, invokes `brainstorming`. |
| `factory phase <name>` | Advance phase, enforce the skill gate, record the transition in beads. |
| `factory discover` | Run the skill-discovery flow (below); idempotent. |
| `factory onboard` | Per-repo one-time check: `bd init` if no beads DB, `graft build` if no graph, then `factory discover`. Auto-offered when the conductor starts in a repo without state. The graph is rebuilt again whenever phases 4/4' find it empty or stale (see "Graft context freshness"). |
| `factory selfcheck` | Environment health (from the spec's verification section): plugins load, graft MCP handshake returns its tools, `bd version` and `graft --version` resolve, and every mandatory phase skill is discoverable. `--tokens` adds a per-skill description-size + total loaded-footprint report — the **required** flag for keeping the loaded footprint visible (spec §8). |

## Skill discovery — `factory discover` (spec §7)

Pull-only, on demand, deduped, and locked. Idempotent.

1. **Detect context** — read the repo stack directly: `package.json` /
   `go.mod` / top import lines for language/ecosystem terms. Graft `find_all`
   may AUGMENT these keywords only when its graph is known non-empty (check
   freshness first — an empty graph contributes nothing). Feature-request
   keywords at `factory <feature>` time are always considered.
2. **Find candidates** — query skills.sh for matching skills. Fallback: the
   `find-skills` skill or web search; the same ranking applies.
3. **Rank** — 1. best keyword fit for the *actual* work, 2. official/verified
   origin, 3. most-used/most-liked.
4. **Install project-locally** — `.agents/skills/<name>/`. Project-installed
   skills are **committed to the repository** (they travel with the project).
5. **Record the choice** —
   `bd update <id> --append-notes "skills: <name>@<version> <source>"`.
6. **Dedupe** — skip if already in global or project skills, below the
   relevance threshold, or not expected to be invoked; `skills.lock.json` is
   the dedupe authority and enables deterministic reinstalls. **Every run —
   including one that installs nothing — must end by writing/updating
   `.agents/skills/skills.lock.json`** with an `installed` array and a `run`
   record (`at`, `keywords`, `sources`, `degraded`, `note`); see
   `docs/discovery.md` for the schema.
7. **Fail loudly** — if EVERY candidate source fails (skills.sh CLI absent,
   API/site unreachable, search unavailable, catalog empty), the run is
   `DISCOVERY_DEGRADED`: record it in the lockfile (`degraded: true` + reason)
   and as `bd update <id> --append-notes "skills: DISCOVERY_DEGRADED <reason>"`.
   Never default to "no project skill needed" as a silent fallback — that
   verdict is only valid after a non-degraded run.

Install modes:

- **Full** — high-fit skill copied into the project; OpenCode lazily loads it
  only when invoked (its SKILL.md is never in the context until then).
- **Reference stub** — a ~5-line `SKILL.md` ("for `<topic>` load the full skill
  at `<source>`"); content fetched only when the topic actually comes up.

Skill relationships live in the data, not an engine: a flat `catalog.yaml`
(topics → ranked candidates) maps discovery; graft parses code (not markdown)
and beads tracks tasks. Neither stores skill relationships.

## Context economy (spec §8) — everything is pull, never push

- `catalog.yaml` and `skills.lock.json` are **never in the conversation
  context**; opened only while `factory discover` runs.
- A repo already in the lockfile skips discovery; lookups happen only when a
  new stack/feature trigger an unknown technology.
- Skill bodies enter context only on invocation. The conductor `SKILL.md` stays
  thin (description only); this doc is read on demand.
- `factory selfcheck --tokens` reports the loaded footprint so it stays
  visible and cheap.
