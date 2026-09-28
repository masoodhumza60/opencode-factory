---
description: Run the factory health check for this machine and repository (add --tokens for the context footprint)
---
Run the factory selfcheck for this machine and repository — an environment health check, not a shell command.

Locate the bundle's selfcheck script by trying, in order:
1. the folder that the environment variable `OPENCODE_FACTORY_BUNDLE` points to, if it contains `scripts/factory-selfcheck.mjs`;
2. the current working directory or any parent directory that contains `scripts/factory-selfcheck.mjs` (the session may be inside the bundle clone);
3. otherwise, ask the user for the bundle location.

Run:

    node <bundle-path>/scripts/factory-selfcheck.mjs

If argument $1 is `--tokens`, append `--tokens` to the command and also explain the loaded-footprint result.

Then interpret the output:
- the six PASS checks (plugins: all 3 loading, zero load failures; bd present; graft present; factory skill deployed; beads store present)
- `WARN graft graph has 0 nodes` → the graph needs a build (onboard, or the implement/debug phases, will rebuild)
- `WARN skills.lock.json missing` → run `/factory onboard` (or `factory discover`) to record the outcome
- the `--tokens` footprint line if requested

If the script cannot be located, perform the checks manually according to the factory skill docs and report the results honestly, marking them as manual.