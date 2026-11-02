# Domain profiles: one factory, many kinds of software

The core of this factory is an attestation machine. It does not know what a
browser is, and it should not. What changes between a web app, an API, a CLI, a
library, a mobile app, a data pipeline and firmware is **what the interface is,
how you observe it, which standards apply, and how you ship and undo it**.

Those differences belong in a **profile**, not in the doctrine. Without profiles
the factory silently becomes a web factory: it asks for screenshots of a REST
API, a WCAG audit of a C library, and a rollback drill for a static site.

## Two independent axes

| Axis | Values | Chosen when | Answers |
|---|---|---|---|
| **Tier** | `prototype`, `internal`, `public`, `regulated` | G1 | How much assurance is proportionate? |
| **Profile** | `web`, `api`, `cli`, `library`, `mobile`, `desktop`, `data-ml`, `infra`, `embedded`, `game` | G1 | What kind of software is this, and what counts as evidence? |

A bead carries both. A `prototype` `cli` needs almost nothing. A `regulated`
`api` needs ASVS, authz tests and a restore drill. A `public` `web` needs CWV,
axe and three widths. A `public` `library` needs none of the last three and a
semver diff instead.

`public` replaces the old `public-web`; `regulated` replaces `money-or-pii`.
The old names conflated a risk level with a delivery surface.

## The invariant core (never domain-specific)

These do not change per profile, and a profile may not weaken them:

1. Four gates: G1 worth building, G2 ready to build, G3 ready to ship, G4 did it work.
2. Unit of truth: **artifact + independent reviewer + verdict + timestamp + commit**.
3. Evidence manifest at `.factory/<bead>/manifest.json`, verified for existence,
   hash, freshness, commit alignment, completeness and independence.
4. Risk tier chosen at G1; lowering it later needs a recorded human decision.
5. `protected_files`: no agent may write the machinery that grades it.
6. Writer/reviewer separation, enforced by capability, not by instruction.
7. Reproducible scenario written before the run; failures recorded honestly,
   including `unavailable` and `could_not_verify`.
8. One recoverable feature document per substantial change; handoffs point at it.
9. G4 records the outcome; the run is not "done" because the phases passed.

## The profile contract

Every profile declares exactly these fields:

1. **Interface** — the thing a consumer touches, and who owns it.
2. **Runtime evidence** — the form evidence takes at G3 (transcript, screenshot set, plan diff, eval report, HIL log).
3. **Accessibility** — the platform's standard, or `none` with a reason.
4. **Performance** — the budget, the tool that measures it, and the threshold.
5. **Security baseline** — the standard, the attack surface, and the tool that checks it.
6. **Production readiness** — what must exist before a real user is exposed.
7. **Release and rollback** — the mechanism and the worst-case recovery time.
8. **Compatibility and deprecation** — supported versions, the deprecation window, and how the minimum supported version is derived.
9. **Evidence command and threshold** — the exact command that produces each check's evidence and the predicate that decides pass.

## The matrix

| Profile | Interface | Runtime evidence | Accessibility | Performance | Security baseline | Production readiness | Release / rollback | status |
|---|---|---|---|---|---|---|---|---|
| **web** | DOM in a browser | Playwright or agent-browser at 1440/768/390; loading, empty, error, disabled; console clean; visual baseline | WCAG 2.2 AA: axe-core, keyboard path, focus visible, 24×24 targets, contrast | CWV at p75: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1; bundle budget | OWASP ASVS L2, CSP, CSRF, XSS, authz tests, rate limits | SLO, dashboard, alert + runbook, rollback exercised | Deploy, cache purge, feature flag, previous build redeploy | enforced |
| **api** | HTTP / GraphQL / gRPC contract | Contract tests, Schemathesis or Dredd, status and error matrix, authz cases, load test; request/response transcripts | Not applicable: no human interface. Error messages and docs are the UX and are reviewed as text | p95/p99 latency, throughput, saturation at expected load | ASVS L2 API chapters, object-level authz (IDOR), input validation, rate limits, secrets | SLO, RED metrics, traces, dashboard, runbook, dependency failure modes | Blue/green or canary; migration up **and** down; rollback exercised | enforced |
| **cli** | argv, stdin, stdout, stderr, exit codes | Golden-file tests, bats or pytest, TTY transcript, `--help` snapshot, exit-code matrix | Screen-reader-friendly output, no colour-only meaning, `--help` complete | Startup time, peak RSS, binary or package size | Command injection, path traversal, secret handling, unsafe temp files | Install/upgrade/uninstall, crash reporting, man page | Signed release to a package registry; deprecation policy | enforced |
| **library / SDK** | Public API surface | Compile, unit and property tests, downstream consumer build, API diff (api-extractor, cargo-semver-checks) | Docs accessible; code samples runnable | Compile time, binary size, dependency count | Supply chain, unsafe/FFI audit, licence allowlist, CVE scan | Semver, changelog, deprecation policy, supported-versions table | Publish; yank policy; major-version branch | enforced |
| **mobile** | Screens on a device | Device/simulator captures (Appium, XCUITest, Espresso), accessibility tree, offline and permission-denied paths | Platform a11y: TalkBack/VoiceOver, dynamic type, touch targets | Startup, frame timing, memory, battery, app size | OWASP MASVS, secure storage, certificate pinning, root/jailbreak handling | Crash reporting, staged rollout, kill switch, support playbook | Store review, phased release; rollback = halt rollout | experimental: reduced checks |
| **desktop** | Windows, menus, shortcuts | UI automation, accessibility tree, installer and upgrade test, offline behaviour | Platform a11y APIs, keyboard-only operation, high contrast | Startup, memory, installer size | Code signing, notarization, update channel integrity, sandboxing | Crash reporting, auto-update health, support matrix | Signed installer, delta update, rollback to previous version | experimental: reduced checks |
| **data / ML** | Dataset, model, eval report | Reproducible pipeline run (seed + versions), eval vs baseline, data-quality checks, model card, held-out set | Not applicable unless there is a human-facing explanation surface | Inference latency, cost per inference, throughput | PII leakage, poisoning, model extraction, prompt injection if LLM-facing | Drift monitoring, retraining runbook, rollback to previous model | Model registry, shadow mode, staged rollout, rollback | experimental: reduced checks |
| **infra / IaC** | `plan` diff and running system | `terraform plan` / `pulumi preview`, policy check (OPA/Conftest), dry run, rollback rehearsal | Not applicable | Apply time, blast radius | Least-privilege IAM, secrets, network policy, CIS benchmarks | Observability, runbooks, on-call, disaster recovery drill | Apply, revert plan, state backup, change window | experimental: reduced checks |
| **embedded** | Device behaviour | Hardware-in-the-loop test log, timing and memory budget, power draw, OTA update test | Device a11y if it has a human interface | Latency, flash/RAM ceiling, power budget | Secure boot, signed firmware, SBOM, CVE scan | Watchdog, telemetry, recovery mode | Signed OTA, A/B partition, rollback | experimental: reduced checks |
| **game / real-time** | Frame and input | Capture, input replay, performance trace, save/load integrity | Subtitles, colourblind modes, input remapping | Frame time, load time, memory | Anti-cheat, asset pipeline, save integrity | Crash reporting, telemetry, live-ops runbook | Store build, patch, rollback | experimental: reduced checks |

`experimental: reduced checks` means the profile may be selected, but its G3 verdict must say `not-verified` for every check the factory cannot execute. A profile is promoted to `enforced` only when a named tool produces its evidence and a testapp exercises it. Nothing in the machine enforces that rule today: it is a reviewer's judgement written down, and the `status` column is a claim about the tooling, not a gate.

The matrix summarises fields 1–7. Field 8 (compatibility and deprecation) is not yet filled in for any profile. Field 9 is filled in **as data**, not as prose: each profile adds named checks on top of its tier, and `config/factory.policy.example.yaml` declares the phase, artifact kind and command for every one of them.

### The check ids each profile adds

A bead's effective evidence is its tier's list plus its profile's list. The tier says how much assurance the change needs; the profile says what the surface can even produce. These are the profile additions, with the artifact kind the gate demands and the phase it gates:

| Profile | Checks added to the tier | Kinds |
|---|---|---|
| `web` | `a11y` (7), `perf` (7), `visual` (5) | check-output, check-output, screenshot |
| `api` | `contract` (6), `authz` (5), `load` (5) | api-diff, authz, load |
| `cli` | `golden` (5), `tty` (5) | golden, tty |
| `library` | `api-diff` (5), `consumer-build` (5) | api-diff, consumer-build |
| `infra` | `plan-diff` (5), `policy-check` (5), `rollback` (7) | plan-diff, policy-check, plan |
| `mobile` | `a11y` (7), `device` (5), `perf` (7) | check-output, device, check-output |
| `desktop` | `a11y` (7), `signing` (7), `update` (7) | check-output, signing, update |
| `embedded` | `watchdog` (5), `recovery` (5) | watchdog, recovery |
| `game` | `frame` (5), `input` (5) | frame, input |
| `data-ml` | `eval` (5), `data-quality` (5) | eval, data-quality |

Two consequences worth stating plainly:

- **The kind is checked, not just recorded.** `verify` refuses an artifact whose kind is not the one its check declares, with `check "<id>" needs a <declared> artifact; the manifest has <actual> (<path>)`. A transcript cannot answer a `visual` check.
- **A surface with no capture tool cannot claim `enforced`.** `desktop`'s `signing` and `update` checks demand artifact kinds (`signing`, `update`) that no script in this repository produces yet, so a policy copied today would gate on evidence someone has to attest by hand and a reviewer has to accept. That is the honest state: the check list is a declaration. M2b builds the capture tooling; until then the `experimental` column is the truth about the profile, not the row above it.

## What is *not* universal

- **WCAG applies only to human interfaces.** For `api`, `cli`, `library` and
  `infra` the equivalent is interface clarity: error messages, `--help`, docs
  and API naming. That is judged by a human, not by axe-core.
- **Screenshots are not evidence for everything.** An API leaves
  request/response transcripts. A library leaves an API diff and a consumer
  build. Infrastructure leaves a plan diff. Data leaves an eval report.
  Firmware leaves a HIL log.
- **"Deploy" is not one action.** Web and API deploy; mobile submits to a store;
  desktop ships a signed installer; a library publishes to a registry; infra
  applies a plan; firmware flashes OTA.
- **`--booted` becomes `--ran`.** The claim is always "what I started, what it
  answered, when, and where the artifact is" — a process, a container, a device,
  an emulator, an applied plan. The web server was only one instance of it.

## How the machine enforces a profile

1. `factory.policy.yaml` carries `profile:` next to `tier:`.
2. The profile maps to a **named check list**, not hardcoded logic. A missing
   check refuses the gate; the only way to drop one is to edit the policy, which
   is itself a reviewed change.
3. The evidence manifest records a `kind` per artifact, so G3 validates the
   *right* artifact rather than a screenshot for an API. The vocabulary is
   closed and declared once, as `DECLARABLE_KINDS` in `scripts/factory-policy.mjs`;
   attestation derives what it accepts from the same list, and `verify` refuses
   an artifact whose kind is not the kind its check declares. Declarable kinds:
   `screenshot`, `transcript`, `contract`, `api-diff`, `plan`, `eval`, `hil-log`,
   `prr`, `exit-code-matrix`, `golden-file`, `help-snapshot`, `tty-transcript`,
   `completion-script`, `install-log`, `device-capture`, `check-output`, `visual`,
   `authz`, `load`, `golden`, `tty`, `consumer-build`, `plan-diff`,
   `policy-check`, `device`, `signing`, `update`, `watchdog`, `recovery`,
   `frame`, `input`, `data-quality`. A thirty-third kind, `hidden-tests`, can be
   attested but not declared: the orchestrator writes it, and a policy entry
   would print its id in the review package the builder reads.
4. The Reviewer rubric is a property of the role, not the profile; it lives in `factory-v2-model.md` § Role contracts.
5. Multi-surface beads (web + API, mobile + backend) declare a **list** of
   profiles; G3 needs evidence for every surface. In a monorepo, profile is
   per package.

## Choosing a profile at G1

Ask what the consumer touches:

| Consumer touches… | Profile |
|---|---|
| a browser | `web` |
| HTTP / gRPC | `api` |
| argv and exit codes | `cli` |
| an import statement | `library` |
| a phone | `mobile` |
| a window | `desktop` |
| a dataset or model | `data-ml` |
| an `apply` | `infra` |
| a device | `embedded` |
| a frame | `game` |

If the answer is "more than one", the bead lists them all. If the answer is
unclear, that is a G1 failure, not a guess.

## The failure this prevents

A web-shaped factory does not merely ignore other domains; it **fabricates
evidence for them**. An API feature gets a screenshot of its documentation. A
library gets a "booted successfully" line about a test runner. An infra change
gets no runtime evidence at all, because nothing in the pipeline knows what a
plan is. Profiles turn those into explicit "not applicable, because …" decisions
that a human signs, instead of omissions nobody notices.

## Multi-surface projects

Most real products are not one surface. A single project may ship:

- a web app,
- native iOS and Android apps (separate codebases, separate stores),
- a desktop app for Windows, macOS and Linux,
- a public API and a shared core library,
- infrastructure and a data pipeline behind all of them.

Treating that as one profile produces two failure modes: **the wrong evidence**
(a screenshot of the web app presented as verification of the mobile app) and
**the missing surface** (a shared-core change shipped after testing only web).

### Vocabulary

| Term | Meaning |
|---|---|
| **Product** | the thing a user installs or visits; the unit a human cares about |
| **Surface** | one deliverable inside the product: `web`, `ios`, `android`, `windows`, `macos`, `linux`, `api`, `worker` |
| **Shared package** | code consumed by several surfaces: `core`, `design-tokens`, `api-schema`, `auth-client` |
| **Profile** | the evidence contract for a surface (`web`, `mobile`, `desktop`, `api`, `library`, `infra`, …) |

A surface has exactly one profile. A product has many surfaces. A profile can be
used by several surfaces (iOS and Android are both `mobile`, with a `platform`
attribute that selects the driver and the store).

### Declare the product once

`.factory/product.yaml`, committed:

```yaml
product: acme-notes
surfaces:
  - { id: web,     profile: web,      path: apps/web }
  - { id: ios,     profile: mobile,   platform: ios,     path: apps/ios }
  - { id: android, profile: mobile,   platform: android, path: apps/android }
  - { id: windows, profile: desktop,  platform: windows, path: apps/windows }
  - { id: api,     profile: api,      path: services/api }
shared:
  - { id: core,   path: packages/core,   consumers: [web, ios, android, windows] }
  - { id: tokens, path: packages/tokens, consumers: [web, ios, android, windows] }
  - { id: schema, path: packages/schema, consumers: [web, ios, android, windows, api] }
```

The bead declares intent; the factory computes impact:

```yaml
surfaces_affected: [web, api]
```

**Impact rule, enforced at G2:** The affected set is `computed ∪ declared-extra`. `computed` is the import graph — package manifests, `cargo tree`, `go list -deps`, dependency-cruiser, Gradle/Bazel build graphs — plus a `generates:` edge for generated clients. A declaration that omits a computed surface is refused, naming the file that pulled it in. A declaration may add a surface the graph does not see, but it must say why in one line. This is the
rule that stops "we changed the auth client and only tested web".

### What each gate means for a product

| Gate | Product-level requirement |
|---|---|
| **G1** | The product has a surface list. Each surface names its profile, or is explicitly out of scope with a reason. A feature names which surfaces it changes, and why the others are unaffected. |
| **G2** | Every affected surface has a build plan and a test plan. A contract or shared-schema change has a compatibility decision: backward compatible, or a migration window with a named end date. |
| **G3** | Evidence exists **per affected surface**, in that surface's own form: web captures, device captures for iOS and Android, window captures and installer test for desktop, contracts and load result for the API. Plus the cross-surface checks below. |
| **G4** | Outcome recorded per surface that shipped, plus a product-level statement: which versions are live, which clients are still on an older contract, and what the next change costs. |

G3 refuses if any affected surface has no evidence. It does not average: a green
web run cannot cover a red mobile run.

### Cross-surface checks

These only exist for multi-surface products, and they are the reason a product
needs a product-level gate rather than N independent ones:

1. **Contract compatibility.** The API schema is the shared truth. Every client
   is tested against the version it will actually talk to, including one version
   behind. Contract tests are generated from the schema, not hand-written twice.
2. **Compatibility matrix.** Record, per release: surface, version, minimum
   supported contract, rollout state. Mobile and desktop lag by design — store
   review, staged rollout, users who never update — so the server must support
   the oldest client still in the field. A breaking change is a G2 decision with
   a dated migration window, never a side effect.
3. **Design coherence.** One token source, consumed by every human surface.
   Composition is platform-native: iOS follows its platform conventions, Android
   follows its own, web follows neither. The rule is *shared tokens, native
   composition* — not pixel parity, which produces apps that feel wrong on every
   platform.
4. **Feature parity declaration.** A product-level matrix of which surfaces have
   which capability. Deliberate gaps are fine and must be stated; accidental gaps
   are defects. A feature that ships on web and silently not on mobile is a G3
   finding, not a backlog item.
5. **Identity and data across surfaces.** One auth flow, token storage per
   platform (Keychain, Keystore, DPAPI, secure enclave), and a sync or conflict
   rule if surfaces share mutable state. Test the second device, not just the
   first.
6. **Secrets do not exist in client binaries.** Mobile and desktop artifacts are
   decompilable. A key shipped in a client is a security finding at G3 regardless
   of how well it is obfuscated.

### Release is per surface, rollback is per surface

| Surface | Ships by | Undo by |
|---|---|---|
| web | deploy | redeploy previous build, flag off |
| api | blue/green or canary | traffic shift, migration down |
| ios / android | store review, phased rollout | halt rollout; server-side kill switch for behaviour |
| windows / macos / linux | signed installer, auto-update | previous version pin, update channel rollback |
| library | registry publish | yank, patch release |
| infra | apply | revert plan, state restore |

**Ordering rule:** ship the server before the client when the change is additive;
ship the client before the server only behind a flag, and never remove a field a
released client still reads. The release record lists the order actually used.

### Repository shape this assumes

```text
apps/web            apps/ios        apps/android     apps/windows
services/api        packages/core   packages/tokens  packages/schema
infra/
```

One factory run, one bead, one feature document — many surfaces in the evidence
manifest:

```json
{
  "bead": "acme-7f2",
  "surfaces": [
    { "id": "web", "profile": "web", "artifacts": ["screenshots/1440.png", "axe.json"] },
    { "id": "api", "profile": "api", "artifacts": ["contract.json", "load.json"] }
  ]
}
```

The verifier walks `surfaces[]`, not a fixed list of filenames. A missing entry
for an affected surface is a refusal; an entry whose `kind` does not match the
profile is also a refusal.

### What stays product-level

The feature document, the spec, the acceptance criteria, the risk tier, the
compatibility decision, the release record and the G4 outcome. Surfaces produce
evidence; the product makes the promise.

## What stays the same

The four gates, the evidence manifest, independence, tiering, `protected_files`,
the reproducible scenario, honest failure recording, and G4. A profile may add
requirements. It may never remove one from the invariant core.
