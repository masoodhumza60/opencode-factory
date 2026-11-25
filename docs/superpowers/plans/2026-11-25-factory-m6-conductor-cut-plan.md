# M6 — Cut the conductor Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task (Native is what Humza will pick unless told otherwise). Steps use checkbox syntax.

**Goal:** Cut `docs/conductor.md` from 783 to ≤ ~300 lines; every remaining line is routing,
machine-enforced rule, or a human gate. Detail that moves out goes to
`docs/negative-results.md`.

**Architecture:** doc surgery, 3 tasks. Each task ends with `node scripts/test-selfcheck.mjs`
green (the repo's own net: it reads every doc in the tree, so the "commit hash cited in docs"
checks run on every conductor edit).

**Tech Stack:** Markdown; edits via the `edit` tool; verification via `node scripts/test-selfcheck.mjs`.

**Spec:** docs/superpowers/specs/2026-11-25-factory-m6-conductor-cut-design.md (this plan argues from it).

**Global Constraints:**

- Every ≤100 lines of conductor edits, commit a checkpoint draft and note the deletions (rationale per deleted line).
- When a section detail moves to `negative-results.md`, the header title must match any cross-link edited elsewhere, and the old header must be the pointer where moved.
- New branches only off master; no pushes.
- `node scripts/test-selfcheck.mjs` passes after each task's step 3.

---

### Task 1: Compress `Code navigation (no MCP required)` section (admin entry points → negative-results, conductor keeps pointer)

**Files:**

- Modify: `docs/conductor.md`
- Modify: `docs/negative-results.md`

**Interfaces:** none.

- [ ] **Step 1: Read** `grep -n` is NOT available (PowerShell): `Select-String -Path docs\conductor.md -Pattern 'Code navigation|MCP' -Context 0,0`. Read the section fully.
- [ ] **Step 2: Draft** — write the condensed text (`docs/conductor.md`): what it says today minus the middle; one-line pointer to `scripts/factory-mcp.mjs` (scope/audit/dump/drop: the machine answers).
- [ ] **Step 3: Move detail** — write the detailed version under header `## Code navigation (no MCP required) — detail moved by M6` in `negative-results.md`.
- [ ] **Step 4: Checkpoint** — run `node scripts/test-selfcheck.mjs`; exit 0. Commit `docs(factory): m6 - code navigation condensed; detail in negative-results`.

### Task 2: Compress `Phase state machine rules` section (bullet outline; details stay in `factory-phase.mjs`)

**Files:** Modify `docs/conductor.md`.

- [ ] **Step 1: Read** — read the section in `docs/conductor.md` between `## Phase state machine rules` and the next `##`.
- [ ] **Step 2: Draft** — a bullet outline (no prose). The machine's full rule text lives in `scripts/factory-phase.mjs` — kept as pointer.
- [ ] **Step 3: Checkpoint** — `node scripts/test-selfcheck.mjs` green. Commit `docs(factory): m6 - phase machine rules condensed to outline`.

### Task 3: `Gates A / B / C` (HARD STOPS) — 3 gates to one paragraph each; move long strings to negative-results (`gate command is not a bare ok`)

**Files:** Modify `docs/conductor.md`; Modify `docs/negative-results.md`.

- [ ] **Step 1: Read** — read the section `### Gates A / B / C — HARD STOPS` (and the subsections `Gate C also rules on the running app`).
- [ ] **Step 2: Draft** — three short paragraphs in `docs/conductor.md` ("A = after spec approved, machine blocks until...; B = spec is G2a..." — or whatever the current text says, compressed; C = the signed tag that makes accept one file not source).
- [ ] **Step 3: Move** — detail (long refusal strings of truth tokens/rejected evidence) into a `negative-results.md` section `## What humans mistyped: long strings of gate evidence (moved by M6)`.
- [ ] **Step 4: Checkpoint** — `node scripts/test-selfcheck.mjs` green. Commit `docs(factory): m6 - gate definitions condensed`.

### Task 4: Final pass — `git diff docs/conductor.md` stat (+/-), run `node scripts/test-selfcheck.mjs`, push nothing. Count the final line total; report to Humza: `conductor.md` at N lines (target ≤ 300).

- [ ] **Step 1: Verify** — `git diff --stat docs/conductor.md`; run `node scripts/test-selfcheck.mjs`; final `Get-Content docs\conductor.md | Measure-Object -Line`.
- [ ] **Step 2: Ledger** — append to `.superpowers/sdd/2026-11-08-factory-m6-conductor-cut/progress.md` if it exists; report counts + 3-4 cuts made.

## Success — before signing this off

- `node scripts/test-selfcheck.mjs` → 57/57 (or higher) after every task.
- Conductor ≤ 300 lines after Task 4.

## Trim decision (autonomous calls)

- Move the `M5` "install modes: Full / Reference stub" text? Not now.
- The spec's "At this target: first ten commits" section of the roadmap stays (not conductor).
