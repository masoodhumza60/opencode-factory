# factory-gap-analysis.md — where the factory is strong, where it is weak, and what to change

Status: **assessment and proposal, not implemented.** Written 2026-10-20.
Inputs: the repository as it stands, six independent model reviews (enforcement,
product outcome, operations, red team, design, subtraction), and the industry
survey in `docs/factory-v2-model.md`.

The short version: the factory is **strong at sequence and state, weak at
substance and independence**. It can prove a run reached phase 7. It cannot
prove the phase produced anything, and it cannot prove anyone other than the
builder looked at it.

## 1. What exists today

| Area | Component | What it actually enforces |
|---|---|---|
| Phase state | `scripts/factory-phase.mjs` | enter/complete/status/next/handoff, monotonic order, gate creation, `--evidence` non-empty, `--booted` non-empty on phase 5 |
| Plan | `scripts/factory-plan.mjs` | JSON task graph, fingerprinted; the markdown plan is deliberately never parsed |
| Skills | `scripts/factory-skills.mjs` + `skills/catalog.yaml` | install/check/lock; **mandatory = `commit-work`, `skill-judge` only**; topics = brainstorming, skill-discovery, git-workflow, skill-review |
| Audit | `scripts/factory-selfcheck.mjs` | file presence, install currency, mandatory skills, MCP state |
| MCP | `scripts/factory-mcp.mjs` | scope/toggle/add/audit/handshake; handshake spawns a second instance |
| Verification | `skills/verify-app/SKILL.md` | a re-runnable boot and route check for a web app |
| Docs | `docs/conductor.md` (651 lines / 47 KB), `how-factory-works.md`, `discovery.md`, `mcp-judging.md`, `negative-results.md`, `plan-format.md` | doctrine |
| Commands | `commands/factory/{feature,onboard,selfcheck}.md` | entry points; `feature.md` records phases with free-text notes, not the phase machine |
| Tests | 9 `test-*.mjs` suites | the machine itself, not a product |
| Bundle-local skills | `skills/factory`, `skills/verify-app` | only two skills ship in the bundle |

Two facts frame everything below:

1. `cmdComplete` checks `if (!evidence)` (`factory-phase.mjs:583`). A single
   space passes. `cmdComplete` contains no gate check at all, so `complete 7`
   runs with Gate C still open.
2. The bundle installs two skills. The doctrine names eleven phase skills as
   MUST-invoke. The other nine are neither installed nor checked.

## 2. Scorecard against the target model

Status: **Strong** = artifact and mechanical check exist; **Partial** = some
mechanism, no teeth; **Weak** = prose only, builder-judged; **Missing** =
nothing at all.

| Discipline | Skill shipped | Installed / mandatory | Artifact required | Mechanical check | Independent judge | Status |
|---|---|---|---|---|---|---|
| Product / discovery | brainstorming (topic) | topic only | no brief, metric or kill criterion | no | Gate A, agent-framed | Weak |
| UX / UI design | none | no | no directions, rationale or critique | no | Gate C, agent supplies narrative | Missing |
| Front-end design | none | no | no width/state evidence | no CWV, visual diff or console check | no | Missing |
| Accessibility | none | no | no | no axe, contrast or keyboard check | no | Missing |
| Performance | none | no | no budget | no | no | Missing |
| Engineering / architecture | superpowers (not shipped) | no | spec/plan files, unbound | build and typecheck not checked by the phase machine | Gate B, agent-framed | Partial |
| Code review | requesting/receiving (not shipped) | no | none | phase 6 has no gate and no artifact | builder reviews itself | Weak |
| QA / SDET | test-driven, verification (not shipped) | no | `--booted` string | phase suite tests the machine; `testapps/` not run end-to-end | human reads tests | Partial |
| Security / AppSec | none | no | no threat model or ASVS checklist | no SAST, DAST, secrets, dependency, SBOM or authz checks | no | Missing |
| Privacy / data | none | no | no event schema, retention or consent | no PII-in-logs check, no licence scan | no | Missing |
| SRE / production readiness | none | no | no SLO, dashboard, rollback or runbook | no | no | Missing |
| Documentation | commit-work | yes | commit hygiene only | no link, command or changelog check | no | Weak |
| Release | commit-work | yes | none | `complete 7` is not gated by Gate C | Gate C prose | Weak |
| Support / on-call | none | no | no known-failure list or playbook | no | no | Missing |
| Red team / critic | none | no | ad hoc (this review) | no | no standing role | Missing |
| Supply chain | none | no | no SBOM or provenance | no | no | Missing |

Ten of sixteen disciplines are missing outright. None of the ten has a
skill, a topic, an artifact, or a check. That is the honest summary.

## 3. Strengths — keep these

The reviews were not uniformly negative, and the parts that work are worth
naming so a rewrite does not throw them away.

1. **A forward-only phase machine that refuses out-of-order transitions.**
   `enter N` requires `complete N-1`; the error messages name what is missing.
   This is better than most agent workflows, which have no state at all.
2. **The plan ledger is the right split.** Markdown for humans, JSON for beads,
   and the markdown is deliberately not parsed. Re-parsing prose is how task
   lists silently lose tasks.
3. **The `--booted` idea is correct.** Requiring contact with a running app,
   rather than inferring "it works" from a green suite, is the single best
   instinct in the system. It is defeated by a truthiness check, not by being
   wrong.
4. **`verify-app` turns a claim into a re-runnable artifact.** Keep the skill;
   point the machine at the artifact it produces.
5. **`negative-results.md` is an asset.** Very few projects record what they
   tried and shelved, with the control that proved it did not work. It is the
   reason this factory can be critiqued precisely.
6. **beads as the single state store.** One issue per feature, gates that hide
   work from `bd ready`, audit notes. Do not add a second store.
7. **Install idempotency tests and an install manifest.** The installer is more
   careful than most; its gaps are coverage, not intent.
8. **The project is willing to be red.** A suite that reports failure, and a
   culture that writes down retractions, is a precondition for improving.

## 4. Weaknesses — the five that matter

### W1. Strings are accepted as work (severity: critical)

Evidence:

- `factory-phase.mjs:583` — `if (!evidence) throw`; `" "` passes.
- `gate` accepts any 12-character string; `aaaaaaaaaaaa` resolves a gate.
- `complete 7` has no gate check, so a feature can be marked shipped while
  Gate C is open.
- `gatePending` returns `null` when the gate id is absent *and* when `bd gate
  list` fails, so a broken gate reads as "no gate".
- `ARTIFACTS` covers phase 2 only, checked on entry, by directory
  non-emptiness. A 0-byte file passes, and a previous feature's brainstorm
  satisfies the next one.

Consequence: roughly twenty commands walk a bead to "shipped" with no spec, no
plan, no code, no running app, and no human approval. This is not an exploit;
it is the shortest legal path.

### W2. Prose and code describe different factories (severity: critical)

- The conductor says phase skills are mandatory; the catalog lists two, neither
  of which is a phase skill.
- The conductor says resolving Gate C unblocks `complete 7`; the code never
  blocks it.
- `commands/factory/feature.md` records transitions as free-text notes, which
  creates no gates, while the conductor says to use the phase machine "not
  free-text notes".
- The conductor names eleven phase skills as MUST-invoke; the bundle ships two.

Consequence: an agent that follows the command file, rather than the phase
machine, creates no gates at all and every check stays green.

### W3. The builder grades itself (severity: high)

Phase 6 has no gate and no artifact. The only record is `--evidence
"reviewed"`. The human at Gate C receives the builder's screenshots, the
builder's URL, and the builder's answers to two prose questions. In the agency
run the builder measured a layout imbalance and called it "intentional
editorial layout"; there was no mechanism by which anyone else's judgement
could enter the record.

Consequence: the canonical failure — every phase passed, product judged boring
— is the expected output, not an accident.

### W4. There is no outcome loop (severity: high)

Nothing stores what the human thought after ship. There is no retrospective
phase, no verdict dimension, no consumer in discovery or evals. The evals grade
process predicates; in `factory-workspace/`, the with-skill run stops at Gate A
and the without-skill run implements the feature, and both are recorded as
passing because the assertion is about phase order, not product.

Consequence: the factory cannot learn from the one signal that matters.

### W5. The disciplines that catch bad products are absent (severity: high)

No design, frontend, accessibility, performance, security, privacy, SRE or
support skill exists in the catalog. There is no design topic, so discovery
cannot surface a design skill for a UI feature; the agency run had only `beads`
and `verify-agency` installed. There is no threat model, no CWV budget, no
axe run, no SBOM, no rollback drill, no SLO.

Consequence: "production ready" currently means "the build passed".

### Secondary weaknesses

- **Reading burden.** 651 lines / 47 KB, of which roughly 485 lines are
  enforced by code anyway, duplicated in another doc, or history. Unenforced
  prose is skipped under pressure; `verify-app` at phase 1 was skipped in a run
  that passed everything.
- **Distribution.** The documented install path is far behind the working
  branch; the installer crashes on a JSONC config; there is no uninstall; the
  Windows `npx` handshake fails. A second user cannot currently succeed.
- **Tests test the machine, not the product.** No suite boots the default
  `testapps/orderboard` and exercises a feature end to end.
- **A check can be unsatisfiable and nobody notices.** The guard added to stop
  vacuous gate tests greps output that `--quiet` suppresses, so it can never
  pass. A check must be run against a known-good subject before it is trusted.

## 4b. The superpowers skill set: declared, installed, enforced, used

The conductor names a MUST-invoke skill for every phase. Eight of the ten are superpowers skills. The check below separates four different claims that the word "mandatory" currently conflates.

| Phase | Skill the conductor says MUST run | In `catalog.yaml` | Installed by the bundle | Machine checks it | On this machine | In the last real run (`agency`) |
|---|---|---|---|---|---|---|
| 1, 2 | `brainstorming` | yes - **topic only** | no | no | yes | **no** |
| 3 | `writing-plans` | no | no | no | yes | **no** |
| 4 | `executing-plans` / `subagent-driven-development` | no | no | no | yes | **no** |
| 4 | `test-driven-development` | no | no | no | yes | **no** |
| 4' | `systematic-debugging` | no | no | no | yes | **no** |
| 5 | `verification-before-completion` | no | no | no | yes | **no** |
| 6 | `requesting-code-review` + `receiving-code-review` | no | no | no | yes | **no** |
| 7 | `finishing-a-development-branch` | no | no | no | yes | **no** |
| 7 | `commit-work` | yes - **mandatory** | yes | selfcheck only | yes | **no** |

Evidence, in order of how much it settles:

- `docs/conductor.md:36-47` is the table above, ending with "MUST invoke skill". The same file says at `:113-116` to verify the model "actually has the skill content, not just the name", and at `:126-127` that a skipped skill forces the phase to re-run.
- `skills/catalog.yaml` contains **one** superpowers entry: `brainstorming`, as an optional topic. The other eight phase skills appear nowhere in the data. `writing-plans`, `executing-plans`, `subagent-driven-development`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review` and `finishing-a-development-branch` are all absent.
- `scripts/factory-phase.mjs` contains **no occurrence of the word "skill"**. The phase table (`:27-38`) has `id`, `name`, `gate` - nothing else. A phase cannot require, record, or verify a skill.
- `node scripts/factory-skills.mjs check` prints **`PASS mandatory skills: 2/2 present`, exit 0** - on a machine where it would pass even if every phase skill were deleted. That is the whole mandatory story.
- **No `skills.lock.json` exists anywhere** - not in the bundle, not in `~/.agents`. `factory-skills.mjs record` has never run here, so discovery has no recorded output and "discovery found nothing" is indistinguishable from "discovery did not run".
- The last real run is decisive: `agency/.agents/skills/` contains `beads` and `verify-agency` only. Not one superpowers skill was installed, so the doctrine's "MUST invoke" was **impossible to obey for eight phases**, and every gate still passed.

The set is installed globally on this machine (`~/.agents/skills` has all ten), which is why this session can use them. That is the operator's environment, not the factory's doing: the bundle installs two skills, and the repo's own `.agents/skills` is empty.

**Verdict: the superpowers set is declared, not used.** Of the four claims - declared, installed, enforced, recorded - only the first is true. Four consequences follow:

1. On a clean machine the whole pipeline runs without them and no check notices.
2. "The right skill ran at the right phase" is unfalsifiable, because nothing records a skill name per phase.
3. Phase 6 - the review phase - can be completed without `requesting-code-review` or `receiving-code-review`, which is exactly the phase that let the builder grade itself.
4. A skill that is present but never required behaves like prose: it is available to an agent that already knows to look, and invisible to one that does not.

The fix is the `phase_engines` concept in section 8, plus a `--skill` record on `complete` and a gate that refuses without it. The test is simple and should be written before the mechanism: delete `writing-plans` from the skills directory, and the phase 3 entry must go red. Today it stays green.

## 4c. Skill sourcing: superpowers, pstack, and Matt Pocock

The question this section answers: does the new plan actually use the superpowers set, and should it add packs like pstack or Matt Pocock's skills?

**Superpowers: yes, and the plan is the right fix.** Section 8 lists all ten
under `mandatory` and makes a missing one an install failure, not a warning.
The factory never chose the wrong skills. It declared ten and installed two,
which is why the set looked absent from the runs rather than misapplied.

The harder question is whether to add more. Three packs, three different jobs:

| Pack | What it is | Job | Verdict |
|---|---|---|---|
| **superpowers** (`obra/superpowers`) | The phase loop: brainstorm, plan, execute, TDD, debug, verify, review, finish | **Phase engines** | Adopt all ten; install and check them |
| **Matt Pocock** (`mattpocock/skills`) | Alignment, domain language, spec/tickets, two-axis review, retro | **Reinforcement** | Adopt six; they fill gaps superpowers leaves |
| **pstack** (`backnotprop/pstack`, mirror of `cursor/plugins/pstack`) | Engineering principles + multi-model adversarial verification | **Principles and verification depth** | Adopt six principles, three skills |

All three resolve through the same source: **`skills.sh`** and the `skills`
CLI that `factory-skills.mjs` already calls. The classification is by need, not
by pack:

- **superpowers -> mandatory: the factory's operating loop.** Every run needs
  the phase skills, so they install with the factory, pinned and checked, and
  refresh when the factory itself is upgraded.
- **Matt Pocock and pstack -> sourcing references, not a second pipeline.**
  They are engineering capability, not project skills. Anything the factory
  would use on every run joins the operating set and is installed with it; a
  duplicate of a superpowers engine (`tdd`, `diagnosing-bugs`, a generic
  `code-review`) is never installed twice; the rest stay as references and are
  not installed.
- **Project skills -> the on-demand class.** `nuxt`, `nuxt-ui`, framework test
  tools, a design system for a public page: these belong to the project, install
  when the project's stack or an MCP server needs them, and are recorded in the
  project's `skills.lock.json`. An API-only project never pays for them.

So the catalog does not need a separate `phase_engines` section: one
`mandatory` list shipped with the factory, one `on_demand` list of project
skills with triggers.

### What each adds that the others do not

**Matt Pocock** is strongest exactly where the agency run failed:

- `grilling` / `grill-with-docs` - a relentless interview about the plan, plus a `GLOSSARY.md` and ADRs. This is the mechanism that asks "what does this replace?" and would have surfaced the placeholder/positioning ambiguity at G1.
- `domain-modeling` - a shared language, which also cuts token spend and makes naming consistent.
- `to-spec` / `to-tickets` - tracer-bullet tickets with declared blocking edges; maps directly onto the plan ledger.
- `code-review` - two axes, **Standards** and **Spec**, run as parallel sub-agents so neither lens pollutes the other. This is the review the factory's phase 6 never had.
- `prototype` - "several radically different UI variations toggleable from one route". This is the cheapest available answer to the design failure, and it belongs at G1, before the build.
- `retro` - suggests changes to the agent's environment after a session; a natural input to G4.

**pstack** is strongest on verification discipline and on encoding rules:

- `prove-it-works` - verify against the real artifact, not a proxy, a self-report, or "it compiles". The same principle as `--booted`, stated better.
- `sequence-verifiable-units` - small units, each ending in a verifiable state; matches the plan ledger and one commit per task.
- `encode-lessons-in-structure` - encode a rule as a lint, check, or script instead of more text. This is the factory's own lesson, written as a principle.
- `guard-the-context-window` - bulk work to subagents, summaries in the main thread.
- `blast-radius` - what else a small-looking change can break, proven by running code.
- `interrogate` (multi-model adversarial review), `arena` (N parallel attempts), `swarm` (N workers, one report) - the machinery behind the six-reviewer exercise, made repeatable at G3.
- `create-verification-skill` - generates a project-local verify skill; the `verify-app` idea generalised.
- `correct` - mines repeated corrections and fixes each at the highest level that works (architecture, types, lint, CI, tests, docs last). A G4 mechanism.

### What not to adopt

- **pstack's stance that planning is unnecessary** ("the best spec is code"). That is the philosophy of a senior engineer who already holds the design in their head. The factory exists for the case where nobody does; G1 and G2 are the product. Take pstack's verification, leave its planning philosophy.
- **`poteto-mode` as a router.** The factory is the router. Two routers compete and the agent follows whichever it read last.
- **All 24 principles.** That is 24 new pieces of prose, which is the disease. Take six; encode the rest as checks.
- **Duplicate engines.** pstack `tdd` vs superpowers `test-driven-development`; pstack `diagnosing-bugs` vs `systematic-debugging`; `interrogate` vs `requesting-code-review`. One engine per phase; reinforcements must not shadow an engine.
- **`arena` as a default.** N parallel attempts is the most expensive skill in the pack; use it for design directions, not every task.

### The rule that keeps this from becoming 47 KB again

A skill earns its place only if it has a **consumer** - a phase that loads it, or a gate that refuses without the artifact it produces. Nothing goes in the catalog because it is good.

Proposed reinforcement map:

| Gate | Reinforcement skills |
|---|---|
| G1 | `grilling`, `domain-modeling`, `prototype` |
| G2 | `to-spec` / `to-tickets`, `research` |
| G3 | `code-review`, `interrogate`, `blast-radius`, `prove-it-works`, `create-verification-skill` |
| G4 | `retro`, `correct`, `reflect`, `encode-lessons-in-structure` |

Cap: **10 phase engines + at most 8 reinforcements + the role skills the tier requires.** Everything else is reading burden.

### The gap this still leaves

Section 7 names twelve `factory-*` role skills but gives them no upstream source. Source before authoring: `frontend-design` and `design-taste-frontend` already exist on this machine, `nuxt-ui` exists for the stack, and WCAG/ASVS/PRR have authoritative sources. Author only where no good upstream exists - `factory-review` (the sealed critic) and `factory-release` (the DRI record).

The one-line diagnosis of how the factory deviated: **it shipped a doctrine it had no install step for.** Every pack above is installed and checked by its own ecosystem; the factory's own ten were installed by nobody.

## 5. Structural changes

Ordered by dependency, not by preference.

| # | Change | Why | Effort |
|---|---|---|---|
| S1 | **Completion requires attestations, not strings.** A phase completes when the tier's artifacts exist, hash-match, are current, and carry independent verdicts. | Removes the fake-ship path at its root | M |
| S2 | **Replace A/B/C with G1-G4.** G1 worth building, G2 ready to build, G3 ready to ship, G4 did it work. Phase 6 becomes the G3 review. | Gives review a gate and ship an owner | M |
| S3 | **Risk tier on the bead, chosen at G1.** `prototype`, `internal`, `public`, `regulated`. | Makes assurance affordable and proportional | S |
| S4 | **Evidence directory per bead** (`.factory/<bead>/manifest.json` plus artifacts). | One auditable unit; kills stale and 0-byte evidence | M |
| S5 | **A DRI per gate, and a role skill per discipline.** | A gate with no name is a committee, and committees rubber-stamp | M |
| S6 | **Conductor split:** routing and invariants stay; policy moves to `factory.policy.yaml`; role rubrics move to skills; history moves to `negative-results.md`. Target <= 250 lines. | Reading is a prerequisite for obeying | S-M |
| S7 | **One skill source of truth.** `catalog.yaml` gains the phase-engine table and design/security/qa/sre topics; `factory-skills.mjs check` FAILs, never WARNs, when a phase's skill is absent. | Ends the "mandatory by prose" claim | M |
| S8 | **Sealed reviewer.** Different session, preferably different model family, read-only tools, diff and artifacts only, verdict file with `could_not_verify`. Gate refuses `reviewer == builder`. | Independence cannot be a prompt instruction | S-M |

## 6. Tools to add

Adopt existing tools. Building a checker is how this repo got a divergence
metric that could not see divergence.

| Priority | Tool | Checks | Tier |
|---|---|---|---|
| P0 | evidence-manifest verifier (in `factory-phase.mjs`) | existence, sha256, freshness, commit alignment, reviewer identity | all |
| P0 | `--json` assertions in the phase tests | the machine's refusals, not its prose | all |
| P1 | Playwright | 3 widths, loading/empty/error/disabled states, traces, keyboard path | internal+ |
| P1 | axe-core (or pa11y) | WCAG 2.2 AA automated subset, contrast, target size, focus order | public+ |
| P1 | Lighthouse CI | LCP <= 2.5s, INP <= 200ms, CLS <= 0.1 at p75; bundle budget | public+ |
| P1 | visual regression (Playwright screenshots or Chromatic) | unintended visual change against the approved baseline | public+ |
| P1 | Semgrep (or CodeQL) | SAST | internal+ |
| P1 | gitleaks | secrets in the diff and history | all |
| P1 | osv-scanner / Trivy | vulnerable dependencies | all |
| P1 | Syft | SBOM | public+ |
| P2 | k6 (or autocannon) | load and latency budget | public+ |
| P2 | Stryker | mutation score on core logic, not line coverage | internal+ |
| P2 | dependency-cruiser | forbidden imports and layering | internal+ |
| P2 | Schemathesis | API contract and property tests | internal+ |
| P2 | OWASP ZAP baseline | DAST | public+ |
| P2 | OpenTelemetry + a dashboard | the SLO in the PRR is real | public+ |
| P3 | SLSA provenance + signed release | artifact-to-source binding | regulated |
| P3 | DORA collector | recovery time, rework rate, lead time | all, after G4 exists |
| P3 | link checker + runbook executor | docs that work | public+ |

Not tools: a "design score", an LLM quality judge as a gate, a divergence
metric, a component counter used as a quality proxy. Those were tried or
proposed and all fail the same test: they output a number that looks like
judgement.

## 7. Skills to add

Each skill is a short rubric plus the commands it runs. It does not restate
doctrine; it answers one role's question and leaves one artifact.

| Skill | Role | Artifact | Gate | Install policy |
|---|---|---|---|---|
| `factory-product` | product / researcher | brief with user, alternative, metric, kill criterion | G1, G4 | topic `product`, required at G1 for every tier |
| `factory-ux` | UX / UI designer | 2-3 directions, rationale, rejected alternatives, critique record | G1, G3 | topic `design`, required for any user-facing tier |
| `factory-frontend` | front-end designer / engineer | width and state evidence, visual baseline, CWV and bundle numbers | G3 | topic `frontend`, required when a UI framework is a dependency |
| `factory-accessibility` | accessibility | WCAG 2.2 AA conformance record with axe output and keyboard script | G3 | topic `accessibility`, required `public`+ |
| `factory-security` | AppSec | threat model per trust boundary, ASVS checklist, scan results, SBOM | G2, G3 | topic `security`, required `internal`+ |
| `factory-qa` | QA / SDET | test strategy mapped to acceptance criteria, flaky quarantine | G2, G3 | topic `testing`, required every tier |
| `factory-sre` | SRE / production readiness | PRR: SLO, dashboard, alerts, runbook, rollback drill, restore drill | G3 | topic `sre`, required `public`+ |
| `factory-review` | independent critic / tech lead | findings with reproductions, verdict, `could_not_verify` | G2, G3 | **mandatory** — every run needs a reviewer |
| `factory-release` | release manager / DRI | signed release record: commit, tag, artifact hash | G3 | topic `release`, required every tier |
| `factory-data-privacy` | data / privacy / legal | event schema, retention, consent, licence scan | G2, G3 | topic `privacy`, required `regulated` |
| `factory-docs` | tech writer | README, runbook, changelog, API docs | G3 | topic `docs`, required `internal`+ |
| `factory-redteam` | red team | attack report with reproducible paths | G3 | topic `redteam`, required `regulated`, optional otherwise |

Phase engines are not role skills. They are the procedures the phases run and
must be declared as such (see below).

## 8. Mandatory list and catalog structure

Today `skills/catalog.yaml` has `mandatory` (2 entries) and `topics` (4
entries). The doctrine's phase table was never transcribed into it. The
catalog's job is simpler than the current file suggests: **skills.sh is the
source, and there are two classes of skill.**

**Class 1 — mandatory: the factory's own operating skills.** Installed onto the
machine by the factory installer from a pinned source, verified by selfcheck,
enforced at phase entry, and refreshed when the factory itself is upgraded.
This is the superpowers spine plus the two hard skills plus the independent
critic. A machine missing any of them is not factory-ready and the install
fails. These are *not* project skills: they are what the factory needs in order
to run any feature at all.

**Class 2 — on demand: project skills.** Installed only when the project needs
them, resolved from skills.sh at install or discovery time. A Nuxt + Nuxt UI
project such as `bio-link` needs `nuxt` and `nuxt-ui`; an API-only project does
not, and never pays for them. Triggers are the project's stack, an MCP server
that is present, or the feature's risk tier. Every install is recorded in the
project's `skills.lock.json` with source, resolved ref, hash, reason and phase.
Nothing is fetched at run time.

The distinction that keeps this honest: a project skill can be *absent from the
factory's operating set* and still be *required by this project's gates*. A
public feature cannot pass G3 without design and accessibility skills; its
lockfile must name them. The catalog declares the triggers; the run's policy
decides what is required.

Proposed shape (requires a parser change in `factory-skills.mjs`, which is
deliberately strict; do not hand-edit the YAML and hope):

```yaml
version: 3
source: skills.sh

mandatory:                        # shipped with the factory, pinned, checked
  - name: skill-judge             # 1
  - name: brainstorming           # 1,2
  - name: writing-plans           # 3
  - name: executing-plans         # 4
  - name: test-driven-development # 4
  - name: systematic-debugging    # 4p
  - name: verification-before-completion  # 5
  - name: requesting-code-review  # 6
  - name: receiving-code-review   # 6
  - name: finishing-a-development-branch  # 7
  - name: commit-work             # 7
  - name: factory-review          # 6,7 - the independent critic

on_demand:                        # resolved from skills.sh when a trigger fires
  - name: nuxt-ui
    trigger: { stack: [nuxt], mcp: [nuxt-ui] }
  - name: frontend-design
    trigger: { tier: [public] }
  - name: wcag-audit
    trigger: { tier: [public, regulated] }
  - name: threat-modeling
    trigger: { tier: [public, regulated] }
  - name: prr
    trigger: { tier: [regulated] }
```

`phases:` on a mandatory entry is what the phase machine enforces
(`complete <n> --skill <name>`). `trigger:` on an on-demand entry is what
discovery evaluates. Phase 8 is the session-close protocol and has no skill of
its own.

Decisions embedded here:

- **Mandatory means shipped, not mentioned.** Everything above installs with the
  factory; a missing one fails the install, and the phase machine refuses to
  enter that phase. This is the fix for §4b: the doctrine's phase table becomes
  data the installer reads. Skills adopted from §4c that the factory uses on
  every run join this same list - they are engineering capability, not project
  skills.
- **Optional means on demand, not optional for the run.** Design and security
  doctrine in an API-only run is noise, so they are not globally mandatory. But
  a tier that requires them makes them *run-mandatory*: the gate refuses
  without the skill and its artifact. That is stronger than a global list and
  cheaper to run.
- **One source, pinned.** skills.sh resolves the name; the lockfile records the
  exact source, ref and hash. `npx --yes skills add` at run time is how
  unpinned third-party instructions get executed; pin at install, verify at
  selfcheck, never fetch mid-run.
- **`factory-review` is mandatory**, because independence is the one thing every
  run needs and the current system has no way to provide it.
- **Mandatory skills are versioned with the factory, not with the project.**
  `catalog.yaml` carries the factory release; `factory upgrade` refreshes the
  installed operating set; the lockfile records which factory version supplied
  it; selfcheck fails when the installed set and the catalog release disagree.
  Project skills are versioned per project, in the project's own lockfile.

## 8b. MCP servers: installed globally, enabled per run

The same two classes apply to tools, and the factory currently conflates three different states.

| State | Meaning | Where it lives |
|---|---|---|
| **Installed** | Present on the machine, with credentials: GitHub, Etincel, browser and dev-tool servers | Machine config, installed with the factory, versioned with it |
| **Enabled** | Toggled on for this project or run | Project config, default off, reason recorded |
| **Used** | Actually called, with evidence | The run's evidence manifest |

Rules:

1. **Global install, project toggle.** A server definition belongs to the machine. The repository carries a name and an enabled flag, never a command line or an absolute path - those are machine-specific and leak the operator's filesystem into a repo.
2. **Default off.** `disabled: true` is the resting state. Enabling is a deliberate act, recorded with the reason and the phase that needed it. This is the MCP analogue of an on-demand skill: installed is not enabled, and enabled is not used.
3. **Audit the effective config.** Merge global and project before judging. "Installed, not enabled here" is a normal state and must not be reported as unverified or failed.
4. **`add` never auto-enables.** Installing a server and turning it on are two separate decisions, and the second one is the human's.
5. **Triggers map to gates.** GitHub -> review and release evidence (PR, required checks). Etincel -> copy and documentation quality. Browser/dev-tool servers -> G3 visual and interaction evidence. `nuxt-ui` -> the project on-demand class.
6. **Toggling is also context control.** An always-on server's tools occupy the tool namespace in every session, whether or not they are called.

Current defects this replaces, all confirmed in the review: `factory-mcp.mjs audit` grades only the global map (`:439`) and labels user-owned enabled servers as unverified (`:435,486`); human mode exits 0 when `ok:false` (`:488-494`); `scope` writes absolute machine paths into the project config; `add` writes `disabled:false` against the repo's own rule that nothing installs automatically; and the shipped `config/mcp-requirements.json` comment describes the opposite of what the code does.

Falsifier: with a server installed and disabled, its tools must not appear in the run, and the audit must print "installed, disabled for this project" and exit 0 - not "unverified".

## 9. Priority order

| Priority | Work | Exit criterion |
|---|---|---|
| **P0** (days) | Four fake-ship holes; the unsatisfiable test guard; manifest for one phase | `complete 4 --evidence " "` fails; `complete 7` with Gate C open fails; deleting `gate_a` blocks `enter 3`; the guard passes against a known-good setup |
| **P1** (1 week) | Risk tiers; G3 independent reviewer; `factory-review`; G4 record | A run cannot reach shipped without a reviewer session different from the builder's |
| **P2** (2 weeks) | Design, frontend, accessibility, security, QA, SRE skills; policy file; evidence manifest for all gates | A `public` run without axe, CWV, visual diff or threat model is refused at G3 |
| **P3** (3-4 weeks) | Tool wiring (Playwright, axe, Lighthouse, Semgrep, gitleaks, osv, Syft); evals on `testapps/`; conductor cut; tagged release | Clean-machine install on Windows and Linux; evals score the product, not the process; conductor <= 250 lines |

P0 is not optional and should not wait for any design decision below. The rest
can be sequenced.

## 10. Definition of done for the factory itself

The factory should be judged the way it judges products:

1. **Fake ship is impossible.** The twenty-command path fails at four
   independent points, each with a test.
2. **Independence is structural.** `reviewer == builder` is refused, and the
   reviewer's verdict names what it could not verify.
3. **Assurance is proportional.** A prototype costs minutes; a
   `regulated` feature costs a PRR, an ASVS checklist and a restore drill.
4. **The product is measured.** Evals run the pipeline on `testapps/` with
   hidden acceptance tests and score acceptance, accessibility and performance
   — not phase order.
5. **The loop closes.** Every ship writes a G4 record; the record changes the
   next run's evals or `negative-results.md`.
6. **A second person can install it.** Tagged release, JSONC-safe merge,
   uninstall, Windows and Linux.
7. **The reading fits.** Conductor <= 250 lines, and every remaining line is
   either an invariant or a route to an artifact.
8. **Gates sometimes say no.** Over ten runs, at least one gate rejects and the
   rejection changes the work. A gate that never rejects is decoration.

## 11. Decisions needed from the operator

1. **Default tier** for a new feature: `prototype` (fast, low assurance) or
   `internal` (safer default)?
2. **Reviewer model policy**: which model families are acceptable as
   independent reviewers, and is a different family required or preferred?
3. **Build vs adopt**: confirm the tool list in section 6 is adopted rather
   than reimplemented.
4. **G4 blocking** — resolved: `complete 8` is refused when no G4 record exists; the record's content is judged by a human later, and "not measurable, here is why" is a valid record.
5. **Conductor cut**: do it now, or after the gates are real? (Recommendation:
   after P1, so the cut removes prose that the machine has already replaced.)
