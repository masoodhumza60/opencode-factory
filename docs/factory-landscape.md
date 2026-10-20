# The factory landscape — what other people built, and what we should copy

**Status:** research note. Not implemented, not current behaviour.
**Date:** 2026-10-20.
**Method:** GitHub repository search plus direct README/spec fetches. The
`websearch` integration returned no results for every query, so every claim
below comes from a repository we read, not from a blog post about it.

The purpose of this note is narrow. We already have a target model
(`factory-v2-model.md`), a gap analysis (`factory-gap-analysis.md`) and a
roadmap (`factory-roadmap.md`). This note answers one question:

> Other people have already built software factories. Which of their
> **mechanisms** are we missing, and which are we right to leave alone?

---

## 1. What we looked at

| Repository | ★ | Licence | What it is | Why it matters to us |
|---|---:|---|---|---|
| `gemini-cli-extensions/conductor` | 3.7k | — | Spec-Driven Development plugin: Context → Spec & Plan → Implement | The same name as our doctrine file, a different thing. Establishes that "spec before code" is now a product category, not our idea. |
| `spec-kitty/spec-kitty` | 1.7k | MIT | Governed factory: `spec → plan → tasks → next → review → accept → merge`, work packages, worktrees, retrospective per mission | **The closest thing to our G1–G4 gate model**, with a real provenance trail. |
| `dzhng/skills` | 1.4k | — | Reusable agent skills for software factories | Skill packaging, not process. Reference only. |
| `strongdm/attractor` | 1.3k | — | An NLSpec for a non-interactive coding agent sufficient for a software factory | **Graph-based pipeline with checkpoints and human decision nodes.** The strongest argument that the pipeline should be data. |
| `Runfusion/Fusion` | 1.3k | — | Multi-node agents running continuously | Out of scope: always-on orchestration, not a per-feature factory. |
| `Gentleman-Programming/gentle-ai` | 1.25k | MIT | Deterministic engineering environment: memory, SDD workflow, evidence, 17 integrations including OpenCode | **Distribution done properly**: backup/rollback, self-update, marker-based injection, drift-free install. |
| `Agent-Field/SWE-AF` | 1.0k | — | Autonomous fleet producing production-grade PRs | Fleet parallelism. Not our problem yet. |
| `disler/super-simple-software-factory` | 991 | MIT | Deterministic Python owns the graph; agents are bounded nodes | **The single most useful repository in this list.** Every mechanism we lack is in it. |
| `bastani-inc/atomic` | 864 | MIT | "The verifiable coding agent runtime": explicit checkable execution graphs | **The best evidence discipline we have seen**, and model fallback as a first-class feature. |
| `KubeRocketCI/kuberocketai` | 33 | — | SDLC as Code, declarative agents | Small, but confirms "process as declarative config". |
| `bitbitcodes/autonomous-sdlc` | 40 | — | 52 agents across the SDLC with governance and cost control | Role breadth reference; too heavy to copy. |

Deep reads: Attractor, Super Simple Software Factory (SSSF), Spec Kitty,
Atomic, gentle-ai, and the Conductor plugin.

---

## 2. The convergence

Six independently built systems, six different authors, one architecture. This
is no longer a hypothesis:

1. **Code owns the loop; agents are bounded nodes.** SSSF: *"Deterministic
   Python owns the graph. Coding agents are bounded nodes inside it."* Atomic:
   workflows are explicit execution graphs. Spec Kitty: a CLI owns lanes and
   gates. The agent never owns sequencing, retries, or acceptance.
2. **Evidence is artifacts plus executable checks**, never a string and never a
   self-report. Every one of them verifies files, diffs, test output or
   screenshots after the fact.
3. **Independence is structural, not requested.** Separate session, separate
   agent, read-only tools, and — in SSSF — a `protected_files` list so **no
   agent may edit the machinery that grades it**.
4. **Provenance is append-only.** Envelopes, JSONL trails, artifact links,
   commit links, invocation IDs that must agree with the stored record.
5. **A phase passing is not the run being acceptable.** SSSF makes this a
   separate call (`run.finish(accepted=…)`) so the two can never be conflated.
6. **Not every task deserves the pipeline.** Risk and understanding decide the
   tier, not file count and not habit.
7. **Failures are recorded honestly**, including "could not verify".
8. **Distribution is part of the product**: idempotent stamp, drift check,
   backup, rollback, upgrade.

Our `factory-v2-model.md` already asserts 1, 2, 3, 4 (partially), 5 (via G3/G4),
6 and 8. The value of this research is not a new direction. It is that four of
these systems have **already solved the parts we wrote as intentions**, and we
can copy the shape instead of inventing it.

---

## 3. The five mechanisms we are missing

### 3.1 `protected_files` — the builder must not edit what grades it

SSSF keeps a list of paths no agent may write:

- `adws/adw_modules/` (the gate implementations)
- the factory config
- the workflow scripts

The check runs **after every agent call**, by diffing the repository. Any
unauthorised change is rolled back and the phase fails.

This is the mechanism behind our worst defect. Phase 6 has no gate, but even if
it did, our builder can edit `scripts/test-factory-phase.mjs`, the conductor and
the phase machine itself. A run can pass its own review by weakening the review.
No amount of prose fixes that; a write boundary does.

**Adopt.** A `protected_files` list in `factory.policy.yaml`, enforced around
every agent phase. Rollback on violation, phase fails, finding recorded.

### 3.2 `writes` is a boundary, `tools` is only a capability list

SSSF separates what an agent *can call* from what it *may change*. The reviewer
has no ability to write code, but can still write its own report. After every
call the harness diffs the repo and rejects anything outside the declared
surface.

Our reviewers are read-only by instruction. That is the same category of
enforcement as our evidence strings: a well-behaved agent complies, a lazy one
does not, and nothing notices.

**Adopt.** Per-role `writes` globs. `reviewer: [".factory/<bead>/review.md"]`.
Enforced by the harness, not by the prompt.

### 3.3 Phases default to fail; acceptance is a separate question

In SSSF every phase starts as `fail`. A clean exit flips it, and an agent phase
also needs a parseable envelope **and every gate green**. Then a second,
separate call decides whether the *run* is acceptable:

> "phases passing is not the same as the run being acceptable: a test phase
> that ran a red suite did its job perfectly."

Our model has `phase_done` and a ship gate, but no equivalent distinction. We
have already seen the consequence: every phase passed and the product was
rejected.

**Adopt.** `complete` sets `phase_ok`, never `accepted`. `factory finish`
decides `accepted` from the gate verdicts and the outcome record. Status must
report them separately.

### 3.4 An append-only trail with IDs that must agree

Spec Kitty writes `kitty-ops/<invocation_id>.jsonl` **before the executor
returns**, with `started` and `completed` events, plus `artifact_link` and
`commit_link` correlation events. Tier-2 evidence is rejected *before any
write* if the invocation is not evidence-eligible. A claimed `--invocation-id`
must agree exactly on mission, work package, action, profile and model with the
stored record.

Atomic does the equivalent at the commit level: an
`Assistant-verification:` trailer per commit records each check **run or
attempted**, including honest failures:

```
Assistant-verification: playwright 1440/768/390 — 14 assertions passed
Assistant-verification: axe-core — 0 violations
Assistant-verification: screen-reader — unavailable: no NVDA in this environment
```

and later runs look up those trailers for comparable changes and reuse the
commands that proved them.

Our evidence manifest (v2) stores artifacts and hashes but has no append-only
event log and no "what did we try and fail to verify" field.

**Adopt both.** `.factory/<bead>/trail.jsonl` (append-only, written by the
harness, not the agent) and a `could_not_verify` list in every review verdict.
Keep bd as the state store; the trail is evidence, not a second tracker.

### 3.5 Task tiering by understanding, risk and resumability

gentle-ai's ODD rule: size the process by **understanding, risk and
resumability — never by file count**. A small understood task runs inline with
no subagents and no task document. Substantial work gets one recoverable feature
document holding the spec verbatim, and every handoff points at it instead of
paraphrasing.

Our factory currently applies the same eight phases to a typo fix and a payments
integration. That is why the doctrine grew to 47 KB: it had to be true for every
case at once.

**Adopt.** The four tiers already in `factory-v2-model.md`
(`prototype / internal / public / regulated`) become the switch that
selects checks **and** the number of phases. A prototype is allowed to skip G2's
threat model; it is not allowed to skip the record.

---

## 4. Two more worth taking

**Human decisions as structured nodes** (Attractor, Atomic). Both pause the
graph and present a choice (`input / confirm / select / editor`) rather than
asking a prose question. Our Gate C asks two unscorable questions in a chat
message. A select with the rejected design directions, the three screenshots and
one forced-choice question is cheaper for the human and produces a record.

**A retrospective per run** (Spec Kitty generates one for every completed
mission). This is our G4, and it is the only mechanism that makes the factory
improve. Spec Kitty makes it automatic rather than optional; we should too.

---

## 5. What we should not copy

- **A DOT/graph execution engine.** Attractor's graph is elegant, but it is a
  product in itself. Our phases are linear with one detour (4p); a graph engine
  would be a second thing to debug. Revisit only if parallel work packages
  become real.
- **SQLite as the trace store.** SSSF needs it because its agents stream events
  from many processes. We have bd and a JSONL file. Adding a database adds a
  second source of truth.
- **A separate Python runtime.** SSSF's determinism comes from code owning the
  loop, not from Python. Our phase machine is already Node and already owns the
  loop; what it lacks is the checks, not the language.
- **Their workflow catalogues** (12 ADWs, 23 playbooks). Copying the list would
  recreate the 47 KB problem in a new place.
- **Their model routers.** Atomic's fallback chains are good, but our model
  selection belongs to opencode, not to the factory.
- **Always-on fleets** (Fusion, SWE-AF). Parallel agents are a scaling answer to
  a quality problem we have not solved yet.

---

## 6. What this changes in our plan

Nothing structural. It sharpens M0–M2 with five concrete additions:

| Addition | Comes from | Effort |
|---|---|---|
| `protected_files` list, enforced with rollback | SSSF | 1–2 days |
| Per-role `writes` globs enforced by the harness | SSSF | 1 day |
| `phase_ok` vs `accepted` as separate state | SSSF | hours |
| `.factory/<bead>/trail.jsonl` + `could_not_verify` | Spec Kitty, Atomic | 1–2 days |
| `Assistant-verification` trailers in commits | Atomic | hours |
| Tier selects phases as well as checks | gentle-ai ODD | 1 day |
| Structured gate choices instead of prose questions | Attractor, Atomic | 1–2 days |
| Retrospective generated per run, not optional | Spec Kitty | 1 day |

Scheduled in docs/factory-roadmap.md §M1. The first three are cheap and they close the
self-grading hole that the six-model review identified as the deepest defect.

---

## 7. The one-sentence lesson

> Every system in this list treats the agent as an **untrusted worker inside a
> trusted process**. Ours treats the agent as the process and hopes it is
> trustworthy.

That is the whole reframe, and it is now corroborated by six independent
implementations rather than by our own review.

---

## Sources

- https://github.com/gemini-cli-extensions/conductor
- https://github.com/spec-kitty/spec-kitty — `docs/architecture/trail-model.md`
- https://github.com/strongdm/attractor — `attractor-spec.md`, `coding-agent-loop-spec.md`
- https://github.com/disler/super-simple-software-factory
- https://github.com/bastani-inc/atomic — verification and evidence docs
- https://github.com/Gentleman-Programming/gentle-ai
- https://github.com/dzhng/skills
- https://github.com/KubeRocketCI/kuberocketai
- https://github.com/bitbitcodes/autonomous-sdlc
- https://github.com/Agent-Field/SWE-AF
- https://github.com/Runfusion/Fusion

All repositories listed as MIT were verified from their licence file at the time
of reading. Mechanisms were studied, not copied; if any code is lifted later,
the licence and attribution come with it.
