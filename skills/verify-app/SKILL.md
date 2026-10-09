---
name: verify-app
description: Generate a project-local verification skill that drives the real app the way a user does, so "it works" becomes a claim anyone can re-check. Use when completing phase 5 (verify), when asked to "make a control skill for this repo", or when a project has no scripted way to prove UI/CLI/service behaviour. Adapts create-verification-skill from backnotprop/pstack (MIT/AGPL check before vendoring text).
disable-model-invocation: true
---

# Generate this project's verification skill

## Why this exists

A run shipped 22 tasks, every gate green, and nobody had ever started the app.
The person driving it still had to ask *how do I run it*, then *run it*, then
*check it's working properly*. The factory's `--booted` flag now forces someone
to answer that at least once — but one sentence is a claim, not a checkable
thing. This skill makes the claim **re-runnable**: every later agent drives the
app the same way, because the instructions are in the repo.

**You are writing for the next agent, not for a human.** It will read this cold,
mid-task, having never seen the app. Anything you leave as a placeholder teaches
a guess.

## Step 1 — interview the repo, not the user

Answer from the codebase. Ask the user only what cannot be observed.

1. **Surface** — what does a user actually touch? Web UI, CLI/TUI, desktop, API,
   mobile, or a library. A repo can have several: pick the primary, note the rest.
2. **Run** — how does it start locally? Prefer the repo's own documented dev
   command. Note ports, env vars, seed data, auth.
3. **Drive** — how can an agent interact programmatically? Two passes, in this
   order, because hand-writing Playwright when a browser is already connected is
   the most common wasted effort here:

   **Pass 1 — what is already available on this machine?** Run
   `node <bundle>/scripts/factory-mcp.mjs audit`. It lists every configured MCP
   server, who owns it, whether it is live or disabled, and what it can reach.
   For a **web surface, a live `chrome-devtools` (or any browser) MCP is the
   harness** — drive the real app through it rather than generating test code
   that then has to be maintained. A connected MCP is already handshaken and
   costs you nothing to use; generated Playwright costs a file you must keep
   correct forever. If a browser MCP exists but is switched off (`audit` reports
   its state as disabled), say so and offer to connect it with
   `node <bundle>/scripts/factory-mcp.mjs enable <server>` rather than silently
   writing the fallback — that is a decision the human should see, not one to
   make by omission. That command writes **this project's** `opencode.json`, so
   nothing else on the machine is affected; say so when you offer it, and tell
   the human OpenCode needs a restart before the server appears.

   **Pass 2 — only then the repo's own harnesses**: existing Playwright/Cypress
   specs, expect scripts, PTY helpers, a debug port, a curl-able health endpoint.
   Only after both passes, a generic recipe — browser/CDP for web and Electron,
   tmux/PTY for CLI-TUI, plain HTTP for services.

   Record which pass supplied the harness in the Drive section, so a later reader
   knows whether the choice was made or just inherited.
4. **Observe** — what evidence can be captured? Screenshots, terminal
   transcripts, response bodies, logs, exit codes, database state.
5. **Isolate** — can two instances run side by side? If not, say so plainly.
   Refusing to double-drive a shared instance beats corrupting the user's session.

**If the checkout does not build or start as-is, fix that first, or report it
precisely, before generating anything.** A skill written against a broken base
teaches wrong steps and gets blamed for the base's breakage.

## Step 2 — generate `.agents/skills/verify-<app>/SKILL.md`

Use the project's existing skills folder if it has one (`.agents/skills/` for
OpenCode, `.claude/skills/`, `.cursor/skills/`). Frontmatter is required — a
skill without it never registers.

- **Launch** — the exact command that starts the app, how to tell it is ready
  (log line, port answering, prompt), and how to tear it down. A short-lived
  CLI/TUI has no server: build once, then start each drive in its own PTY.
- **Doctor** — one read-only check answering *is this instance worth driving?*:
  process up, right version/build, the port is ours, auth valid. Run it first
  whenever anything looks wrong.
- **Drive** — the recipe with **real selectors and commands from this repo, not
  examples**. Prefer stable handles (ARIA labels, data attributes, prompt text,
  route paths) over coordinates and tab order.
- **Evidence** — what to capture and where it goes. Proof standards:
  - exercise the **real user path**, not an internal setter or test-only endpoint;
  - capture **the action and the resulting state**, not just the final screen;
  - verify **side effects** — files written, rows inserted, messages sent —
    alongside whatever is visible;
  - a dry-run is not automatically safe. **Observe what it actually did**
    (files, network, git refs) instead of trusting its name.
- **Cleanup** — how to tear down what this run created. **Never kill by process
  name; kill what you started.** Cleanup removes instances and scratch state and
  **never the evidence** — proof survives teardown, at a path the skill names.
- **Helpers** — any script shipped here is executable, and its invocation appears
  in the body. A helper the reader has to reverse-engineer is not a helper.

## Step 3 — seed the feature map

Create `features/README.md` plus one file per user-facing feature (top 3–5,
taken from routes, commands, menus or docs). Each has four fixed headings:
`Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`,
`Gotchas`.

This map is the repo's maintained verification source. A proof that drives one
convenient entry point is incomplete when the map lists others.

## Step 4 — prove the generated skill before handing it over

Run its own instructions end to end, once: launch, doctor, drive **one** mapped
feature, capture evidence, clean up. One is enough; the map exists so later runs
cover the rest.

**After cleanup, confirm the evidence still exists at the named path.** A
cleanup that eats the proof fails this step. Run cleanup after every failed
attempt too, so broken runs do not strand processes and ports.

A generated skill that was never executed is a draft, not a deliverable.

## Step 5 — hand off to the phase machine

Once the skill exists and has been run once, complete phase 5 with the claim
pointing at the artifact rather than restating it in prose:

```
factory-phase.mjs complete <bead> 5 --evidence "…" \
  --booted "verify-<app>: drove <feature>, evidence at <path>"
```

`run.at` is stamped by the script, so do not supply it. The claim is short
because the state field holds at most 255 characters and no double quotes —
the detail lives in the committed skill, and the claim points at it.

## Step 6 — keep it honest

As the app changes, update the map when a feature is added, renamed or removed;
update a Drive recipe when a selector moves. A verification skill that has
drifted teaches the next agent to trust a claim that is no longer true — which
is worse than having none, because it looks like evidence.