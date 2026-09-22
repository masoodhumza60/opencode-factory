# opencode-factory — Design (2026-09-22)

## 1. Vision

A single, portable "software factory" for OpenCode: one bundle that turns any
feature request into a complete end-to-end pipeline —

**brainstorm → spec → plan → tasks → implement → debug → verify → review → ship**

The system is **autopilot with human gates**: it carries a feature through every
phase on its own, stops only for human approval at three gates (spec, plan,
ship), and enforces that the right phase skill runs at the right time. It is
**repeatable and portable**: the entire setup ships as one GitHub repo. Setting
up a new machine is "set up my factory from `<repo>`" — an agent (or a human
running `install.ps1`) rebuilds the whole environment.

The design constraint that shaped everything else: **fewer random pieces, not
more glue**. The bundle consolidates the scattered artifacts accumulated in the
existing environment (three plugins, a graft MCP server, 29 command files, an
agent file, skills, hooks, disabled MCP entries, store-patch scripts) into one
managed, idempotently-installable package.

## 2. Goals

- One entry point: `factory <feature>` starts a feature and runs the pipeline.
- Human gates at **spec (A)**, **plan (B)**, **ship (C)** — everything else autopilot.
- Mandatory, enforced skill usage per phase (superpowers set) with audit trails.
- Durable, restart-proof phase state via beads (Dolt-backed), injected into every
  agent-loop model call.
- Brainstorming = human vision questions **plus** the system's own research
  (web, docs, ecosystem, prior art) feeding sharper questions and informed
  design options — research tools are used only after the user says yes.
- Code-graph context (graft) powering plan / implement / debug.
- On-demand project skill discovery (skills.sh) that is deduped, lockfile-pinned,
  and context-cheap.
- Idempotent, OS-aware install to a new machine with a self-test.
- The bundle reduces what the user must manually maintain.

## 3. Non-goals

- A new task tracker, coding agent, or MCP server product (we reuse beads, graft,
  superpowers, OpenCode).
- Automatic merging/deploying without a human gate. Ship always stops for C.
- Replacing the user's existing global opencode config wholesale — the installer
  *merges*, with the bundle winning only where it explicitly owns a value
  (DCP pin, enabled MCP servers).
- Multi-user team workflows (single-operator assumption for v1).

## 4. Architecture

Four layers, each with one clear job:

| Layer | Component | Job |
|---|---|---|
| **Conductor** | `factory` skill (new — the only new code) | Phase machine + gates + skill enforcement |
| **Phase engines** | superpowers skills (reused) | Phase procedures (brainstorm, plan, TDD, debug, verify, review, ship) |
| **State** | beads (`bd` CLI + Dolt DB) | One issue per feature; phase stored on the issue; audit log; durable across sessions/devices |
| **Context** | graft (MCP, code graph) | Fast navigation during plan/implement/debug |

Role boundaries:

- The conductor is **thin**: a small `SKILL.md` (description only) plus bundled
  docs it reads while running. It does not reimplement any phase procedure.
- beads is the **source of truth for phase state**, not a to-do list — one issue
  per feature, `phase:<name>` stored on the issue, `bd prime` output pushed into
  every model call by the existing opencode-beads plugin.
- graft never reads markdown/skills; its job is code structure (stack detection,
  navigation) only.

## 5. The pipeline

### 5.1 Phases and mandatory skills

| # | Phase | MUST invoke skill | Gate |
|---|---|---|---|
| 0 | onboard (per repo, auto-offered) | — | — |
| 1 | brainstorm | `brainstorming` | — |
| 2 | spec | `brainstorming` (spec section) | **A — human** |
| 3 | plan | `writing-plans` | **B — human** |
| 4 | implement | `executing-plans` *or* `subagent-driven-development` (method chosen at B) + `test-driven-development` per feature/bug | — |
| 4' | debug (as needed) | `systematic-debugging` | — |
| 5 | verify | `verification-before-completion` | — |
| 6 | review | `requesting-code-review` → `receiving-code-review` | — |
| 7 | ship | `finishing-a-development-branch` | **C — human** |
| 8 | close | session-close protocol | — |

Implementation detail: 4' is not a separate command — the conductor routes any
bug/test failure into the debug phase with `systematic-debugging` before fixes
are allowed (no ad-hoc fixes).

### 5.2 Enforcement mechanics

- Each phase begins with a literal instruction: *"Invoke skill X now and follow
  it."* A phase cannot be marked complete until skill X's content was loaded
  in-session (the model verifies it has the skill content, not just the name).
- The conductor records each transition in beads:
  `bd update <feature-id> --note "phase:plan ✓ writing-plans"` — the audit
  survives restarts and device moves (Dolt).
- At each human gate the conductor reports which mandatory skills ran per phase.
  Any skipped skill forces the phase to re-run before the gate can pass.

### 5.3 Journey

```
factory <feature-name>            # create beads issue, start phase 1
  → 1 brainstorm                   # brainstorming skill: vision questions + own research
  → 2 spec                         # spec doc → docs/superpowers/specs/
  → GATE A                         # human approves spec  ── STOP, wait
  → 3 plan                         # writing-plans → plan doc, task breakdown
  → GATE B                         # human approves plan + execution method ── STOP, wait
  → 4 implement                    # TDD; beads-task-agent subagents; graft navigation
  → 4' debug (routed on failure)   # systematic-debugging
  → 5 verify                       # verification-before-completion (evidence gate)
  → 6 review                       # requesting/receiving code review
  → 7 ship                         # finishing-a-development-branch
  → GATE C                         # human approves ship  ── STOP, wait
  → 8 close                        # bd update, session-close protocol
```

### 5.4 Brainstorm in detail: vision questions + self-research

Phase 1 runs two tracks that feed each other:

- **Intent/vision elicitation** — the `brainstorming` skill's question flow: one
  focused question at a time draws out the feature's purpose, who it serves, and
  what success looks like. The answers become the design brief.
- **Autonomous research** — the system researches on its own, before and during
  the questions: web/technology search and fetch (official docs, ecosystem and
  similar projects, alternatives, prior art, current version landscape), plus
  in-repo exploration. The goal is that questions are sharper and design options
  are *informed*, not guessed.
- **Permission gate** — research tools are never used silently. Before the first
  external research action (web search/fetch) the conductor asks the human for
  permission ("may I research this?"). A yes covers the feature's brainstorm; a
  no keeps research to in-repo context only and the phase still runs.

Interaction model (iterative, but outward-facing one question at a time):

1. Light research first → sharper opening questions.
2. Answers shape deeper research (follow-ups, docs, comparisons).
3. Research produces informed options, presented alongside the remaining
   questions and carried into the spec phase with sources.

Token discipline: research is summarized, never dumped raw; sources are noted and
kept with the design brief for the spec phase. The human-facing cadence is still
exactly one question per message — the research works underneath it.

Commands implemented by the conductor (thin wrappers over existing tools):

- `factory <feature>` — new feature: creates the beads issue, records
  `phase:brainstorm`, invokes `brainstorming`.
- `factory phase <name>` — advance phase, enforce the skill gate, record
  transition in beads.
- `factory discover` — run the skill-discovery flow (below); idempotent.
- `factory onboard` — per-repo one-time check: `bd init` if no beads DB,
  `graft build` if no graph, then `factory discover`. Auto-offered when the
  conductor starts in a repo without state.
- `factory selfcheck` — environment health (section 10). `--tokens` adds a
  per-skill description-size + total loaded-footprint report.

Conductor state machine rules:

- Phase transitions are monotonic forward (with `debug` as an in-implement loop).
- Each transition verifies the prerequisite gate (A before 3, B before 4, C
  before 8).
- The conductor reads phase state from beads (`bd show <id>`) at every entry,
  so a restarted session or a different device resumes where it left off.

## 7. Skill discovery (`factory discover`)

Pull-only, on demand, deduped, and locked.

1. **Detect context** — the need for a project skill arises from (a) the repo
   stack (via graft `find_all` on `package.json`/`go.mod`/imports → stack
   keywords) or (b) feature-request keywords at `factory <feature>` time.
2. **Find candidates** — query skills.sh for matching skills. The exact
   skills.sh CLI/API mechanism is pinned during planning (fallback: the
   `find-skills` skill or web search, same ranking applies).
3. **Rank** — 1. best keyword fit for the *actual* work, 2. official/verified
   origin, 3. most-used/most-liked.
4. **Install project-locally** — `.agents/skills/<name>/`. Project-installed
   skills are **committed to the repository** (they travel with the project;
   unlike bd init's gitignored `.agents/` output).
5. **Record the choice** — `bd update <id> --note "skills: <name>@<version> <source>"`.
6. **Dedupe** — skip if already in global `~/.agents/skills/` or project
   `.agents/skills/`; skip if below the relevance threshold or not expected to
   be invoked; `skills.lock.json` is the dedupe authority and enables
   deterministic reinstalls. `factory discover` is idempotent.

Install modes:

- **Full** — high-fit skill copied into the project; OpenCode lazily loads it
  only when invoked (its SKILL.md is never in the context until then).
- **Reference stub** — ~5-line `SKILL.md` ("for `<topic>` load the full skill at
  `<source>`"); content is fetched only when the topic actually comes up.

Lockfile schema (`skills.lock.json`, project root):

```json
{
  "installed": [
    {
      "name": "nuxt",
      "version": "1.0.0",
      "source": "skills.sh/nuxt",
      "sha256": "<hash>",
      "why": "project stack: Nuxt app (package.json)"
    }
  ]
}
```

The "skill graph" question is answered with **data, not an engine**: a flat
`skills/catalog.yaml` in the bundle maps topic → ranked candidates. graft parses
code (not markdown); beads tracks tasks. Neither is used to store skill
relationships.

## 8. Context economy

Everything is **pull, never push**:

- `catalog.yaml` and `skills.lock.json` are never in the conversation context;
  opened only while `factory discover` runs.
- A repo already in the lockfile skips discovery; lookups happen only when new
  stack/feature triggers an unknown technology.
- Skill bodies enter context only on invocation. The conductor `SKILL.md` stays
  thin (description only); the conductor's detailed logic lives in bundled docs
  read on demand.
- `factory selfcheck --tokens` reports the loaded footprint so it stays
  visible and cheap.

## 9. Bundle contents and portability

### 9.1 Repository layout (`opencode-factory`)

```
SKILL.md                        # entry point — an agent reads this first on a new device
install.ps1                     # Windows bootstrap (human or agent)
install.sh                      # Unix bootstrap
docs/HOW-INSTALL.md             # manual path + troubleshooting
skills/
  factory/SKILL.md              # the conductor (thin)
  catalog.yaml                  # topic → ranked skill candidates
plugins/
  opencode-beads.ts             # bd-prime context injection (ported, V2)
  opencode-pty.ts               # V2 shim for opencode-pty
  dcp.pin                       # "@tarquinen/opencode-dcp@3.2.0" pin note (config reference)
config/
  opencode.snippet.json         # merged config fragment (DCP pin + graft MCP only)
executables/
  install-bd.ps1 / install-bd.sh# beads CLI install (install.ps1 calls these)
commands/beads/*.md             # 29 /beads/* command templates
agents/beads-task-agent.md      # task subagent definition
scripts/
  graft-patch-store.ps1 / .sh   # re-apply graft native-binding patches
  graft-patch-extract.mjs       # kotlin-optional patch for dist/graph/extract.js
  factory-selfcheck.mjs         # health checks (or pure .ps1/.sh + bd/graft checks)
```

### 9.2 What the bundle owns (consolidation)

| Existing piece | Bundle home |
|---|---|
| `opencode-beads.ts` plugin (context injection) | `plugins/` |
| `opencode-pty.ts` shim | `plugins/` |
| DCP pin `@tarquinen/opencode-dcp@3.2.0` | `config/opencode.snippet.json` |
| 29 `/beads/*` commands | `commands/beads/` |
| `beads-task-agent` | `agents/` |
| graft MCP server config (enabled) | `config/opencode.snippet.json` |
| graft store patches (node.napi.node rename + kotlin-optional) | `scripts/` |
| beads CLI installation | `executables/` |

The bundle deliberately includes **enabled** config only — the disabled
`chrome-devtools` / `nuxt` / `nuxt-ui` MCP entries from the source environment
are not carried over.

### 9.3 Install (`install.ps1` / `install.sh`)

Idempotent, OS-aware, run twice with no drift:

1. **Shells/CLIs**: install beads (`bd`) and graft; verify `bd version` and
   `graft --version`.
2. **graft native patches** (Windows): re-apply (a) rename every
   `prebuilds/win32-x64/*.node` → `node.napi.node` in the pnpm global store,
   (b) apply the kotlin-optional edit to `dist/graph/extract.js`. Both are reset
   by any graft reinstall/upgrade, which is exactly why they are part of install.
3. **Copy artifacts**: plugins → `~/.config/opencode/plugins/`, commands →
   `~/.config/opencode/commands/beads/`, agent → `~/.config/opencode/agents/`,
   factory skill + catalog → `~/.agents/skills/factory/` (+ project skill dirs
   where appropriate).
4. **Merge config** with machine-resolved paths: graft's `cli.js` is located by
   scanning the pnpm global store (hash varies per install) and beads by
   `LOCALAPPDATA/Programs/bd/bd.exe` (or `bd` on PATH); the resulting
   `mcp.servers.graft` entry uses an absolute `node.exe`/`cli.js` command array
   (no `.cmd` shims — spawned without a shell on Windows). The installer never
   writes `service.json` or any credential-bearing file — those stay
   machine-local.
5. **Verify**: run `factory selfcheck`.

New-device UX: the user says "set up my factory from `<repo>`". The agent reads
the repo `SKILL.md`, runs the bootstrap for the current OS, and finishes with
`factory selfcheck`. A human can also run `install.ps1` by hand.

## 10. Verification and self-tests

`factory selfcheck` asserts, with real evidence:

- Plugins load — log contains `loading plugin` for all three and zero
  `failed to load plugin` (same opencode run id).
- MCP connects — graft server handshake returns the 6 tools.
- CLIs resolve — `bd version` and `graft --version` succeed.
- Skill gate integrity — every mandatory phase skill is discoverable.
- `--tokens` — footprint report (used to keep the bundle context-cheap).

Pipeline-level tests:

- **Install idempotency** — run install twice on a clean checkout; the second
  run reports "no drift".
- **Dogfood** — run one trivial feature end-to-end through the full pipeline on
  the opencode-factory repo itself (covers discover → gates → implement →
  verify → ship/close).

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| skills.sh API changes or is unavailable | Catalog + lockfile are the source of truth; fallback `find-skills`/web-search mechanism applies the same ranking; no hard dependency |
| No git identity on a new machine | Bootstrap/config includes a step to set a machine-local git identity (documented in HOW-INSTALL) |
| graft store patches reset on reinstall/upgrade | They are part of install; re-run install or `scripts/graft-patch-*` |
| Pipeline discipline drifts (skills skipped) | Beads audit + gate reporting; a gate cannot pass with a skipped skill |
| Context bloat | Pull-only loading, thin SKILL.md, selfcheck --tokens visibility |
| Phase state lost across devices/sessions | beads on Dolt (`bd prime` injected each call); conductor resumes from `bd show` |
| `bd`/`graft`/plugins not working after OS updates | selfcheck catches; install re-runs idempotently |

## 12. To pin during planning (not open questions)

- Exact skills.sh query mechanism (CLI vs API vs page schema); fallback already
  defined.
- Conductor doc format and file set (where its phase logic lives, so the
  SKILL.md stays thin).
- Exact `skills.lock.json` + `catalog.yaml` schemas (draft above).
- Bootstrap ordering for `config` merge *before* plugin load on first run.
- Windows store-patch script correctness against junctioned pnpm store dirs
  (verified fact from the current machine's install history).

## 13. Success criteria

1. On a fresh machine: `bd`, `graft`, 3 plugins, 29 commands, task agent, MCP,
   and the factory skill are installed by one command and pass `selfcheck`.
2. `factory <feature>` runs the full pipeline with gates A/B/C and enforces all
   mandatory skills, as recorded in beads.
3. A restarted session or second device resumes the same feature at the same
   phase.
4. Project skills install deduped, locked, and context-cheap; nothing unused is
   loaded.
5. A dogfooded trivial feature lands with a verified, reviewed, closed flow.
6. The brainstorm phase pairs the human's vision with the system's own research
   (run only with the user's permission), and the spec cites the sources that
   informed it.