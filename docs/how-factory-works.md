# how-factory-works.md — architecture and principles

Read this first (about 5 minutes) when a feature starts, then
`docs/conductor.md` for the exact procedure. This document explains the shape
of the factory; the conductor doc is the authoritative how-to.

Two design documents sit alongside the shipped pipeline. `docs/factory-gap-analysis.md`
is a **proposal, not current behaviour**: what the factory has, what it is
missing, and the priority order. `docs/factory-v2-model.md` is now partly
shipped — its evidence manifest, risk tiers and policy-as-data are real as of
M1a (see "Mechanical attestation" below) — while its roles, four gates and
review/independence machinery remain proposals until M1b. Read both when
changing the factory itself, and treat only the parts that name a shipped
command as installed.

## The factory in one sentence

`factory <feature>` drives one feature through a fixed pipeline — brainstorm →
spec → plan → implement → debug → verify → review → ship — on autopilot, stops
only at three human gates (spec, plan, ship), and enforces that the right
superpowers skill runs at the right phase.

## Three layers, one job each

| Layer | Component | Job |
|---|---|---|
| Conductor | `factory` skill (thin) | Phase machine + gates + skill enforcement |
| Phase engines | superpowers skills (reused) | The actual phase procedures |
| State | beads (`bd` CLI + Dolt DB) | One issue per feature, `phase:` stored on it, audit log |

The design rule that shaped everything: **fewer random pieces, not more glue**.
The conductor is the *only* new component. Everything else is reused: the
superpowers skills run the phases and beads owns state. The bundle consolidates
the user's scattered existing pieces (plugins, beads commands, task agent,
install scripts) into one managed, idempotently-installable package.

There is deliberately **no context layer**. The factory once shipped a code-graph
MCP server for it and removed it after measuring it: across 40,467 recorded tool
calls it was used once, in a project the factory never touched. Navigation in
this bundle is `glob`, `grep` and `read` — tools that are already present, cost
nothing to install, and never need a graph built before they answer. See
`docs/conductor.md` — "Code navigation (no MCP required)" for the measurement.

### Role boundaries

- The conductor is **thin** — a `SKILL.md` with description only, plus bundled
  docs it reads while running. It never reimplements a phase procedure.
- beads is the **source of truth for phase state**, not a to-do list. One issue
  per feature; `bd prime` pushes phase state into every model call; the audit
  survives restarts and device moves because beads is Dolt-backed.
- The filesystem is the context layer, and it is not optional machinery. Reading
  a file answers "what is here" with no index to build, no server to connect,
  and no staleness to re-check.

## Pull, never push (spec §8)

The factory is strict about context economy:

- `catalog.yaml` and `skills.lock.json` are never in the conversation context;
  they are opened only while `factory discover` runs.
- Skill bodies enter context **only on invocation**. The factory `SKILL.md`
  stays thin exactly so that its logic does not sit in the context window; the
  conductor's detail lives in docs read on demand.
- `factory selfcheck --tokens` reports the loaded footprint so it stays
  visible and cheap — that flag is the tool that keeps the pull-only promise
  honest.

## The pipeline at a glance

Phases 1–8 with their mandatory skills, gates A/B/C, the journey, the
per-phase enforcement protocol, and the resume logic are all in
`docs/conductor.md`. In short: the machine advances forward-only, routing any
bug or test failure into the debug loop (`systematic-debugging`) before fixes
are allowed, reads `bd show <id>` at every phase entry, and refuses to mark a
phase complete until that phase's skill content was actually loaded in-session.

## Non-goals (spec §3)

The factory deliberately does not try to become:

- **A new task tracker, coding agent, or MCP server product** — beads,
  superpowers, and OpenCode are reused, not replaced.
- **Automatic merging/deploying without a human** — ship always stops for
  gate C; no lights-out shipping.
- **A wholesale takeover of the user's global OpenCode config** — the installer
  *merges*, with the bundle winning only where it explicitly owns a value
  (DCP pin, enabled MCP servers).
- **A multi-user team product** — v1 assumes a single operator.

## Mechanical attestation

A phase used to complete on a sentence. M1a makes it complete on a file whose
bytes are hashed: the factory records what was produced, verifies it
mechanically, and refuses completion when a required artifact is missing,
edited, or stale. Everything lives beside the bead's `.beads` directory under
`.factory/<bead>/`.

**The manifest — `.factory/<bead>/manifest.json`.** One entry per attested
artifact, with these fields:

- `id` — the policy check id this artifact satisfies (`tests`, `review`, …).
- `kind` — one of the sixteen artifact kinds (`screenshot`, `transcript`,
  `contract`, `api-diff`, `plan`, `eval`, `hil-log`, `prr`, `exit-code-matrix`,
  `golden-file`, `help-snapshot`, `tty-transcript`, `completion-script`,
  `install-log`, `device-capture`, `check-output`).
- `path` — the file, root-relative, with `/` separators.
- `sha256` — the hash of the bytes at attestation time.
- `bytes` — the file size.
- `command` — the command whose run produced it, or `null` when none is named.
- `producer_session` — the session that recorded it.
- `produced_at` — the ISO timestamp.
- `commit` — the git commit `HEAD` pointed at when it was recorded.

Re-attesting the same `id` replaces the entry in place rather than stacking a
second one.

**The trail — `.factory/<bead>/trail.jsonl`.** Append-only, one JSON event per
line, never rewritten: `attest` (an artifact was recorded), `verify` (a
decision was reached), `refusal` (completion was refused with a policy in
force), and `complete` (a phase advanced). The manifest is the current state;
the trail is the history. A `refusal` is written immediately before the throw,
so a log never records a refusal as a completion.

**The CLI.** The commands are scripts, not the `factory` wrapper:

```
node scripts/factory-attest.mjs attest <bead> <path> --id <check> --kind <kind> \
  [--command "<cmd>"] [--policy <path>]
node scripts/factory-attest.mjs verify <bead> [--phase <n>] [--policy <path>] [--json]
node scripts/factory-attest.mjs protect [--write]

node scripts/factory-review.mjs start    <bead> [--phase <n>] [--base <rev>]
node scripts/factory-review.mjs record   <bead> --file <path> --verdict pass|changes
node scripts/factory-review.mjs show     <bead> [--json]
node scripts/factory-review.mjs accept   <bead> [--note "<what you read>"]
node scripts/factory-review.mjs withdraw <bead> --note "<why>"
```

Two environment variables carry identity. `FACTORY_SESSION` names the session;
`FACTORY_ROLE` is `builder` (the default), `reviewer` or `human`. An unknown
role is a refusal, not a fallback. The builder session is frozen at the first
manifest write: a later run with a different `FACTORY_SESSION` still counts as
the same builder, because the artifacts already exist.

`review start` writes `.factory/<bead>/review-package.md` — the commit range,
the diff (excluding `.superpowers/`), the attested artifacts, and the policy's
checks — plus a `git status` snapshot. A reviewer reads that, writes
`.factory/<bead>/review*.md` with one `Verdict: pass` or `Verdict: changes`
line, and `review record` binds it to the manifest. `record` refuses the
builder's own session, any file outside `.factory/<bead>/`, any product file
changed after `start`, and a package that has gone stale. `accept` is the human
act: it copies nothing, it records that a named human accepted a specific
verdict at a specific commit. `withdraw` deletes that record and says why.

`attest` records one artifact; with no `--command` it takes the command from
the policy check, and with no `--policy` it reads `config/factory.policy.yaml`.
Without a policy any non-empty `--id` is accepted; with one, the `id` must be a
check that policy declares.

**The four tiers.** A policy declares `tier`, `profile`, `tiers`, `profiles`
and `checks`. The tiers are cumulative floors: `prototype` (3 checks),
`internal` (6), `public` (13), `regulated` (20). The effective set for a bead
is a union, not the tier alone:

```
effective = tiers[tier].checks ∪ profiles[profile].checks
```

A bead may override both in its own metadata (`tier`, `profile`); the bead's
values win over the file's. Duplicates collapse, and a check id that is not
declared under `checks:` is a policy error refused before anything runs.
`config/factory.policy.example.yaml` is the full four-tier example; it must be
copied to `config/factory.policy.yaml` to take effect.

**No policy file means M0 behaviour.** This is the rule that matters most: when
`config/factory.policy.yaml` is absent, `complete` uses the existing M0
evidence predicate and nothing else changes. An unconfigured repo behaves
exactly as it did before attestation existed. Verification runs **only** on the
branch where a policy was loaded.

**What `complete` does when a policy exists.** Before advancing a phase, it
resolves the checks that policy declares for that phase and verifies each one
against the manifest and disk. One failing rung is enough to refuse: the file
is gone (`MISSING`/`ABSENT`), is not a regular file (`NOT-A-FILE`), its `sha256`
changed on disk (`HASH`), it was recorded at an older commit than `HEAD`
(`STALE`), it has no producer session (`PRODUCER`), or it was recorded by the
same session that is verifying it (`INDEPENDENCE`). Every check must be `ok` or
`not-applicable` (a check with no verdict independence to test, because
`FACTORY_SESSION` is unset). On refusal it prints each failing artifact and the
exact command that would fix it, e.g.:

```
node scripts/factory-attest.mjs attest <bead> <path> --id <check> --kind <kind> --command "<cmd>"
```

and leaves `phase` and `phase_done` untouched — the bead stays where it was.
One exception: a phase-5 run writes its `booted` record before the manifest
check can refuse, so a refused phase-5 run keeps the `booted` record it wrote
first.

**Two phases need more than artifacts.** When a policy is in force:

- **Phase 7 (ship)** needs a human acceptance. `factory-review.mjs accept` writes
  `.factory/<bead>/acceptance.json` only when the caller declares
  `FACTORY_ROLE=human`, the recorded review verdict is `pass`, the reviewer
  session differs from the frozen builder session, the verdict file still hashes
  to what the manifest recorded, and the accepted commit is still `HEAD`.
  `complete 7` re-checks all of that, so editing the code after an acceptance
  revokes it.
- **Phase 8 (close)** needs `.factory/<bead>/outcome.md` with `## What changed`
  and either `## Measured before / after` or a `Not measurable: <reason>` line.
  Existence is the gate; whether the numbers are honest is a human judgement
  made later.

`complete 7` also verifies the pinned grading machinery. Every script listed in
`config/factory.protected.json` must still hash to its recorded value, and that
file must match the committed blob at `HEAD`. `factory-attest.mjs protect
--write` refreshes the set, but only for a caller declaring `FACTORY_ROLE=human`,
and the refreshed set must be committed before ship can pass.

### What this does not prove

A hash is evidence that the bytes did not change **after** attestation, and
nothing more:

- It does **not** prove the `command` recorded in the manifest produced the
  artifact. The `command` is a label the producer wrote down; M1a never runs it
  or checks its output against the file.
- `producer_session` is **self-declared**, and so is `FACTORY_ROLE`. M1b froze
  the builder session at the first manifest write, so re-running with a new
  `FACTORY_SESSION` no longer looks like a different agent, and `review record`
  refuses a verdict from the builder's own session. An agent that can set the
  environment can still claim to be a reviewer or a human.
- `FACTORY_SESSION` is **not a secret**. It is an environment variable the
  builder sets, so anyone willing to set it can claim any session identity.
- `acceptance.json` is a **file, not a signature**. It records that a session
  declaring itself human accepted a specific verdict at a specific commit. The
  trail and the git history are the witnesses; they are not proof.
- The reviewer's write scope is checked **after the fact**: `record` compares
  `git status` (with a sha256 per dirty path) against the snapshot `start`
  took, and refuses changes outside the verdict file. It does not sandbox the
  reviewer, and paths git ignores are invisible to it.
- The protected set **detects, it does not prevent**. An edited grading script
  is refused at ship, and re-baselining requires `FACTORY_ROLE=human` plus a
  commit — but the role is declared, not proven, so the check is a tripwire
  that leaves a trail rather than a lock.
- A hand-edited manifest that rewrites both `sha256` and `commit` to match an
  edited file **will verify**. The manifest is validated for shape, not
  authenticated; M1a assumes a single operator who is not attacking themselves.

## Troubleshooting

- **`bd` is missing / `bd version` fails.** `factory onboard` re-runs
  `bd init` when there is no beads DB. If the CLI itself is absent, the
  bootstrap scripts (`install.ps1` / `install.sh`) install beads; re-run them
  — they are idempotent. `factory selfcheck` verifies CLIs resolve.
- **An MCP server of yours is not connecting.** The factory requires none and
  touches no `mcp.servers` entry, so this is almost never the bundle's doing.
  Diagnose it with `node scripts/factory-mcp.mjs handshake --name <server>`,
  which spawns the configured command and speaks the real MCP protocol, and
  with `node scripts/factory-mcp.mjs audit --json` for what the config claims.
  Re-run the installer rather than hand-editing MCP config — it merges with
  machine-resolved paths and never touches credential-bearing files.
- **Skill gate stalls (a phase won't complete).** The gate is the point:
  a phase is incomplete until its mandatory skill's content was loaded
  in-session. Re-invoke the skill and actually load its content; re-run the
  phase entry ("Invoke skill X now and follow it") before recording it. At any
  gate, a skipped skill forces the phase to re-run — the audit
  (`bd update <feature-id> --append-notes "phase:<name> ✓ <skill>"`) shows what ran.
- **Resume after a restart or a different device.** Beads is the durable
  source of truth. At every entry the conductor reads `bd show <id>`; a fresh
  session starts with `factory <feature>` (existing issue) or
  `factory phase <name>` to continue from where the audit log left off. State
  is not kept in the model or the session, so nothing is lost.
- **Context bloat creeping in.** Run `factory selfcheck --tokens` and look at
  the loaded-footprint report; trim whatever is in the context that does not
  need to be there. `catalog.yaml` and `skills.lock.json` should never appear
  in conversation — they are opened only during `factory discover`.
- **A session is getting expensive.** This is a shape problem, not a footprint
  problem, and the two have different fixes. Cost is driven by turn count: every
  turn re-sends the turns before it, so a long session gets quadratically
  worse even when each turn is small. A real run spent 78.3M tokens across 955
  turns with its context climbing to 191k and never dropping. The conductor
  therefore **hands off to a fresh
  session rather than pushing on — see "Cost discipline" in `docs/conductor.md`,
  which also covers picking work with `bd ready` (not `bd list`) and keeping a
  subagent's report rather than its raw output. Automatic context pruning on the
  machine helps with tool noise, but it is a nudge, not a budget: it cannot stop
  a session from re-sending its own history.

