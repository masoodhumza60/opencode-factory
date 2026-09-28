# Skill Discovery (factory discover)

## Trigger

`factory discover <feature-id>` — run as the **technology-discovery sub-step of
phase 1**. Phase 2 (spec) may not begin until it has run and been reported. The
conductor runs it on entering the brainstorm phase; the human can run it on
demand.

Two things come out of it, and both are reported to the human before the spec
is written:

1. **The stack the repo is actually on** — which technologies this feature
   touches, and what evidence says so.
2. **A verdict per candidate** — adopt or reject-with-a-reason. A candidate
   that is neither adopted nor rejected is a decision deferred until the
   expensive part, which is the same mistake one phase later.

## The one rule that matters most: usage evidence

**A technology is in use only when there is a declared dependency AND an
actual import.**

- Declared — a real entry in `package.json` / `go.mod` / `pyproject.toml` /
  `Cargo.toml`, or a lockfile that resolves it.
- Imported — the name appears in an actual import/require statement in the
  source.

One without the other is a finding, not a fact:

| Declared | Imported | Verdict |
|---|---|---|
| yes | yes | **in use** — safe to build on |
| yes | no | **unused dependency** — report it; do not build on it |
| no | yes | **undeclared dependency** — the build will break for anyone who installs clean. This is a real defect, report it loudly. |
| no | no | **not present** |

**Prose is a hint, never evidence.** A README that says "built with X", a
comment naming a framework, a doc mentioning a library — these are claims by
someone, not facts about the machine. `docs/conductor.md` is not evidence that
this repo uses beads. Neither is a spec, a plan, or this file. If the question
is "does this repo use X", the answer comes from the manifest and the imports,
and nothing else counts.

The one deliberate exception: a technology **being introduced by this feature**
has no usage evidence yet, by definition. That is what the research step is
for.

## 1. Detect context

- Read the stack directly from the repo: `package.json` / `go.mod` /
  `pyproject.toml` / `Cargo.toml` / `*.csproj`, plus the real import lines
  (top 200 lines is plenty). Apply the usage-evidence table above to each
  candidate ecosystem term.
- Graft may **augment** these terms — `graft find_all "<keywords>"` — but only
  when its graph is known non-empty. Check freshness first: an empty graph
  contributes nothing and is treated as no graph, not as "no context needed".
- Add keywords from the feature request itself. Those are the thing being
  searched for, not the thing being detected.

## 2. Find candidates

Primary: the skills.sh CLI. Use only the non-interactive forms below — a
command that can open a prompt will hang an agent forever.

```bash
# enumerate what a source actually offers (plain text, non-interactive)
DISABLE_TELEMETRY=1 npx --yes skills add <owner/repo> --list --yes

# preview one skill WITHOUT installing it
DISABLE_TELEMETRY=1 npx --yes skills use <pkg>@<skill>
```

**Never run `npx skills find` from a script or an agent.** It is interactive
and will block. It is fine for a human at a terminal.

CLI contract, verified: `-g/--global`, `-a/--agent`, `-s/--skill`, `-l/--list`,
`-y/--yes`, `--copy`. `--json` cannot be combined with `--list`, and `--json`
requires `--yes`. The CLI restores with `experimental_install`, which reads
**its own** `skills-lock.json`.

Fallback order when the CLI is unavailable or returns nothing:

1. The `find-skills` skill, if installed.
2. Web search — **permission-gated**: ask "may I research this?" first. A no
   is an answer, and it is recorded as one.
3. The `topics` section of `skills/catalog.yaml`.

**DISCOVERY_DEGRADED — never a silent default.** If every source fails or
returns nothing, record the reason, write the lockfile with `degraded: true`,
and add the beads audit line:

```
bd update <feature-id> --append-notes "skills: DISCOVERY_DEGRADED <reason>"
```

The four reasons, and only these four:

| Reason | Meaning |
|---|---|
| `CLI_MISSING` | the skills CLI is not installed / not runnable |
| `RESEARCH_DENIED` | the human declined the web-research permission gate |
| `NO_SOURCES` | sources ran fine and genuinely had nothing |
| `NETWORK_FAIL` | a source was reachable-flagged but the call failed |

Do **not** fall through to "no project skill needed". That verdict is only
valid after a non-degraded run. A degraded run tells the human the question
was not answered; pretending it was is the failure mode this whole file
exists to prevent.

## 3. Judge before adopting

For every candidate that looks plausible, invoke **`skill-judge`** and apply its
rubric before recommending it. The gate:

- **Score at least C (70/120)** across the rubric's 8 dimensions. Below that,
  reject it and record the score. This is a floor, not a ranking — a 70 that
  is the only option is still a no, because a weak instruction set misdirects
  the phase it is trusted with.
- **Official origin wins.** Prefer the vendor that owns the technology
  (`vercel-labs`, `anthropics`, `microsoft`, `obra`, the upstream project
  itself). A community fork of a maintained official skill is rejected with
  that as the reason.
- **New technology needs research with named sources.** Do not recommend a
  library from memory. Current docs, the actual API, and at least one prior art
  reference. An unresearched recommendation is a guess with a version number
  attached.

Record the score, the evidence, and the reason for every rejection. A rejection
with a stated reason is what stops the next session from re-proposing the same
thing.

## 4. Rank

1. Official/verified origin (above).
2. Best fit for the **actual** work — read the candidate's `SKILL.md` and match
   the verbs in the feature, not its title.
3. Most-used (install counts).

Official outranks popularity on purpose. A skill that gets installed a lot
because it is easy to install is not evidence that it is any good.

## 5. Install, dedupe, and record

- Skip any candidate already in `~/.agents/skills/` or `.agents/skills/`.
- Project-install chosen skills so they are **committed and travel with the
  repo**:

  ```bash
  DISABLE_TELEMETRY=1 npx --yes skills add <source> --skill <name> -a opencode --copy -y
  ```

  `--copy` is deliberate: symlinked installs need elevation on Windows.
- **Every run writes `.agents/skills/skills.lock.json` — including runs that
  install nothing.** Its absence means discovery never provably ran.

```json
{
  "installed": [
    { "name": "<name>", "version": "<version>", "source": "<owner/repo>",
      "sha256": "<hash of SKILL.md>", "grade": "B",
      "why": "<feature-id: reason>" }
  ],
  "rejected": [
    { "name": "<name>", "score": 54, "reason": "below floor C (70/120)" }
  ],
  "run": {
    "at": "<ISO timestamp>",
    "keywords": ["<queried terms>"],
    "sources": ["skills.sh", "find-skills", "catalog.yaml"],
    "degraded": false,
    "reason": "",
    "note": ""
  }
}
```

### Two lockfiles, two jobs — do not confuse them

| File | Owner | Job |
|---|---|---|
| `skills-lock.json` | the skills CLI | the **install** lockfile — deterministic restore, exact versions |
| `.agents/skills/skills.lock.json` | the factory | the **decision record** — scores, evidence, sources, approvals, rejections, and the run's degradation state |

The factory never writes the CLI's file, and the CLI knows nothing about ours.
This split is deliberate: one file for "what is installed", one for "why we
chose it and what we turned down". Collapsing them loses the reasoning, and the
reasoning is the part that is expensive to reconstruct.

## 6. Report, then let the human decide

Discovery proposes; the human approves. Report the stack, each candidate with
its score, each rejection with its reason, and the lockfile outcome — then
wait. A skill the human declined is recorded as declined, and phase 1 continues
without it; that verdict is not a blocker, it is an answer.

## 7. Audit the MCP servers

Skills are what this flow finds. MCP servers are what it has to live alongside,
so they get audited in the same sub-step, and the asymmetry is the point:

```bash
node scripts/factory-mcp.mjs audit                    # what is configured, and what it costs
node scripts/factory-mcp.mjs handshake --name graft   # does it actually answer?
```

A skill costs context when it is triggered. An **enabled MCP server costs
context on every model call**, and its tools can write to the repo or to
production. That makes an unused server a standing tax, and it makes a
misconfigured one a failure that is invisible until a feature needs it. So:

- Report every configured server: owner (bundle or the user), live or disabled,
  whether it needs a credential, and the instructions it injects per call.
- A server the feature depends on must have **completed a handshake**, not
  merely appear in the config. The selfcheck does this for graft; a
  feature-specific server is handshaked on demand.
- If a *new* server looks like the answer, judge it against
  `docs/mcp-judging.md` and record the verdict, rejections included.
- **Never install one automatically.** It edits the user's global
  `opencode.json`. The agent proposes and records; the human decides.

A degraded audit is a recorded outcome with a reason, exactly as
`DISCOVERY_DEGRADED` is for skills: `MCP_NO_CONFIG`, `MCP_CONFIG_UNREADABLE`,
`MCP_NOT_STDIO`, `MCP_HANDSHAKE_FAILED`. It is never reported as a clean pass.

## Hard skills are not discovered

`commit-work` and `skill-judge` are **hard skills** — declared in
`skills/catalog.yaml`, installed by the installer, and FAILed by the selfcheck
when missing. They are not subject to this flow, the relevance threshold, or
the human's per-feature approval. See "Hard skills" in `docs/conductor.md`.

## What this flow will not do

- **Skip the run** because the spec "looks obvious". The hard stop in phase 1
  is the point.
- **Recommend a library from memory** without research and named sources.
- **Report a clean run** when a source failed. `degraded` is the honest word.
- **Treat silence as rejection**, or rejection as a reason to stop. Rejected
  candidates with reasons are the record that makes the next run faster.
- **Let a low score through** on the grounds that it is the only option. The
  floor is a floor.
