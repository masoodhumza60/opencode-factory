# M4 — Make it learn: the outcome feedback loop, evals, and calibration

Spec: 2026-11-09
Branch: `feat/m4-make-it-learn` (cut from `master` `3141ab2`; nothing pushed yet)

## Vision anchor

From `docs/superpowers/specs/2026-09-22-opencode-factory-design.md`, "1. Vision":
a portable factory that turns a feature request into a shipped pipeline, and from
`docs/factory-v2-model.md`, "Four gates":

> G4 blocks `complete 8` on the **existence** of an outcome record (what
> changed, measured before and after, or an explicit "not measurable, here is
> why"). The record's content is judged by a human later; a missing record is a
> refusal, not a warning. ... **G4 is the missing feedback loop.** It is the
> only gate that can change the factory itself: its record is written to
> `docs/negative-results.md` and to the eval set, so the next run starts from a
> different place.

M1c shipped the existence half of that promise. M4 ships the loop half:
outcomes stop being inert files and start changing the factory — what the
discovery skill ranks, what the negative-results doc learns, what the eval set
regressions on, and what the human knows about the reviewer's advice.

The roadmap's M4 section names four items. Item 1 (G4) is done. This milestone
ships items 2, 3 and 4 as three phases: **A. the feedback loop**, **B.
end-to-end evals on `testapps/`**, **C. review-model calibration**. Item 5
(factory metrics) is deliberately not in scope; it needs a fleet before it
needs a design. DORA is measurement without a loop; this milestone builds the
loop.

## What already exists (do not rebuild)

- `outcome.md` at `.factory/<bead>/outcome.md`, required by `complete 8`
  (`outcomeProblems()` in `scripts/factory-phase.mjs`): non-empty file; a
  `## What changed` section; either `## Measured before / after` with content
  or a `Not measurable:` line. A missing or malformed file is a refusal.
- `scripts/factory-phase.mjs` is **pinned** in `config/factory.protected.json`.
  Any change to it — including the ledger append below — requires a human
  re-baseline (`FACTORY_ROLE=human node scripts/factory-attest.mjs protect --write`)
  and a commit of the re-baselined set. That is a deliverable, not an accident.
- `testapps/orderboard` (web, React+TS+Vite) and `testapps/orderboard-api`
  (Node+SQLite API with auth, migrations, migration index, tests, `web/`
  sub-app). A CLI seed does not exist.
- `factory-workspace/` holds prior A/B skill-eval runs (untracked). Their
  layout is reusable; their mechanism (with_skill vs without_skill) is not the
  whole-pipeline product verdict this milestone builds.
- Hidden tests are already a kind: `hidden-tests` (M1c) — attested as evidence,
  never declarable in a policy.

## Scope

- One spec, three phases, executed in order A → B → C. Each phase is
  independently verifiable and independently shippable.
- The factory's own tooling and its seed apps only. No produced product, no
  cloud target, no other repositories.
- Prose docs stay prose. Machine enforcement only where this spec says so.
- No new evidence kinds, no policy-vocabulary changes, no pinned-script
  changes **except** Phase A's `factory-phase.mjs` change, which is
  re-baselined as part of this milestone.
- Nothing is promoted to `enforced`; the example policy is data; local factory
  behaviour stays M0 until a policy opts in. Mobile/desktop stay experimental.

## Phase A — the G4 outcome feedback loop

### Intent

When `complete 8` lands, the outcome exists for reasons beyond the audit. A
`did-not-work` should get easier to notice next time; a learning should be
discoverable by the phase-1 discovery skill; a pattern repeated across beads
should surface in the docs. All of that starts with one append-only ledger.

### Design

1. **`outcome.md` gains one required line:**

   `Outcome: worked | worked-with-changes | did-not-work | not-measurable`

   Enforced by `outcomeProblems()` (factory-phase.mjs, pinned) alongside the
   existing sections. Verdict vocabulary is closed; anything else is a refusal.
   `Outcome: not-measurable` requires the `Not measurable:` line already
   enforced — a contradiction between them is a refusal naming both lines.

2. **Optional structured section** `## What the factory learned` in
   `outcome.md`, with bullets of the form:

   ```
   Learned: <name>: <one line>
   ```

   `<name>` is a tool, mechanism or pattern (e.g. `git apply`, `hidden tests`,
   `orderboard API`); the match key for the discovery lookup. Absence of the
   section is legal; the ledger simply records no `learned` entries.

3. **`docs/outcomes.jsonl` — append-only, tracked, never hand-edited.** One
   JSON object per line, written transactionally in `complete 8` after
   `outcomeProblems()` passes (same pattern as the trail append):

   ```json
   {"at":"2026-11-09T12:00:00Z","bead":"factory-m4-x","head":"abc1234","verdict":"worked","what_changed":"...","measured":"...","learned":[{"name":"hidden tests","line":"..."}]}
   ```

   The machine records what the human wrote; it does not judge it.

4. **`scripts/factory-outcome.mjs`** — unpinned, stdlib-only, never attests:
   - `node scripts/factory-outcome.mjs list [--verdict <word>]` — parse and print rows.
   - `node scripts/factory-outcome.mjs report` — tally by verdict; prints a
     table; always exits 0.
   - `node scripts/factory-outcome.mjs lookup <name>` — print matching rows
     (verdict, bead, date, learned line) for the phase-1 discovery skill;
     advisory only, exits 0 either way.
   - `node scripts/factory-outcome.mjs draft` — regenerate
     `docs/negative-results.draft.md` deterministically: every
     `did-not-work` row's `what_changed` line, plus every `Learned:` line seen
     in two or more beads. Header states provenance; output is overwritten
     whole, so the draft is always consistent with the ledger.

5. **`negative-results.md` stays human-curated.** The machine writes only
   `docs/negative-results.draft.md`. Promotion from draft to the curated doc is
   a human act, by review, with the same commit discipline as any doc change.

6. **Discovery is advisory only.** One line in `docs/discovery.md` (the Rank
   section): before ranking, consult
   `node scripts/factory-outcome.mjs lookup <tool>`; a `did-not-work` entry
   demotes, it never promotes, and no verdict of the discovery skill may be
   machine-refused for a ledger reason. The machine informs; the human
   (or the rank skill) decides.

7. **Tests.** `scripts/test-factory-phase.mjs` gains `Outcome:`-line cases
   (missing line refuses; wrong word refuses; `worked` passes). New suite
   `scripts/test-factory-outcome.mjs` proves: append-on-complete-8 (rides
   `complete 8` against a temp bead), ledger round-trip, `report` tallies,
   `lookup` match/no-match, `draft` regeneration is byte-deterministic, and
   `draft` emits did-not-work rows and repeated learnings only. The draft
   never edits `negative-results.md` — proven by a canary file kept unchanged.

### Not in scope (Phase A)

- Automatic adjudication or ranking. The ledger has no authority over Rank.
- Machine writes to `negative-results.md` or any curated doc.
- DORA/lead-time metrics (roadmap item 5).
- Back-filling existing beads' outcomes (there is nothing to back-fill).

## Phase B — end-to-end evals on testapps/

### Intent

Roadmap: "End-to-end evals on `testapps/`: the whole pipeline runs against a
seed app with hidden acceptance tests, so the factory itself has a regression
suite." The exit criterion that matters: a change to a factory rule that
silently breaks delivery should be caught before it ships.

### Design

1. **Third seed — `testapps/orderboard-cli/`.** Node (>=22), zero runtime
   dependencies, no network: an `orders` CLI against a local JSON store —
   `orders create --json <payload>`, `orders list [--status pending|paid|shipped|cancelled] [--json]`.
   Statuses are `pending | paid | shipped | cancelled`, matching the two other
   seeds. Own tests in `testapps/orderboard-cli/test/`; committed; tracked.

2. **One feature request per seed** (the eval's task):
   - `orderboard` (web): a status filter on the orders list
     (all|pending|paid|shipped|cancelled, default all — today's behavior unchanged).
   - `orderboard-api` (api): `PATCH /orders/:id` enforcing the
     pending → paid|cancelled and paid → shipped transitions with 409 on an
     illegal transition, 404 on unknown id, 400 on a missing or unknown status.
   - `orderboard-cli` (cli): machine-readable output — `orders list --status pending --json`
     and `orders create --json` with validation and a non-zero exit on bad input.

3. **Hidden acceptance tests** per seed, committed under
   `testapps/<seed>/hidden/`. They express the feature request and are written
   once, by hand, by us. In-repo hiding is **by convention, not secrecy**: the
   builder agent is instructed (via the seed's README and the eval runbook) not
   to read them; the machine cannot and does not verify that. That ceiling is
   stated, not hidden.

4. **Two reference patches** per seed, committed:
   - `golden.patch` — a minimal, correct implementation of the feature
     (satisfies the hidden tests).
   - `broken.patch` — a plausible wrong implementation (satisfies the request
     on its face; fails the hidden tests in at least one assertion class:
     filter/default, 409 vs 200, JSON vs plain output, exit code).

5. **`scripts/factory-eval.mjs`** — unpinned, never attests:

   `node scripts/factory-eval.mjs check`

   For each seed: copies it to a temp directory (never mutates the repo);
   (a) asserts the seed's own tests pass on the bare tree; (b) asserts the
   hidden tests **fail** on the bare tree (they cannot be vacuous); (c) asserts
   the hidden tests **pass** on the golden reference; (d) asserts the hidden
   tests **fail** on the broken reference (they discriminate). Prints one
   verdict line per seed per proof; exits non-zero on any miss; writes only
   `out/eval/<timestamp>.jsonl`. `report` prints the last summary. The
   four proofs together are the cheap, deterministic regression: no LLM, no
   gates, no ambiguity.

6. **`docs/factory-eval.md`** — the runbook for the honest ceiling. A
   human runs the real pipeline per seed (`factory <feature>` against a fresh
   copy, real G1/G2/G3, the seed's request, transcripts under
   `factory-workspace/eval-<seed>-<date>/`); after the build, the hidden tests
   score the product; the outcome lands in `outcome.md` and the ledger. The
   cheap eval catches machine rot; the human-run eval catches judgment rot.
   Runs on demand, before releases and after rule changes that survive the
   cheap eval — never implied to be automatic.

7. **Tests.** New suite `scripts/test-factory-eval.mjs` reproduces the four
   proofs against fixture seed copies, proves the harness refuses a missing
   seed by name, proves `out/` writes and exits, and pins the report shape.
   Phase suite and attest are untouched; attest/phase never run concurrently.

### Not in scope (Phase B)

- CI. This repo has no CI; the cheap eval is run by hand like every suite.
- Running the factory unattended. Human gates stay human, including in evals.
- More seeds. Three classes are enough to learn from; library/data-ml later.
- Machine reading or validating the hidden tests' quality. They are ours.

## Phase C — review-model calibration

### Intent

Roadmap: "Calibrate the review model against human labels; record agreement;
an LLM judge is a finding generator, never the sole sign-off." v2-model: a
judge that agrees with the builder 100% of the time is a mirror, not a
reviewer. M4 makes that measurable, model-agnostic, and repeatable.

### Design

1. **Cases.** `docs/calibration/cases/<id>.diff` — 30 frozen diffs:
   - **20 synthetic**, built from the seeds: two of each class — wrong
     condition, missing validation, contract break, dropped error path —
     plus twelve mixed (off-by-one, silent swallow, over-broad delete, stale
     comment that code violates, and others). Generated deterministically by the harness
     `package` subcommand into the working tree; each diff carries a header
     comment with its class.
   - **10 real-history**: hand-picked from this repo's history (M1b–M3 diffs,
     pinned by SHA in the generator, never re-derived silently).

2. **Labels.** `docs/calibration/labels/<id>.md` — one file per case, written
   by the user (the human label): the verdict the reviewer should reach
   (`changes` or `pass`) and one line of why. Labels are never read by the
   harness scorer as ground truth for scoring until they are filled; a missing
   label is reported as missing, not as disagreement.

3. **No model in the harness.** `factory-calibrate.mjs` builds the package
   and scores recorded verdicts. The reviewer model is whatever the user
   points at each case — the build model stays fixed; the reviewer is the
   variable. This makes the harness provider-agnostic and the pairing
   measurable instead of assumed.

4. **Recording.** `node scripts/factory-calibrate.mjs record --case <id>
   --reviewer <model-id> --verdict pass|changes [--note "..."]` appends to
   `docs/calibration/verdicts.jsonl`. Append-only; one row per (case,
   reviewer).

5. **Scoring.** `node scripts/factory-calibrate.mjs score [--reviewer <id>]`
   computes, per reviewer and per split (synthetic / real-history): verdict
   agreement %; false-accept count/rate; false-reject count/rate; lists every
   disagreement (case, class, human verdict, reviewer verdict) for triage.
   Writes `docs/calibration/<date>-agreement.md`. A reviewer that agrees 100%
   with the human is flagged as mirror-risk, not celebrated.

6. **Docs.** `docs/factory-calibration.md` — the runbook (how to run the 30
   cases with any reviewer model, how to fill labels, how to score, how to read
   the report), the ceilings (small n, agreement ≠ correctness, synthetic
   selection bias, a real-history set the reviewer may have seen in training),
   and the rule this supports: the reviewer advises; G3 signs.

### Not in scope (Phase C)

- Calling a model from the harness. Provider, auth, and cost are the user's.
- Prompt engineering of the reviewer. Measure what is, don't tune first.
- Automatic promotion of any reviewer model, pairing, or threshold.
  `docs/conductor.md` stays unchanged; pairing recommendations, if any, live
  in the agreement report as observations.
- Calibrating anything other than verdicts (findings overlap is a later
  question once verdict agreement is known).

## Deliverables

1. Phase A: `factory-phase.mjs` change + protected re-baseline (human,
   with commit), `scripts/factory-outcome.mjs`, `scripts/test-factory-outcome.mjs`,
   `test-factory-phase.mjs` outcome cases, `docs/outcomes.jsonl` (seeded empty),
   `docs/discovery.md` one-line advisory addition.
2. Phase B: `testapps/orderboard-cli/` (new), hidden tests + `golden.patch` +
   `broken.patch` under all three seeds, `scripts/factory-eval.mjs`,
   `scripts/test-factory-eval.mjs`, `docs/factory-eval.md`.
3. Phase C: `scripts/factory-calibrate.mjs`, `scripts/test-factory-calibrate.mjs`,
   `docs/calibration/` (cases/, labels/, verdicts.jsonl seeded empty,
   `<date>-agreement.md` after first scored run), `docs/factory-calibration.md`.
4. Roadmap + ledger: `docs/factory-roadmap.md` M4 section rewritten to what
   shipped (counts kept current), the M4 SDD ledger closed out, this spec,
   three plans.

## Verification (what "done" means)

- Phase A: phase suite green with the `Outcome:` cases; outcome ledger
  appended by a real (sandboxed) `complete 8`; factory-outcome suite green;
  draft regeneration deterministic; canary untouched.
- Phase B: `node scripts/factory-eval.mjs check` exits 0 and prints 12/12
  proofs (4 per seed); eval suite green; broken references each discriminate.
- Phase C: 30 cases package once byte-identically across runs; a full record →
  score cycle on fixture verdicts produces a parseable agreement doc; factory
  calibration suite green.
- Whole branch: every touched suite green; attest and phase never run
  concurrently; standing dirt untouched; nothing pushed without approval.

## Risks and honest ceilings

- The ledger records what the human wrote; a dishonest or empty `measured:` is
  not detected — same boundary as every M1c artifact.
- In-repo hiding convention; the builder is instructed, not constrained.
- The cheap eval tests the seeds and their tests, not the model; the human-run
  eval remains the judgment ceiling. Neither proves another machine/operator.
- Small-n calibration; synthetic bias; possible train-set contamination of the
  real-history cases; 100% agreement is a mirror, not a medal.
- `factory-phase.mjs` re-baseline is a human act by design; without it, the
  phase machine refuses to complete 8 — which is the point.
- Nothing here makes the factory enforced; the example policy stays data.
