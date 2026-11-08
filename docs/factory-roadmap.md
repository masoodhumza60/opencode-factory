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

Prove the exit criterion with (counts as they stood at M0; the current numbers are in the M1c block below):

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
node scripts/test-factory-phase.mjs     # 173/173 phase-machine tests passed.
node scripts/test-factory-fixture.mjs   # 20/20 fixture tests passed.
node scripts/test-factory-design.mjs    # 12/12 design tests passed.
node scripts/test-factory-capture.mjs   # 24/24 capture tests passed.
node scripts/test-factory-skills.mjs    # 44/44 skills tests passed.
node scripts/test-fake-ship.mjs         # 6/6 fake-ship paths refused.
node scripts/test-factory-manifest.mjs  # 26/26 manifest tests passed.
node scripts/test-factory-compliance.mjs # 33/33 compliance tests passed.
node scripts/test-factory-policy.mjs    # 77/77 policy tests passed.
node scripts/test-factory-attest.mjs    # 112/112 attest tests passed.
node scripts/test-factory-review.mjs    # 83/83 review tests passed.
node scripts/test-factory-protect.mjs   # 17/17 protect tests passed.
node scripts/test-factory-delivery.mjs   # delivery tests passed.
```

The capture suite prints `SKIPPED: no browser` and exits 1 if no browser is available; a skip is not a pass.

The counts are kept current with the last shipped milestone (M3); each suite's
number only ever grows, so a stale count here is a doc bug, not a weaker claim.

### M1b — review and independence (shipped)

- `protected_files` — `config/factory.protected.json` pins the five grading scripts by sha256;
  `complete 7` refuses a changed script, and re-baselining needs `FACTORY_ROLE=human` plus a commit.
- Per-role write scope — `factory-review start` snapshots `git status` (with a sha256 per dirty
  path) and `record` refuses any change outside the reviewer's own verdict file.
- `phase_ok` vs `accepted` — `complete 7` needs the signed tag `factory-accept/<bead>`,
  made by `factory-review accept` from a human session (a file at M1b, a signed git tag since
  M1c); `complete 8` needs an outcome record.
- Independence — the builder session is frozen at the first manifest write, and `review record`
  refuses a verdict recorded from it.

1. `scripts/factory-review.mjs start|record|show` — the reviewer reads
   `.factory/<bead>/review-package.md` (commit range, diff, attested artifacts, policy checks; no
   `.superpowers/` narrative) and writes one `review*.md` with a single `Verdict:` line.
2. `accept|withdraw` — the human act, made as an annotated SSH-signed tag
   `factory-accept/<bead>` beside the review rather than inside the phase state.
3. The review is enforced as a G3 artifact at phase 7, which is what `factory-v2-model.md` already
   describes. The gate **renaming** (G1 / G2a / G2b / G3 with A / B / C as aliases) is **M1c**, not
   M1b: it changes names, not assurance, and shipping it untested would have bought nothing. M1c
   has since shipped in its own right — see the M1c section below.

**Exit:** self-review is refused; nothing is accepted on the builder's word alone.

**What M1b cannot prove.** Identity is declared, not proven: `FACTORY_SESSION` and `FACTORY_ROLE`
are environment variables, so an agent with shell access can claim to be a reviewer or a human.
At M1b an acceptance was a file, not a signature; M1c made it a signed tag. The reviewer's write
scope is checked after the fact
and cannot see gitignored paths. The protected set detects an edited grading script and leaves a
trail; it does not prevent the edit.

### M1c — gates and a human signature (shipped)

- Gates are named `G1`, `G2a`, `G2b`, `G3`; `A`, `B`, `C` remain accepted aliases that resolve to
  the same bead dimensions, so no existing gate record had to be migrated. `G1` is required by
  `complete 1` only when a policy file exists.
- Acceptance is an annotated, SSH-signed git tag `factory-accept/<bead>` at the reviewed commit,
  verified against `config/factory.allowed_signers`. `acceptance.json` is gone; `withdraw` deletes
  the tag.
- When `config/factory.allowed_signers` exists, the commit that last changed
  `config/factory.protected.json` must itself be signed by an allowed signer.

**Exit:** a gate name is no longer a letter someone remembered, and an acceptance is a signature
that git can check, not a JSON file the agent could write.

**What M1c cannot prove.** Key custody is the guarantee: an agent that can read the private key, or
an unlocked agent, can sign. `allowed_signers` is trust-on-first-review — a public key committed
without review is trusted. Deleting `.factory/<bead>/` still restarts the record, and a tag can be
replayed onto an older signed commit. The signature proves *who could sign*, not *what they read*.

### M2 - The disciplines that make it real (2-3 weeks) - **in progress, M2a and M2b shipped**

Each item is a role skill plus mechanical checks plus a gate refusal. Do them in this order, because
each one depends on the manifest from M1.

**M2a shipped the machinery this list runs on** - skill resolution (item 1), profile check lists as
data, and hidden acceptance tests (part of item 6). **M2b shipped the human-surface mechanisms** -
directions, capture and `axe`. M2c remains; see *M2a - the mechanisms* and *M2b - human surfaces*
below for what is done and what is owed.

1. **Project skill resolution (on demand).** `factory-skills.mjs resolve` reads the project stack and
   the policy's profile, resolves the matching skills from `skills/catalog.yaml`, pins them in the
   project's `skills.lock.json`, and records the reason for each. Nothing is fetched at run time; an
   API-only project never resolves UI skills.
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

#### M2a - the mechanisms (shipped)

Four mechanisms, each a refusal rather than a paragraph:

1. **Skill resolution has a record.** `node scripts/factory-skills.mjs resolve`
   reads `skills/catalog.yaml` and the project's `config/factory.policy.yaml` and
   writes `.agents/skills/skills.lock.json`: every resolved skill with its
   version and its reason (`mandatory`, `profile=web`, `stack=rust`, `default`),
   every skip with its reason. It is catalog-local, so the answer is reproducible
   offline; 43 skills resolve on this repo. Commit `90d42c6`.
2. **Profiles are data, not prose.** `config/factory.policy.example.yaml`
   declares all ten profiles and the four tier lists; `factory-policy.mjs` unions
   the tier's checks with each profile's, dedupes, and answers the same set the
   docs promise - `prototype+web` 6, `public+api` 15, `regulated+data-ml` 22.
   Commit `c434f0e`.
3. **Hidden acceptance tests are the orchestrator's.** A builder who can read the
   policy can target it, so end-to-end acceptance lives outside the builder's
   reach: attested as `--kind hidden-tests` under `.factory/<bead>/hidden/`, only
   with `FACTORY_ROLE=orchestrator` and a named session, and required by
   `complete 7` with a hash that still matches and a `producer_session` that is
   not the manifest's `builder_session`. A verdict may not itself be a hidden
   test. Commit `1229e7f`.
4. **The evidence vocabulary is closed.** One exported list -
   `DECLARABLE_KINDS` in `factory-policy.mjs` - and attestation derives what it
   accepts from it, so a policy can no longer declare a kind nothing can carry
   (the example's `authz`, `signing` and `load` checks were unsatisfiable before
   this). `verify` also refuses an artifact whose kind is not the kind its check
   declares: `check "shot" needs a screenshot artifact; the manifest has
   transcript (…)`. Commit `0ff2b13`.

**What M2a does not prove.** A check list is a declaration, not a detector:
`profile: web` requires the web checks to be attested, and never runs them.
`FACTORY_ROLE` is a declared string, so the hidden-test rule refuses the
ordinary builder and records the claim; the signed acceptance tag remains the
only gate backed by a secret. Skill resolution answers from the local catalog, so
it proves a consistent recorded set, not an installed one. An evidence `kind`
proves an artifact's shape, not its quality: a transcript cannot answer a
screenshot check, but a passing transcript is not a passing test. And with no
policy file on disk, none of it applies - the M0 behaviour is unchanged.

**Still owed to M2:** nothing. M2c closes the security/QA/SRE mechanisms; what remains
unproven inside M2c is stated in its section below.

#### M2b - human surfaces (shipped)

M2b treats design judgment and runtime accessibility as evidence-bearing work, not as a promise to care:

1. **Directions are a reviewable record.** `factory-design.mjs` shape-checks the user, journey, at least two named directions, each critique and `fits|strains|rejects` verdict, the chosen direction, and rejected directions with substantive reasons. The web profile asks for `directions` at phase 1; the phase suite proves `complete 1` refuses without attested directions and passes with them. Commits `3dac181`, `1590191`, `6f47eaf`.
2. **Capture is evidence, not attestation.** `factory-capture.mjs` serves `fixtures/testapp`, captures the five fixture states at 1440, 768 and 390, and writes an `axe.json` report for the default state. It fails loudly on console errors or an unreadable fixture and never attests. The example policy declares `axe` at phase 7 in the **public tier**, a deliberate deviation so every public surface gets the report without duplicate profile entries; the web profile itself adds `directions`, not `axe`. Commits `41fd16d`, `8e3cd46`, `1590191`.
3. **Design judgment is resolvable.** `skills/catalog.yaml` gains `design-judgment` for `web`, `mobile`, `desktop` and `game`; it resolves for web and not for api. Commit `b54650d`.
4. **The closed evidence vocabulary moved with the mechanisms.** `DECLARABLE_KINDS` grew from 32 to 34 (`directions`, `axe`), and the attestation vocabulary derives from it. Commit `8e3cd46`.

The toolchain and fixture are committed at `eb3a3eb` and `a884a16`. The plan's fixtures cover six states; capture reports the five browser-observable states and uses `console-error` as a test-only probe.

**What M2b does not prove.** A shape check is not taste: whether a direction is any good is judged at G1. One web capture path is proved; mobile and desktop remain designed-in but experimental, with no profile promoted to `enforced`. An axe-clean result is not accessible: review handles the contrast of meaning, keyboard order, focus and other failures a rule cannot judge. The example policy is data only; no `config/factory.policy.yaml` ships here, and the capture report is not an attestation of the product's quality.

#### M2c - security, QA and SRE (shipped)

M2c turns three disciplines that were prose-only into named, shaped evidence:

1. **Five kinds, one closed list.** `DECLARABLE_KINDS` grew from 34 to 39: `threat-model`,
   `sbom`, `traceability`, `runbook`, `slo`. Attestation still derives its vocabulary from
   that list, so a declarable kind is always attestable.
2. **Shape is checked, adequacy is not.** `factory-compliance.mjs` exports one pure check per
   type and a `check <type> <bead> <path>` CLI. It refuses missing/empty sections, malformed
   JSON, neither-CycloneDX-nor-SPDX reports, unmapped traceability criteria, and incomplete
   SLO objectives. It never runs a scanner, scores severity, or judges whether a report is good.
3. **The example policy wires the proof.** `threat-model` (phase 1) and `traceability` (phase 6)
   join the web profile; `sbom`, `runbook` and `slo` (phase 7) join the **public tier**, following
   the M2b `axe` precedent. Example counts are 17 / 9 / 21.
4. **Five checked-in fixtures prove it.** `fixtures/testapp/{security,qa,ops}/` carry one valid
   artifact per kind, and the compliance suite runs the real CLI over each.

**What M2c does not prove.** No scanner ran: `sbom` is a report-shaped artifact, not a dependency
inventory of this repo. No ASVS/MASVS conformance, authz/IDOR runtime test, mutation score, flaky
quarantine, load/rollback/restore drill, SLSA/signing, or live alert firing is claimed. The five
checks are shape gates; reviewers judge content. The example policy is data only, no profile is
promoted to `enforced`, and no `config/factory.policy.yaml` ships here.

### M3 - Real delivery: the bundle drill (shipped)

The factory is a local, single-operator OpenCode bundle; it has no hosted
service to deploy and no product URL to smoke-test. Real delivery therefore
means the bundle itself delivers, as a scripted drill - backup, install,
verify, rollback, verify, transcript - with `scripts/factory-delivery.mjs` as
the spine:

1. **Backup.** `HEAD` is recorded; `~/.config/opencode` and `~/.agents/skills`
   are copied into `<backup>/opencode/` and `<backup>/agents-skills/`, with a
   SHA256 manifest of every file at `<backup>/manifest.json`.
2. **Install.** `install.ps1` re-installs the bundle from this repo.
3. **Verify install.** `factory-selfcheck.mjs` must exit 0, and the installed
   `install-manifest.json` must name this repo's HEAD as its `bundle_commit`
   and hash-match every file it lists.
4. **Rollback.** Every backed-up file is restored byte-identically; files not
   in the backup manifest (install artifacts) are deleted.
5. **Verify rollback.** Every live file is re-hashed against the backup
   manifest and must match exactly.
6. **Transcript.** The run writes `out/delivery/<timestamp>-drill.md`, and any
   failure before the rollback completes restores the machine automatically
   unless `--no-auto-rollback` was passed.

See `docs/factory-delivery.md` for how to run it and the honest ceiling.

- The drill proves byte-equality of two trees and the installer's own
  invariants (`install-manifest` bundle_commit and hashes) plus a green
  `factory-selfcheck.mjs`.
- It changes nothing about gates, kinds, or other projects; it is a local
  delivery drill, not a deployment pipeline.
- The docs are never attested as evidence; the transcript is the record.

**Exit:** the drill, run on this machine, prints `delivery ok` and leaves the
machine restored to the pre-drill state. One machine, one moment - the floor,
not the ceiling. What M3 does not prove: any other machine, any other operator,
any cloud target, or the quality of software the factory builds.

**Product projection, not the bundle, and not built.** The deploy step with a
real target (environment, secrets, migrations, post-deploy smoke test against a
deployed URL), rollback exercised per run, feature flags for risky changes with
migration backout tested, observability wired (structured logs, a metric, a
trace, one dashboard, one alert that fires in a drill), a support handoff with a
known-failure list and playbook, and a compatibility matrix across a product's
surfaces with per-surface rollback move with the *target product*, not with this
bundle. They are the product projection of this milestone, not the bundle, and
they are not built. The ship gate does not require a deployed URL; it requires
nothing new from M3.

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
| M3 Real delivery (bundle drill, shipped) | M2 (partly parallel) | 1 wk | The bundle itself delivers: backup, install, verify, rollback — one machine, one moment |
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
