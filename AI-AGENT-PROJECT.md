# AI Agent Project Setup — use opencode-factory in a project

Use this when the **machine is already set up once** (the one-time install from
[`AI-AGENT-SETUP.md`](AI-AGENT-SETUP.md) was done) and you want the factory
tools to run in a specific project folder — new or existing.

The prompt below is self-contained: **the agent does not need to know how the
tools work** — it uses the three `/factory` commands that the machine install
made available, in order, and follows what they tell it.

## How to use

1. The machine must already have the factory installed (once per device).
   If it does not, do that first:
   `git clone https://github.com/masoodhumza60/opencode-factory` and paste the
   prompt in `AI-AGENT-SETUP.md`.
2. Open a new OpenCode session **in the project folder** you want the feature in.
3. Paste the prompt below.
4. The factory runs in phases and **stops to ask for your approval** at spec,
   plan, and ship. Reply at each stop — this is by design.

## The prompt

```
Build a feature in this project using the factory tools on this machine. You
do not need to know how the tools work internally — use the commands below in
order and follow what they tell you.

THE RULES FIRST:
- Only run these commands if your shell runs on MY computer. No local shell
  (cloud sandbox or chat app)? STOP — give me the project README instead.
- The setup step below writes state only — it must not change my source code
  or project files.
- Never ask for or echo API keys or secrets — none are needed here.

PART 1 — check the tools are installed
1. This session has three commands: /factory onboard, /factory selfcheck and
   /factory feature. If typing /factory offers none of them, the machine was
   never set up — STOP and tell me to run the one-time machine setup first
   (AI-AGENT-SETUP.md from the opencode-factory repo). Do not build without
   the tools.

PART 2 — set up this project
2. Run:  /factory onboard
   It prints what it is doing and finishes when the project is stamped.
   Wait for it to finish. If it errors, copy the output back to me and STOP.
3. Run:  /factory selfcheck
   Every check must print PASS (WARN lines are informational — ignore them).
   If any check FAILs, follow the repair instruction it names and re-run until
   all PASS.

PART 3 — run the feature
4. Run:  /factory feature <short description of the feature>
   It works in phases and STOPS at each phase to wait for my approval. Never
   skip a stop — wait for me to reply each time.
5. When it finishes, tell me in your own words: which files were created or
   changed and why, how to try it, and what I approved at each stop.

PART 4 — report
6. Summarize: whether /factory onboard and /factory selfcheck ran cleanly,
   the feature result, and anything unfinished with the exact next command.
```

## What it does, step by step

| Step | Action |
|---|---|
| Part 1 | Agent checks the 3 `/factory` commands exist — or stops and sends you to `AI-AGENT-SETUP.md` first |
| Part 2 | `/factory onboard` stamps the project, `/factory selfcheck` confirms all PASS |
| Part 3 | `/factory feature <description>` builds it, stopping for your approval at each gate |
| Part 4 | Agent reports files, how to try it, and approvals |

Setup is per-project and never touches your source. Machine not set up yet?
Run `AI-AGENT-SETUP.md` **first** — this prompt stops and sends you there if
the tools are missing.