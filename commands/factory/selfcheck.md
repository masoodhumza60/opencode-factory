---
description: Run the factory health check for this machine and repository (add --tokens for the context footprint)
---
Run the factory selfcheck for this machine and repository — an environment health check, not a shell command.

Locate the bundle's selfcheck script: try `C:\Users\Humza\Desktop\projects\opencode-factory\scripts\factory-selfcheck.mjs`; if it is not there, ask the user for the bundle path. Run:

    node <bundle-path>\scripts\factory-selfcheck.mjs

If argument $1 is `--tokens`, append `--tokens` to the command and also explain the loaded-footprint result.

Then interpret the output:
- the six PASS checks (plugins: all 3 loading, zero load failures; bd present; graft present; factory skill deployed; beads store present)
- `WARN graft graph has 0 nodes` → the graph needs a build (onboard, or the implement/debug phases, will rebuild)
- `WARN skills.lock.json missing` → run `/factory onboard` (or `factory discover`) to record the outcome
- the `--tokens` footprint line if requested

If the script cannot be located, perform the checks manually according to the factory skill docs and report the results honestly, marking them as manual.