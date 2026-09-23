# opencode-factory

`factory <feature>` runs one feature end-to-end through the opencode-factory
pipeline (brainstorm -> spec -> plan -> tasks -> implement -> debug -> verify ->
review -> ship), stopping only at the human gates (spec, plan, ship).

**Run the factory:** load the `factory` skill and invoke it. The skill lives at
`skills/factory/SKILL.md` in this repo and is installed to
`~/.agents/skills/factory/` by the installers.

**Understand the factory first** (read in order, on demand):
1. `docs/how-factory-works.md` - architecture and principles (5 min).
2. `docs/conductor.md` - the exact phase pipeline, gates, and audit protocol
   (the authoritative how-to).
