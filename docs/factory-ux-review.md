# opencode-factory — UX and deployability review

Date: 2026-11-09 · Reviewer: opencode (in-session) · Branch: feat/m4-make-it-learn · Repo: masoodhumza60/opencode-factory

Scope: the whole factory as a *user-facing product* — installer, docs, CLIs, the selfcheck, the `factory` skill, the seed apps — not the test harness. The request was a report, fixes, and a deployable state. This file is the report; the fixes are committed; the ceilings are stated, not hidden.

## GitHub (the remote)

Clean. Zero open and zero closed issues; zero PRs; default branch `master` (`3141ab2`); remote branches only the consolidation ones. There was nothing on GitHub to fix or fold in — everything that mattered lived in the repo itself.

## Findings, and what was done about them

### F1 — The live machine was undeployable, silently (Critical, fixed)

`node scripts/factory-selfcheck.mjs` on this machine printed `FAIL factory runtime scripts deployed — missing from the install: factory-manifest.mjs, factory-policy.mjs, factory-attest.mjs, factory-review.mjs — the installed docs reference them (re-run install.ps1/install.sh)` and exited 1. The repo's installers ship the full 12-script set (install.ps1, `$runtimeScripts` at line ~216; install.sh likewise) — the user-level install at `~/.agents/skills/factory/scripts/` was an old 8-script bundle that never received the M1a/M2c scripts, and nothing told the machine it had drifted until the selfcheck refused it.

Fix applied surgically, not silently: the four missing scripts were copied from this repo into `~/.agents/skills/factory/scripts/` (nothing else touched). Re-run: `All selfchecks passed`, exit 0.

Remaining honest gap: the other 8 installed scripts (including `factory-phase.mjs`, which is what enforces phase 8's outcome gate on this branch) are still the **old** versions. The selfcheck cannot see version skew — presence is what it checks. **A full `install.ps1` re-run is the only consistent repair; it is recommended and not done yet**, because it re-runs the whole pipeline (suites, mandatory-skills fetch, config merge). It is idempotent by construction. This review did not run it.

### F2 — The Unix installer never failed the install (High, fixed in `9f4e8b6`)

`install.sh`'s `run_selfcheck` printed `selfcheck: OK` unconditionally — the documented fail-stop ("If the selfcheck fails, the installer **aborts**") held on Windows only. Now it exits 1 with the same message as `install.ps1` when the selfcheck is non-zero.

### F3 — The normative docs teach a dead flag (High, fixed in `9f4e8b6`)

Phase 5 requires `--ran "<command> -> <observed result> at <ISO-8601>" --artifact <path>` (enforced in `scripts/factory-phase.mjs`: one `->`, no double quotes, ≤ 255 chars, ISO timestamp after `at`); `--booted` is a one-release deprecated alias. `docs/conductor.md` (the "authoritative how-to") still mandated `--booted` in six places — a first-run user following the doc literally would have every phase-5 completion refused. Fixed: all six occurrences now teach `--ran`, including the example and format limits. `docs/HOW-INSTALL.md` l.126/l.169/l.300 carried the same drift; fixed. Historical narrative docs (`factory-fit-map.md`, `factory-gap-analysis.md`, `factory-domain-profiles.md`, `factory-roadmap.md`) still mention `--booted` as history, deliberately — they describe what the machine used to demand.

### F4 — "6 PASS checks" is a fiction; the selfcheck has more checks and a tri-state verdict (Medium, fixed in `9f4e8b6`)

`scripts/factory-selfcheck.mjs` pushes ~26 verdicts across plugins, mcp requirements, beads store, dcp pruning, mandatory skills, verify-app, docs-completeness, the phase-machine smoke test, context footprint… The docs (README l.42/l.53; AI-AGENT-SETUP l.57-59/l.71/l.83) claimed "6 PASS lines" and, worse, told agents that lines printing WARN are "informational — ignore them" while a non-zero exit means a FAIL. An agent following that would accept a red install. Fixed: docs now teach "every check must print PASS and the command must exit 0", WARNs are informational, non-zero exit = FAIL with a named repair.

### F5 — Two shipped installer defects from the M3 review remain unverified live (Medium, documented, not silently claimed)

- The `install.ps1` `__EXITCODE__` sentinel change (suites could not feed a fake exit code to the suite gate) is committed and parse-checked but **never exercised by a live install**.
- `install.sh` has no wall-clock timeout on its test-suite loop (PS1 enforces a 60-minute bounded job; portable bash has no such primitive). A hang there still hangs the installer. Documented trade-off; use `timeout(1)` on Unix if you need the bound.

### F6 — The phase suite is UNVERIFIED on this branch (Medium, open, honest)

Two background launches of `node scripts/test-factory-phase.mjs` exceeded the 50-minute tool timeout with zero output (the second broke the never-concurrent rule by overlapping the first). A third run, launched with unlimited timeout writing full raw output to a log, had produced ~10.8 KB of output but no exit verdict at the time this review was written — the suite passes its checks invisibly to the file redirect because bd's noise is buffered, and this machine's bd has a known-illusory staleness issue ("beads.role not configured (GH#2950)" warnings throughout). **No claim is made that the suite passes at commit `195c810`/`9f4e8b6`.** It must be run once, cleanly, to a file, with the verdict read from the tail, before the phase suite's documented counts are restated. attest and phase must never run concurrently; neither is settled.

### F7 — Honest ceilings that persist (by design, stated)

- No CI in this repo. Every suite runs by hand. The installer runs the relevant ones; the reader must.
- Historically stale factory/docs on every machine installed before October 10: the "docs ship with the scripts" selfcheck (F1) now exists because of this; the failure mode is real and only visible on the machine itself.
- `skills.lock.json` missing after install prints WARN — informational by design, exit code unaffected.
- The `--booted` → `--ran` rename means any book paraphernalia outside the repo (screenshots, videos, talks) referring to `--booted` is stale; this repo cannot fix those.
- Seed apps: `orderboard`/`orderboard-api`/`orderboard-cli` still contain a plaintext auth pattern deliberately (documented in tests as the thing the factory is meant to harden). They are teaching material, not production code; do not copy their security posture.
- Citation policy: claims in this file came from `Select-String`/source reads at review time; suite counts shown in roadmap/README may drift between milestones and are re-stated at each close.

## What "deployable again" means, and what this review verified

- **This machine**: selfcheck red → repaired surgically → `All selfchecks passed`, exit 0. Deployable as of this review.
- **A fresh machine**: `install.ps1` / `install.sh` from the repo at `9f4e8b6` installs the 12-script set, enforces all steps fail-stop (now on both platforms), and ends in a green selfcheck or a named failure. Not exercised end-to-end this session — a full install with real `npx skills add` is a live action that was not taken without approval.
- **Consistency**: everything in this file is committed (`9f4e8b6`) or explicitly flagged as open (F5, F6). Nothing pushed to GitHub.

## The one thing to do next

Run the full installer once on this machine (`powershell -ExecutionPolicy Bypass -File install.ps1`, or `install.sh` on Unix) so the installed bundle matches the repo — then re-run `node scripts/factory-selfcheck.mjs` and expect `All selfchecks passed`. That closes F1 completely, refreshes the installed conductor/docs, and exercises the F5 code paths on a real machine. It is your call, and it is not done.
