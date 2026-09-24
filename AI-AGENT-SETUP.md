# AI Agent Setup — install opencode-factory on a new machine

Use this when you want to set up the factory on a machine with **no manual
install**. Give the prompt below to an AI coding agent (OpenCode) running on
that machine — it performs the whole installation itself.

## How to use

1. Clone this repo on the new machine:
   `git clone https://github.com/masoodhumza60/opencode-factory && cd opencode-factory`
2. Open a new OpenCode session in that folder.
3. Paste the prompt below and answer the agent's questions (only the TinyFish
   API key needs to come from you — give it in chat; it is never written to the
   repo).
4. After the agent finishes, **start a fresh OpenCode session** — the
   `/factory` commands and TinyFish tools only appear in sessions started after
   the install.

## The prompt

```
Install opencode-factory on this machine and connect TinyFish.

THE RULES FIRST:
- Only run these commands if your shell runs on MY computer. If you are a cloud
  sandbox or a chat app with no local shell, STOP — never quote my API keys back
  to me; give me the install links for your app instead.
- Never print, commit, or store API keys. Ask me interactively when one is needed.

PART 1 — opencode-factory (the software factory)
1. This repo is already cloned on this machine. Confirm your working directory
   is the clone.
2. Run the platform installer once (idempotent, safe to re-run):
   - Windows:  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
   - macOS/Linux: ./install.sh   (if the exec bit is missing: bash install.sh)
   It installs: 3 OpenCode plugins, the 29 beads commands, the 3 /factory
   commands (onboard, selfcheck, feature), the beads-task agent, and the factory
   skill with its docs.
3. Verify:  node scripts/factory-selfcheck.mjs --tokens
   The 6 PASS checks cover plugins, bd, graft, the factory skill and the beads
   store. Run the repairs it lists, in order, then re-check. WARN lines are
   informational, not failures.
4. The /factory commands and TinyFish tools only appear in a session started
   AFTER this install. If /factory is still missing in a fresh session, say so —
   do not reinstall.

PART 2 — TinyFish (web-research MCP server)
1. Before running anything, tell me that a browser sign-in may be required that
   only I can finish, and ask me for my TinyFish API key. I provide it in chat;
   never echo it back and never write it to disk or the repo.
2. Run with a 10-minute timeout (it waits while I finish that sign-in):
   npx -y @tiny-fish/cli@latest connect --all --api-key <MY_API_KEY> --skip-launch --url "https://agent.tinyfish.ai/mcp?connect_attempt_id=<ATTEMPT_ID>"
   If I did not give you an attempt ID, ask for the current connect URL from my
   TinyFish account instead of inventing one.
3. Check:  npx -y @tiny-fish/cli@latest doctor --pretty
   If anything failed, run its repairs in the listed order. Repairs marked
   unattended_safe: false are mine — show me the command, do not run it.
4. Prove it works: use TinyFish to find today's top Hacker News story.

PART 3 — report back
1. Factory: what installed and the verification result.
2. TinyFish: which agents connected, which still need my browser sign-in.
3. Anything you could not finish, with the exact command I still need to run.
```

## What it does, step by step

| Step | Action on the new machine |
|---|---|
| 1 | Agent confirms the clone as working dir |
| 2 | `install.ps1` / `install.sh` — installs plugins, beads + `/factory` commands, agent, factory skill |
| 3 | `factory-selfcheck.mjs --tokens` — 6 PASS health gate |
| 4 | TinyFish `connect --all` — registers the MCP server for opencode and every agent it finds |
| 5 | `doctor --pretty` + live proof (top HN story) |
| 6 | Fresh session → `/factory onboard` in any project |

The one human-only moment is the TinyFish browser sign-in (if required) and the
API key, given in chat.