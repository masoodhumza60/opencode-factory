# M6 — Cut the conductor (spec)

Date: 2026-11-25. Milestone is after M2, which is shipped. **Track:** none (docs-only).

## Intent and why

The factory is working, and the remaining friction is reading it. `docs/conductor.md`
has grown to **783 lines**; the roadmap's own target from M6 is ~250 lines
(stale since M2 — "after M2" was written 2026-10-07 and the conductor has grown
since). Readers read the conductor to follow the factory's routing, so prose
dilutes the machine-enforced rules; in the other direction, some history and
operational detail sits only in the conductor and is of no use to the next
operator. The cut: make `conductor.md` the **router and the human gates**, move
evidence of past failures and detail into `docs/negative-results.md` (and, where
a section is now better as a pointer, replace detail with one-line pointers to
the machines that own it).

## Goals, non-goals, anti-goals

- Goal: after M6, `conductor.md` is ≤ ~300 lines; every line is routing,
  machine-enforced rule, or a human gate. Docs elsewhere travel with their
  code, so target the same truth, not fewer facts.
- Goal: nothing the conductor explains that the machine can actually enforce
  becomes prose — each must have a check in the code already (M1a manifest,
  M1c acceptance, the phase machine, the attestation suite).
- Non-goals: cut coverage for first-time readers ("what is a bead, who am I?");
  change behavior of any script. Cut only prose.
- Anti-goals: deleting a human gate; breaking the phase machine doc; creating a
  new authoritative home for anything.

## Constraints

- PowerShell is the shell; docs are Markdown, any editor.
- Structured checkpoints every ~100 lines of doc edits: no deletions without a
  draft, no lines deleted that a doc's own tests cite (strings are checked by
  `scripts/test-selfcheck.mjs` — verify hashes/hashes-of-doc via `node
  scripts/test-selfcheck.mjs` after edits; the 18 "commit hash cited" checks are
  the regression net).
- No pushes; commits on a new branch off master for review.

## Approaches (considered)

1. **Section by section rewrite** — same skeleton, compress prose. Leaves most
   volume (some sections are duplicated between conductor and how-factory-works
   and other docs).
2. **Selective extraction** — pick the heaviest per-section; move detail to
   negative-results.md; shrink conductor with leftovers.
3. **The M6 shape as stated** — "subtracts only after the checks exist elsewhere": move
   detail to negative-results.md (a list of entry points when agents start blindly,
   review flow summary pointing at the gateway), condense the rest. Also refine
   `docs/conductor.md`'s Gate C and other sections (such as the basic flow) and update any
   doc-numbering of gates.
4. **Trim doc trees entirely** — `docs/factory-v2-model.md` may move to history (it says "is
   now partly shipped"). Not yet: it is the authority on current behavior.

Chosen: option 3, with 4 as an explicitly rejected extension (v2 model stays until its
claims are true or its facts are moved).

## The cut plan

Move out (with pointers):

- `Code navigation (no MCP required)` — detail into negative-results.md as
  history if not here (replaced by pointer to `factory-mcp.mjs`).
- Long-tail of optional flags/aliases on `bd` (`A`/`B`/`C` gate letters, bare-yes
  evidence, etc.) → negative-results.md as "what got cut and why".
- `Cost discipline` — three rules; keep condensed (it says why the session model is capped).

Compress:

- `Phase state machine rules` → bullet outline; details live in `factory-phase.mjs`.
- `Hard skills` — keep list, replace prose about official sources with pointers to
  `factory-skills.mjs resolve` + catalog.

## What stays a human gate (M6 exits none; keep gates A, B, C)

Gates G1/G2a/G2b/G3 plus G1-G3 remain, defined in one paragraph each.

## Success

- `node scripts/test-selfcheck.mjs` passes (57/57) — it is the machine-check
  net for docs.
- `conductor.md` ≤ 300 lines, r/w count on line-references drops.
- Negative-results.md has the moved sections with header titles that match any
  cross-links edited elsewhere ("End of cut line 1...", etc.)

## Exit

Done when the balance of prose vs. routing in `conductor.md` reads right to
Humza; tracker stays at master with `+N / -M` style note in the ledger if
similar work remains later (spec offers: "negative-results keeps the cuts;
conductor.md falls under the repo's own TOSK").
