# conductor.md — the opencode-factory conductor (authoritative how-to)

This is the operating manual for the `factory` skill. The skill's `SKILL.md` is
intentionally thin (description only); the conductor's actual logic lives here,
read on demand. Everything below is transcribed from the factory's own design
spec (§4–§8), kept in the bundle repo at
`docs/superpowers/specs/2026-09-22-opencode-factory-design.md` as build
reference — it is not installed on machines. When this file and that spec
disagree, the spec wins; settle the disagreement in the bundle repo.

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
| 7 | ship | `finishing-a-development-branch` + `commit-work` | **C — human** |
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
  → 3 plan                         # writing-plans → plan doc + task breakdown
                                   #   + <plan>.plan.json (the machine graph)
  → GATE B                         # human approves plan + execution method ── STOP, wait
  → 4 implement                    # TDD; beads-task-agent subagents; graft navigation
  → 4' debug (routed on failure)   # systematic-debugging
  → 5 verify                       # verification-before-completion (evidence gate)
  → 6 review                       # requesting/receiving code review
  → 7 ship                         # finishing-a-development-branch + commit-work
  → GATE C                         # human approves ship  ── STOP, wait
  → 8 close                        # bd update, session-close protocol
```

## Phase entry protocol and enforcement (spec §5.2)

For every phase after onboard:

1. **Read phase state from beads first**: `bd show <id>` at every entry, so a
   restarted session or a different device resumes where it left off. Better:
   `node <bundle>/scripts/factory-phase.mjs status <bead>` reads the recorded
   phase *and* the pending gates in one call. For *choosing* what to work on
   next use `bd ready`, never `bd list` — the difference is load-bearing, see
   "Cost discipline" below.
2. **Verify the prerequisite gate** (A before 3, B before 4, C before 8). This
   is enforced, not remembered — see "The phase machine" below.
3. **Load the mandatory skill's content in-session.** Each phase begins with
   the literal instruction: *"Invoke skill X now and follow it."* A phase
   cannot be marked complete until skill X's content was loaded in-session —
   verify the model actually has the skill content, not just the name.
4. **Run the skill's procedure** for this phase.
5. **Record the transition with the phase machine**, not with free-text notes:
   `node <bundle>/scripts/factory-phase.mjs enter <bead> <phase> --reason "…"`
   then `complete <bead> <phase> --evidence "…"`. The `--reason` becomes an
   append-only event bead, so the audit survives restarts and device moves
   (Dolt) — and an illegal transition is refused outright. Completing phase 5 (verify) additionally requires `--booted "..."` — see the phase machine section for why, and for the format limits.
6. At each human gate, **report which mandatory skills ran per phase**. Any
   skipped skill forces the phase to re-run before the gate can pass.

## The phase machine - rules that refuse to be talked out of

`scripts/factory-phase.mjs` is the pipeline's enforcement. It reads the same
phase table documented above, and it **fails closed**: an unreadable state, an
unknown phase, or a gate it cannot evaluate means STOP. That is deliberate. The
gaps it closes were not hypothetical - a session once read the words
"GATE A approved" out of a plan file and began implementing on the strength of
prose, and bd reported no gates at all afterwards.

**Run the script with no arguments to see its command surface; that output is
the source of truth, and this document deliberately does not restate it.** The
one form worth repeating here is the one with a flag that is easy to miss:

```
node <bundle>/scripts/factory-phase.mjs complete <bead> 5 --evidence "…" --booted "…"
```

Exit codes: **0** ok · **1** illegal transition or error · **2** blocked, a
human gate is still pending.

Seven properties worth relying on:

- **Legality is checked on every transition, including the first.** A bead with
  no recorded phase may enter `0` or `1`; it may not jump to `5`.
- **Entering a gate-bearing phase creates that gate** in bd and records its id
  on the bead, so `bd ready` withholds the next phase from every other session
  on every device. The gate is no longer a sentence in a document.
- **`--evidence` is mandatory on complete.** Completion has to be checkable
  rather than asserted, which is the difference MAST's "not recognizing
  completion" failures actually turn on.
- **`--booted` is mandatory on completing phase 5 (verify).** A green test suite
  is not a running app, and a real run reached 22 tasks with every gate passing
  while nobody had ever started the thing. The `verify-app` skill generates the
  per-project, committed way to drive it (a feature map plus Launch / Doctor /
  Drive / Evidence / Cleanup); run it at phase 1 and its claim here becomes
  checkable instead of asserted. Record what you started, what you drove, and
  where the evidence is: `--booted "verify-app: drove export, evidence at
  .verify/2026-10-09.md"`. It is
  written to the state layer *before* `phase_done`, so a claim that cannot be
  recorded leaves the machine correctly refusing to advance. Under 255
  characters, no double quotes (bd's argument parser splits on them); the script
  refuses rather than truncating, because half a boot claim is worse than none.
- **The `verify-app` skill makes that claim re-checkable.** `--booted` proves the
  app answered once. `verify-app` writes a per-project skill - committed, so every
  person and every agent drives the app the same way - naming the launch command,
  the selectors, the features, and where evidence lands. Generate it at phase 1,
  before there is anything to verify.
  The machine cannot tell whether the claim is *honest* - that stays a human
  judgement at Gate C - but it does make the claim impossible to skip.
- **Entering phase 2 (spec) requires a brainstorm to exist.** A real run produced
  no brainstorm at all - the string appears nowhere in the project - and the spec
  was written anyway, resting on nothing. `ARTIFACTS` in the script maps a phase
  to the artifact it depends on; entering a phase whose artifact is missing is
  refused and the refusal names the file and the directory it looked in.
- **`status` reports staleness.** It reads the issue's own `updated_at` and
  reports `idle:` days, flagging a run as stale at 3 days idle while its current
  phase is unfinished. This is a REPORTING threshold, never an enforced one - it
  can only change what you see, never stop you - which is why a number belongs
  here and did not belong on the handoff rule. It exists because a machine that
  only speaks when spoken to cannot notice it has been abandoned: one real run
  sat in implement for ten days with every guard in this file still working and
  nobody having asked any of them a question. Run `factory-phase.mjs status
  <bead>` before you trust that a run is moving.
- **`status` flags a `repair_done` record that outlived its phase.** bd 1.3.0
  offers no way to unset a dimension, so a completed debug detour can still read
  as standing state after the run has returned to implement. It is reported as
  incoherent rather than cleared, and it does not block anything.

If the script refuses you, that is the gate working, not a bug to route
around. Fix the state or ask the human — do not start writing files anyway.

## Cost discipline — the three rules that keep a session affordable

A real factory run produced **78.3M tokens in a single session**: 955 turns,
~63 hours, context climbing 39k → 113k and peaking at 191k, never once dropping.
The work it did was good. The session shape was the failure. Three rules prevent
it, and none of them is "be more careful" — each is mechanical, and each exists
because the softer version was already tried and did not hold.

### 1. A mandatory handoff, with no turn count attached

Cost is driven by **turn count**, not by how much any single turn says. Turn N
re-sends every turn before it, so a session that simply keeps going pays
quadratically. That is why the 78M run's context never came back down.

**There is deliberately no turn number here.** An earlier version said 100, then
30; both were guesses from a single observed run, and a number like that gets
treated as a threshold whether or not it is one. A budget set too low causes
*premature handoff* - a failure mode the factory did not otherwise have - so
trading a real risk for a precise-looking fiction is a bad trade. The rule is
instead: **hand off when the next step needs something you cannot see** - a
decision you are not authorised to make, a value only the human has, a file large
enough that reading it is itself the cost. Measure your own spend with
`node <bundle>/scripts/measure.mjs` and judge it. Reaching that point is not a
suggestion to push on. It is a handoff:

1. Record where things stand — `node <bundle>/scripts/factory-phase.mjs handoff <bead> --next "<action>"`
   (which writes `bd set-state` and the next action for you).
2. Leave the next action **in beads, not in your context** — create or update the
   next unit of work and `bd update <id> --append-notes "next: <action>"`.
3. Tell the human in one line: what is done, what is next, what is blocked.
4. Stop.

A fresh session resumes with roughly 20k of context instead of 190k. The budget is
soft in one direction only: **hand off early at a phase boundary even if you are
well under it**, because a handoff is where the state becomes durable rather than
merely remembered. A session that is stuck should also hand off early and say
what it is stuck on — a stuck session that keeps talking is precisely the failure
this rule exists to stop.

Corollary: **work out of beads, never out of your own scrollback.** The next
session has no memory of this one, so anything that matters must already be in
beads before you stop.

**A claim is the mechanism, so a runaway cannot hide.** When you start work on a
bead, `bd update <id> --claim` takes a lease on it, and `bd heartbeat <id>`
keeps that lease alive. Two properties make this worth the two commands:

- A session that dies — crashes, closes its laptop, gets killed — simply stops
  heartbeating. Its lease goes stale, and `bd reclaim` returns the bead to
  ready. **The runaway is then detectable without reading a single token
  count**, which is the whole point: you cannot see cost from inside a session
  that is happily spending it.
- `bd heartbeat` on a reclaimed bead *fails*, so a session that has been
  overtaken learns to stop instead of continuing to write.

So a handoff is a release: `bd unclaim <id>` (or closing the bead) tells the
next session the work is genuinely free, rather than leaving the previous
owner holding it until a lease expires.

### 2. Query `bd ready`, never `bd list`

When choosing what to work on next — next task, next feature, what is unblocked —
use **`bd ready`**.

**`bd list` will hand you gated work.** It does not render the blocked state: a
gated issue still shows up as ordinary open work. `bd ready` is the only query
that respects gates. Verified on bd 1.3.0 — create a gate and `bd ready` reports
*"No ready work found (all issues have blocking dependencies)"*; resolve the gate
and the work appears. A conductor that selects work with `bd list` will cheerfully
start a feature whose Gate A is still waiting on a human.

### 3. Subagents return reports, never transcripts

Every `task` (subagent) and `skill` (skill load) output is **protected from
context pruning** — it is kept, in summary form, for the remainder of the
session. So the more the factory delegates, the more unprunable content it
carries, and every bit of it is re-sent on every subsequent turn.

Therefore: **keep a subagent's report, not its output.** The subagent writes up
findings, changed files, verification evidence and open questions; the
orchestrator reads that report. Do not ask a subagent to re-emit its transcript,
and do not go back and re-read a subagent's raw output to double-check it — the
report *is* the contract, and treating it as a summary to be second-guessed is how
a cheap delegation turns into permanent context tax.

This is the same lever as delegation itself: a fresh subagent context is ~20k, a
saturated orchestrator is ~190k, and the difference is paid on every turn after.

### What context pruning does and does not do for you

Automatic pruning on the machine is real and it does help — it removes repeated
tool results and the oversized payloads of failed builds and failed test runs,
none of which need anyone's cooperation. But it is a **nudge channel, not a
budget**: it can only ask the model to compress stale context, and on the 78M run
it asked five times and was ignored five times. Pruning cannot remove the fact
that turn N re-sends turn N−1.

So pruning sits **under** these three rules as a safety net, never as a
substitute for them. If it is not visibly working, say so out loud — never let it
become the reason a session is allowed to run long.

## Gates A / B / C — HARD STOPS (spec §5.3)

Gates are genuine stops in the pipeline, not checkboxes. The conductor waits
for the human; nothing advances past a gate without approval.

**They are enforced in the state layer, not just described here.** Entering
phase `2`, `3` or `7` through the phase machine creates a real `bd` gate
(`--type human`) that blocks the bead, so `bd ready` reports the feature as
blocked on every device. Ask the human, then `bd gate resolve <gate-id>` — and
only then can the next phase be entered. A word written in a document is not an
approval; a resolved gate is.

- **Gate A — spec approved** (between phase 2 and phase 3): the spec doc
  exists at `docs/superpowers/specs/`, `brainstorming` (spec section) ran and
  is reported, the technology-discovery sub-step of phase 1 completed and was
  reported, and the human approves the spec. If skipped skills were
  reported at the gate, the spec phase re-runs first.
  **Gate A re-opens if the stack changes.** A spec approved against a stack
  that discovery later contradicts — a library the human approved is not
  maintained, the chosen approach is no longer supported, or phase 3 turns
  up a dependency the spec never mentioned — is no longer the spec that was
  approved. Re-open A, re-run discovery, and get the change re-approved rather
  than quietly implementing around it. The cost of a re-opened gate is one
  conversation; the cost of skipping it is a feature built on a premise the
  human already rejected.
- **Gate B — plan approved** (between phase 3 and phase 4): the plan doc and
  task breakdown were produced with `writing-plans`, the execution method was
  chosen (B decides between `executing-plans` and
  `subagent-driven-development`), and the human approves plan + method. After B,
  apply the plan graph so the approved task breakdown becomes the ledger (see
  "The plan ledger" below) — before entering phase 4.
- **Gate C — ship approved** (between phase 7 and phase 8): the ship criteria
  are met — verification passed (`verification-before-completion`, the
  evidence gate), review completed (`requesting-code-review` then
  `receiving-code-review`), the branch was finished with
  `finishing-a-development-branch`, and the commits were made with
  `commit-work` — and the human approves the ship.

**No implementation files before spec AND plan approval.** Gates A and B are
hard human gates before any implementation; the plan is shared mutable state
between human and agent.

## The plan ledger — markdown for humans, JSON for beads

A plan has two halves and neither replaces the other. The markdown plan
(`docs/superpowers/plans/`) is the human record you read in a review. The
companion `*.plan.json` is the machine graph, and it is the half beads can
enforce: dependencies, acceptance criteria, `bd lint` completeness.

**The factory never parses the markdown.** Headings get reworded mid-review and
tables get reformatted, so a markdown parser loses tasks quietly — a plan that
still reads perfectly to a human while phase 4 finds three of its tasks have
disappeared.

Once Gate B is resolved, compile the graph before entering phase 4:
`factory-plan.mjs validate <name>.plan.json`, then
`factory-plan.mjs graph <name>.plan.json --issue <feature-bead>`. Run the
script with no arguments for its full surface.

This is what stops beads being decoration. A feature that leaves phase 3 with
two issues against a 7,476-line plan has a progress nobody can query. With the
graph applied, `bd ready` answers "what can I work on right now" with
dependencies honoured, and every task carries its own acceptance criteria.

The compiler refuses two things on your behalf. A field bd would **silently**
drop — a task whose acceptance criteria quietly vanish is how work ships
undefined. And a re-apply, because `bd create --graph` is not idempotent: the
plan is fingerprinted and a second application exits `2` rather than creating a
second set of issues. The format, every field bd accepts and the ones it drops,
is in `docs/plan-format.md`.

## Hard skills - the non-negotiable ones

Most skills are *optional*: discovery may install them if a feature fits, and
the run is still correct if none are found. Hard skills are different. They are
required for the pipeline to work at all, they are declared as data in
`skills/catalog.yaml`, the installer puts them on the machine, and **the
selfcheck FAILs when one is missing** — not warns. A hard skill reported as a
WARN is just a suggestion wearing a warning's clothing, and this bundle has
already shipped that defect once.

`factory-skills.mjs` has four commands — `check` (exit 0 when every mandatory
skill is on disk, 1 when one is missing or the catalog is unreadable),
`install`, and `record`. Run it with no arguments for its surface.

`record` is the one worth remembering: it takes the decision record on stdin
(`factory-skills.mjs record < record.json`) and **refuses anything
incomplete**, which is what makes "discovery ran and found nothing" a recorded
answer rather than a silence.

Two ship today, both from `softaworks/agent-toolkit`:

| Skill | Phase | Why it is hard |
|---|---|---|
| `commit-work` | **7 ship** | The commit is the artifact a reviewer reads first. Splitting it properly and writing a message that says what changed and why is not something to be improvised at the end of a long session, and a rushed squash-commit hides exactly the logical unit the human is approving at Gate C. It runs beside `finishing-a-development-branch`. |
| `skill-judge` | discovery | A third-party skill is executable instructions from a stranger. Grading it against a rubric — before it is trusted with a phase — is the only check that is not "it looked fine in the description". |

**Official-origin-first.** When a mandatory skill exists from the vendor who
owns the thing it teaches, that one is used and a community equivalent is
rejected with a recorded reason. A maintained upstream skill gets security
fixes and breaking-change notes; a fork does not. Prefer the boring canonical
source over the cleverer copy.

**A candidate below grade C is rejected, not installed.** `skill-judge` scores
120 points across 8 dimensions. Anything under **C (70/120)** does not get
installed, and the score plus the reason go into the project record. This is a
floor, not a ranking: a 70 that is *the only* option is still a no, because a
mediocre instruction set is worse than none — the phase engine already covers
the competent case, and a weak skill actively misdirects.

The catalog is **data, and it never installs anything by being read**. The
parser is deliberately strict — it throws on an unknown version, an unknown
top-level key, a mis-indented entry or anything else it does not understand,
because a permissive parser turns a typo into a silently empty list, and an
empty mandatory list means "nothing is required", which is the most dangerous
possible failure for this file.

Verify from disk, never from an installer's exit code: the CLI printing a
success banner is not evidence, the `SKILL.md` being on disk is. That is why
`check` looks for a real `SKILL.md` file rather than trusting a directory name
(an interrupted install can leave a directory behind and look complete).

## Brainstorm: vision questions + self-research (spec §5.4) + self-research (spec §5.4)

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
| `measure` (`scripts/measure.mjs`) | Token spend for a project, split into **orchestrator** vs **subagent** sessions, reported as input and cache-read separately (a cache read is roughly a tenth of a fresh input token, so collapsing the two makes a session that re-read the same context look like one that consumed it). The split exists because the cost problem lives on the orchestrator side, not the subagent side. This is a **report, not a gate** — it blocks nothing. The turn budget is a judgement you make with this number in front of you. |
| `factory mcp audit` | Inventory the configured MCP servers: owner (bundle or the user), live or disabled, whether each needs a credential, and the context it injects into every model call. Read-only; it never edits the config. |
| `factory mcp enable` / `disable <server>` | Connect or disconnect one server **for this project only**, writing `mcp.<server>.enabled` into the project's `opencode.json`. Never the global config: a global toggle changes every project on the machine, including ones somebody is working in right now. Refuses when there is no project (no `.git` above the working directory). The write is verified by re-reading the file and rolled back if it cannot be, and the output says a restart is needed — because a toggle that appears to work and silently does not is worse than none. |
| `factory mcp handshake` | Spawn a local stdio server and speak the real protocol, proving it answers rather than assuming it. See `docs/mcp-judging.md`. |
| `factory onboard` | Per-repo one-time check: `bd init` if no beads DB, `graft build` if no graph **or the graph is empty (0 nodes — an empty `wiring.json` counts as "no graph"**, same rule as phases 4/4' freshness), then `factory discover`. Auto-offered when the conductor starts in a repo without state. The graph is rebuilt again whenever phases 4/4' find it empty or stale (see "Graft context freshness"). |
| `factory selfcheck` | Environment health (from the spec's verification section): plugins load, the graft MCP completes a real handshake (serverInfo, the tool list, and the instructions it injects into every call; 0 tools is a legitimate state, not a failure), `bd version` and `graft --version` resolve, and every mandatory phase skill is discoverable. `--tokens` adds a per-skill description-size + total loaded-footprint report — the **required** flag for keeping the loaded footprint visible, plus the current orchestrator session's own input and cache-read spend (the number the turn-budget decision in "Cost discipline" is actually made against) (spec §8). |

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
   relevance threshold, or not expected to be invoked; `skills-lock.json` is
   the dedupe authority and enables deterministic reinstalls. **Every run —
   including one that installs nothing — must end by writing
   `.agents/skills/skills.lock.json`** with an `installed` array and a `run`
   record (`keywords`, `sources`, `degraded`, `degraded_reason`). Write it with
   `factory-skills.mjs record`, which refuses an incomplete record and stamps
   `run.at` itself; see `docs/discovery.md` for the schema.
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
