# The plan file format

Every plan has two halves, and neither replaces the other:

- **`docs/superpowers/plans/<date>-<name>.md`** — the human-readable record. You
  read this in a review, and it survives a bad `bd` upgrade.
- **`docs/superpowers/plans/<date>-<name>.plan.json`** — the machine-readable
  graph. This is what beads can enforce: dependencies, acceptance criteria, and
  `bd lint` completeness.

The factory **never parses the markdown**. A markdown parser is where plans
quietly go wrong — headings get reworded mid-review, tables get reformatted, and
a task silently disappears from the graph while still reading fine to a human.
The JSON is written alongside the markdown, and the JSON is what the state layer
sees.

## Commands

```bash
node scripts/factory-plan.mjs validate <plan.json>
node scripts/factory-plan.mjs graph <plan.json> --issue <bead> [--dry-run] [--force]
```

Exit codes: `0` ok · `1` invalid or error · `2` this exact plan is already applied.

`validate` checks the file without touching the database. `graph` validates
**first**, then creates the issues. Run `validate` whenever you like; a plan that
does not validate never reaches beads.

## Shape

```json
{
  "nodes": [
    {
      "key": "gateway",
      "title": "Define the PaymentGateway port",
      "type": "task",
      "description": "One interface the UI codes against.",
      "acceptance_criteria": "A fake adapter satisfies the interface in a test.",
      "priority": 1,
      "estimate": 2,
      "labels": ["payments"]
    },
    {
      "key": "fake-adapter",
      "title": "Build the fake adapter",
      "type": "task",
      "description": "Deterministic, offline, no network.",
      "acceptance_criteria": "submitPayment resolves with a fixed transactionId.",
      "parent": "gateway",
      "deps": [{ "target": "gateway" }],
      "estimate": 3
    }
  ]
}
```

**Required on every node:** `key`, `title`. **`type`** defaults to `task`.
`task` and `bug` nodes must carry `acceptance_criteria` — a task whose
definition of done vanished is how work ships with no criteria at all.

`key` is the node's identity inside the plan. It must match
`[A-Za-z0-9._-]+` — no spaces — because created issue ids are parsed back out of
bd's output. Use a short, stable, meaningful key (`gateway`, not `n1`): the key
is what you will read in a review.

`deps` entries are **objects**, not strings: `{ "target": "other-key" }`. A
`target` naming a key that is not in this file is an error, not a warning.
`parent` also must name a key in the same file; a node with no `parent` is
attached directly to the feature bead.

## Fields bd accepts

`key`, `title`, `description`, `acceptance_criteria`, `type`, `labels`,
`priority`, `estimate`, `metadata`, `status`, `id`, `spec_id`, `external_ref`,
`assignee`, `notes`, `design`, `parent`, `deps[].target`.

`priority` and `estimate` must be **integers**. A quoted number aborts parsing.

## Fields bd silently drops

bd prints a warning and then creates the issue anyway. The factory refuses the
file instead, because a requirement that quietly disappears is worse than a plan
that never compiled:

| You probably wrote | bd actually wants | What happens otherwise |
|---|---|---|
| `acceptance` | `acceptance_criteria` | your criteria are gone |
| `depends_on` | `deps` | no dependency is created |
| `skills` | — | see the limitation below |
| `blocked_by` | `deps` | nothing blocks |
| `milestone` | `label` or a parent epic | not recorded |

`factory-plan.mjs` reports these by name, with the fix inline.

## Applying it

```bash
node scripts/factory-plan.mjs graph my-plan.plan.json --issue <feature-bead> --dry-run
node scripts/factory-plan.mjs graph my-plan.plan.json --issue <feature-bead>
```

`bd create --graph` is **not idempotent** — run it twice and you get two sets of
issues with different ids. So the script fingerprints the plan (a SHA-256 over
canonical, key-sorted, order-insensitive JSON) and stores it on the feature bead
with the file name and the created ids. Re-applying the same plan exits `2` and
tells you so. Formatting changes do not count as changes; a real content change
does. `--force` overrides deliberately.

After creation the script runs `bd lint` over the new issues. `bd lint` wants:

| type | must have |
|---|---|
| `bug` | Steps to Reproduce + Acceptance Criteria |
| `task`, `feature` | Acceptance Criteria |
| `epic` | Success Criteria |
| `chore` | nothing |

Then `bd ready` — not `bd list` — becomes the query that answers "what can I
work on right now", because it is the one that honours dependencies and gates.

## Known limitation in bd 1.3.0

`bd create --graph` has no `skills` field, and **`bd update` has no `--skills`
flag** (only `bd create` does). So a task created from a plan cannot carry its
required skills through beads. Plan-level skill requirements are therefore
recorded in the markdown and enforced by the conductor at phase entry, not by
`bd`. Tracked for the hard-skills work.
