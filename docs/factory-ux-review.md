# opencode-factory - UX and deployability review

Date: 2026-11-09 Â· Revised 2026-11-15 (applied an in-review read: F1 retitled â€” the selfcheck was loud at run time; the gap is that nothing schedules a re-check. F6 rewritten to evidence only. F5 names its consequence. Coverage section added below.) · Revised again 2026-11-15 (the installer re-run on d7adea1 failed its final selfcheck - the installed docs named four scripts the bundle never shipped; fixed in 50fa229 as a 16-script bundle; verification re-run launched; see F5 and the verification verdict below.) | Revised 2026-11-16 (verification re-run at 50fa229: six suite gates green, final selfcheck exit 0; F1 and F5 closed) Â· Reviewer: opencode (in-session) Â· Branch: feat/m4-make-it-learn Â· Repo: masoodhumza60/opencode-factory

Scope: the whole factory as a *user-facing product* â€” installer, docs, CLIs, the selfcheck, the `factory` skill, the seed apps â€” not the test harness. The request was a report, fixes, and a deployable state. This file is the report; the fixes are committed; the ceilings are stated, not hidden.

## GitHub (the remote)

Clean. Zero open and zero closed issues; zero PRs; default branch `master` (`3141ab2`); remote branches only the consolidation ones. There was nothing on GitHub to fix or fold in â€” everything that mattered lived in the repo itself.

## Findings, and what was done about them

### F1 â€” The deployed bundle drifted from this repo; a hand-run selfcheck caught it (Critical, fixed surgically)

`node scripts/factory-selfcheck.mjs` on this machine printed `FAIL factory runtime scripts deployed â€” missing from the install: factory-manifest.mjs, factory-policy.mjs, factory-attest.mjs, factory-review.mjs â€” the installed docs reference them (re-run install.ps1/install.sh)` and exited 1. The failure was **loud at the moment it ran** â€” this check exists because of exactly this drift (see F7). The gap that let it persist for weeks was not silence inside the check; it is that *nothing schedules a re-check*, so drift is only ever caught by a human remembering to run one. The repo's installers shipped the 12-script set and were never extended when M2b/M2c and this milestone added the four scripts the installed docs name; as of 50fa229 they ship all 16 (install.ps1, `$runtimeScripts` at line ~216; install.sh likewise) â€” the user-level install at `~/.agents/skills/factory/scripts/` was an old 8-script bundle that never received the M1a/M2c scripts.

Fix applied surgically, not silently: the four missing scripts were copied from this repo into `~/.agents/skills/factory/scripts/` (nothing else touched). Re-run: `All selfchecks passed`, exit 0.

Remaining honest gap: the other installed scripts (including `factory-phase.mjs`, which enforces phase 8's outcome gate on this branch) were the old versions deployed at the M4a close. The selfcheck cannot see version skew - presence is what it checks. The full re-run happened 2026-11-15 14:12 (bundle `d7adea1`): everything passed - bd, config, mandatory skills, DCP, and all six suite gates including the phase suite - until the FINAL selfcheck, which FAILED naming exactly the four scripts the bundle list missed (`factory-outcome.mjs`, `factory-design.mjs`, `factory-capture.mjs`, `factory-compliance.mjs`). The failure was introduced by this milestone. Fix `50fa229` ships all four (bundle now 16 scripts); Verification re-run on 2026-11-16: the 16-script bundle deployed, all six suite gates passed, and the final selfcheck printed `All selfchecks passed — factory is ready` (exit 0). F1 is closed.

### F2 â€” The Unix installer never failed the install (High, fixed in `9f4e8b6`)

`install.sh`'s `run_selfcheck` printed `selfcheck: OK` unconditionally â€” the documented fail-stop ("If the selfcheck fails, the installer **aborts**") held on Windows only. Now it exits 1 with the same message as `install.ps1` when the selfcheck is non-zero.

### F3 â€” The normative docs teach a dead flag (High, fixed in `9f4e8b6`)

Phase 5 requires `--ran "<command> -> <observed result> at <ISO-8601>" --artifact <path>` (enforced in `scripts/factory-phase.mjs`: one `->`, no double quotes, â‰¤ 255 chars, ISO timestamp after `at`); `--booted` is a one-release deprecated alias. `docs/conductor.md` (the "authoritative how-to") still mandated `--booted` in six places â€” a first-run user following the doc literally would have every phase-5 completion refused. Fixed: all six occurrences now teach `--ran`, including the example and format limits. `docs/HOW-INSTALL.md` l.126/l.169/l.300 carried the same drift; fixed. Historical narrative docs (`factory-fit-map.md`, `factory-gap-analysis.md`, `factory-domain-profiles.md`, `factory-roadmap.md`) still mention `--booted` as history, deliberately â€” they describe what the machine used to demand.

### F4 â€” "6 PASS checks" is a fiction; the selfcheck has more checks and a tri-state verdict (Medium, fixed in `9f4e8b6`)

`scripts/factory-selfcheck.mjs` pushes ~26 verdicts across plugins, mcp requirements, beads store, dcp pruning, mandatory skills, verify-app, docs-completeness, the phase-machine smoke test, context footprintâ€¦ The docs (README l.42/l.53; AI-AGENT-SETUP l.57-59/l.71/l.83) claimed "6 PASS lines" and, worse, told agents that lines printing WARN are "informational â€” ignore them" while a non-zero exit means a FAIL. An agent following that would accept a red install. Fixed: docs now teach "every check must print PASS and the command must exit 0", WARNs are informational, non-zero exit = FAIL with a named repair.

### F5 â€” Two shipped installer defects from the M3 review remain unverified live (Medium, documented, not silently claimed)

- The `install.ps1` `__EXITCODE__` sentinel change (suites could not feed a fake exit code to the suite gate) is committed and parse-checked but **never exercised by a live install**.
- `install.sh` has no wall-clock timeout on its test-suite loop (PS1 enforces a 60-minute bounded job; portable bash has no such primitive). A hang there still hangs the installer. Documented trade-off; use `timeout(1)` on Unix if you need the bound.
- One consequence worth naming: the installer re-run recommended below is also the **first live exercise** of these F5 code paths. If it fails there, the cause may be the new PowerShell code rather than the old bundle â€” which is itself useful evidence, but should be expected, not a surprise.
- **Live exercise (partial), 2026-11-15:** the first full re-run executed the Run-Tests gate end-to-end and the installer **fail-stopped loudly** at the phase suite â€” `test-factory-phase.mjs failed (exit 1)` â†’ exit 1, `Run-Selfcheck` never ran, no false PASS. That verified the F5 failure branch on a real machine. The **green** path is now verified live: the 2026-11-16 verification re-run at bundle `50fa229` deployed all 16 runtime scripts, every suite gate passed, and the final selfcheck completed with exit 0. F5's green path is closed; `install.sh`'s missing timeout remains a documented trade-off.

### F6 â€” The phase suite â€” **CLOSED 2026-11-15**

Evidence: two background launches hit the 50-minute tool timeout with zero output; an unlimited-timeout re-run died in a session restart at ~18.8 KB. The first installer re-run then exercised the suite live and it **crashed at `test-factory-phase.mjs:1472`** â€” `mkdirSync` on the ledger path the suite's earlier blocks had already created (the phase machine at `195c810` appends a ledger row on every successful `complete 8`). Fixed in `13243ab`: back up the pre-existing `SANDBOX/docs/outcomes.jsonl`, `rm` it, `mkdir` the directory marker, prove the refusal, restore the backup, and assert the good-append lands exactly one additional row. One clean run at `13243ab` to a file: **180/180 phase-machine tests passed**, exit 0 (`%TEMP%\phase-suite-task2-fix.log`, `%TEMP%\phase-suite-task2-fix.exit` = 0). Attest re-run 2026-11-15: **112/112 attest tests passed**, exit 0 (`%TEMP%\attest-m4a.log`, `.exit` = 0). F6 and the attest gate are both closed.

### F7 â€” Honest ceilings that persist (by design, stated)

- No CI in this repo. Every suite runs by hand. The installer runs the relevant ones; the reader must.
- Historically stale factory/docs on every machine installed before October 10: the "docs ship with the scripts" selfcheck (F1) now exists because of this; the failure mode is real and only visible on the machine itself.
- `skills.lock.json` missing after install prints WARN â€” informational by design, exit code unaffected.
- The `--booted` â†’ `--ran` rename means any book paraphernalia outside the repo (screenshots, videos, talks) referring to `--booted` is stale; this repo cannot fix those.
- Seed apps: `orderboard`/`orderboard-api`/`orderboard-cli` still contain a plaintext auth pattern deliberately (documented in tests as the thing the factory is meant to harden). They are teaching material, not production code; do not copy their security posture.
- Citation policy: claims in this file came from `Select-String`/source reads at review time; suite counts shown in roadmap/README may drift between milestones and are re-stated at each close.

## What this review did not check (honest coverage)

- `commands/factory/*.md` (feature, onboard, selfcheck) were never read line-by-line; `skills/factory/SKILL.md` beyond the installed-presence check; `agents/beads-task-agent.md`, `plugins/`, `executables/`, `skills/catalog.yaml` â€” none audited here.
- The seed apps were surveyed only for the M4 milestone, not re-reviewed for this report.
- GitHub was checked for issues, PRs and branches only â€” not releases/tags, Actions, branch protection, or README CI badges.
- Suite ledger at the close of M4a: phase 180/180 (`13243ab`, `%TEMP%\phase-suite-task2-fix.log`); outcome 9/9; skills 44/44; attest 112/112 (`%TEMP%\attest-m4a.log`, `.exit` = 0); policy, review, delivery, manifest, protect, fixture, design, capture, compliance, fake-ship suites NOT re-run this milestone (delivery was 70/70 at `2d2d5b0`). Roadmap counts updated together where they are restated.
- The report's suite counts claim ("nothing green claimed") is deliberate: this review closes doc and installer defects, not milestone verification.

## What "deployable again" means, and what this review verified

- **This machine**: selfcheck red â†’ repaired surgically â†’ `All selfchecks passed`, exit 0. Deployable, verified against bundle `50fa229`.
- **A fresh machine**: `install.ps1` / `install.sh` from the repo at `50fa229` installs the 16-script set, enforces all steps fail-stop (both platforms), and ends in a green selfcheck or a named failure. Verified end-to-end on 2026-11-16: full install at `50fa229`, 6/6 suite gates passed, final selfcheck green (exit 0).
- **Consistency**: everything in this file is committed or explicitly flagged as open: F1, F5 and F6 are all closed with evidence. `50fa229`, `bc14d30` and later doc-only commits are not pushed; nothing moved on the remote.

## Verification verdict - 2026-11-16

The verification re-run happened at bundle `50fa229` (launch failed twice on the way - one parameter binding error, one transcript lock; neither ran any install step). It completed end-to-end: bd verified, config merged, factory skill deployed, 16 runtime scripts deployed (including factory-outcome.mjs, factory-design.mjs, factory-capture.mjs, factory-compliance.mjs), install manifest written (25 files, bundle 50fa229), mandatory skills 2/2, DCP prompts unchanged, all six suite gates passed ("selfcheck tests: OK"), and the final `factory-selfcheck.mjs` printed all PASS with "All selfchecks passed - factory is ready." (exit 0).

F1 and F5 are CLOSED. `50fa229` and `bc14d30` are not pushed; master is untouched (3141ab2). The remaining WARNs on the machine are informational by design (skills.lock.json). The `dcp prompt` persistence caveat noted in the installer output applies to this same session and is inherited from the pre-existing DCP gap, not introduced here.

