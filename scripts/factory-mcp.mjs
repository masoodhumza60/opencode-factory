#!/usr/bin/env node
// opencode-factory MCP parity. Two questions the factory could not answer before:
//
//   handshake - is the bundle-owned MCP server actually *serving*?
//               (`graft --version` proves the CLI exists, not that the MCP
//               wiring works. A server that is misconfigured, renamed, or
//               crashes on boot looks identical from the outside.)
//
//   audit     - what MCP servers does this machine actually run, which are
//               enabled, and which of them does anything verify?
//
// Redaction is structural, not a filter: every field in the output is copied
// through an explicit allowlist, so a future config field carrying a secret
// cannot leak into a decision record that gets committed to a repo.
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(k); return i === -1 ? undefined : argv[i + 1]; };
const has = (k) => argv.includes(k);

const BUNDLE_OWNED = "graft";
const DEFAULT_TIMEOUT = 8000;

// --quiet suppresses chatter only. The payload is ALWAYS printed: a check whose
// result can be silenced is a check that can be made to look like it passed.
const say = (m) => { if (!has("--quiet")) console.log(m); };
// `--json` means machine-readable, so it emits ONE line. Pretty-printing a
// --json payload forces every consumer to guess how to extract it: the
// selfcheck's first version read the last line, which on a nested payload is a
// lone "}" and not JSON at all. A flag whose output shape is ambiguous is a
// defect, not a style choice. Human readers get the pretty form.
const out = (o) => console.log(has("--json") ? JSON.stringify(o) : JSON.stringify(o, null, 2));

// `stage` is a required argument, not an optional field. Six of the seven
// original failure sites omitted it, and a consumer reading the result saw
// "handshake failed at unknown stage" for the most common fault of all: a
// server that is not registered. A diagnostic that cannot name where it failed
// is half a diagnostic, so the signature makes omitting it impossible.
function fail(msg, stage, extra = {}) {
  out({ ok: false, stage, error: msg, ...extra });
  process.exit(1);
}

function configPath() {
  if (get("--config")) return get("--config");
  return join(homedir(), ".config", "opencode", "opencode.json");
}

// Strict JSON, like merge-config.mjs. A config we cannot parse is a failure we
// must report, never a reason to assume there is nothing to check.
function loadConfig() {
  const p = configPath();
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    fail(`cannot read opencode config at ${p}`, "config-unreadable", { config: p });
  }
  try {
    return { config: JSON.parse(raw), path: p };
  } catch (e) {
    fail(`opencode config at ${p} is not valid JSON: ${e.message}`, "config-invalid-json", { config: p });
  }
}

// A remote URL can carry the credential in the query string
// (?token=..., ?key=...). Record the origin + path only, so the record stays
// portable (no machine-specific absolute paths) and inert.
function safeUrl(u) {
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}

// The audit payload is meant to be committed as a decision record, so it must
// not carry this machine's absolute paths - the same reason a shipped command
// file cannot hardcode a bundle location. Error text keeps the full path,
// because a human has to be able to open the file they are being told about.
function displayPath(p) {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length).replace(/\\/g, "/") : basename(p);
}

function describe(name, s) {
  const type = s?.type === "remote" ? "remote" : "local";
  const enabled = s?.disabled === true ? "disabled" : "enabled";
  const hasHeaders = s?.headers != null && Object.keys(s.headers).length > 0;
  const urlQuery = type === "remote" && s?.url ? /[?&](token|key|apikey|api_key|access_token|password)=/i.test(s.url) : false;
  return {
    name,
    owner: name === BUNDLE_OWNED ? "bundle" : "user",
    type,
    state: enabled,
    // Allowlist. A local server's absolute path is machine-specific and would
    // be wrong in every other checkout, so record the executable's name only.
    target: type === "remote" ? safeUrl(s?.url) : basename(s?.command?.[0] ?? "<unknown>"),
    needsCredential: hasHeaders || s?.oauth === true || urlQuery,
    // Never the value, never the key name either - the header map can name the
    // secret it wants, and the env var holding it is a hint worth stealing.
    credentials: hasHeaders ? Object.keys(s.headers).length + " header(s), values withheld" : s?.oauth === true ? "oauth" : urlQuery ? "credential in url query, withheld" : null,
  };
}

// ---------------------------------------------------------------- handshake
async function handshake() {
  const { config, path } = loadConfig();
  const name = get("--name") || BUNDLE_OWNED;
  const server = config?.mcp?.servers?.[name];
  if (!server) {
    fail(`no MCP server named "${name}" in ${path}`, "server-absent", { server: name, configured: Object.keys(config?.mcp?.servers ?? {}) });
  }
  if (server.disabled === true) {
    fail(`MCP server "${name}" is disabled in the config; it cannot serve`, "server-disabled", { server: name, state: "disabled" });
  }
  if (server.type === "remote" || !Array.isArray(server.command) || server.command.length === 0) {
    fail(`MCP server "${name}" is not a local server with a command; this check speaks stdio JSON-RPC only`, "server-not-stdio", { server: name, type: server.type ?? "local" });
  }

  const timeout = Number(get("--timeout") || DEFAULT_TIMEOUT);
  const TOOLS_GRACE = 1200; // tools/list may lag initialize; never hang on it
  const [exe, ...args] = server.command;
  const started = Date.now();
  // ONE promise, resolved once, carrying BOTH round trips. Awaiting the same
  // promise twice hands back the first value and silently reports no tools.
  const result = new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ kind: "spawn-failed", detail: e.message });
      return;
    }
    let buf = "", err = "", settled = false, initMsg = null, toolsMsg = null, grace = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      try { child.kill(); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => done({ kind: initMsg ? "tools-timeout" : "timeout" }), timeout);
    const ok = (tools) => done({ kind: "ok", info: initMsg.result?.serverInfo ?? {}, capabilities: initMsg.result?.capabilities ?? {}, instructions: initMsg.result?.instructions ?? "", tools });
    child.on("error", (e) => done({ kind: "spawn-failed", detail: e.message }));
    child.on("exit", (code) => {
      if (settled) return;
      const tail = err.trim().slice(0, 200);
      done({ kind: initMsg ? "exited-after-initialize" : "exited", detail: `server exited (code ${code}) before completing the handshake${tail ? `: ${tail}` : ""}` });
    });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) { done({ kind: "initialize-error", detail: m.error.message ?? JSON.stringify(m.error) }); return; }
          initMsg = m;
          if (toolsMsg) { ok(Array.isArray(toolsMsg.result?.tools) ? toolsMsg.result.tools : []); return; }
          // initialize already proved the server serves. Give tools/list a short
          // window, then accept the handshake with whatever it did (or did not)
          // say: an empty tool list is a legitimate state, never fatal.
          grace = setTimeout(() => ok(null), TOOLS_GRACE);
        } else if (m.id === 2) {
          if (m.error) { done({ kind: "tools-error", detail: m.error.message ?? JSON.stringify(m.error) }); return; }
          toolsMsg = m;
          if (initMsg) ok(Array.isArray(m.result?.tools) ? m.result.tools : []);
        }
      }
    });
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch { /* pipe closed */ } };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "opencode-factory-selfcheck", version: "1.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });

  // A live handshake is proven by initialize + serverInfo + an advertised tools
  // capability. The tool count is reported as information and never graded:
  // graft defers tool schemas and reports none until a graph exists, so
  // "0 tools" is a normal state, not a fault.
  const r = await result;
  if (r.kind !== "ok") {
    fail(`MCP handshake with "${name}" failed: ${r.kind}${r.detail ? ` - ${r.detail}` : ""}`, r.kind, { server: name, ms: Date.now() - started });
  }
  const list = r.tools;
  out({
    ok: true, server: name, stage: "initialized",
    serverInfo: { name: r.info.name ?? null, version: r.info.version ?? null },
    advertisesTools: r.capabilities?.tools != null,
    toolCount: list === null ? null : list.length,
    toolNote: list === null ? "tools/list did not answer in time; not graded" : list.length === 0 ? "0 tools - expected without a graft graph; not graded" : null,
    instructionsChars: (r.instructions || "").length,
    ms: Date.now() - started,
  });
  if (r.info.name != null && r.info.name !== name) say(`note: config key "${name}" answered as server "${r.info.name}"`);
}

// ------------------------------------------------------------------- audit
function audit() {
  const { config, path } = loadConfig();
  const servers = config?.mcp?.servers;
  if (servers == null || typeof servers !== "object" || Array.isArray(servers)) {
    fail(`no mcp.servers object in ${path}; there is nothing to audit`, "no-servers-object", { config: path });
  }
  const inventory = Object.entries(servers).map(([n, s]) => describe(n, s ?? {}));
  const enabled = inventory.filter((s) => s.state === "enabled");
  const unverified = enabled.filter((s) => s.owner === "user");
  const payload = {
    ok: true, config: displayPath(path), total: inventory.length, enabled: enabled.length,
    servers: inventory,
    unverifiedEnabled: unverified.map((s) => s.name),
    note: unverified.length > 0
      ? "these enabled servers are the user's own; the factory audits them and never installs, edits, or disables them"
      : "no user-owned MCP server is enabled",
  };
  if (has("--json")) { out(payload); return; }
  say(`mcp: ${payload.enabled}/${payload.total} server(s) enabled, config ${path}`);
  for (const s of inventory) {
    const mark = s.owner === "bundle" ? "*" : " ";
    say(`  ${mark} ${s.name.padEnd(18)} ${s.type.padEnd(6)} ${s.state.padEnd(8)} ${s.target}${s.needsCredential ? "  [needs credential]" : ""}`);
  }
  say("  * bundle-owned");
  if (unverified.length) say(`unverified by any check: ${unverified.map((s) => s.name).join(", ")}`);
  out(payload);
}

const cmd = argv[0];
if (cmd === "handshake") await handshake();
else if (cmd === "audit") audit();
else {
  console.error("usage: factory-mcp.mjs handshake [--name <server>] [--config <path>] [--timeout <ms>] [--quiet] [--json]");
  console.error("       factory-mcp.mjs audit    [--config <path>] [--quiet] [--json]");
  process.exit(1);
}
