// Bundled opencode-factory beads plugin. Self-contained: BEADS_GUIDANCE is
// inlined below instead of imported from the npm cache, so this file works on
// any machine with a `bd` CLI on PATH (or in %LOCALAPPDATA%\Programs\bd).
// - Commands ship as files: ~/.config/opencode/commands/beads/*.md (auto-reloaded).
// - Agent ships as a file:  ~/.config/opencode/agents/beads-task-agent.md.
// - This file only injects `bd prime` output + BEADS_GUIDANCE into model system
//   context, refreshed after each compaction (mirrors V1 session.compacted logic).
import { execFile } from "node:child_process";

/* Inlined from opencode-beads@0.8.0 src/vendor.ts (BEADS_GUIDANCE). */
const BEADS_GUIDANCE = `<beads-guidance>
## CLI Usage

**IMPORTANT:** There is no \`bd\` tool in this environment. You must use the \`bash\` tool to run the \`bd\` command.

**Do not try to call a tool named \`bd\` directly.** It does not exist.
**Do not try to call MCP tools (like \`ready\`, \`create\`) directly.** They do not exist.

Instead, use the \`bash\` tool for all beads operations:

- \`bd init [prefix]\` - Initialize beads
- \`bd ready\` - List ready tasks
- \`bd show <id>\` - Show task details
- \`bd create "title" -t bug|feature|task -p 0-4\` - Create issue
- \`bd update <id> --status in_progress\` - Update status
- \`bd close <id> --reason "message"\` - Close issue
- \`bd reopen <id>\` - Reopen issue
- \`bd dep add <from> <to> --type blocks|discovered-from\` - Add dependency
- \`bd list --status open\` - List issues
- \`bd blocked\` - Show blocked issues
- \`bd stats\` - Show statistics

If a tool is not listed above, try \`bd <tool> --help\`.

Use the default command output unless \`--json\` would make a task easier or more reliable. If you parse command output, distinguish parsing errors from command failures.

## Agent Delegation

**Default to the agent.** For ANY beads work involving multiple commands or context gathering, use the \`task\` tool with \`subagent_type: "beads-task-agent"\`:
- Status overviews ("what's next", "what's blocked", "show me progress")
- Exploring the issue graph (ready + in-progress + blocked queries)
- Finding and completing ready work
- Working through multiple issues in sequence
- Any request that would require 2+ bd commands

**Use CLI directly ONLY for single, atomic operations:**
- Creating exactly one issue: \`bd create "title" ...\`
- Closing exactly one issue: \`bd close <id> ...\`
- Updating one specific field: \`bd update <id> --status ...\`
- When user explicitly requests a specific command

**Why delegate?** The agent processes multiple commands internally and returns only a concise summary. Running bd commands directly dumps hundreds of lines of raw JSON into context, wasting tokens and making the conversation harder to follow.
</beads-guidance>`;

// Per-session cache of `bd prime` output; cleared on compaction so the next model
// call re-runs bd. Stores "" when bd is unavailable (feature stays inert, no retries).
const primeCache = new Map();
// Agent-id -> mode snapshot ("primary"|"all"|"subagent"|"unknown"); refreshed lazily.
let agentModes = new Map();

async function refreshAgentModes(ctx) {
  try {
    const res = await ctx.agent.list();
    const list = (res && res.data) || res || [];
    const next = new Map();
    for (const agent of list) {
      next.set(String((agent && (agent.name ?? agent.id)) ?? ""), String((agent && agent.mode) ?? ""));
    }
    agentModes = next;
  } catch {
    // Keep the previous snapshot; unknown agents fall back to "unknown" (inject).
  }
}

// `bd` resolves through PATH first (faithful to V1). On this machine the official
// beads installer puts bd.exe in %LOCALAPPDATA%\Programs\bd, and the already-running
// OpenCode service may still have a PATH without it, so try that location as a
// fallback before giving up ("", keeping the feature inert).
const BD_BIN_CANDIDATES = [
  "bd",
  `${process.env.LOCALAPPDATA || ""}\\Programs\\bd\\bd.exe`,
].filter((bin) => bin !== "");

// Runs `bd prime` in cwd; resolves "" on any error/empty output (bd not installed,
// no beads database, timeout). No shell metacharacter risk: fixed args only.
function runBdPrime(cwd) {
  return new Promise((resolve) => {
    let index = 0;
    const tryNext = () => {
      if (index >= BD_BIN_CANDIDATES.length) {
        resolve("");
        return;
      }
      const bin = BD_BIN_CANDIDATES[index++];
      try {
        execFile(
          bin,
          ["prime"],
          { cwd, timeout: 15000, shell: process.platform === "win32", windowsHide: true },
          (err, stdout) => {
            if (err) {
              const message = (err && err.message) || "";
              // Binary missing (PATH miss or absent .cmd shim) -> try next candidate.
              // Any other error (no beads database, schema skew, timeout) -> stay inert.
              if (/ENOENT|not recognized|not found|No such file/i.test(message)) {
                tryNext();
                return;
              }
              resolve("");
              return;
            }
            resolve(stdout ? String(stdout).trim() : "");
          }
        );
      } catch {
        tryNext();
      }
    };
    tryNext();
  });
}

// Resolves the session's project directory (bd must run there, not the config dir).
// The plugin client's exact get() input shape is uncertain, so try known shapes
// defensively and return "" if none yields a directory.
async function sessionDirectory(ctx, sessionID) {
  for (const input of [{ path: { id: sessionID } }, { sessionID }, { id: sessionID }]) {
    try {
      const res = await ctx.session.get(input);
      const info = (res && res.data) || res;
      if (info && typeof info.directory === "string" && info.directory) {
        return info.directory;
      }
    } catch {
      // Try the next call shape.
    }
  }
  return "";
}

// V1 shouldInject parity: no agent or beads-task-agent always injects; primary/all
// inject; subagents skip; unknown agent names inject (safe fallback).
function shouldInject(agentId, mode) {
  if (!agentId || agentId === "beads-task-agent") return true;
  if (!mode || mode === "unknown" || mode === "primary" || mode === "all") return true;
  return false;
}

export default {
  id: "opencode-beads",
  async setup(ctx) {
    const registrations = [];
    await refreshAgentModes(ctx);

    // System parts are per-request and not persisted, so push on every agent-loop
    // model call (same visible effect as V1's persisted synthetic message, but
    // always fresh). Runs `bd prime` only on cache miss (first call per session,
    // and once after each compaction).
    const contextReg = await ctx.session.hook("context", async (event) => {
      try {
        const agentId = event.agent ? String(event.agent) : "";
        let mode = agentId ? agentModes.get(agentId) : undefined;
        if (agentId && mode === undefined) {
          await refreshAgentModes(ctx);
          mode = agentModes.get(agentId);
          if (mode === undefined) agentModes.set(agentId, "unknown");
        }
        if (!shouldInject(agentId, mode)) return;

        if (!primeCache.has(event.sessionID)) {
          let cwd = await sessionDirectory(ctx, event.sessionID);
          if (!cwd) {
            cwd = (ctx.location && ctx.location.project && ctx.location.project.directory)
              || (ctx.location && ctx.location.directory)
              || process.cwd();
          }
          primeCache.set(event.sessionID, await runBdPrime(cwd));
        }
        const prime = primeCache.get(event.sessionID);
        if (!prime) return; // bd missing or no data: stay inert (V1 behavior)

        event.system.push({
          type: "text",
          text: `<beads-context>\n${prime}\n</beads-context>\n\n${BEADS_GUIDANCE}`,
        });
      } catch (err) {
        console.warn("[opencode-beads] context injection skipped:", err instanceof Error ? err.message : err);
      }
    });
    if (contextReg && typeof contextReg.dispose === "function") registrations.push(contextReg);

    // V1 re-injected after session.compacted; here compaction only invalidates the
    // cache so the next model call primes fresh content.
    const compactionReg = await ctx.session.hook("compaction", (event) => {
      primeCache.delete(event.sessionID);
    });
    if (compactionReg && typeof compactionReg.dispose === "function") registrations.push(compactionReg);

    return () => {
      for (const reg of registrations) {
        try {
          reg.dispose();
        } catch {
          // Already disposed or host teardown; ignore.
        }
      }
      primeCache.clear();
    };
  },
};
