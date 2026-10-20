# How the new model fits the current factory

Verdict: **extension and hardening, not a rewrite.** Roughly two thirds of the
existing machine is reusable as-is. The incompatible third is not the phase
machine — it is the idea that a phase completes when a string was supplied.

## 1. Phase-by-phase fit

The phase order does not change. What each phase must *leave behind* does.

| Today | Becomes | Gate today | Gate after | What changes |
|---|---|---|---|---|
| 0 onboard | 0 onboard | — | — | stays; also resolves which MCP servers and skills this project may use |
| 1 brainstorm | 1 brainstorm | none | **G1 worth building** | new artifact: product brief (user, alternative, success metric, kill criterion); new data: tier, profiles, surfaces |
| 2 spec | 2 spec | **A** | **G2a ready to build** | spec becomes a hashed, bead-bound artifact; "not applicable, because …" decisions signed |
| 3 plan | 3 plan | **B** | **G2b ready to build** | plan fingerprint already exists; add impact set and compatibility decision |
| 4 implement | 4 implement | — | — | add `protected_files` and per-surface write boundaries |
| 4p repair | 4p repair | — | — | stays; evidence attaches to the same surface and bead |
| 5 verify | 5 verify | none | none (feeds G3) | `--booted` becomes `--ran`; writes the evidence manifest per surface |
| 6 review | 6 review | **none** | **G3 ready to ship** (review half) | must produce a verdict artifact from an independent session; still no separate gate |
| 7 ship | 7 ship | **C** | **G3 ready to ship** | release record per surface; `complete 7` refuses without G3 |
| 8 close | 8 close | none | **G4 did it work** | outcome record, retrospective, feedback into evals and `negative-results.md` |

G3 is today's Gate C. It is created when the run enters phase 7 (ship); the review half of phase 6 is enforced as a required artifact (`review.md` plus the reviewer verdict), not as a second gate record. G2 is created in two steps: `G2a` on entering phase 2, `G2b` on entering phase 3, riding the existing Gate A and Gate B records.

So the gate count goes from 3 to 4, but **no phase is added or reordered**. G1 is
inserted where there is already a natural boundary (end of brainstorm), G2 simply
names what A and B were already doing in two steps, Gate C becomes G3, and G4 is
the phase 8 close that today records nothing.

## 2. What is reused unchanged

| Component | Why it survives |
|---|---|
| `factory-phase.mjs` phase legality | forward-only, refuses skips, refuses unknown phases — exactly what an attestation machine needs |
| beads as the single store | already holds phase, metadata, gates; the manifest and verdicts extend it instead of adding a second tracker |
| `factory-plan.mjs` + fingerprint | Gate B's real enforcement; G2b reads the same fingerprint |
| gate creation on `enter` | correct shape; needs fail-closed and a reason check |
| `--evidence` plumbing | correct idea, wrong predicate — becomes a manifest reference |
| `verify-app` | becomes the `web` profile's verifier; other profiles get siblings |
| `factory-skills.mjs` + `catalog.yaml` | the data-driven catalog is right; the mandatory list is wrong |
| selfcheck | right instrument; must FAIL rather than WARN on missing mandatory skills |
| install scripts | right shape; need backup, uninstall, JSONC-safe merge, pinned versions |
| testapps | the only end-to-end fixtures; need one per profile, not just web/API |

## 3. What must change, and where

| New rule | Lives in | Change |
|---|---|---|
| Tier | bead metadata + `factory.policy.yaml` | new field, read at every gate |
| Profile | bead metadata + `.factory/product.yaml` | new field; selects the check list |
| Surfaces + impact | `.factory/product.yaml`, `factory-phase.mjs` | The affected set is `computed ∪ declared-extra`: the import graph plus a `generates:` edge, with a declaration able to add a surface but never to omit one. |
| Evidence manifest | new `scripts/factory-attest.mjs` | writes and verifies `.factory/<bead>/manifest.json`; `complete` calls it |
| `--ran` | `factory-phase.mjs` | replaces `--booted`; requires command, observed result, timestamp, artifact path that exists |
| Gate reasons | `factory-phase.mjs` `cmdGate` | require `close_reason`; reject raw `bd gate resolve` as unresolved |
| `complete 7` requires G3 | `factory-phase.mjs` `cmdComplete` | one gate lookup, mirroring `cmdGate` |
| Fail-closed gates | `factory-phase.mjs` `cmdEnter` | create gate before advancing; roll back phase on failure; absent metadata means pending |
| Independence | `plugins/opencode-beads.ts` + `factory-review.mjs` | reviewer in a separate session, different model family, no write tools, diff-only context |
| `protected_files` | plugin permissions | deny `edit` on grading paths at session creation; diff as a second belt |
| Profile check lists | `factory.policy.yaml` | named checks per profile; missing check refuses the gate |
| G4 outcome | bead metadata + `negative-results.md` | record metric before/after, post-ship defects, recovery time, what changes next |
| Conductor size | `docs/conductor.md` | 651 lines to routing only; move history and duplicated doctrine out |

## 4. The four real incompatibilities

These are the only places where the old model and the new one cannot both be true:

1. **"Phase complete" vs "attestation verified."** `cmdComplete` currently means
   "a string was supplied." It must mean "the required artifacts exist, hash,
   are fresh, match HEAD, and have an independent verdict." Same command, stricter
   predicate. Keep the old behaviour behind `policy_version: 1` during migration.
2. **Phase-keyed artifacts vs surface-keyed evidence.** `ARTIFACTS` is a map from
   phase to one directory. It has to become a map from `(profile, surface)` to
   required artifact kinds. This is a data change, not a control-flow change.
3. **Gate letters A/B/C are hardcoded.** `GATE_KEY` and the gate command assume
   three letters. G1–G4 need a mapping table and a compatibility alias so old
   beads keep working.
4. **Doctrine as enforcement.** The conductor's phase table says "MUST invoke
   skill X." Nothing can verify that, and the real run proved it. The replacement
   is not better prose; it is a recorded skill on `complete`, checked at entry, and
   installed by the factory. This one cannot be patched — it has to be retired.

## 5. Migration path, no big bang

Each step is independently shippable and leaves the suite green.

| Step | Change | Exit criterion |
|---|---|---|
| 0 | Evidence and gate holes: whitespace, reasons, `complete 7`, fail-closed metadata, test harness | the ~20-command fake-ship path fails at the first artifact |
| 1 | Add `tier`, `profile`, `surfaces` to metadata and `product.yaml`; nothing enforces them yet | `status` prints them; old beads default to `internal`/`web` |
| 2 | Manifest + `--ran`; `complete 5/6/7` read it | deleting an artifact refuses completion |
| 3 | G1 and G4 gates; A/B become G2a/G2b behind aliases | a run without a kill criterion cannot leave phase 1 |
| 4 | Independence and `protected_files` via the plugin | builder editing `scripts/` is denied by the platform, not by prose |
| 5 | Profile check lists + surface impact computation | an API bead is refused for missing contracts, not screenshots |
| 6 | Conductor cut to routing | <= 250 lines, no rule stated twice |

## 6. What would actually force a rewrite

Only three things, and none is required now:

- **Per-surface autonomy** — different teams, different repos, independent
  release calendars with no shared bead. That needs a product-level orchestrator
  above the current machine.
- **True parallel builders on one bead** — the current lease handling cannot
  prevent two sessions overwriting each other's `phase_done`.
- **A hosted service** — multi-tenant state, remote runners, a UI. The CLI and
  bd store would be replaced, not extended.

Everything the user has asked for so far — all software types, multi-surface
products, independent review, evidence instead of strings — fits inside the
existing machine.

## 7. One-sentence answer

The current factory is the right skeleton with the wrong completion predicate:
keep the phases, the beads, the plan ledger and the gates; replace "a string was
supplied" with "a verified artifact exists," add tier/profile/surface as data,
and move independence and protected files into the platform where they can
actually refuse.
