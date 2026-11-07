# M2c — Security, QA and SRE: shaped evidence, one bounded proof (2026-11-07)

**Status:** approved design; no implementation before the plan that follows it is approved.

## 1. Intent

M2b made design judgment structural for human surfaces: a directions artifact whose shape a machine
can check, and whose taste a human judges at G1. M2c does the same for the three disciplines that
were still prose-only in the phase model — **security**, **quality assurance**, and **SRE/operability**.

The factory can already require an artifact, hash it, and refuse a missing file. It cannot yet say
what a threat model, a dependency report, an acceptance trace, a runbook or an SLO record must contain
before a bead may claim to have one. That is the gap this milestone closes, and it closes it the same
way M2b closed design judgment: a closed evidence vocabulary, a shape validator, example-policy
wiring, and one proved path — not a scanner install, not a compliance claim.

## 2. The exit line

A `public` `web` bead on this repo cannot pass its phase checks unless:

1. it has a **threat model** at phase 1 with assets, entry points, at least one threat, and at least
   one mitigation;
2. it has an **acceptance traceability record** at phase 6 mapping every acceptance criterion to at
   least one evidence reference;
3. it has an **SBOM report**, a **runbook**, and an **SLO record** at phase 7, each passing its shape
   check; and

every one of those artifacts is attested under policy like any other evidence. The checks are shape
checks. None of them asserts that the system is secure, the tests are adequate, or the service is
operable — those remain human and reviewer judgments.

The proof is **one path**: the existing `fixtures/testapp/` surface, checked-in shape-valid artifacts,
and the example policy. No profile is promoted from `experimental` to `enforced`.

## 3. Goals

- Make security, QA and SRE evidence nameable and structurally checkable, so "we have a threat model"
  is a file with a known shape rather than a sentence in a chat message.
- Close the vocabulary gap M2b named (`sbom` absent) and add the four other kinds this proof needs.
- Prove every new check against the real example policy and real fixture artifacts — the same way
  M2a proved every profile id against the real policy file.
- Keep the machine's claim honest: the validator checks shape, never severity, adequacy or coverage.

## 4. Non-goals

- No scanner execution. No Semgrep, gitleaks, osv-scanner, syft, Trivy or similar is installed,
  invoked or required by this milestone. The SBOM proof is a checked-in report-shaped artifact.
- No ASVS/MASVS conformance claim, no authz/IDOR runtime test, no SLSA/signing work, no dependency
  vulnerability judgment, no license judgment.
- No mutation-score gate, no flaky-quarantine enforcement, no contract-test runner. Traceability
  checks the mapping structure only.
- No load, rollback, backup/restore or alert-firing drill. Runbook and SLO checks validate required
  fields, not adequacy or live behaviour.
- No new phase, no new gate, no phase-machine change. Existing `G1`, `G2a`, `G2b`, `G3`, `G4` are
  unchanged; the new checks ride the existing verifier's per-phase policy rail.
- No promotion of any profile to `enforced`. No active `config/factory.policy.yaml` is added to this
  repository; the example policy is data.
- No new runtime dependency. The validator uses Node's standard library only.

## 5. Architecture

### 5.1 Five record kinds added to the closed vocabulary

`DECLARABLE_KINDS` (currently 34, after M2b) gains exactly five ids, declared once in
`scripts/factory-policy.mjs`; `factory-attest` derives its `KINDS` from that list, so no second
vocabulary is edited:

| Kind | What it is | Artifact format |
|---|---|---|
| `threat-model` | phase-1 security design record | Markdown |
| `sbom` | dependency-report evidence | JSON (CycloneDX- or SPDX-shaped) |
| `traceability` | acceptance-criteria to evidence map | JSON |
| `runbook` | operability response record | Markdown |
| `slo` | service-level objective record | JSON |

`DECLARABLE_KINDS` becomes 39 entries. `hidden-tests` remains non-declarable. No existing kind is
renamed or removed.

### 5.2 `scripts/factory-compliance.mjs check <type> <bead> <path>` — shape, not judgment

A new, **unpinned** script (same class as `factory-design.mjs` and `factory-capture.mjs`), Node
standard library only. It exports one pure check function per type and a CLI:

- exported: `checkThreatModel(text)`, `checkSbom(text)`, `checkTraceability(text)`,
  `checkRunbook(text)`, `checkSlo(text)` — each returns `{ ok, problems }`;
- CLI: `node scripts/factory-compliance.mjs check <type> <bead> <path>` where `<type>` is
  `threat-model|sbom|traceability|runbook|slo`;
- refuses, by name and with the fixing detail: an unknown type, missing arguments, a missing file, a
  directory, unreadable or malformed JSON, a missing/empty required section or field, and a report
  that matches none of the accepted shapes;
- exits 0 only when shape holds; exits 1 otherwise;
- prints `compliance ok -> <path>` on success, and on refusal says exactly which section or field is
  missing and that adequacy is a human/reviewer call.

The script never judges severity, likelihood, vulnerability counts, license risk, SLO realism,
runbook quality, or whether a traceability reference actually attests. It is a shape gate, and its
refusal text says so.

### 5.3 Artifact schemas

**`threat-model` — Markdown.** Required level-2 headings, each non-empty: `Assets`, `Entry points`,
`Threats`, `Mitigations`. `Entry points` also accepts `Entry Points`; `Threats` also accepts `Risks`.
`Threats` and `Mitigations` must each contain at least one bullet or numbered item. STRIDE labels are
allowed and documented, not required.

**`sbom` — JSON.** Must parse as a JSON object and match one of two shapes:

- CycloneDX: `bomFormat` equals `CycloneDX`, `specVersion` is a non-empty string, `components` is an
  array (it may be empty in a fixture that only proves shape); or
- SPDX: `spdxVersion` is a non-empty string and at least one of `packages`, `files` or
  `documentNamespace` is present.

Anything else is refused with the two accepted shapes named. Vulnerabilities, licenses and component
completeness are not evaluated.

**`traceability` — JSON.** Object with a non-empty `criteria` array. Each criterion has `id` (string),
`description` (string) and `evidence` (non-empty array). An evidence entry is either a non-empty
string or an object with `kind` (string) and `ref` (string). The validator refuses a missing/empty
`criteria`, a criterion without `id` or `description`, and any criterion whose `evidence` is absent or
empty. It does not resolve the references; attestation already decides whether an artifact exists,
hashes and is current.

**`runbook` — Markdown.** Required level-2 headings, each non-empty: `Purpose` (or `Service`),
`Ownership` (or `Owner`), `Detection` (or `Symptoms`), `Response` (or `Procedure`), and one of
`Escalation` or `Rollback`.

**`slo` — JSON.** Object with `service` (non-empty string) and `objectives` (non-empty array). Each
objective has `name`, `target` and `indicator` (each a non-empty string, or `target` as a finite
number). `alerts` and `window` are allowed and unchecked.

All checks refuse empty content as a distinct problem from a missing section, so a placeholder file
cannot pass by having the heading present.

### 5.4 Example-policy wiring

`config/factory.policy.example.yaml` gains five checks and two list entries. This is data; no active
policy is created.

| Check id | Kind | Phase | Command | Added to |
|---|---|---:|---|---|
| `threat-model` | `threat-model` | 1 | `node scripts/factory-compliance.mjs check threat-model $bead .factory/$bead/security/threat-model.md` | `profiles.web.checks` |
| `traceability` | `traceability` | 6 | `node scripts/factory-compliance.mjs check traceability $bead .factory/$bead/qa/traceability.json` | `profiles.web.checks` |
| `sbom` | `sbom` | 7 | `node scripts/factory-compliance.mjs check sbom $bead out/sbom.json` | `tiers.public.checks` |
| `runbook` | `runbook` | 7 | `node scripts/factory-compliance.mjs check runbook $bead .factory/$bead/ops/runbook.md` | `tiers.public.checks` |
| `slo` | `slo` | 7 | `node scripts/factory-compliance.mjs check slo $bead .factory/$bead/ops/slo.json` | `tiers.public.checks` |

Resulting counts in the example policy:

- `public` tier: 14 → 17 ids;
- `prototype` + `web`: 7 → 9 ids (`tests, run, review, a11y, perf, visual, directions,
  threat-model, traceability`);
- `public` + `web`: 16 → 21 ids (tier's 17 first, then `visual`, `directions`, `threat-model`,
  `traceability`).

Wiring `sbom`, `runbook` and `slo` to the `public` **tier** rather than a profile follows the M2b
`axe` precedent: it proves one release-readiness obligation for every public bead without inventing
profile-specific wiring for ten profiles. The cost if a later milestone needs per-profile
declarations is that the placement must be revisited; the spec records this deliberately.

### 5.5 Proof fixtures

Checked-in under `fixtures/testapp/`, static, no tool execution:

- `fixtures/testapp/security/threat-model.md` — valid shape for the testapp surface;
- `fixtures/testapp/security/sbom.cdx.json` — minimal valid CycloneDX shape;
- `fixtures/testapp/qa/traceability.json` — at least two criteria, each mapped to at least one
  evidence reference (e.g. `directions`, `screenshot`, `check-output`);
- `fixtures/testapp/ops/runbook.md` — valid headings;
- `fixtures/testapp/ops/slo.json` — one service and at least one complete objective.

The existing `fixtures/testapp/index.html`, `states.js`, `app.css` and README are untouched.

### 5.6 What the gates judge

`factory-phase complete <n>` continues to use `verifyChecks`: an attested artifact must exist, hash,
be at HEAD, carry a producer session, and match the check's declared kind. M2c adds no gate and no
phase. A missing or shape-invalid artifact refuses the transition with the check id and the fix
command. Reviewers still judge whether the threat model is honest, whether the trace is complete, and
whether the runbook and SLO are useful. G1 continues to carry the human verdict.

## 6. Test plan

**New — `scripts/test-factory-compliance.mjs`** (fast, deterministic, no browser):

- every golden fixture passes through its exported check function;
- missing file, missing arguments and unknown type are refused by the CLI with the fixing text;
- empty/missing required section or field is refused by name for each of the five types;
- a non-JSON SBOM, a JSON object matching neither CycloneDX nor SPDX, and a malformed traceability
  record are refused;
- an unmapped traceability criterion is refused; a malformed SLO objective is refused;
- CLI exit 0 prints `compliance ok -> <path>`; every refusal exits 1.

**Updated:**

- `scripts/test-factory-policy.mjs`: `DECLARABLE_KINDS` gains exactly the five new kinds; the example
  policy parses with the new checks at the declared phases and kinds; the three count assertions
  above move to 17 / 9 / 21 with tier-first ordering preserved.
- `scripts/test-factory-attest.mjs`: the pinned kinds list/count moves by five; attesting a
  `threat-model` artifact is accepted once the kind is declarable.
- No phase-suite change is required: M2c adds no phase-machine code. If a narrow proof is cheap
  (for example `complete 1` refusing without a threat model when a sandbox policy declares it), it
  may be added in the plan; it is not an exit criterion.
- `config/factory.protected.json` is re-baselined only if a pinned script changes. `factory-compliance.mjs`
  is unpinned, and this milestone does not edit the five pinned scripts unless a test demands it.

## 7. Docs and ledger

- `docs/factory-domain-profiles.md`: add the five kinds to the evidence-vocabulary table and mark
  which are proved here as shape-only; correct any stale "absent" claims. No profile status changes.
- `docs/how-factory-works.md`: describe the compliance shape checks and their ceiling in the kinds
  section.
- `docs/factory-roadmap.md`: M2c section with what shipped (five kinds, five checks, validator, five
  fixtures) and what remains unproven (real scanners, conformance claims, runtime authz, mutation,
  flaky quarantine, drills, signing/SLSA, alert firing). Suite counts move together with the actual
  results.
- `skills/catalog.yaml`: **no change.** A security/QA/SRE skill is not needed to make the evidence
  shape real, and an unused catalog entry is not kept.
- Ledger `.superpowers/sdd/2026-11-07-factory-m2c/progress.md`: one line per task with commits and the
  exact test command and result.

## 8. Verification gate for the plan

Every task ends with:

- `node --check` on changed `.mjs` files, plus the relevant suite;
- the new compliance suite and the policy/attest suites green;
- attest and phase suites never run concurrently;
- `FACTORY_ROLE=human node scripts/factory-attest.mjs protect --write` plus commit **only if** a
  pinned script changes;
- no `git push`, no remote operations, and no staging of the standing untracked dirt.

## 9. Risks

- **Shape theatre.** A threat model can name one asset and one mitigation and pass. The validator
  cannot fix that; reviewers judge content, and the docs say so plainly.
- **SBOM without a scanner.** The proof validates report shape, not dependency truth. Calling the
  artifact an SBOM is honest only while the docs state that no generator ran here.
- **Tier placement is a deliberate approximation.** `sbom`, `runbook` and `slo` are public-tier
  obligations, not profile obligations, following the M2b `axe` precedent. If a real project needs
  per-profile requirements, that is a later, evidenced change.
- **Count churn.** Three example-policy assertions and the attest kinds pin move in the same commit
  as the vocabulary; leaving them for later would show a green suite that tests the old contract.
- **Scope creep into M4–M6.** Runtime drills, scanners and conformance claims stay out.

## 10. Success criteria

- `node scripts/factory-compliance.mjs check <type> <bead> <fixture>` accepts each of the five golden
  fixtures and refuses each malformed one in its test suite.
- `scripts/test-factory-compliance.mjs` passes, and `node --check` is clean.
- The example policy parses; `DECLARABLE_KINDS` is 39; the example counts are 17 / 9 / 21.
- The existing policy and attest suites pass with the updated pins; unaffected suites stay green.
- No profile is promoted, no active policy is created, and no scanner is invoked.
