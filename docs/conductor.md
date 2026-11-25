# conductor.md — the opencode-factory conductor (authoritative how-to)

This doc routes; the machines enforce. Read it first when a feature starts
(`docs/conductor.md`; `docs/how-factory-works.md` is the architecture map).
When this file and the design spec
(`docs/superpowers/specs/2026-09-22-opencode-factory-design.md`) disagree, the
spec wins; settle it in the bundle repo.

## Roles (spec §4)

Conductor (`factory` skill, thin) → Phase engines (superpowers skills, reused) → State (`bd`, one issue per feature, phase on the issue) → Context (none, no MCP). Beads is the source of truth for phase state, per spec §5.2. The bundle declares no MCP; an empty `--allow` list touches nothing.

## The pipeline (spec §5.1)

| # | Phase | Skill invoked | Gate |
|---|---|---|---|
| 0 | onboard (per repo) | — | — |
| 1 | brainstorm | `brainstorming` | — |
| 2 | spec | `brainstorming` (spec section) | A — human |
| 3 | plan | `writing-plans` | B — human |
| 4 | implement | `executing-plans` or `subagent-driven-development` (method chosen at B) + `test-driven-development` | — |
| 4' | debug (as needed) | `systematic-debugging` | — |
| 5 | verify | `verification-before-completion` | — |
| 6 | review | `requesting-code-review` → `receiving-code-review` | — |
| 7 | ship | `finishing-a-development-branch` + `commit-work` | C — human |
| 8 | close | session-close protocol | — |

4' is not a separate command: the conductor routes failures to debug. Details (the
spec-required "bounded work still writes a spec", and the artifact requirements per
phase): see [docs/negative-results.md](negative-results.md).

## Journey (spec §5.3)

`factory <feature-name>` → 1 brainstorm → 2 spec → GATE A → 3 plan → GATE B →
4 implement → 4' debug → 5 verify → 6 review → 7 ship → GATE C → 8 close.
(The per-phase mapping and the 4' detour: spec §5.3 and §5.4; see the phase
table at the top of this doc and the `status`/`next` commands.)

## Phase entry protocol and enforcement

Every phase: `bd show <id>` or `node <bundle>/scripts/factory-phase.mjs status <bead>`
at entry; the phase machine is the source of truth for state (beads are, per spec §5.2 item 2, so a restarted session resumes where it left off).

1. Read phase state from beads.
2. Verify the prerequisite gate is resolved (A before 3, B before 4, C before 8).
3. Load the mandatory skill for the phase: its SKILL.md content in-session.
4. Run the phase procedure.
5. Record the transition: `factory-phase.mjs enter <bead> <phase> --reason "…"`
   then `complete <phase> --evidence "…"` (phase 5 adds mandatory
   `--ran "<cmd> -> <observed result> at <ISO-8601>" --artifact <path>`).
   Gates resolve with `gate <bead> <A|B|C> --evidence "…"` (spec §5.2 item 5).
6. At each human gate, report the mandatory skills that ran in the phases.

`--evidence` is mandatory on complete. Completing phase 5 additionally requires `--ran` and `--artifact` (see the phase machine section). Run the script with no arguments to see its full surface.

## The phase machine - rules that refuse to be talked out of

`scripts/factory-phase.mjs` is the pipeline's enforcement and fails closed:
an unreadable state, unknown phase, or unresolvable gate means STOP. Exit codes: 0 ok, 1 illegal transition/error, 2 blocked.
Key properties: legality on every transition; entering gate phases creates the
bd gates; `--evidence` mandatory on complete; `--ran` mandatory on phase 5;
phase 2 entry requires a brainstorm artifact; the script says "if the script
refuses you, that is the gate working, not a bug: fix the state or ask the human."
The one flag worth repeating: `complete <bead> 5 --evidence "…" --ran "<cmd> -> <observed> at <ISO-8601>" --artifact <path>`.
Run the script with no args for the full surface; it is the source of truth.
## Before measuring anything: seed a known app

Every number this factory produces is a comparison; use one stable app each time
(seed script in `testapps/`). Numbers measure the app, not the factory — the
feature is absent by construction.

## A check is finished when you have watched it fail

A check that cannot fail is decoration. Run 1 (pass), 2 (break it, it must fail naming the thing), 3 (undo, pass), 4 (record the invocation and output in the commit/bead). This has caught real defects in the phase machine itself. Trap: a clean fixture proves nothing (write with the same tool that reads).

## Which servers this project runs

On start and resume, before anything else, decide the allowlist now — the list
is "the whole truth": every server you do not name is switched off for this
project, and the cost of a wrong pick is a run quietly half-verified. Default:
the project genuinely needs nothing, so run `scope` with no `--allow`. A
web-page project keeps `chrome-devtools`; an API/CLI keeps `--allow` (nothing).
`scope` turns off other servers only for this project and records what was
kept, and `factory-mcp.mjs enable`/`disable <server>` are the only sanctioned
ways to change the state afterwards.

## Cost discipline — the three rules that keep a session affordable

Cost is driven by **turn count**; a session that keeps going pays quadratically.
The rule instead: **hand off when the next step needs something you cannot see**
- a decision you are not authorised to make, a value only the human has, or a
large file where reading it is itself the cost. Measure spend with
`node <bundle>/scripts/measure.mjs` and judge it.

**1. A mandatory handoff.** On handoff: record where things stand
(`factory-phase.mjs handoff <bead> --next "<action>"`), leave the next unit of
work in beads (`bd update <id> --append-notes "next: <action>"`), tell the human
in one line, stop. Corollary: work out of beads, never out of your own
scrollback.

**2. Query `bd ready`, never `bd list`** — gated work reads as ready otherwise
(see [docs/negative-results.md](negative-results.md)).

**3. Subagents return reports, never transcripts.** Delegation trades
probabilities; keep only their contract. Full rules in the
[docs/negative-results.md](negative-results.md) section "Subagent reports".

## Gates A / B / C — HARD STOPS (spec §5.3)

Gates are stops; the conductor waits for the human and nothing advances past a
gate without approval. **They are enforced in the state layer**: entering phases
`2`, `3` or `7` through the phase machine creates a real `bd` gate that blocks
the bead, so `bd ready` reports the feature blocked on every device. Record the
approval with `factory-phase.mjs gate <bead> <A|B|C> --evidence "…"`. A word in
a document is not an approval; a resolved gate is.

- **Gate A — spec approved** (between phases 2 and 3): spec doc exists at
  `docs/superpowers/specs/`; discovery ran (`factory discover`) and was
  reported; the agent human approves.
- **Gate B — plan approved** (between phases 3 and 4): the markdown plan plus
  task breakdown were produced with `writing-plans` and the human approves both
  plan and execution method (`executing-plans` or `subagent-driven-development`).
  Before phase 4 begins, the plan graph is compiled: `factory-plan.mjs
  validate <name>.plan.json`, then `factory-plan.mjs graph <name>.plan.json
  --issue <bead>` so `bd ready` honours the breakdown.
- **Gate C — ship approved** (between phases 7 and 8): verification passed,
  review completed, the branch finished with `finishing-a-development-branch`,
  and commits are made with `commit-work`.

**What the human must actually see at a gate** — before asking: the decisions
(1), what the project commits to (2), what remains open (3). A gate nobody
read is a gate that was never really there (see
[docs/negative-results.md](negative-results.md)).

**Gate C also rules on the running app** — run it, report the URL and command,
show it at real viewports, answer the two provenance questions in prose
("what did they think it was?", "what would two more days be worth?"), then
ask the human to rule.

## The plan ledger — markdown for humans, JSON for beads

The markdown plan (`docs/superpowers/plans/`) is the human record; the
companion `*.plan.json` is the machine graph beads enforce. The factory never
parses the markdown: when Gate B is resolved, compile with
`factory-plan.mjs validate <name>.plan.json` then `factory-plan.mjs graph <name>.plan.json --issue <feature-bead>`,
so `bd ready` honours the breakdown. (Format: `docs/plan-format.md`.)

## Hard skills - the non-negotiable ones

Most skills are optional; a run is still correct if discovery finds none. Hard
skills are required for the pipeline: declared as data in
`skills/catalog.yaml`, the installer puts them on the machine, and the selfcheck
FAILs when one is missing (exit 0 when all present, 1 otherwise).

`factory-skills.mjs` has four commands — `check`, `install`, `record`, plus
no-args surfaces; details in `docs/discovery.md`.

Two ship today, both from softaworks/agent-toolkit:

| Skill | Phase | Why it is hard |
|---|---|---|
| `commit-work` | ship | A reverted squash commit hides the logical unit a reviewer approves. |
| `skill-judge` | discovery | Third-party skills are executable instructions from strangers; grading them before trust is the only non-description check. |

`record` is the one worth remembering: it takes the decision record on stdin and
refuses anything incomplete — "discovery ran and found nothing" is a recorded
answer, never silence. Verify from disk (real SKILL.md on disk), never an
installer's exit code. Details: [docs/negative-results.md](negative-results.md).

## Brainstorm: vision questions + self-research (spec §5.4) + self-research (spec §5.4)

Phase 1 runs two tracks that feed each other:

- **Intent/vision elicitation** — the `brainstorming` skill's question flow: one
  focused question at a time draws out the feature's purpose, who it serves, and
  what success looks like. The answers become the design brief. The cadence
  stays exactly one question per message.
- **The first question is a WHY question (hard rule).** Before *any* how-question
  — no "which database", no "how do we handle X", no "is this in scope" — phase 1
  must ask and **record the answer to** the question a senior engineer asks
  first: *"what is this for, and who is it for?"* Both halves are required:
  the audience named concretely (not "users"), and the specific thing this does
  that the alternative does not.

  This is not a style preference. A run of the factory asked four scope
  questions in its first brainstorm — how are profiles addressed, are social
  icons in scope, what theming, where does it deploy — and answered all four
  well. **All four were how-questions.** Nothing asked why the thing existed,
  so nothing noticed it was a faithful reproduction of a product that already
  ships, and four days of correct work went into it. A brief the human issued
  while still exploring ("reverse engineer X") is a *hypothesis*, not a spec.
  Treating it as a specification is the failure this rule exists to stop.

  **A question is a why-question when it can change whether the feature is
  built at all.** If the answer would be the same either way, it is a how-question
  and it comes second.

  The answer is recorded verbatim in the brainstorm record, above any
  decomposition. It may be short. It may be revised later — but it must exist.
- **Autonomous research** — the system researches on its own, before and during
  the questions: web/technology search and fetch (official docs, ecosystem and
  similar projects, alternatives, prior art, current version landscape), plus
  in-repo exploration. Questions get sharper and design options become
  *informed*, not guessed.
- **Permission gate** — research tools are never used silently. Before the
  first external research action (web search/fetch) the conductor asks the
  human ("may I research this?"). A yes covers the feature's brainstorm; a no
  keeps research to in-repo context only, and the phase still runs.
- **Technology discovery (mandatory sub-step, hard stop before the spec)** —
  phase 1 also answers *"what technology does this feature need, and how do I
  know?"* It runs `factory discover` per `docs/discovery.md` and reports:
  the stack actually in use, the candidates found, and for each one a verdict
  of **adopt** or **reject with a reason**. Proposing new technology requires
  research **with named sources**; a library suggested from memory is a guess
  wearing a citation. Every reject is recorded, because a rejected candidate
  with a stated reason is what stops the next session from re-litigating it.

  **Phase 2 may not begin until this has run and been reported.** The hard stop
  exists because the alternative is worse than a pause: a spec written on
  unexamined assumptions becomes the shared agreement at Gate A, and by then
  the human is approving a premise nobody ever checked. A degraded discovery
  run is *not* a reason to skip it — run it, report `DISCOVERY_DEGRADED` with
  its reason, and let the human decide. See `docs/discovery.md`.

- **MCP audit (part of the same sub-step)** — an enabled MCP server costs
  context on *every* model call, not only when something triggers it, and its
  tools can write to the repo or to production. So before a feature leans on
  one, run `node scripts/factory-mcp.mjs audit` and report what is configured,
  what it costs, and which of it the factory actually verifies. A server the
  feature needs must have completed a real handshake
  (`factory-mcp.mjs handshake --name <server>`), never merely appear in the
  config. If a new server looks like the answer, judge it against
  `docs/mcp-judging.md` and record the verdict, including the rejections.

  **The factory never installs an MCP.** Adding one edits the user's global
  `opencode.json`, which is a larger act than adding a project skill, so the
  agent proposes, judges and records, and the human decides. A degraded audit
  (`MCP_NO_CONFIG`, `MCP_CONFIG_UNREADABLE`, `MCP_NOT_STDIO`,
  `MCP_HANDSHAKE_FAILED`) is reported with its reason, never silently passed.

Interaction model: light research first → sharper opening questions; answers
shape deeper research (follow-ups, docs, comparisons); research produces
informed options, presented alongside the remaining questions and carried into
the spec phase with sources.

Token discipline: research is summarized, never dumped raw; sources are noted
and kept with the design brief for the spec phase.

## Phase state machine rules (spec §5.4)

- Transitions are **monotonic forward** (debug is the in-implement loop);
  each phase verifies the prerequisites (A before 3, B before 4, C before 8).
- Entry reads phase state from beads at every entry, so a restarted session
  or a different device resumes where it left off.

## Code navigation (no MCP required)

This doc routes; the code's own modules are the answer. The bundle carries no
graft index and no MCP dependency; `grep`, `glob` and `read` (or the language's
index) are the navigation tools. The full measurement of the old instrument and
why it was removed is in [docs/negative-results.md](negative-results.md) (see
"Code navigation (no MCP required)" below), including the one entry that moved
with it.

## Command reference (spec §5.4, §7, §8)

The one-line router list lives here: `factory <feature>`, `factory phase`,
`factory discover`, `factory mcp audit` / `enable` / `disable` / `handshake`,
`factory onboard`, `factory selfcheck --tokens` (loads: it prints the loaded
footprint per skill description size; spec §8). Details, per command, are
elsewhere in this doc or in the specs (§5.2/§5.4); the phase machine (`status`,
`next`) is its own section above.

## Skill discovery — `factory discover`

On demand, idempotent, deduped, locked. Project-installed skills are committed to the repository. Record the choice with `bd update <id> --append-notes "skills: <name>@<version> <source>"`; `factory-skills.mjs record` writes the machine graph after Gate B; if every candidate source fails (no skills.sh, API/site unreachable, catalog empty) the run is `DISCOVERY_DEGRADED` — recorded, never a silent default.
## Context economy (spec §8) — everything is pull, never push

- `catalog.yaml` and `skills.lock.json` are **never in the conversation
  context**; opened only while `factory discover` runs.
- A repo already in the lockfile skips discovery; lookups happen only when a
  new stack/feature trigger an unknown technology.
- Skill bodies enter context only on invocation. The conductor `SKILL.md` stays
  thin (description only); this doc is read on demand.
- `factory selfcheck --tokens` reports the loaded footprint so it stays
  visible and cheap.
