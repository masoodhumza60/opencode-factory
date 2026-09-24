---
description: Stamp the factory state layer onto this repository (beads, graft, skills.lock.json)
---
Run the factory onboarding flow for this repository. This is a factory flow — NOT a shell command, and there is no `factory` executable to invoke.

Read the factory skill docs first (docs/conductor.md, "factory onboard") and follow them literally:

1. **beads** — run `bd init` only if no beads store exists in this repo; if one exists, reuse it (never re-initialize). Report the repo id / DB name.
2. **graft** — run `graft build` if there is no graph OR the graph is empty (0 nodes; an empty `graft/.graph/wiring.json` counts as "no graph"). Report node/edge counts.
3. **skill discovery** — run the discovery step (query candidate sources per docs/discovery.md). If every candidate source fails, that is `DISCOVERY_DEGRADED` — record it loudly. In every case, WRITE/UPDATE `.agents/skills/skills.lock.json` (installed list + a `run` record with `at`, `keywords`, `sources`, `degraded`, `note`) so the outcome is on record, including an empty "nothing needed" verdict.
4. Record the result in beads (`bd update <feature-id> --append-notes "onboard: ..."`, creating an issue if none exists).

Report each step as "existing → outcome", then run the factory selfcheck and show its output.