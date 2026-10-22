# factory-v2-model.md — from phase machine to attestation machine

Status: **design proposal, not implemented.** Written 2026-10-20 after a
six-model review of the factory and a survey of how other teams run AI-assisted
delivery. `docs/conductor.md` still describes the shipped pipeline; where this
document disagrees with it, this document is the proposal and the conductor is
the current behaviour.

Read this with `docs/factory-gap-analysis.md`, which measures today's factory
against this model and lists what to change first.

## The one-sentence reframe

> A phase is not complete because a string was supplied. It is complete because
> a **named artifact**, produced by a **named command**, was signed off by a
> **named reviewer who is not the builder**, at a **timestamp**, against a
> **commit** — and the machine can verify all five.

The current machine asks "did someone type evidence?". The proposed machine
asks "does the evidence exist, is it current, and did an independent party
accept it?".

## What the industry converges on

Six patterns recur across spec-driven tooling, agent engineering, and the
established disciplines (security, SRE, accessibility, design):

| # | Pattern | Where it shows up |
|---|---|---|
| 1 | **Spec-driven, artifact-first.** The spec is an object later phases read and check against, not a phase you pass. | GitHub Spec Kit (`specify -> plan -> tasks -> implement`, plus `clarify`, `analyze`, `converge`); Kiro (`requirements.md`, `design.md`, `tasks.md`); BMAD (briefs and specs carry forward) |
| 2 | **Generator is not the evaluator.** | Anthropic's evaluator-optimizer pattern; peer code review; design critique; AppSec review; SRE production readiness review; external audit |
| 3 | **Gates are executable policy, not prose.** | Required status checks and branch protection; policy-as-code; signed commits; a named person signing a named artifact |
| 4 | **Assurance is risk-tiered.** | OWASP ASVS levels 1-3; OWASP SAMM risk-driven maturity; SLSA build levels L0-L3 |
| 5 | **Production readiness is a signed review, not a green build.** | Google SRE, *Reliable Product Launches at Scale* (PRR): architecture, capacity, monitoring, rollout, rollback, on-call, reviewed outside the team |
| 6 | **Outcomes feed back.** | DORA's five delivery metrics, including failed-deployment recovery time and deployment rework rate; post-launch design critique |

Spec Kit also supplies a missing verb: its assessment can return **go /
clarify / kill**. Our factory can only say "not yet". A factory with no kill
path will faithfully build things that should not exist.

## The unit of truth

Every discipline already uses the same record shape:

```
artifact  +  independent reviewer  +  verdict  +  timestamp  +  commit
```

- Code review: diff + reviewer + approve/request-changes + time + SHA.
- PRR: architecture and runbook + SRE + launch approval + time + release.
- Security: threat model and scan results + AppSec + risk acceptance + time + build.
- SLSA: artifact + build platform + signed provenance + time + source digest.
- Design critique: direction + peers + recorded decision + time + the build shown.

The factory should store that record, not a sentence about it.

## Risk tiers

Tiering is what makes the rest affordable. Applying ASVS L3 and a full PRR to a
weekend prototype is how teams learn to rubber-stamp. The tier is chosen at G1
and recorded on the bead.

| Tier | Examples | Required assurance |
|---|---|---|
| `prototype` | spike, demo, internal tool with no users | build + typecheck + unit tests + one runtime smoke in the profile's own terms; no threat model, no SLO |
| `internal` | team tool, back office, low blast radius | + e2e happy path, authz test, dependency and secret scan, README/runbook, rollback note |
| `public` | customer-facing surface, any profile | + the public checks for its profile (CWV, axe and visual diff for `web`; contracts, authz and load for `api`; store review for `mobile`; registry and semver for `library`), SAST/DAST where applicable, SLO + dashboard + alert for anything long-running, rollback exercised |
| `regulated` | payments, health, identity, personal data, any profile | + the profile's regulatory baseline, ASVS L2/L3 for `web`/`api`, STRIDE threat model per trust boundary, SBOM + provenance, load test, backup restore drill, on-call, privacy/data review, independent pen-test or red team |

The tier says **how much** assurance. A profile says **what kind**. The two are
independent: a `prototype` `api` and a `prototype` `web` need different evidence at
the same low bar. See `docs/factory-domain-profiles.md` for the ten profiles and
the checks each one requires.

The tier lives in `factory.policy.yaml` and on the bead. A gate reads the tier
and refuses the checks that tier requires. Raising the tier later is allowed;
lowering it after G1 requires a recorded human decision, because that is exactly
the move a tired agent makes at 2 a.m.

## Role contracts

A role is not a persona in a prompt. A role **owns a question**, **leaves an
artifact**, and **signs a verdict**. If the artifact is absent the next gate
refuses, regardless of how good the prose is.

| Role | Owns this question | Must leave | Machine-checkable | Stays human | Gate |
|---|---|---|---|---|---|
| Product / researcher | Should this exist, for whom, and what would kill it? | brief: user, job, current alternative, success metric, kill criterion | metric is instrumented; kill criterion has a number and a date | is the bet worth making | G1 |
| UX / UI designer (profiles with a human interface) | What is the user's path, and what is the composition? | 2-3 named directions, chosen rationale, rejected alternatives, critique record | directions and rationale exist; tokens declared *and consumed*; at least K library components in interactive contexts | is it any good | G1, G3 |
| Interface designer / engineer (web, mobile, desktop, game) | Does the interface hold at real sizes, states and inputs? | runtime captures at the profile's sizes; loading, empty, error, disabled states; visual baseline | the profile's performance budget; zero console errors; visual diff; keyboard or input path | does the interface feel right | G3 |
| Senior engineer / architect | What breaks at 10x, and what is irreversible? | spec, ADRs, NFRs, data model, failure modes, migration and backout | build, typecheck, contract tests, migration up/down, dependency policy | architecture judgement | G2 |
| Tech lead / code reviewer | Is this the simplest correct change? | review verdict bound to the commit | reviewer session != builder session; diff reviewed; no skipped tests | readability, naming, fit | G2, G3 |
| QA / SDET | How do we know it works, and how would we know it broke? | test strategy mapped to acceptance criteria; exploratory charter; flaky quarantine | traceability matrix; mutation score on core logic; no skips in a release | is coverage sufficient | G2, G3 |
| Accessibility (human interfaces only) | Can everyone use it? | the applicable standard's conformance record: WCAG 2.2 AA for web, platform assistive APIs for mobile/desktop, screen-reader-friendly output for a CLI | automated checks where they exist; keyboard or assistive path; focus order | assistive-technology reality | G3 |
| Performance | Does it stay within budget under real conditions? | budget and measurement at the profile's percentile | the profile's metrics: CWV for web, p95/p99 for an API, startup and RSS for a CLI, frame time for a game, flash/RAM for embedded | is the budget right | G3 |
| Security / AppSec | What can an attacker do, and what stops them? | threat model (STRIDE per trust boundary), ASVS checklist, authz tests | SAST/DAST/dependency/secret scans; IDOR tests; SBOM; provenance; headers; rate limits | threat-model completeness, risk acceptance | G2, G3 |
| SRE / production readiness | Can we run it, see it, and undo it at 3 a.m.? | PRR: SLO, dashboard, alerts + runbooks, rollback, capacity, backup/restore drill, on-call | dashboards and alerts exist; rollback exercised; error budget defined | operational risk | G3 |
| Data / privacy / legal | What do we collect, and are we allowed to? | event schema, retention, consent, licence scan | events fire; no PII in logs; licence allowlist | regulatory judgement | G2, G3 |
| Tech writer | Can a stranger operate this? | README, runbook, changelog, API docs | docs build; runbook commands execute; links resolve | clarity | G3 |
| Release manager / DRI | Who is accountable for go-live? | signed release record | commit + tag + artifact hash match | go / no-go | G3 |
| Support / on-call | What will users report? | known-failure list, support playbook | ticket categories wired to alerts | severity calls | G4 |
| Red team / independent critic | How would I ship this while it is still bad? | attack report with reproducible paths | every claimed hole has a failing test | novel attacks | G3 |

Roles are **capabilities, not job titles**. A profile without a visual surface has
no UX/UI designer, but it still has an *interface* role: the API designer, the CLI
designer, the library's public-surface owner. A profile without a browser has no
axe-core, but it still has an accessibility decision to make and sign. The profile contract in `docs/factory-domain-profiles.md` names, for every profile, who owns its interface and what "usable" means there.

Two roles are routinely forgotten and both caused real defects in this repo's
history: **accessibility** (not a subset of QA) and **the independent critic**
(the six-model exercise should be a standing phase, not a one-off).

## Four gates

Gate attention is the scarcest resource in the system. Three old gates plus an
ungated review phase became four gates with different questions, one DRI each.

| Gate | Question | Signs | Refuses when |
|---|---|---|---|
| **G1 Worth building?** | Real user, real alternative, a reason this beats doing nothing | product DRI + design DRI | no success metric; no kill criterion; no named design direction and no rejected alternative — **where the surface's profile has a design surface**. A `cli`, `library`, `infra`, `embedded` or `data-ml` run declares "no visual surface" at G1 and is reviewed on interface clarity instead. |
| **G2 Ready to build?** | Spec falsifiable, plan applied, risk understood | architect + security + QA | no spec artifact bound to the bead; no plan fingerprint; no threat model for the tier; no test strategy |
| **G3 Ready to ship?** | Works, usable, safe, runnable | independent reviewer + design critic + security + SRE | evidence manifest missing, stale or mismatched; reviewer == builder; any open high-severity finding; no PRR for the tier |
| **G4 Did it work?** | Did the metric move, and what changes next time? | product + SRE | no outcome record — a refusal, not a warning; the record's content is judged by a human later |

G3 is today's Gate C. It is created when the run enters phase 7 (ship); the review half of phase 6 is enforced as a required artifact (`review.md` plus the reviewer verdict), not as a second gate record. G2 is created in two steps: `G2a` on entering phase 2, `G2b` on entering phase 3, riding the existing Gate A and Gate B records.

G4 blocks `complete 8` on the **existence** of an outcome record (what changed, measured before and after, or an explicit "not measurable, here is why"). The record's content is judged by a human later; a missing record is a refusal, not a warning.

G4 is the missing feedback loop. It is the only gate that can change the
factory itself: its record is written to `docs/negative-results.md` and to the
eval set, so the next run starts from a different place.

Mapping from today's pipeline: G1 is new at the end of brainstorm; Gate A
becomes `G2a` and Gate B becomes `G2b`; Gate C becomes `G3`; phase 6's review
is enforced as a required `G3` artifact rather than a second gate; phase 8
close writes the `G4` record.

## The evidence manifest

One directory per bead. Nothing in it is prose about work; everything is a file
produced by a command.

```
.factory/<bead>/
  manifest.json
  spec.md
  plan.json
  review.md
  threat-model.md
  prr.md
  surfaces/
    web/   screenshots/1440.png 768.png 390.png  axe.json  lighthouse.json  visual-diff/
    api/   contract.json  load.json
    ios/   device-captures/  a11y-tree.json
```

One directory per **affected surface**, not one per product. A web screenshot
never counts as mobile evidence, and a surface that is missing is a refusal, not
an average.

`manifest.json`:

```json
{
  "bead": "acme-7f2",
  "product": "acme-notes",
  "tier": "public",
  "commit": "b99e501",
  "generated_at": "2026-10-20T10:00:00Z",
  "surfaces": [
    {
      "id": "web",
      "profile": "web",
      "artifacts": [
        { "kind": "screenshot", "path": "surfaces/web/screenshots/1440.png", "sha256": "..." },
        { "kind": "axe", "path": "surfaces/web/axe.json", "sha256": "..." }
      ]
    },
    {
      "id": "api",
      "profile": "api",
      "artifacts": [
        { "kind": "contract", "path": "surfaces/api/contract.json", "sha256": "..." },
        { "kind": "load", "path": "surfaces/api/load.json", "sha256": "..." }
      ]
    }
  ],
  "verdicts": [
    {
      "gate": "G3",
      "role": "security",
      "reviewer": "model:opencode/glm-5.3",
      "session": "ses_...",
      "verdict": "pass-with-findings",
      "findings": [{"severity": "low", "id": "SEC-3", "status": "fixed"}],
      "could_not_verify": ["rate limiting under real traffic"],
      "at": "2026-10-19T16:40:00Z"
    }
  ]
}
```

A gate verifies, mechanically:

1. **Existence** — every artifact required by the tier is listed and on disk.
2. **Integrity** — the hash matches the file.
3. **Freshness** — produced after the last relevant change, not before it.
4. **Alignment** — `commit` equals HEAD, or the manifest records a stale
   exception that a human signed.
5. **Independence** — the reviewer session differs from the builder session,
   and preferably the model family differs too.
6. **Completeness** — every required role has a verdict; no high-severity
   finding is open; `could_not_verify` is allowed but must be visible.
7. **Surface coverage** — every surface affected by the diff is present in
   `surfaces[]`, and each artifact's `kind` matches what that surface's profile
   requires. A shared-package change pulls in all its consumers; a declaration
   that omits one is refused, naming the surface and the file that caused it.

This single mechanism retires whitespace evidence, 0-byte brainstorms,
screenshots of the wrong page, and the "I reviewed it" sentence that nobody can
audit.

## Policy as data, not doctrine

The conductor should say *how to run the machine*. The policy file says *what
this project requires*. That is how the same factory serves a prototype and a
payments system without teaching every agent the top bar.

`factory.policy.yaml`:

```yaml
version: 1
tier: public
profile: web

roles:
  product:
    required: [brief, metric, kill_criterion]
  design:
    required: [directions, rationale, critique]
    min_library_components: 3
  security:
    required: [threat_model, asvs_level, sbom]
    asvs_level: 2
  sre:
    required: [slo, dashboard, rollback_drill]
  accessibility:
    standard: WCAG-2.2-AA

gates:
  G3:
    independent_reviewer: required
    open_high_severity: refuse

checks:
  - core-web-vitals
  - axe-core
  - visual-regression
  - sast
  - dependency-audit
```

The conductor no longer contains a 40-line section per discipline. Each role
gets a short skill with a rubric and the commands it runs; the policy file
selects them.

## Independence, solved structurally

The builder cannot be the evaluator. This is the single strongest finding of the
review and the one every discipline already encodes.

- The reviewer runs in a **different session** and, where possible, a
  **different model family**.
- The reviewer gets the **diff and the artifacts**, not the builder's narrative.
- The reviewer has **read-only tools**.
- The reviewer must produce findings with reproductions and a verdict file that
  names what it could **not** verify.
- The gate refuses if `reviewer_session == builder_session`, or if the verdict
  predates the artifact it claims to have reviewed.
- **LLM-as-judge is a finding generator, never the sole sign-off.** Calibrate it
  against human labels and measure agreement; a judge that agrees with the
  builder 100% of the time is a mirror, not a reviewer.

For irreversible or high-blast-radius decisions the human is the DRI and signs
the artifact. The machine's job is to make skipping that signature impossible,
not to pretend it can replace it.

## Mechanical vs human, by discipline

| Discipline | The machine can check | Only a human can judge |
|---|---|---|
| Engineering | build, typecheck, lint, unit/integration, contract tests, migration up/down, mutation score, complexity budget, dependency policy | design judgement, reversibility, is this the simplest change |
| Front-end | CWV p75, bundle budget, zero console errors, 3-width screenshots, visual diff, state coverage | composition, hierarchy |
| Accessibility | axe-core, contrast, target size, focus order, keyboard traversal | screen-reader reality |
| UX | tokens declared and consumed, library-component adoption, directions and rationale present | is it understandable, is it boring |
| Security | SAST, DAST, secrets, dependencies, SBOM, provenance, authz/IDOR, headers, rate limits | threat-model completeness, risk acceptance |
| Quality | acceptance-criteria traceability, no skipped tests, flaky quarantine, severity triage | is exploratory coverage enough |
| Production | SLO defined, dashboards and alerts exist, rollback exercised, load test, restore drill | operational readiness |
| Docs | links resolve, commands execute, changelog present | clarity |

Explicitly **not** mechanical: "is it good", "is it boring", "is the
architecture right". Any score claiming to answer those is a taste oracle
wearing a meter, and this repo already built one and shelved it for that reason
(`docs/negative-results.md`, `scripts/factory-divergence.mjs`).

## Replaying the agency run against this model

The agency site passed every phase and gate and was judged boring. Under this
model it would have stopped at three points:

1. **G1** would have refused: there was no success metric, no kill criterion,
   no named design direction, and no rejected alternative. "AI-first software
   agency" is a positioning claim, not a design decision.
2. **Discovery at G1** would have had a `design` and `frontend` topic, so the
   Nuxt UI and design-taste skills would have been installed and recorded. In
   the real run the project had only `beads` and `verify-agency`.
3. **G3** would have refused: no 3-width screenshots, no visual baseline, no
   axe or CWV result, no component-adoption check, and no independent design
   critique. The builder's "intentional editorial layout" would have been a
   finding it raised against itself, not a verdict that closed the gate.

The point is not that the factory should have had better taste. It is that the
factory had no place where taste was **required to be exercised by someone who
was not the builder**.

## Rollout

Three increments, ordered so that each one is useful on its own.

### 1. Stop the bleeding (days)

- Close the four fake-ship holes: reject whitespace evidence; require a recorded
  gate `close_reason`; check Gate C in `complete 7`; treat missing gate
  metadata as pending, not resolved.
- Fix the unsatisfiable test guard (it greps output suppressed by `--quiet`).
- Introduce the evidence manifest for **one** phase, end to end.

Nothing else. Adding disciplines before the state machine can refuse a fake ship
just produces more elaborate theatre.

### 2. Add the missing disciplines (1-2 weeks)

- Risk tiers on the bead, chosen at G1.
- Role artifacts for design, security, SRE and accessibility.
- Four gates, with G3 requiring an independent reviewer in a different session.
- G4 outcome record.
- Role skills: `factory-ux`, `factory-frontend`, `factory-security`,
  `factory-sre`, `factory-qa`, `factory-review`.

### 3. Make it learn (2-4 weeks)

- Evals that run the whole pipeline on `testapps/` with hidden acceptance tests,
  scored on the product, not the process.
- DORA-style outcome metrics: recovery time and rework rate, not just "shipped".
- Policy file drives checks; conductor cut to routing only.
- Publish a tagged release so a second person can install it.

## What not to do

- Do not apply ASVS, SAMM and PRR wholesale to a prototype. Tiering is the point.
- Do not let the generator grade itself, in any discipline.
- Do not automate taste. Automate the floor and make critique mandatory.
- Do not use an LLM judge as the only gate.
- Do not add gates without deleting prose. The conductor is already 651 lines;
  most of it is unenforced, duplicated, or history.
- Do not chase SOC 2 ceremony for a weekend app, or a "design score" for a
  landing page.
- Do not build a second source of truth. Extend beads with artifacts and
  verdicts; two stores drift and the copy nobody reads wins.

## Evidence manifest

`attest` writes `.factory/<bead>/manifest.json` at the project root (the directory holding `.beads`):

```json
{
  "version": 1,
  "bead": "example-1",
  "artifacts": [
    {
      "id": "tests",
      "kind": "check-output",
      "path": ".factory/example-1/tests.txt",
      "sha256": "…",
      "bytes": 812,
      "command": "npm test",
      "producer_session": "ses_abc",
      "produced_at": "2026-10-21T09:00:00Z",
      "commit": "d2426e2"
    }
  ]
}
```

`id` is the policy's check id, `path` is root-relative, and `sha256` is computed from the bytes on disk at attest time. Attesting the same id again replaces the entry and preserves any unknown fields.

A model may name an artifact, but it cannot attest a hash for a file that does not exist — and the hash it writes is whatever the writer computed, not proof of what produced the bytes.

`.factory/<bead>/trail.jsonl` is append-only. Each line is one event — `attest`, `verify`, `refusal`, or `complete` — with `at`, `event` and `bead`. Nothing rewrites or truncates it.

The manifest answers three questions and no more:

1. **Did the bytes change after attestation?** The hash answers this. It does not say the named command produced them.
2. **Is the artifact from this commit?** `commit == HEAD` is freshness relative to a commit, not proof that the work happened at that commit.
3. **Did a different producer session record it?** `producer_session` is self-declared until the reviewer session exists (M1b); anyone can type any value.

## Sources

- GitHub Spec Kit — https://github.com/github/spec-kit
- BMAD Method — https://github.com/bmad-code-org/BMAD-METHOD
- Kiro specs — https://kiro.dev/docs/specs/
- Anthropic, *Building effective agents* — https://www.anthropic.com/engineering/building-effective-agents
- Google SRE, *Reliable Product Launches at Scale* — https://sre.google/sre-book/reliable-product-launches/
- OWASP ASVS 5.0 — https://owasp.org/www-project-application-security-verification-standard/
- OWASP SAMM 2.2 — https://owasp.org/www-project-samm/
- SLSA build levels — https://slsa.dev/spec/v1.0/levels
- WCAG 2.2 — https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- Core Web Vitals — https://web.dev/articles/vitals
- DORA software delivery metrics — https://dora.dev/guides/dora-metrics-four-keys/
- NN/g design critiques — https://www.nngroup.com/articles/design-critiques/
