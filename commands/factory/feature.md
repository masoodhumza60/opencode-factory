---
description: Run a feature through the whole factory pipeline (gates A, B, C are hard stops)
---
Run the factory feature pipeline for: $ARGUMENTS

This is a factory flow — NOT a shell command. Follow the installed factory skill: read docs/how-factory-works.md and docs/conductor.md and obey them literally. If $ARGUMENTS is empty, ask the user what feature to run.

1. Create/target a beads issue for this feature (`bd create`), and use its id throughout.
2. **brainstorm** — ask vision questions one at a time; the first external research action only after the user grants permission; summarize sources, never dump raw research.
3. **spec** → **GATE A — HARD STOP**: write the spec to docs/superpowers/specs/, report the mandatory skills that ran, and WAIT for the user's approval. Nothing further until approved.
4. **plan** → **GATE B — HARD STOP**: produce the plan + task breakdown with writing-plans, get the user to approve the plan AND pick the execution method (executing-plans or subagent-driven-development). No implementation files before gates A and B.
5. **implement** (phase chosen at B) — TDD everywhere; on any bug/test failure route through the debug phase (systematic-debugging) before fixes. At implement/debug entry, check graft freshness and rebuild if the graph is empty or stale.
6. **verify** (verification-before-completion), then **review** (requesting-code-review → receiving-code-review).
7. **ship** → **GATE C — HARD STOP**: finish the branch with finishing-a-development-branch and WAIT for the user's decision (merge / push-PR / keep as-is).
8. **close** — record the final audit and wrap up.

Record every phase transition in beads with the audit format:
`bd update <feature-id> --append-notes "phase:<name> ✓ <skill>"`
and every graft rebuild as `"graft: rebuilt (N nodes)"` / `"graft: fresh"` / `"graft: degraded <reason>"`.