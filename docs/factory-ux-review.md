# opencode-factory - UX and deployability review

Date: 2026-11-09 - Revised 2026-11-15 - Revised again 2026-11-16 - Revised 2026-11-17 (corrections pass: line-level claims re-checked against evidence; see "Corrections made in this revision")
Reviewer: opencode (in-session) - Branch: feat/m4-make-it-learn - Repo: masoodhumza60/opencode-factory

Scope: the whole factory as a *user-facing product* - installer, docs, CLIs, the selfcheck, the `factory` skill, the seed apps - not the test harness. The request was a report, fixes, and a deployable state. This file is the report; the fixes are committed and pushed; the ceilings are stated, not hidden.

## What this review did - line by line

| Surface | Coverage | Strength |
|---|---|---|
| `install.ps1`, `install.sh` | Read end-to-end; fail-stop logic; 16-script bundle; `__EXITCODE__` sentinel (PS1); 60-min bounded job; no bash wall-clock bound (trade-off, F5) | Strong - exercised live twice (FAIL path 2026-11-15; PASS path 2026-11-16) |
| `scripts/factory-selfcheck.mjs` | Read (tri-state verdict model; inconclusive excluded from FAIL/PASS; `--tokens` note) | Strong - observed in both runs |
| README, AI-AGENT-SETUP, HOW-INSTALL, conductor.md, AI-AGENT-PROJECT-SETUP | Doc claims vs. enforced behavior; `--booted` -> `--ran` correction; "6 PASS" fiction | Strong - edited and committed |
| `docs/factory-ux-review.md` | Every line re-read in this revision | Strong - corrections listed below |
| This machine's install (`~/.agents/skills/factory/scripts/`) | Surgical re-copy of 4 missing scripts (2026-11-15); full 16-script reinstall, 2026-11-16 | Strong for *presence*; parity of already-installed older scripts NOT checked |
| GitHub | Issues (0), PRs (0), branches (all), remote refs | Medium - releases/tags/Actions/protection/license NOT audited |
| `factory-phase.mjs` (phase 8's outcome gate) | Read via M4a (committed 249592e/195c810) | Strong (not this report's scope, but referenced) |
| The seed apps | Surveyed for M4 only, not re-reviewed here | Weak - see "did not check" |
| `commands/factory/*.md`, `skills/factory/SKILL.md` body, `agents/`, `plugins/`, `executables/`, `skills/catalog.yaml`, `mcp-requirements.json` | Presence only (selfcheck covers docs-vs-bundle presence) | None - not audited |

## GitHub (the remote)

Clean. Zero open and zero closed issues; zero PRs; default branch `master` (`3141ab2`); remote branches: `feat/mcp-registry` (merged), `feat/mcp-registry-consolidated` (merged), `feat/m3-delivery-drill` (merged, branch gone), `feat/m4-make-it-learn` (added by this session; `d7adea1..416af31` pushed 2026-11-17). Nothing on GitHub needed fixing. Releases, tags, Actions, and branch protection: not audited.

## Findings, and what was done about them

### F1 - The deployed bundle drifted from this repo; a hand-run selfcheck caught it (Critical, fixed)

Evidence: `factory-selfcheck.mjs` on this machine printed `FAIL factory runtime scripts deployed - missing from the install: factory-manifest.mjs, factory-policy.mjs, factory-attest.mjs, factory-review.mjs - the installed docs reference them (re-run install.ps1/install.sh)` and exited 1. The failure was loud at the moment it ran. The repo's installers shipped the 12-script set and were never extended as M2b/M2c and this milestone added four scripts the installed docs name; as of `50fa229` they ship all 16.

Fix, 2026-11-15: the four missing scripts were copied surgically into `~/.agents/skills/factory/scripts/` (nothing else touched); re-run printed `All selfchecks passed`, exit 0. The full re-run on 2026-11-15 14:12 (bundle `d7adea1`) passed bd, config, mandatory skills, DCP, and all six suite gates - then the FINAL selfcheck FAILED, naming exactly the four scripts the bundle list missed (`factory-outcome.mjs`, `factory-design.mjs`, `factory-capture.mjs`, `factory-compliance.mjs`). The failure was introduced by this milestone; it had never shipped a green bundle before.

Fix `50fa229` shipped all 16; verification re-run on 2026-11-16 (bundle `50fa229`): the 16-script bundle deployed, all six suite gates passed, final selfcheck `All selfchecks passed - factory is ready.`, exit 0. F1 is closed **for this machine and this bundle**. Version skew of already-installed scripts remains unverified (presence is what the selfcheck checks).

### F2 - The Unix installer never failed the install (High, fixed in `9f4e8b6`)

`install.sh`'s `run_selfcheck` printed `selfcheck: OK` unconditionally. Now it exits 1 with the same message as `install.ps1`.

### F3 - The normative docs teach a dead flag (High, fixed in `9f4e8b6`)

Phase 5 requires `--ran "<command> -> <observed result> at <ISO-8601>" --artifact <path>` (`scripts/factory-phase.mjs`: one `->`, no double quotes, 255-char cap, ISO timestamp after `at`); `--booted` is a one-release deprecated alias. `docs/conductor.md` (the "authoritative how-to") still mandated `--booted` in six places; fixed. `docs/HOW-INSTALL.md` carried the same drift; fixed. Historical narrative docs still mention `--booted` as history, deliberately.

### F4 - "6 PASS checks" is a fiction; the selfcheck has more and a tri-state verdict (Medium, fixed in `9f4e8b6`)

`factory-selfcheck.mjs` pushes ~26 verdicts across plugins, mcp requirements, beads store, dcp pruning, mandatory skills, verify-app, docs-completeness, a phase-machine smoke test, and context footprint. Docs claimed "6 PASS lines" and told agents WARNs are ignorable while a non-zero exit means a FAIL - an agent would have accepted a red install. Fixed: docs now teach "every check must print PASS and the command must exit 0"; WARNs are informational; non-zero exit = FAIL with a named repair.

### F5 - Installer defects live paths (Medium, now verified live)

- `install.ps1`'s `__EXITCODE__` sentinel (last-match) is exercised by every live install; the 2026-11-15 fail-stop and the 2026-11-16 green run both went through it.
- `install.sh` has no wall-clock timeout on its test-suite loop (PS1 enforces a 60-minute bounded job; portable bash has no such primitive). A hang there still hangs the installer. Documented trade-off; use `timeout(1)` on Unix if you need the bound.
- 2026-11-15 live exercise: fail-stop at the suite gate, exit 1, Run-Selfcheck never ran - verified the F5 failure branch on a real machine.
- 2026-11-16 live exercise: green path - suite gates all passed, final selfcheck exit 0. F5's green path is closed.

### F6 - The phase suite - CLOSED 2026-11-15

Evidence: two background launches hit the 50-minute tool timeout with zero output; an unlimited re-run died in a session restart at ~18.8 KB. The first installer re-run then crashed the suite at `test-factory-phase.mjs:1472` - `mkdirSync` on the ledger path its earlier blocks had already created (the phase machine at `195c810` appends a ledger row on every successful `complete 8`). Fixed in `13243ab`: back up the pre-existing `SANDBOX/docs/outcomes.jsonl`, `rm` it, `mkdir` the directory marker, prove the refusal, restore the backup, assert exactly one more ledger row. One clean run at `13243ab` to a file: **180/180 phase-machine tests passed**, exit 0 (`%TEMP%\phase-suite-task2-fix.log`, `.exit` = 0). attest re-run 2026-11-15: **112/112**, exit 0 (`%TEMP%\attest-m4a.log`, `.exit` = 0).

### F7 - Honest ceilings that persist (by design, stated)

- No CI in this repo (as of 2026-11-17; tasked this session, not yet landed). Suites run by hand.
- Drift is only caught when a human re-runs the selfcheck; nothing schedules one after install.
- `skills.lock.json` missing after install prints WARN - informational; exit code unaffected.
- External materials referring to `--booted` are stale; this repo cannot fix them.
- `orderboard` (web) and `orderboard-api` (api) still contain deliberately plaintext auth (documented as teaching material); do not copy their security posture. (This line originally mis-claimed `orderboard-cli` as well - corrected.)
- Suite counts in this file are milestone-historical unless restated at each close.

## What this review did NOT check (coverage - not re-claimed)

- `commands/factory/*.md`, `skills/factory/SKILL.md` body, `agents/beads-task-agent.md`, `plugins/`, `executables/`, `skills/catalog.yaml`, `mcp-requirements.json` - presence only via selfcheck.
- Fresh-machine/VM install - never exercised. This machine only.
- Version skew of the already-installed older scripts (presence is what the selfcheck sees).
- Seed apps' security/quality - not re-reviewed.
- GitHub releases/tags/Actions/branch protection/license/CONTRIBUTING - not audited as of this revision (branch protection now tasked this session, pending your approval).
- attest and non-phase suites at HEAD - attest 112/112 at M4a (2026-11-15); all others NOT re-run at HEAD (delivery was 70/70 at `2d2d5b0`).
- Branch merge of `feat/m4-make-it-learn` into `master` - pending your decision; nothing was merged or pushed to master by this review.

## What "deployable again" means, and what this review verified

- **This machine**: red -> surgically repaired -> green; full re-install at `50fa229` (2026-11-16) end-to-end green, exit 0. Deployable verified on this machine only.
- **A fresh machine**: not exercised. `install.ps1`/`install.sh` from `50fa229` should work by construction (fail-stop, 16-script bundle), but no clean VM has run it. That is the open deployment claim.
- **Push state**: this review's fixes are on `feat/m4-make-it-learn`; `416af31` pushed 2026-11-17; `master` untouched at `3141ab2`.

## Verification verdict - 2026-11-16 (pushed 2026-11-17)

The verification re-run happened at bundle `50fa229` (two launch failures on the way - parameter binding, then a transcript lock; neither ran any install step). It completed end-to-end: bd verified, config merged, verify-app skill deployed, 16 runtime scripts deployed, install manifest written (25 files), mandatory skills 2/2, all six suite gates passed, final selfcheck all PASS, exit 0. **F1, F5 and F6 are closed.**

## Corrections made in this revision (the review of the review)

- Removed "before October 10" - an unverifiable invented date; F1's actual date evidence is 2026-11-15/16.
- Corrected the seed-app claim: only `orderboard` and `orderboard-api` carry deliberate plaintext auth (`orderboard-cli` does not exist).
- Fixed the self-contradiction "nothing green claimed" - greens claimed here (F6 180/180, attest 112/112, selfcheck exit 0) are all tied to dated logs and commits.
- Fixed the stale F5 bullet claiming the sentinel was "never exercised by a live install" - it has been exercised live twice.
- Refreshed push state: the review previously said the fixes were not pushed; as of 2026-11-17, `416af31` is on origin.
- Normalized encoding: the committed file contained mojibake (`A?`, `%?`, `?+`) from PowerShell edits; rewritten clean UTF-8.
- Sanity-checked every remaining word. What remains claimed was observed, in-session, in this machine, on this branch. What the evidence does not show is moved into "What this review did NOT check".
