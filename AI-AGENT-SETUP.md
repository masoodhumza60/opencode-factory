# AI Agent Setup — install opencode-factory on a new machine

Use this when you want to set up a machine with **no manual install**. Give
the prompt below to an AI coding agent (OpenCode) running on that machine.

The prompt is self-contained: **the agent does not need to know anything
about the tools being installed** (beads, graft, MCP, skills — none of it).
It only runs the commands below in order and checks the output. No API keys,
no browser sign-ins, nothing else needed from you.

The install puts the whole system in place once per machine: the `bd` command
line tool (beads), the graft code-graph server, the OpenCode plugins, and the
`/factory` commands (onboard, selfcheck, feature) with their agent and skill.

## How to use

1. Clone this repo on the new machine:
   `git clone https://github.com/masoodhumza60/opencode-factory && cd opencode-factory`
2. Open a new OpenCode session in that folder.
3. Paste the prompt below.
4. After the agent finishes, **start a fresh OpenCode session** — the `/factory`
   commands only appear in sessions started after the install.
5. From then on, in **any** project on that machine, paste the project prompt
   from [`AI-AGENT-PROJECT.md`](AI-AGENT-PROJECT.md) into a session opened in
   that project — it sets the project up, then runs your feature.

## The prompt

```
Set up this repo into a working system on my machine — no manual steps, and
no knowledge of the components needed on your side. Do not research, rename,
improve, or re-order the steps. Run them exactly as written and report back.

THE RULES FIRST:
- Only run these commands if your shell runs on MY computer. No local shell
  (cloud sandbox or chat app)? STOP — there is nothing for you to install;
  give me the project README instead.
- Do not modify anything in this repo — it installs to my user config
  (~/.config/opencode and ~/.agents/skills).
- Never ask for or echo API keys or secrets — this setup needs none.

PART 1 — install (once; safe to re-run)
1. Check Node.js is installed and at least version 20:
     node --version
   If it errors or shows an older version, STOP and tell me — Node >= 20 is
   required.
2. Run the installer, exactly one of these two:
   - Windows:  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
   - macOS / Linux:  ./install.sh
     If that prints "permission denied", run:  bash install.sh
3. The installer prints progress and must finish with no error. If it fails,
   copy the exact error back to me and STOP.

PART 2 — check the install
4. Run:
     node scripts/factory-selfcheck.mjs --tokens
5. Every check must print PASS (lines that print WARN are informational —
   ignore them). If any line prints FAIL, follow the repair instruction it
   names and run this check again until all PASS.

PART 3 — why the new commands are not visible here
6. This install adds three OpenCode commands that appear as /factory onboard,
   /factory selfcheck and /factory feature. They only load in a session
   started AFTER this install, so they will not appear in this session. That
   is expected — do not try to run them here.
7. Once you finish, they will be available in every new session.

PART 4 — report back
8. Tell me, in plain words:
   - the installer finished without errors (or paste the exact failure)
   - the 6 PASS lines from the check
   - that /factory only appears in fresh sessions, so nothing else needs
     testing here
   - anything you could not finish, with the exact command I need to run.
```

## What it does, step by step

| Step | Action on the new machine |
|---|---|
| 1 | Agent checks Node >= 20 and runs the platform installer |
| 2 | Installer puts everything in place once (commands, tools, skill) |
| 3 | Agent runs the 6-check health gate — all PASS |
| 4 | You start a fresh session — `/factory` commands now exist |
| 5 | You paste `AI-AGENT-PROJECT.md` in any project to build features |

No API keys, no browser sign-ins, no prior knowledge needed from the agent —
the only human input is running this prompt once per machine.