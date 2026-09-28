# Judging an MCP server

An MCP server is a different kind of dependency from a skill, and judging it
with a skill's rubric produces a wrong answer. This is the rubric the factory
uses when a feature would be better served by an MCP than by a skill, plus the
two commands that produce the evidence.

## Why an MCP is not a skill

| | Skill | MCP server |
|---|---|---|
| When its content reaches the model | Only when triggered | **On every model call, while enabled** |
| What it adds | Prose: a description, then a body on trigger | Tool schemas **and** server instructions, injected up front |
| Can it act on its own? | No. It advises; the agent still calls tools | **Yes.** Its tools can write files, open tickets, deploy |
| What a bad one costs | Wasted tokens when triggered | Wasted tokens **always**, plus an unpredictable action surface |

The middle-left cell is the one that changes the arithmetic. A redundant skill
costs nothing until someone triggers it. A redundant MCP costs context on every
turn of every session on the machine, which is the same shape of cost the
factory already spends a phase discipline defending.

## The commands

Both live in the bundle and speak only to the config, never to the network.

```bash
node scripts/factory-mcp.mjs audit                    # what is configured, and what it costs
node scripts/factory-mcp.mjs handshake --name graft   # does it actually answer?
```

`audit` reports every configured server with its owner (bundle-owned or the
user's), its type, whether it is live, and whether it needs a credential.
**Credentials are described, never quoted**, and no header names are recorded
either: an env-var name is a hint worth stealing, and a record of someone's
config has no business carrying secrets.

`handshake` spawns a local stdio server and speaks the real protocol
(`initialize`, then `tools/list`). It is the only way to know a server works
rather than assumes it. `tools/list` returning zero tools is a **legitimate
answer** and is never graded as a failure: graft defers its schemas until a
graph exists, and a server may legitimately expose nothing in a given repo.

## Dimensions

### Transferred from `skill-judge` (the 120-point rubric)

| Skill dimension | Transfers? | How it reads for an MCP |
|---|---|---|
| D1 Knowledge Delta (20) | Yes, inverted | The delta is the *tool surface*, not prose. Forty tools when the work needs three is a negative delta. |
| D2 Mindset + Procedures (15) | Yes | Does it encode a workflow, or just wrap an API the agent could already call? |
| D3 Anti-Pattern Quality (15) | **Barely** | An MCP has no prose to warn with. The equivalent is structural: do required fields, enums and validation make the mistake impossible? |
| D4 Specification Compliance (15) | Yes, as protocol | Does it honour the MCP spec: correct handshake, honest capability advertisement, proper tool schemas, errors returned as results rather than thrown? |
| D5 Progressive Disclosure (15) | Yes, and it is the decisive one | Can tools load on demand? A server that injects every schema into every call fails this even when its quality is excellent. |
| D6 Freedom Calibration (15) | Yes | Opinionated where the domain demands it, permissive where it does not. |
| D7 Pattern Recognition (10) | Weakly | Marginal for a tool server. |
| D8 Practical Usability (15) | Yes | Can it be driven correctly on a first attempt from its schema alone? |

**Floor: C (70/120)**, the same floor `skill-judge` uses for skills, for the
same reason. A floor is not a ranking. A 70 that is the only option is still a
no, and the honest verdict is that nothing suitable exists.

Official origin outranks popularity. A maintained first-party server beats a
more-starred third-party one at equal scores.

### MCP-specific dimensions

**M1. Context cost, per call.** Measure it: `instructionsChars` plus the size
of every tool schema. Report the number. graft's own instructions are ~950
characters before any tool is added, which is the floor to compare against, not
the ceiling.

**M2. Write blast radius.** Enumerate what its tools can change: read-only,
writes files, writes tickets, writes to production. A read-only server is a
routine dependency. A server that can deploy is a decision that needs a human
regardless of how good it scores.

**M3. Credentials.** Where does the secret live, and who supplies it? A server
needing a token is a server whose setup can fail on a fresh machine, so it
belongs in the onboarding check, not discovered mid-feature. Never record the
value.

**M4. Failure semantics.** When a tool fails, does the agent get something it
can act on, or a blank result it will misread as success? A server that returns
an empty list for an auth failure will be believed.

**M5. Maintenance and trust.** Who publishes it, when was it last touched, and
does removing it leave anything behind in the user's config?

## The flow

1. **Audit first.** `factory-mcp.mjs audit`. If the capability already exists
   locally, stop: an unused server is pure cost.
2. **Handshake** the ones that matter, so a broken server is discovered before
   it is relied on.
3. **Research with sources** before proposing a new server, the same rule the
   skill path follows. An unresearched prior written into a spec becomes the
   thing everyone agreed to at Gate A.
4. **Score** against the rubric above, with sources.
5. **Record the verdict** in beads, including the rejections and their scores.
6. **Never install automatically.** Adding a server edits the user's global
   `opencode.json`, which is a bigger act than adding a project-local skill. The
   factory audits, judges and records; the human decides. This is the one rule
   here with no automation behind it, on purpose.

## Degradation

Report the reason; never report a silent success. The skill flow's four reasons
do not all apply, so MCP adds its own:

| Reason | Meaning |
|---|---|
| `MCP_NO_CONFIG` | No readable `opencode.json`; nothing to audit. |
| `MCP_CONFIG_UNREADABLE` | The config exists but cannot be parsed. Never assume "no servers". |
| `MCP_NOT_STDIO` | The server is remote or has no command, so a stdio handshake cannot be performed. |
| `MCP_HANDSHAKE_FAILED` | It is configured and it does not answer. The stage is reported, so the fault is locatable. |

A degraded audit is a recorded outcome with a reason, in the same way
`DISCOVERY_DEGRADED` works for skills. It is not a reason to continue silently,
and it is not a reason to abort the feature.
