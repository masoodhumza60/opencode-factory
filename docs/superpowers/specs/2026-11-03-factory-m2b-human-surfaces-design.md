# M2b — Human surfaces: design judgment in the machine, plus one proved capture path (2026-11-03)

**Status:** draft for human review; no implementation before this spec is approved, and no
implementation before the plan that follows it is approved.

## 1. Intent

The factory today cannot enforce *design judgment*. It can require an artifact, hash it, and check
its shape — but it has no opinion about who the surface is for, what journey they are on, or whether
the chosen visual direction is any good. The earlier milestone lineage (M1a–M2a) shipped evidence
mechanics precisely because they were deterministic; taste was never a candidate for a mechanism.

The user's stated complaint:

> what is actually issue was previous factory do not have design taste and did not think software as
> user centeric and missing human designer elements

M2b puts the *human designer element* inside the pipeline as a required phase-1 artifact whose shape
is machine-checkable, and whose taste is an explicitly human judgement at G1 — not a new gate, not a
new phase, and not a machine-authored aesthetic.

M2b also lands the **capture evidence path** that M2a deliberately left declared-but-unusable: a web
testapp proved end-to-end here (Playwright at 1440/768/390, axe report, console-clean), attested
under policy, and wired so a `web` bead cannot ship without it.

## 2. The exit line

A `public` `web` bead on this repo cannot complete its G1/G3 transitions unless:

1. it has a **directions artifact** attested at phase 1: who the user is, the journey, two or three
   named directions with critiques, the chosen one, rejected directions with reasons; and
2. it has **runtime captures** at 1440/768/390 across a declared state set, console errors absent,
   plus an **axe report** with no unreviewed violations.

Machine-interface profiles (`api`, `cli`, `library`) are not required to produce these. `mobile` and
`desktop` are designed for in the adapter shape but are **not** proved, **not** promoted from
`experimental: reduced checks`, and not wired to G3 until a real run passes.

## 3. Goals

- Make design judgment structural: a bead with a human-surface profile cannot skip naming the user,
  the journey and the directions.
- Give G1 something to judge that is not a paragraph in a chat message: a directions artifact with a
  known shape, attested and hashable like every other evidence.
- Make visual/runtime evidence real for exactly one profile end-to-end, and honest about the other
  nine.
- Keep the machine's claim honest: shape is checked, taste is not. Every refusal message says which
  is which.

## 4. Non-goals

- No taste engine. The machine never scores an aesthetic.
- No new phase. The phase machine (`0…8`) and its gates (`G1`, `G2a`, `G2b`, `G3`, `G4`) are unchanged.
- No new gate. Design judgment is enforced by an attested artifact plus G1 as the human verdict.
- No promotion of `mobile`, `desktop`, `embedded`, `game`, `data-ml`, `infra` to `enforced`.
- No M2c scope (security, QA, SRE).
- No removal of the "M2b builds the capture tooling" sentence from `docs/factory-domain-profiles.md`
  before the tooling exists and is proved here.
- No vendored/global tooling assumptions; the only new dependencies are exact-pinned devDependencies
  in this repo for the web proof.

## 5. Architecture

### 5.1 Two record kinds added to the closed vocabulary

`DECLARABLE_KINDS` (currently 32) gains exactly two ids, declared once in
`scripts/factory-policy.mjs` and derived everywhere else the same way M2a did it:

- `directions` — a phase-1 design artifact.
- `axe` — an accessibility report produced by axe.

`screenshot` is reused, not duplicated. `hidden-tests` remains non-declarable and unrelated.

Neither kind is produced by any M2a mechanism; both are produced by the M2b tooling below, and the
example policy declares them. `config/factory.protected.json` is re-baselined because the scripts
that edit the grading machinery changed — never edited and forgotten.

### 5.2 `scripts/factory-design.mjs check <bead> <path>` — shape, not taste

A new, unpinned script modeled on the existing attest/policy tooling style:

1. Reads the directions artifact at the given path (root-relative, `/` separators).
2. Requires these sections, each non-empty:
   - **User** — who this is for (roles, context, constraints).
   - **Journey** — the path from arrival to a completed job, with the states they pass through.
   - **Directions** — at least two named directions; each has a one-line concept, a critique
     (what it would make hard), and a fit verdict (`fits`, `strains`, `rejects`).
   - **Chosen** — the chosen direction, named.
   - **Rejected (with reasons)** — at least one, with a reason that is more than an adjective.
3. Prints a refusal listing exactly which section is missing or empty.
4. Exits 0 only when shape holds. It never says a direction is *good*.

The validator's refusal text is the contract: a G1 reviewer sees a failing `check` before seeing the
artifact, or a passing `check` and knows the taste call is theirs.

### 5.3 Design enters the catalog as a skill, not a note

`skills/catalog.yaml` gains a `skills` (topics) entry for design judgment, scoped
`profiles: web, mobile, desktop, game`:

- name: `design-judgment`
- profiles: `web, mobile, desktop, game`
- why: the surface is for a human; a bead that cannot name its user and its journey is not ready for
  a spec, regardless of how good its architecture is.

It is deliberately **not** mandatory machine-wide (an `api` bead must not resolve it), consistent with
how `factory-skills.mjs resolve` already filters by `profiles:`.

### 5.4 `scripts/factory-capture.mjs` — one adapter, one fixture, proved here

A new, unpinned script that the policy's `web` profile can name in a check command:

1. `node scripts/factory-capture.mjs --fixture fixtures/testapp [--bead <bead>]`
2. Serves `fixtures/testapp/` statically (Node `http`), picks a free port.
3. Launches Playwright at 1440, 768 and 390 widths.
4. Visits each declared state in the fixture — the fixture declares exactly five: `default` (as
   shipped), `loading` (via query `?state=loading`), `empty` (`?state=empty`), `error`
   (`?state=error`), `disabled` (`?state=disabled`) — and waits for `document.body` to reach a
   settled state or 5s, whichever first.
5. Fails the run if any console message of type `error` arrives during settle, or if the page throws.
6. Writes `out/capture/<state>-<width>.png` and `out/axe.json` (axe run against the `default` state).
7. Prints the artifact list; it does not attest. Attesting is `factory-attest attest … --kind …`,
   same as every other evidence.

The fixture is a plain static page plus a `states.js` that reads `location.search` — no framework,
no build step, no network.

### 5.5 Policy wiring (example policy, and exactly what a real policy inherits)

`config/factory.policy.example.yaml` changes in three places, for the `web` profile only:

| Check id | phase | kind | command |
|---|---|---|---|
| `directions` (new) | 1 | `directions` | `node scripts/factory-design.mjs check <bead> .factory/<bead>/design/directions.md` |
| `axe` (new) | 7 | `axe` | `node scripts/factory-capture.mjs --fixture fixtures/testapp` |
| `visual` (existing, now real) | 5 | `screenshot` | unchanged (`npm run visual` semantics replaced by the capture script) |

`api`, `cli`, `library`, and the experimental profiles keep their current lists. `web` stays
`experimental: reduced checks` in the status column until a real project passes end-to-end — M2b
makes the checks *satisfiable and provable here*, not `enforced`.

### 5.6 What G1 judges

`factory-phase complete 1` rides the existing verifier: with a project policy declaring `directions`
at phase 1, absence or shape failure refuses the transition with a named check. The G1 gate record is
untouched — G1 remains the human's verdict on whether the direction is any good. The machine proves
the artifact exists and is shaped; the human proves it deserves to exist.

## 6. Test plan

- `scripts/test-factory-design.mjs` (new): shape refusals (missing user / journey / directions /
  chosen / rejected), two-direction minimum, "at least one named reason" rule, exit-0 on a correct
  fixture, refusal text names the failing section.
- `scripts/test-factory-capture.mjs` (new, uses the fixture and a skipped browser check if Playwright
  is unavailable): fixture serves; `--help` works; a state set that exists in the fixture is refused
  when absent; console-error injection is caught (fixture `states.js` carries a `?state=console-error`
  probe used only by the test).
- `scripts/test-factory-policy.mjs`: the two new kinds parse; a policy declaring `directions`/`axe`
  loads.
- `scripts/test-factory-attest.mjs`: attesting `--kind directions`/`axe` is accepted; attest still
  refuses an unknown kind.
- Phase suite unchanged in count except any narrowly-scoped additions; attest/policy/review/protect
  re-baselined if the pinned set changes.

## 7. Docs and ledger

- `docs/how-factory-works.md`: replace the placeholder sentence about M2b capture tooling with what
  is now true; add `directions`/`axe` to the kinds list and the two-tool reality; state the ceilings
  (shape vs taste; one profile proved).
- `docs/factory-domain-profiles.md`: the WEB row updated to name `factory-capture.mjs` and the axe
  path; the "M2b builds the capture tooling" sentence is corrected only when this ships; the status
  column stays `experimental` with a note that the checks are now producible.
- `docs/factory-roadmap.md`: M2b line; honest "what this does not prove" for M2b.
- Ledger `.superpowers/sdd/2026-11-03-factory-m2b/progress.md`: each task, its verification and its
  ceiling.
- This spec is committed **only after approval**; `docs/superpowers/` otherwise stays untracked.

## 8. Verification gate for the plan

Every task in the plan must end with:

- `node --check` on changed `.mjs` files (and the new tests), plus the relevant suite run;
- attest and phase suites never run concurrently;
- `FACTORY_ROLE=human node scripts/factory-attest.mjs protect --write` + commit if any of the five
  pinned scripts change;
- no `git push`, no remote operations.

## 9. Risks

- **Playwright/axe are heavy and flaky in CI.** Pin exact versions; the fixture is static; the
  capture script has a 5s settle ceiling and fails loud, not quiet. If the environment cannot launch
  a browser, the test skips with an explicit `SKIPPED: no browser` line rather than a false pass.
- **Shape theatre.** A directions artifact can satisfy every section with one-word answers. The
  validator cannot fix that; the G1 rubric paragraph in the skill's `why` states what a human must
  reject (adjectives without mechanisms, directions with no same-material critique, a chosen direction
  with no rejection).
- **The example policy example remains an example.** No `config/factory.policy.yaml` exists in this
  repo, so local behaviour is unchanged; the proof lives in the testapp and the docs, and promotion
  waits for a real run.
- **Scope creep into M2c.** Security/QA/SRE contents are deliberately excluded; they are the M2c plan.

## 10. Success criteria

- A clean checkout can run `node scripts/factory-capture.mjs --fixture fixtures/testapp` and produce
  the declared artifact set (12 screenshots + `axe.json`), or fail with a message that says why.
- `node scripts/factory-design.mjs check` refuses every missing-section directions artifact in its
  test suite and accepts the golden one.
- The example policy's `web` list resolves `directions` at phase 1 and `axe` at phase 7.
- All prior suites remain green; the new ones pass non-concurrently.
