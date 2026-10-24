# Factory roadmap: from demo machine to production factory

Status: proposed. Nothing here is implemented. This document sequences the changes described in
`factory-gap-analysis.md` and `factory-v2-model.md` into work that can be done, tested, and refused.

## 1. What "real" means

A toy factory produces an app that runs on the author's machine and looks finished in a screenshot.
A real factory produces software that survives contact with users. Any feature it ships must satisfy
all of the following, or the ship gate refuses it:

| Property | Evidence required |
|---|---|
| **Deployed** | A reachable URL, environment config, secrets outside the repo, deploy command recorded |
| **Keeps data** | Schema, migration up **and** down, backup/restore drilled once |
| **Handles the unhappy path** | Authz tests, validation, loading / empty / error / disabled states |
| **Observable** | Logs, metrics, traces, a dashboard, an alert, a runbook someone else can follow |
| **Reversible** | Rollback exercised, migration backout proven, feature flag where the change is risky |
| **Usable by everyone** | the accessibility record its profile requires: WCAG 2.2 AA for web, platform assistive APIs for mobile/desktop, screen-reader-friendly output for a CLI; "not applicable, because …" signed at G1 for a machine interface |
| **Fast** | the profile's budget, measured at the profile's percentile: CWV p75 for web, p95/p99 for an API, startup and RSS for a CLI, frame time for a game, flash/RAM for embedded |
| **Safe** | Threat model, ASVS L2 checklist for public/money tiers, scans clean, SBOM |
| **Independently reviewed** | Reviewer session != builder session, findings, verdict, `could_not_verify` list |
| **Outcome recorded** | Metric before/after, defects found after ship, recovery time, what changes next |

The last row is the one the current factory has no concept of, and it is the row that makes the
factory improve instead of repeat.

## 2. The one architectural change

Stop treating a phase as something you pass. Treat it as a set of attestations that must exist and
verify:

> **artifact + independent reviewer + verdict + timestamp + commit**

Everything else in this roadmap is a consequence of that sentence.

## 3. Milestones

### M0 - Stop the lying (3-5 days)

The evidence layer currently accepts `" "` as proof. Nothing else matters until that is false.

1. Reject whitespace-only and content-free evidence. Phase 5 additionally requires `--ran` in the shape
   `command -> observed result at <ISO-8601 time>` plus `--artifact` naming a file that exists.
2. `--ran` must name a launch command, an observed result, a timestamp, and an evidence path that exists. `--booted` remains an accepted alias for one release and prints a deprecation line.
3. Gate resolution requires a recorded `close_reason`; a gate resolved through raw `bd gate resolve`
   is treated as unresolved by every gate-dependent transition.
4. `complete 7` refuses while Gate C is open.
5. Gate metadata fails closed: a missing gate id for a gate-bearing phase means pending, not absent.
   If gate creation fails, roll the phase back.
6. Fix the test harness: return stdout **and** stderr on success and failure; never assert on a line
   that `--quiet` suppresses; create the brainstorm fixture in the gate-command setup.
7. Add negative tests for every string above: `" "`, `"x"`, `aaaaaaaaaaaa`, raw resolve, open Gate C,
   missing metadata, 0-byte brainstorm.

**Exit:** the ~20-command fake-ship path fails at the first missing artifact. Suite green on Windows
and Linux.

Prove the exit criterion with:

```bash
node scripts/test-factory-phase.mjs   # 143/143 phase-machine tests passed.
node scripts/test-fake-ship.mjs       # 6/6 fake-ship paths refused.
```

### M1a — mechanical attestation (4–5 days) — **shipped**

1. [x] `.factory/<bead>/manifest.json`: every artifact with path, sha256, producing command, producer
   session, timestamp, and commit.
2. [x] `node scripts/factory-attest.mjs attest <bead> <path> --id <check> --kind <kind>` records an
   artifact; `… verify <bead> [--phase <n>] [--json]` checks existence, hash, freshness
   (commit == HEAD), completeness against policy, and independence.
3. [x] Policy-required manifest: when `config/factory.policy.yaml` exists, `complete <n>` refuses unless every check declared for that phase has an attested artifact whose hash, freshness and producer still match. With no policy file the M0 evidence predicate still applies, so an unconfigured repo behaves exactly as it does today.
4. [x] `config/factory.policy.example.yaml`: tier plus required checks. Four tiers: `prototype` (3
   checks), `internal` (6), `public` (13), `regulated` (20). Effective checks are
   `tiers[tier].checks ∪ profiles[profile].checks`; a bead's `tier`/`profile` metadata overrides the
   file. Shipped as an example only — this repo runs no active policy on purpose.

- [x] `trail.jsonl`: append-only, one event per line — `attest`, `verify`, `refusal`, `complete`.

**Exit:** a phase cannot complete without its artifacts; a prototype needs three checks and a
payments feature needs twenty, from the same policy file.

**What M1a cannot prove:**

- A hash proves the file did not change *after* attestation, not that the recorded `command`
  produced it.
- `producer_session` is self-declared until the reviewer session exists (M1b).
- `FACTORY_SESSION` is not a secret; a builder can claim any session identity.
- A hand-edited manifest that rewrites `sha256` and `commit` will verify — the manifest is
  validated for shape, not authenticated.

**One root, two readers.** `attest` and `complete` share `isWorkspaceBeads`
(`scripts/factory-manifest.mjs`): a `.beads` directory with no database is walked past by
both, and an explicit `BEADS_DIR` is trusted by both exactly as given. They cannot anchor
on different roots; pointing `BEADS_DIR` at a directory with no database is refused by
`bd` itself, not silently redirected.

Prove the exit criterion with:

```bash
node scripts/test-factory-phase.mjs     # 143/143 phase-machine tests passed.
node scripts/test-fake-ship.mjs         # 6/6 fake-ship paths refused.
node scripts/test-factory-manifest.mjs  # 25/25 manifest tests passed.
node scripts/test-factory-policy.mjs    # 59/59 policy tests passed.
node scripts/test-factory-attest.mjs    # 82/82 attest tests passed.
```

### M1b — review and independence (1–1.5 weeks)

- `protected_files`: the builder cannot edit the grading machinery (permission rule plus install-manifest hash).
- Per-role write globs: the reviewer writes only its own verdict file.
- `phase_ok` vs `accepted`: completing a phase is not accepting its output.
- Human verdicts carry a channel the agent cannot write.

1. `factory review` runs a reviewer in a separate session and preferably a different model family,
   read-only, given the diff and artifacts rather than the builder's narrative. It writes
   `review.md` with findings and a `could_not_verify` list.
2. Gate refuses when `reviewer_session == builder_session`.
3. Gate remap per `factory-v2-model.md`: Gate A becomes `G2a`, Gate B becomes `G2b`, Gate C becomes
   `G3`, and `G1` / `G4` are new; old gate letters stay as accepted aliases.

**Exit:** self-review is refused; nothing is accepted on the builder's word alone.

### M2 - The disciplines that make it real (2-3 weeks)

Each item is a role skill plus mechanical checks plus a gate refusal. Do them in this order, because
each one depends on the manifest from M1.

1. **Project skill resolution (on demand).** `factory-skills.mjs resolve` reads the project stack and
   MCP servers, resolves `nuxt`, `nuxt-ui`, framework test tools and design skills from skills.sh,
   pins them in the project's `skills.lock.json`, and records the reason. Nothing is fetched at run
   time; an API-only project never installs UI skills.
2. **Design (human interfaces only).** Directions artifact: two or three named directions, the chosen one,
   the rejected ones and why; a prototype route with radically different variations; a critique
   record at G1 and G3. Mechanical floor where the profile has a visual surface: declared tokens
   must be consumed, at least K library components in interactive contexts, no rows of identical
   cards, a bounded type scale. An API, CLI, library or infra change declares "no visual surface"
   at G1 and is reviewed on interface clarity instead.
3. **Interface engineering.** Runtime evidence at the sizes, states and inputs the profile defines.
   `web`: Playwright at 1440 / 768 / 390, visual baseline plus diff, state coverage, zero console
   errors, bundle budget, CWV at p75. `mobile` / `desktop` / `game`: the platform driver, device or
   window captures, and the same state discipline. `api`: contract and error-matrix tests plus a
   load result. `cli`: golden files, exit codes and a TTY transcript. `library`: API diff and a
   downstream consumer build. `infra`: plan diff and a policy check.
4. **Accessibility (human interfaces only).** The standard the profile names: WCAG 2.2 AA with
   axe-core, keyboard traversal, visible focus, 24x24 targets and contrast for `web`; platform
   assistive APIs for `mobile` / `desktop`; screen-reader-friendly output and no colour-only meaning
   for `cli`. Machine interfaces are judged on interface clarity by a human, not by axe-core.
5. **Security.** Threat model per trust boundary (STRIDE), plus the profile's baseline: ASVS L2 for
   public or regulated `web` and `api`, MASVS for `mobile`, code signing and update integrity for
   `desktop` and `embedded`, supply chain and licence for `library`. Authz/IDOR tests, Semgrep,
   gitleaks, osv-scanner, SBOM; headers and rate limits where they apply; SLSA provenance when
   deployed.
6. **QA.** Acceptance-criteria traceability matrix, no skipped tests in a release, flaky quarantine,
   mutation score on core logic, contract tests, and hidden acceptance tests written by the
   orchestrator - never by the builder. Test tools are the profile's, not web's.
7. **SRE / operability.** SLOs for long-running services; crash reporting and update health for
   `mobile` / `desktop`; registry, semver and deprecation policy for `library`; drift detection and
   rollback for `infra`; watchdog and recovery mode for `embedded`. Dashboard, alerts with runbooks,
   rollback drill, backup/restore drill where state exists, load test where load exists. PRR signed
   by someone outside the build.

**Exit:** a `public` run either produces the evidence its **profile** requires, or is refused at G3.
A `public` `api` run is not forced to produce screenshots; it is forced to produce contracts, authz
tests and a load result. A `public` `library` is forced to produce an API diff and a consumer build.
See `docs/factory-domain-profiles.md` for all ten profiles.

### M3 - Real delivery (1 week)

This is the milestone that separates the factory from a demo generator.

A product with several surfaces ships them in a **defined order**, not all at once. The release
record carries a compatibility matrix: each surface, its version, the oldest contract it can still
talk to, and whether it is live, in review or phased. Additive changes ship server-first; a
breaking contract change needs a dated migration window agreed at G2. Mobile and desktop lag on
purpose (store review, staged rollout, users who never update), so the API must support the oldest
client still in the field. Rollback is per surface: redeploy, traffic shift, halt rollout, previous
installer, revert plan.

1. A deploy step with a real target: environment, secrets, migrations, post-deploy smoke test against
   the deployed URL.
2. Rollback exercised at least once per run, not documented.
3. Feature flags for risky changes; migration backout tested.
4. Observability wired: structured logs, a metric, a trace, one dashboard, one alert that fires in a
   drill.
5. Support handoff: known-failure list and a support playbook.

**Exit:** the ship gate requires a deployed URL and a rollback record. "It builds" is no longer
sufficient to ship.

### M4 - Make it learn (2 weeks)

1. **G4 outcome gate.** Record the metric before and after, defects found after ship, recovery time,
   and rework. G4 blocks `complete 8` on the **existence** of an outcome record (what changed, measured before and after, or an explicit "not measurable, here is why"). The record's content is judged by a human later; a missing record is a refusal, not a warning.
2. Feed G4 into `negative-results.md`, discovery ranking, and the eval suite.
3. **End-to-end evals** on `testapps/`: the whole pipeline runs against a seed app with hidden
   acceptance tests, so the factory itself has a regression suite.
4. Calibrate the review model against human labels; record agreement; an LLM judge is a finding
   generator, never the sole sign-off.
5. Factory metrics: lead time, change failure rate, recovery time, rework rate.

**Exit:** changing a factory rule can lower the eval pass rate, and the change is caught before it
ships.

### M5 - Distribution and trust (1 week, parallel)

1. Versioned release: tag, changelog, pinned install, `factory upgrade` refreshes the mandatory
   operating set, lockfile records the factory version.
2. Install/uninstall, backup before rewriting the global config, JSONC-safe merge.
3. Clean-VM test on Windows and Linux, with the phase suite in CI.
4. Push the outstanding commits, tag v1, point the README at the tag instead of `master`.

**Exit:** a stranger on a clean machine installs, runs the suite, and gets the same result.

### M6 - Cut the conductor (3 days, after M2)

Move enforced detail to one-line pointers, history to `negative-results.md`, and leave only routing
and the human gates. Target: 651 lines -> at most 250.

**Exit:** every remaining line is either a rule the machine enforces, a human gate instruction, or a
pointer. Anything else is deleted.

## 4. Order and dependencies

| Milestone | Depends on | Effort | Why here |
|---|---|---|---|
| M0 Stop the lying | none | 3-5 d | Every later check is meaningless while a string counts as work |
| M1a Mechanical attestation | M0 | 4–5 d | Gives the later disciplines something to attach evidence to |
| M1b Review and independence | M1a | 1–1.5 wk | The generator cannot grade itself |
| M2 Disciplines | M1, project skill resolution first | 2-3 wk | The actual gap: design, security, accessibility, performance, QA, SRE |
| M3 Real delivery | M2 (partly parallel) | 1 wk | Converts "it builds" into "it runs and can be undone" |
| M4 Learning loop | M1, M3 | 2 wk | Makes the factory improve rather than repeat |
| M5 Distribution | M0-M1 | 1 wk, parallel | Without it there is no second user |
| M6 Conductor cut | M2 | 3 d | Subtracts only after the checks exist elsewhere |

Realistic total to a verified web+api factory: 13–15 weeks. Ten-profile coverage is a later stream, not part of M2.

## 5. First ten commits

Small, each independently testable, in this order:

1. CI workflow running the phase suite on Windows and Ubuntu.
2. Test harness returns stdout and stderr always; gate-command setup creates its fixture.
3. Evidence validation: reject whitespace and content-free strings.
4. Gate `close_reason` enforcement and rejection of raw resolves.
5. `complete 7` requires Gate C.
6. Gate metadata fails closed; phase rollback on gate-create failure.
7. Manifest schema and `scripts/factory-attest.mjs attest`.
8. `complete` verifies the manifest.
9. `factory.policy.yaml` plus tier defaults.
10. Reviewer independence check (`reviewer_session != builder_session`).

## 6. What we build

- `scripts/factory-attest.mjs` - manifest record and verify.
- `scripts/factory-review.mjs` - independent reviewer, diff in, verdict out.
- `scripts/factory-eval.mjs` - end-to-end pipeline evals with hidden acceptance tests.
- `config/factory.policy.yaml` - tiers, required roles, required checks.
- `skills/factory-*` - one role skill per discipline, each short, each with commands.
- `skills/catalog.yaml` v3 - `mandatory` (factory operating set, shipped and refreshed) and
  `on_demand` (project skills, resolved and pinned per project).
- Phase machine changes: evidence validation, gate checks, manifest verification, skill recording.
- Test changes: negative tests for every refusal, harness fix, CI.

## 7. What we do not build

- An automated taste score or a design pass/fail. Enforce the floor, require a critique.
- An LLM judge as the only sign-off. It finds; a human or an independent reviewer signs.
- A second task tracker or evidence store. Extend beads and the manifest.
- ASVS L2 / PRR on a prototype. Tiering is the point.
- A replacement for Playwright, axe, Semgrep, Lighthouse. Adopt, pin, and wire them.
- More prose. A new rule must be a check that can fail, or it is deleted.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Scope explosion | Tiers: prototype gets three checks, regulated gets twenty |
| Tool fragility on Windows | Pin versions, run CI on two OSes, `shell: true` for `.cmd` shims |
| Reviewer model agrees with itself | Different model family, diff-only input, human sign-off on irreversible changes |
| Cost | Operator-set policy budget, opt-in, never a guessed default |
| The conductor grows again | M6 is a hard gate: no new prose without deleting an equal amount |

## 9. The test of success

The factory is real when this sentence is true:

> A feature can go from an idea to a deployed, observable, accessible, secure, reviewed service with
> a recorded outcome - and any missing piece refuses the ship rather than being described in a note.

Today it is false at the first clause. M0 through M3 are what make it true.
