---
description: Run a feature through the whole factory pipeline (gates A, B, C are hard stops)
---
Run the factory feature pipeline for: $ARGUMENTS

This is a factory flow — NOT a shell command. Follow the installed factory skill: read docs/how-factory-works.md and docs/conductor.md and obey them literally. If $ARGUMENTS is empty, ask the user what feature to run.

1. Create/target a beads issue for this feature (`bd create`), and use its id throughout.
2. **brainstorm** — ask vision questions one at a time; the first external research action only after the user grants permission; summarize sources, never dump raw research. Then run the **technology-discovery sub-step** (docs/discovery.md): report the stack the repo is actually on (a declared dependency AND a real import — prose is never evidence), and an adopt-or-reject-with-reason verdict for every candidate, each judged with `skill-judge` (floor: grade C / 70 of 120, official origin wins). **Hard stop: the spec phase does not begin until this has run and been reported.** A degraded run is not a reason to skip it — report `DISCOVERY_DEGRADED <reason>` and let the user decide. Audit the MCP servers in the same sub-step (`node <bundle>/scripts/factory-mcp.mjs audit`): an enabled server costs context on *every* model call and its tools can write to the repo or to production, so report what is configured, handshake the one this feature needs, and judge any new candidate per docs/mcp-judging.md. Never install one — that edits the user's global config, so the agent proposes and records and the user decides.
3. **spec** → **GATE A — HARD STOP**: write the spec to docs/superpowers/specs/, report the mandatory skills that ran, and WAIT for the user's approval. Nothing further until approved. Gate A re-opens if the stack changes — a library the user approved turns out to be unmaintained, or the plan surfaces a dependency the spec never mentioned. Re-open, re-discover, re-approve rather than building around it.
4. **plan** → **GATE B — HARD STOP**: produce the plan + task breakdown with writing-plans, get the user to approve the plan AND pick the execution method (executing-plans or subagent-driven-development). No implementation files before gates A and B.
5. **implement** (phase chosen at B) — TDD everywhere; on any bug/test failure route through the debug phase (systematic-debugging) before fixes. At implement/debug entry, check graft freshness and rebuild if the graph is empty or stale.
6. **verify** (verification-before-completion), then **review** (requesting-code-review → receiving-code-review).
7. **ship** → **GATE C — HARD STOP**: finish the branch with finishing-a-development-branch, make the commits with `commit-work` (it is a hard skill — it must be on disk; verify with `node <bundle>/scripts/factory-skills.mjs check`), and WAIT for the user's decision (merge / push-PR / keep as-is).
8. **close** — record the final audit and wrap up.

Record every phase transition in beads with the audit format:
`bd update <feature-id> --append-notes "phase:<name> ✓ <skill>"`
and every graft rebuild as `"graft: rebuilt (N nodes)"` / `"graft: fresh"` / `"graft: degraded <reason>"`.
Record every discovery verdict too: `"skills: <name>@<version> <source> grade <B>"` on adopt, `"skills: rejected <name> <reason>"` on reject, `"skills: DISCOVERY_DEGRADED <reason>"` when a source failed. A candidate with no recorded verdict was never actually decided. MCP verdicts follow the same rule: `"mcp: <server> ok <version> <n> tools"` after a real handshake, `"mcp: rejected <server> <reason>"` on reject, `"mcp: AUDIT_DEGRADED <reason>"` when the audit could not complete.

## Session discipline (not a phase — these rules run underneath the pipeline)

- **~100 turns is a soft budget for this session, never for the work.** When you reach it — or at any phase boundary, or the moment you are stuck — hand off rather than continue: record state with `bd set-state <feature-id> <dimension>=<value> --reason "…"`, leave the next action in beads (`bd update <feature-id> --append-notes "next: <action>"`), tell the user in one line what is done / next / blocked, then stop. A fresh session resumes at roughly 20k of context instead of 190k, and the work continues.
- **Keep a subagent's report, not its output.** Subagent and skill output is never pruned and is re-sent on every turn of this session. Take the report it returns; do not go back and re-read its raw output to double-check.
- **Pick work with `bd ready`, not `bd list`.** `bd list` does not render the blocked state, so it will happily offer a feature whose gate is still waiting on the user.
- These rules exist because a real run spent 78.3M tokens in one session — 955 turns whose context climbed to 191k and never dropped. The work was fine; the session shape was not.