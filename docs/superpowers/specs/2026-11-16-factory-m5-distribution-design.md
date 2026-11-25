# M5 — Distribution and trust: release identity for the bundle

Spec: 2026-11-16
Branch at spec time: `master` @ e38f2fc
Binding decisions from brainstorming 2026-11-16 (Humza chose):
- M5 = release identity only (not `factory upgrade`).
- Fresh CI runners are the clean-machine proof.
- Selfcheck green on both fresh runners is the acceptance (no extra smoke feature on runners).
- Approach A chosen: git is the install artifact, the tag is the release, CI fresh runners are the stranger. npm-registry and attached-installer distribution were rejected.

## Intent — why this milestone exists

M0-M4 built the factory that works for one person on one machine. The roadmap's own gate is "without it there is no second user": until a stranger can install and get the same result, the factory proof is anecdotal. M5 makes the install a *known thing* — a version, a tag, a changelog and an automated fresh-machine check — so installing isn't a bet.

M5 does not make the factory distributable software in the app-store sense; it makes the bundle's release identity honest and falsifiable.

## Goals

1. **Version stamp.** `package.json` moves `0.0.0` → `1.0.0`. The install scripts print the bundle's version near their start, e.g. `opencode-factory install (bundle: <path>, version 1.0.0)`. The selfcheck output carries the version it verified.
2. **CHANGELOG.md** (new, at repo root). One entry per milestone (M0–M5), dates, what shipped, honest ceilings where relevant. Not a history of every commit.
3. **Fresh-runner clean-machine check.** Two new CI jobs beside the existing suites, on `ubuntu-latest` and `windows-latest`:
   - checkout the repo at the branch/commit under test;
   - run the real platform installer with defaults (`install.sh` / `install.ps1`, no `-DryRun`, including bd install; the runners carry node, the scripts must not require a Windows admin elevation);
   - run `node scripts/factory-selfcheck.mjs --tokens` and require exit 0 with every check PASS.
   Failing either job fails the build. They augment, not replace, the four existing required checks.
4. **Install docs point at the tag.** `README.md` and the `AI-AGENT-PROJECT.md` / `docs/HOW-INSTALL.md` install lines reference `v1` (or `v1.0.0`) instead of `master`.
5. **`v1` tag.** Created and pushed only after you explicitly approve at the end of this milestone. Nothing is pushed or tagged without it.

## Non-goals / anti-goals

- **No `factory upgrade`** in M5. It is the natural follow-on but it is a larger piece of work (versioned install set, lockfile semantics, upgrade refusal/rollback, preservation of local state) and gets its own milestone.
- **No npm publish.** The registry adds an unverified second path for one operator.
- **No attached release artifacts.** git is the artifact; a second form is drift to maintain.
- **No CI required-status-checks change** by this milestone. The two new jobs are added workflow jobs; whether they become required checks is your separately-recorded protection decision, unchanged by default.
- No M4/DORA changes, no M6 work.

## Constraints

- The clean machines are GitHub's fresh runners; there is no second physical box, and that is accepted as the level of proof for this milestone.
- Installer default path must work under default runner permissions: no new prompts, no elevation, no network beyond what the install already fetches (node/bd are already runner staples or installed by the script).
- Tag and push only on explicit user approval at the end.
- `factory-phase.mjs`'s standing ` M` and untracked plans are never touched by any commit in this milestone.
- PowerShell-and-this-repo conventions hold: PowerShell 5.1, no BOM, no committed `out/`.

## Approaches considered

- **A. Git is the artifact, tag is the release, CI fresh runners are the stranger. (chosen)** Smallest honest change: the repo you already install becomes the release you install. Trade-off: it depends on GitHub uptime for the stranger check and offers no registry-style pinning — fine for one operator and accepted.
- **B. npm-registry publish.** Real second distribution path, but doubles the unverified surface (registry auth, package contents, Windows-vs-Unix parity in a packaged bin) and isn't needed for a one-operator bundle today. Rejected.
- **C. GitHub releases with attached zip/installer.** Extra artifact with a second sync surface; no upside when the repo already clones and pushes. Rejected.

## Parts of the design

### Version
- `package.json` version 1.0.0; no new version file. Install scripts (`install.ps1`, `install.sh`) read it via `node -p "require('./package.json').version"` (or an embedded constant — builder's call in-plan) and echo it in their first output line.
- `factory-selfcheck.mjs` reports the version alongside the PASS summary (read from the same source the installer used).

### CHANGELOG.md
- Written at repo root in keep-notes style. M0 → stop-the-lying; M1a release; M1b; M1c; M2a; M2b; M2c; M3 drill; M4 outcome loop + calibration + evals; M5 release identity. Each entry: date, one-line summary, honest ceilings where they exist. No promises, no metrics we do not have.

### CI jobs
- Add two jobs to `.github/workflows/suites.yml`: `install-ubuntu`, `install-windows` (names chosen at plan time; they must not collide with required check names).
- Steps: checkout → run installer with defaults → `node scripts/factory-selfcheck.mjs --tokens` → job fails if exit ≠ 0 or any FAIL line appears.
- The existing `core / delivery / attest / phase` jobs are untouched and remain the required checks.

### Docs
- `README.md`: install lines change from `…@master` / branch references to `v1` tag; the AI-agent prompts and `HOW-INSTALL.md` move in step.
- A short "Verifying a release" note (tag-or-branch-wins rule) so future commits to master cannot confuse a stranger.

## What is left to the builder

- Write CHANGELOG.md from git log — evidence, not invention.
- Make the version echo work on Windows PowerShell and bash alike; prove under install.ps1 and install.sh in a sandboxed HOME (the M3 drill logic proves the shape).
- CI job shape and names; required-checks decision explicitly deferred.
- The only remote-affecting steps (new branch push, v1 tag) are gated on explicit user yes at milestone end.

## Open questions for you

- Tag `v1` vs `v1.0.0`: the docs use shorthand `v1`; either is fine. I'll use `v1` unless you say otherwise.
- Whether master merges for this milestone travel by PR (default, one-approval gate intact) or by direct admin push — default: PR, you approve.
