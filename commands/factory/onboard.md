---
description: Stamp the factory state layer onto this repository (beads, graft, skills.lock.json)
---
Run the factory onboarding flow for this repository. This is a factory flow — NOT a shell command, and there is no `factory` executable to invoke.

Read the factory skill docs first (docs/conductor.md, "factory onboard") and follow them literally:

1. **beads** — run `bd init` only if no beads store exists in this repo; if one exists, reuse it (never re-initialize). Report the repo id / DB name.
2. **graft** — run `graft build` if there is no graph OR the graph is empty (0 nodes; an empty `graft/.graph/wiring.json` counts as "no graph"). Report node/edge counts.
3. **hard skills** — run `node <bundle>/scripts/factory-skills.mjs check`. These are NOT discovered: they are declared in `skills/catalog.yaml`, installed by the installer, and the selfcheck FAILs when one is missing. If any is absent, run `node <bundle>/scripts/factory-skills.mjs install` and re-check. Report which of `commit-work` / `skill-judge` are present.
4. **skill discovery** — run the discovery step (query candidate sources per docs/discovery.md). Apply the usage-evidence rule — a declared dependency AND a real import; prose is a hint, never evidence. Judge each candidate with `skill-judge` (floor: grade C / 70 of 120; official origin wins) and record adopt **and reject-with-a-reason** verdicts. If every candidate source fails, that is `DISCOVERY_DEGRADED` — record it loudly with its reason (`CLI_MISSING` / `RESEARCH_DENIED` / `NO_SOURCES` / `NETWORK_FAIL`). In every case, WRITE/UPDATE `.agents/skills/skills.lock.json` (`installed` + `rejected` + a `run` record with `at`, `keywords`, `sources`, `degraded`, `reason`, `note`) so the outcome is on record, including an empty "nothing needed" verdict. That file is the factory's **decision record**; the skills CLI owns its own separate `skills-lock.json` and the two are never merged.
5. Record the result in beads (`bd update <feature-id> --append-notes "onboard: ..."`, creating an issue if none exists).

Report each step as "existing → outcome", then run the factory selfcheck and show its output.