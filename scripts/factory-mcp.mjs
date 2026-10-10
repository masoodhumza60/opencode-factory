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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { defMatches } from "./mcp-defmatch.mjs";
import { createHash } from "node:crypto";

// Only these flags take a value. Guessing from the argv shape looked harmless and
// was not: for two consecutive boolean flags the guess is ALWAYS right, so
// `--dry-run --refresh` ate `--refresh`, and `--refresh --registry <url>` ate the
// url - add then quietly queried the default registry instead of the named one.
// The cost of naming them is that a new value-flag must be added here.
const VALUE_FLAGS = new Set(["--registry","--timeout","--limit","--config","--name","--key","--env","--allow","--requirements","--out"]);


const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(k); return i === -1 ? undefined : argv[i + 1]; };
const has = (k) => argv.includes(k);

// Where this bundle lives on disk. The list of servers the factory depends on is
// read from the bundle rather than written here, because a hardcoded name is a
// bundle that only works on the machine it was written on: another laptop may
// run a different code graph, or none, and a different agent reusing this
// factory will have its own. The declaration sits beside the other config
// declarations so there is exactly one place to change it.
const BUNDLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// DATA, not a literal. A machine is free not to have a declared server, so this
// is a wish rather than an assertion - which is why a missing one is reported
// and never fatal, while a typo in an explicit --allow still is.
// --requirements points this at a different declaration. That exists because a
// different bundle, or another agent reusing this factory, has its own list, and
// because the only honest way to test "what if this machine declares nothing"
// is to be able to say so without editing the bundle.
function requiredServers() {
  const f = get("--requirements") || join(BUNDLE_DIR, "config", "mcp-requirements.json");
  if (!existsSync(f)) return [];
  let r;
  r = parseOrFail(readFileSync(f, "utf8"), f, "mcp requirements");
  if (!r || !Array.isArray(r.required)) return [];
  return r.required.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
}

const DEFAULT_TIMEOUT = 8000;

// --quiet suppresses chatter only. The payload is ALWAYS printed: a check whose
// result can be silenced is a check that can be made to look like it passed.
// --json suppresses it too, because the contract one line above is that --json emits
// ONE line: chatter on stdout means a consumer cannot parse the payload without
// first guessing which lines are prose. Refusals are unaffected - fail() prints
// its own payload through out(), so nothing is silenced on the failure path.
const say = (m) => { if (!has("--quiet") && !has("--json")) console.log(m); };
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

// The original bytes, kept so a write that cannot be verified can be undone.
// Restoring the exact text (not a re-serialised copy) matters: a user's config
// may carry formatting and key order they did not ask us to rewrite.
function rawConfig(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    fail(`cannot read opencode config at ${p}`, "config-unreadable", { config: p });
  }
}

// The config path and the reload sentence both come from scripts/platform.mjs
// rather than being literals here, so this script has no opinion about which
// harness it is driving. That is what lets a second one use it unchanged.
const { configPath, platform, projectConfigPath } = await import("./platform.mjs");

// opencode's config is officially JSONC: comments and trailing commas are legal
// in a file a human is expected to edit. Strict JSON.parse on that file reports a
// perfectly good config as broken, and the failure is confusing in the worst way
// - the error points at a comment, not at anything actually wrong. The same
// problem hits every command that reads a project config, which is the file
// people are most likely to have annotated.
function stripJsonc(src) {
  let out = "";
  let inStr = false;
  let q = "";        // which quote character opened the string we are inside
  let esc = false;   // the previous character was a backslash
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === q) { inStr = false; q = ""; }
      continue;
    }
    // A quote only opens a string if it is not inside a comment, which is why
    // comments are tested first.
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++; // land on the '/' so the loop's i++ steps past the pair
      continue;
    }
    out += c;
  }
  // Trailing commas: a comma may legally be followed by a comment or whitespace
  // and then the closing brace, which is not legal JSON.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// parseOrFail reads text that may be JSONC. It is deliberately separate from
// stripJsonc so callers can keep the original bytes for a rollback.
function parseOrFail(src, p, what) {
  try { return JSON.parse(stripJsonc(src)); }
  catch (e) {
    fail(`${what} at ${p} is not valid JSON or JSONC (${e.message}) - fix it by hand rather than losing it`, "config-invalid-json", { config: p });
  }
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
  return { config: parseOrFail(raw, p, "opencode config"), path: p };
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
  // V2 inverted this. The key is `disabled`, not `enabled`: a server stays in the
  // config with `disabled: true` and simply never connects. `enabled` does not
  // exist in V2, and audit() reports it as an unknown key precisely because
  // reading it here reported every server as live when it was not.
  const on = s?.disabled !== true;
  const hasHeaders = s?.headers != null && Object.keys(s.headers).length > 0;
  const urlQuery = type === "remote" && s?.url ? /[?&](token|key|apikey|api_key|access_token|password)=/i.test(s.url) : false;
  return {
    name,
    owner: requiredServers().includes(name) ? "bundle" : "user",
    type,
    state: on ? "enabled" : "disabled",
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
  // No hardcoded default. Handshaking a server this machine does not have is a
  // failure that looks like a broken install, so with no --name we pick from the
  // declared requirements intersected with what is actually configured, and say
  // so plainly when neither is usable.
  const configured = config?.mcp?.servers ?? {};
  const declared = requiredServers();
  const name = get("--name") || declared.find((n) => configured[n]) || declared[0];
  if (!name)
    fail(`no server to handshake: this bundle declares ${declared.length ? declared.join(", ") : "(none)"}, ` +
      `and ${path} configures ${Object.keys(configured).length ? Object.keys(configured).sort().join(", ") : "(none)"}. ` +
      `pass --name <server>, or add one to config/mcp-requirements.json if the factory should depend on it.`,
      "no-target-server", { declared, configured: Object.keys(configured).sort(), config: path });
  const server = config?.mcp?.servers?.[name];
  if (!server) {
    fail(`no MCP server named "${name}" in ${path}`, "server-absent", { server: name, configured: Object.keys(config?.mcp?.servers ?? {}) });
  }
  if (server.disabled === true) {
    fail(`MCP server "${name}" has disabled=true in the config; it is configured but never connects, so it cannot serve`, "server-disabled", { server: name, state: "disabled" });
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
// Keys the live schema accepts, per server type. Taken from
// https://opencode.ai/config.json (McpLocalConfig / McpRemoteConfig), both of
// which set additionalProperties:false - so an unlisted key is not "ignored,
// harmless", it is a claim the file makes that nothing honours.
//
// `disabled` is the one that has actually bitten. It looks like the inverse of
// `enabled`, opencode has no such key, and a server carrying `disabled: true`
// therefore RUNS. On this machine (found 2026-10-10) five servers the operator
// believed were off were enabled on every session: the config asserted an off
// switch that does not exist. Both installers had been writing `disabled`
// while this script correctly read and wrote `enabled`, so our own handshake
// reported "enabled" and agreed with opencode - the fault was upstream of both.
const MCP_KEYS = {
  local: new Set(["type", "command", "cwd", "environment", "disabled", "timeout", "codemode", "protocol"]),
  remote: new Set(["type", "url", "disabled", "headers", "oauth", "timeout", "codemode", "protocol"]),
  // A `{disabled: bool}` entry on its own is legal too - but note that a higher
  // precedence project config REPLACES the whole server object, so a project
  // override that carries only `disabled` also drops the command or url.
  toggle: new Set(["disabled"]),
};

function unknownMcpKeys(s) {
  if (s == null || typeof s !== "object" || Array.isArray(s)) return [];
  // Pick the widest allowance that fits, so a local server that also carries a
  // stray key is judged as local rather than as the toggle shorthand.
  const allowed = MCP_KEYS[s.type === "remote" ? "remote" : "local"];
  return Object.keys(s).filter((k) => !allowed.has(k) && !MCP_KEYS.toggle.has(k));
}

// V2 vocabulary, defined once.
//
// opencode's config uses `disabled`, not `enabled`: a server carrying
// `disabled: true` is configured but never connects. Everything above this line
// speaks "enabled" because that is the sentence we want to write out; the file
// on disk only ever sees "disabled". Concentrating the inversion here is what
// stops the two vocabularies drifting apart in twenty places, which is exactly
// how the previous version ended up configuring a key opencode ignores.
//
// The absent case is NOT "disabled": the key defaults to false, so a server
// with no `disabled` key connects. Reading it as absent-equals-true is what
// made five servers the operator believed were off keep starting.
const isOn = (s) => s?.disabled !== true;

// true when the entry states its state, false when it does not. null is a real
// answer here: an unrecorded server inherits global, and "inherits" is not the
// same as "recorded as on".
const stated = (s) => (s && typeof s === "object" && typeof s.disabled === "boolean" ? !s.disabled : null);

// V2 replaces the whole server object when a project config names a server that
// a global config already defines. So a project override that carries only
// `disabled` deletes the `command`/`url` and leaves a server that cannot
// start. Every write copies a complete definition.
const fullDef = (override, global) =>
  override && typeof override === "object" && override.type ? override
  : global && typeof global === "object" ? global
  : {};

function audit() {
  const { config, path } = loadConfig();
  const servers = config?.mcp?.servers;
  if (servers == null || typeof servers !== "object" || Array.isArray(servers)) {
    fail(`no mcp.servers object in ${path}; there is nothing to audit`, "no-servers-object", { config: path });
  }
  const inventory = Object.entries(servers).map(([n, s]) => describe(n, s ?? {}));
  const enabled = inventory.filter((s) => s.state === "enabled");
  const unverified = enabled.filter((s) => s.owner === "user");
  // An unknown key is worse than a typo: it is silently dropped, so the config
  // can claim a server is off while opencode runs it. Loud is the only safe
  // response - the factory never edits the user's servers, so the operator must.
  const ignored = Object.entries(servers)
    .map(([n, s]) => ({ name: n, keys: unknownMcpKeys(s) }))
    .filter((x) => x.keys.length > 0);
  // The detail lives IN the payload, not in a later fail() call. An earlier
  // version printed the payload and returned under --json, so the one mode a
  // script actually parses lost the stage and the fix while still exiting
  // non-zero - a verdict with nothing to act on. A negative result that does
  // not say what to do is the guard-without-effect shape again.
  const detail = ignored.length === 0 ? null :
    `config ${path} sets keys opencode's schema does not define, so they have no effect: ${ignored.map((x) => `${x.name} -> ${x.keys.join(", ")}`).join("; ")}. ` +
    `opencode's config uses "disabled", not "enabled": a server carrying disabled:true is configured and never connects. ` +
    `Remove the unknown keys and set "disabled": true to actually stop a server. This audit never edits your config.`;
  const payload = {
    ok: ignored.length === 0, config: displayPath(path), total: inventory.length, enabled: enabled.length,
    servers: inventory,
    unverifiedEnabled: unverified.map((s) => s.name),
    ignoredKeys: ignored,
    ...(detail ? { stage: "unknown-mcp-keys", error: detail } : {}),
    note: detail
      ? `keys the live schema does not define are ignored by opencode, so the config may claim a state that never happens: ${ignored.map((x) => `${x.name}(${x.keys.join(",")})`).join("; ")}. The schema accepts "disabled"; an "enabled" key has no effect.`
      : unverified.length > 0
        ? "these enabled servers are the user's own; the factory audits them and never installs, edits, or disables them"
        : "no user-owned MCP server is enabled",
  };
  if (has("--json")) { out(payload); if (!payload.ok) process.exitCode = 1; return; }
  say(`mcp: ${payload.enabled}/${payload.total} server(s) enabled, config ${path}`);
  for (const s of inventory) {
    const mark = s.owner === "bundle" ? "*" : " ";
    say(`  ${mark} ${s.name.padEnd(18)} ${s.type.padEnd(6)} ${s.state.padEnd(8)} ${s.target}${s.needsCredential ? "  [needs credential]" : ""}`);
  }
  say("  * bundle-owned");
  if (unverified.length) say(`unverified by any check: ${unverified.map((s) => s.name).join(", ")}`);
  out(payload);
  if (detail) {
    // Exits non-zero, and says why on stderr so it is visible even when the
    // payload above is long. Every health check we have reported this machine
    // healthy while five "disabled" servers were running, so silence is the bug.
    console.error(detail);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- enable/disable
// Flips `mcp.<server>.enabled` on ONE server in THIS PROJECT's opencode.json,
// never the global one. Project config has the highest precedence of the
// standard files and merges rather than replaces, so this changes the checkout
// you are in and nothing else. A global toggle would switch servers on and off
// for every project on the machine including ones somebody is working in right
// now - which is the reason this scope exists, not a preference.
//
// The key is `enabled`, verified against https://opencode.ai/config.json (the
// schema's mcp properties list `enabled` and nothing else). An earlier version
// wrote `disabled`, reported success, exited 0, and changed nothing: it wrote a
// key the harness does not recognise. The 21 tests that passed against it were
// testing my assumption rather than the schema, which is the defect this bundle
// has been fixing all along, committed here instead.
//
// Deliberately NOT a general config editor: it touches exactly one boolean on
// exactly one named server. A command that could add servers would need to
// decide ownership, credentials and blast radius, and `audit` is where that
// judgement belongs. Nothing here prints a header value or a remote URL beyond
// what safeUrl already strips.
function toggle() {
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (VALUE_FLAGS.has(argv[i])) i++; // skip this flag's value
      continue;
    }
    positional.push(argv[i]);
  }
  const name = get("--name") || positional[0];
  if (which !== "enable" && which !== "disable")
    fail("usage: factory-mcp.mjs enable|disable <server>", "usage", {});
  if (!name) fail("which server? name it, or pass --name <server>", "usage", {});

  // Read the GLOBAL config to answer "is this server defined, and is it on
  // right now" - that is where definitions live. Write the PROJECT config to
  // change it. Those are deliberately different files, and conflating them is
  // how this command ended up editing every project on the machine.
  const { config, path: globalPath } = loadConfig();
  const servers = config.mcp && config.mcp.servers;
  if (!servers || typeof servers !== "object")
    fail(`no mcp.servers in ${displayPath(globalPath)}`, "no-servers-object", { config: globalPath });
  const s = servers[name];
  if (!s || typeof s !== "object") {
    const have = Object.keys(servers).sort().join(", ") || "(none)";
    fail(`no server named "${name}". configured: ${have}`, "server-absent", { config: globalPath });
  }

  // Effective state = the project override if there is one, else the global.
  // Overriding to the same value it already has is not "no change", because the
  // global may disagree - that is the whole reason this command exists.
  const target = projectConfigPath();
  if (!target)
    fail("no project found (no .git above this directory) - refusing to write a global config, " +
      "which would change every project on the machine", "no-project", { cwd: process.cwd() });
  const projectRaw = existsSync(target) ? readFileSync(target, "utf8") : "{}";
  let projectCfg;
  try {
    projectCfg = parseOrFail(projectRaw, target, "opencode config");
  } catch (e) {
    fail(`${displayPath(target)} is not valid JSON (${e.message}) - fix it by hand rather than losing it`, "config-invalid-json", { config: target });
  }
  const override = projectCfg.mcp && projectCfg.mcp.servers && projectCfg.mcp.servers[name];
  const recorded = stated(override);
  const current = recorded === null ? isOn(s) : recorded;

  const want = which === "enable";

  if (current === want) {
    say(`mcp ${name} is already ${which}d (no change)`);
    out({ ok: true, changed: false, scope: "project", server: name, enabled: want, disabled: !want, config: target, globalUntouched: globalPath });
    return;
  }

  if (has("--dry-run")) {
    say(`mcp ${name}: would set disabled=${!want} (${want ? "enabled" : "disabled"}) for THIS PROJECT in ${displayPath(target)}`);
    out({ ok: true, changed: false, dryRun: true, scope: "project", server: name, enabled: want, disabled: !want, config: target, globalUntouched: globalPath });
    return;
  }

  // Rebuild rather than patch a string: a half-applied edit to a user's config
  // is the worst outcome available, and JSON round-tripping cannot produce one.
  const before = projectRaw;
  const next = parseOrFail(before, target, "opencode config");
  next.mcp = next.mcp || {};
  next.mcp.servers = next.mcp.servers || {};
  // A complete definition, not a partial merge: V2 replaces the whole server
  // object when a project config names a server a global config defines, so an
  // override carrying only `disabled` would delete command/url and leave a
  // server that cannot start. A project file may also legitimately carry the
  // whole definition for a server that exists nowhere else, so the project
  // entry wins when it has one.
  next.mcp.servers[name] = { ...fullDef(override, s), disabled: !want };
  writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8");

  // Re-read and re-parse. A write that cannot be read back is not a write, and
  // "I think it saved" is exactly the class of claim this repo keeps refusing.
  let verify;
  try {
    verify = parseOrFail(readFileSync(target, "utf8"), target, "opencode config");
  } catch (e) {
    if (before === "{}") rmSync(target, { force: true });
    else writeFileSync(target, before, "utf8"); // roll back a config we cannot parse
    fail(`wrote ${name} but could not re-read the config (${e.message}); original restored`, "write-unreadable", { config: target });
  }
  const got = verify.mcp && verify.mcp.servers && verify.mcp.servers[name];
  if (!got || got.disabled !== !want) {
    if (before === "{}") rmSync(target, { force: true });
    else writeFileSync(target, before, "utf8");
    fail(`wrote ${name} but the file does not read back as disabled=${!want}; original restored`, "write-unverified", { config: target });
  }

  say(`mcp ${name} ${which}d (disabled=${!want}) for THIS PROJECT in ${displayPath(target)}`);
  say(`  global config untouched - other projects are unaffected`);
  // OpenCode reads its config at startup, so a toggle that appears to work and
  // silently does not is worse than one that says when it will take effect.
  say(platform().reloadHint(displayPath(target)));
  out({ ok: true, changed: true, scope: "project", server: name, enabled: want, disabled: !want, config: target, globalUntouched: globalPath, restartRequired: true });
}

// scope: the start/resume behaviour. Everything not on the allowlist is turned
// off FOR THIS PROJECT, and everything on it is turned on, so the project's
// server set is written down rather than inherited from whatever global happens
// to say today. Writing the allowlisted servers too is deliberate: a project
// that only records the negatives is one global drift can change under it.
function scope() {
  const { config, path: globalPath } = loadConfig();
  const servers = config.mcp && config.mcp.servers;
  if (!servers || typeof servers !== "object")
    fail(`no mcp.servers in ${displayPath(globalPath)}`, "no-servers-object", { config: globalPath });
  const names = Object.keys(servers).sort();

  // Two different questions, and they must fail differently.
  //
  //   --allow <list>  the operator typed it just now. A typo would silently
  //                   disable the very server it was meant to protect, so an
  //                   unknown name here is a refusal.
  //   declared        the bundle's own requirement, read from
  //                   config/mcp-requirements.json. A machine is allowed not to
  //                   have one of these, so an entry that is not configured is
  //                   reported and skipped, never fatal.
  //
  // Nothing here names a server. That is what lets this run on a laptop with a
  // different toolchain, or on a machine where the factory depends on no MCP at
  // all - in which case every configured server is simply turned off here.
  const declared = requiredServers();
  const explicit = has("--allow");
  const allow = new Set((explicit ? get("--allow") : declared.join(",")).split(",").map((x) => x.trim()).filter(Boolean));
  const unknown = [...allow].filter((n) => !servers[n]).sort();
  if (unknown.length && explicit)
    fail(`--allow names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not" : "are not"} configured in ${displayPath(globalPath)}. configured: ${names.join(", ") || "(none)"}`, "allow-unknown", { unknown, configured: names, config: globalPath });
  if (unknown.length)
    say(`declared but not configured here, leaving them out: ${unknown.join(", ")}`);
  for (const n of unknown) allow.delete(n);

  const target = projectConfigPath();
  if (!target)
    fail("no project found (no .git above this directory) - refusing to write a global config, " +
      "which would change every project on the machine", "no-project", { cwd: process.cwd() });
  const projectRaw = existsSync(target) ? readFileSync(target, "utf8") : "{}";
  let projectCfg;
  try {
    projectCfg = parseOrFail(projectRaw, target, "opencode config");
  } catch (e) {
    fail(`${displayPath(target)} is not valid JSON (${e.message}) - fix it by hand rather than losing it`, "config-invalid-json", { config: target });
  }

  const plan = names.map((name) => {
    const override = projectCfg.mcp && projectCfg.mcp.servers && projectCfg.mcp.servers[name];
    const recorded = stated(override);
    const current = recorded === null ? isOn(servers[name]) : recorded;
    const want = allow.has(name);
    // An allowlisted server is recorded even when it already agrees with global,
    // so the project's server set is stated rather than inherited from whatever
    // global says today. Recording it once is a change; re-recording it is not,
    // so this stays idempotent rather than rewriting the same bytes forever.
    return { name, current, want, recorded, change: current !== want || (want && recorded === null), override };
  });

  const todo = plan.filter((p) => p.change);
  // current === want but allowed: recorded anyway, and reported as such.
  if (has("--dry-run")) {
    for (const p of plan) say(`  ${p.name}: disabled=${!p.current} -> ${!p.want} (${p.current ? "enabled" : "disabled"})${p.change ? "" : " (already correct)"}${p.current === p.want ? " (recorded)" : ""}`);
    say(`scope: would set ${todo.length} of ${names.length} server(s) for THIS PROJECT in ${displayPath(target)}`);
    out({ ok: true, changed: false, dryRun: true, scope: "project", config: target, globalUntouched: globalPath, allow: [...allow], servers: plan });
    return;
  }
  if (!todo.length) {
    say(`scope: all ${names.length} configured server(s) already correct for THIS PROJECT (no change)`);
    out({ ok: true, changed: false, scope: "project", config: target, globalUntouched: globalPath, allow: [...allow], servers: plan });
    return;
  }

  const before = projectRaw;
  const next = parseOrFail(before, target, "opencode config");
  next.mcp = next.mcp || {};
  next.mcp.servers = next.mcp.servers || {};
  // A full definition per server, for the same reason as toggle: V2 replaces the
  // whole object, so a bare {disabled} override would strip command/url.
  for (const p of todo) next.mcp.servers[p.name] = { ...fullDef(p.override, servers[p.name]), disabled: !p.want };
  writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8");

  // Same rule as toggle: a write that cannot be read back is not a write. A
  // partial scope is worse than none - it looks deliberate and is not.
  const rollback = () => { if (before === "{}") rmSync(target, { force: true }); else writeFileSync(target, before, "utf8"); };
  let verify;
  try {
    verify = parseOrFail(readFileSync(target, "utf8"), target, "opencode config");
  } catch (e) {
    rollback();
    fail(`wrote ${todo.length} override(s) but could not re-read the config (${e.message}); original restored`, "write-unreadable", { config: target });
  }
  for (const p of todo) {
    const got = verify.mcp && verify.mcp.servers && verify.mcp.servers[p.name];
    if (!got || got.disabled !== !p.want) {
      rollback();
      fail(`wrote ${p.name} disabled=${!p.want} but the file does not read back that way; ALL ${todo.length} changes reverted`, "write-unverified", { config: target, server: p.name });
    }
  }

  for (const p of todo) say(`  ${p.name}: disabled=${!p.current} -> ${!p.want} (${p.current ? "enabled" : "disabled"})${p.current === p.want ? " (recorded; already on)" : ""}`);
  say(`scope: set ${todo.length} of ${names.length} configured server(s) for THIS PROJECT in ${displayPath(target)}`);
  say(`  allowed: ${[...allow].join(", ")}`);
  say(`  global config untouched - other projects are unaffected`);
  say(platform().reloadHint(displayPath(target)));
  out({ ok: true, declared: requiredServers(), declaredButAbsent: unknown, changed: true, scope: "project", config: target, globalUntouched: globalPath, allow: [...allow], servers: plan, changed_servers: todo.map((p) => p.name), disabled: todo.map((p) => !p.want), restartRequired: true });
}

// ---------------------------------------------------------------- search ---
// The one rule in this file that must not be "tidied up": a failed lookup must
// never look like an empty answer. mcpm.sh catches the request error and
// returns its (empty) cache; search then prints "No matching MCP servers found."
// and exits 0. An agent that believes that tells its user the server does not
// exist, which is worse than not looking at all. So every path below that
// cannot reach the registry calls fail() with a stage and exits non-zero.

  const which = argv[0];
  // The name is whatever positional follows the verb and is not a flag's value.
  // Taking argv[1] blindly breaks the obvious invocation `enable chrome-devtools
  // --config <path>`, because argv[1] is the verb and argv[2] is the name but a
  // flag placed between them shifts both. Walk the args instead.

const NEWLINE_TAIL = String.fromCharCode(10);
const DEFAULT_REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const DEFAULT_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 60 * 60 * 1000; // the one genuinely good idea from mcpm.sh

function registryTimeout() {
  const t = Number(get("--timeout"));
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;
}

function registryUrl() {
  const flag = get("--registry");
  if (flag) return flag;
  const f = join(BUNDLE_DIR, "config", "registry.json");
  if (existsSync(f)) {
    const c = parseOrFail(readFileSync(f, "utf8"), f, "registry config");
    if (c && typeof c.url === "string" && c.url) return c.url;
  }
  return DEFAULT_REGISTRY;
}

// Cache is keyed per query, not per registry: a cache holding one query's
// results and being handed to a different query would answer the wrong question
// with a confident-looking file. One file per question, 1-hour TTL.
function cacheFile(url, q) {
  const h = createHash("sha1").update(url + "\n" + q).digest("hex").slice(0, 16);
  return join(homedir(), ".cache", "factory", "mcp-registry", `${h}.json`);
}

function readCache(url, q) {
  const p = cacheFile(url, q);
  try {
    if (!existsSync(p)) return null;
    const c = JSON.parse(readFileSync(p, "utf8"));
    if (typeof c.fetchedAt !== "number" || Date.now() - c.fetchedAt > CACHE_TTL_MS) return null;
    return c.payload;
  } catch { return null; }
}

function writeCache(url, q, payload) {
  const p = cacheFile(url, q);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), url, query: q, payload }), "utf8");
  } catch { /* a cache we cannot write is an inconvenience, not a failure */ }
}

async function fetchRegistry(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let body, err = null;
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (r.ok) body = await r.json();
    else err = `HTTP ${r.status}`;
  } catch (e) { err = e.message || String(e); }
  finally { clearTimeout(t); }
  if (err) fail(`registry unreachable or unusable (${err}) - ${url}. Nothing was searched; ` +
    "this is not the same as no server matching", "registry-unreachable", { url, error: String(err) });
  if (body === undefined) fail(`registry returned no JSON - ${url}`, "registry-unreachable", { url });
  return body;
}

// The official API nests the manifest under `.server` and keeps `_meta` beside
// it, so anything reading entry.name directly gets undefined and treats every
// server as nameless. `packages` is optional and absent on remote-only entries,
// which is why this guards instead of indexing.
function flattenServer(entry) {
  const s = entry && typeof entry === "object" && entry.server ? entry.server : (entry || {});
  const name = typeof s.name === "string" ? s.name : (typeof s.displayName === "string" ? s.displayName : "");
  const remotes = Array.isArray(s.remotes) ? s.remotes : [];
  const packages = Array.isArray(s.packages) ? s.packages : [];
  // Names are namespaced upstream (ai.getvda/kafka-and-postgres-monitoring-stack);
  // the opencode config key has to be the last segment or the name is unwieldy
  // and, worse, differs from what `add` would later be asked to remove.
  const slash = name.lastIndexOf("/");
  return {
    name,
    key: slash === -1 ? name : name.slice(slash + 1),
    description: typeof s.description === "string" ? s.description : "",
    version: typeof s.version === "string" ? s.version : null,
    local: packages.length > 0,
    remote: remotes.length > 0,
    pkg: packages.find((x) => x && x.identifier) || packages.find((x) => x && x.runtimeHint) || null,
    rem: remotes.find((x) => x && x.url) || null,
    requiredEnv: collectRequiredEnv(s, remotes, packages),
  };
}

// The registry lists credentials as bare strings OR as objects, and marks some
// optional. Demanding an optional one refuses installs that would work; missing
// a required one writes an entry that looks installed and dies at first use.
function collectRequiredEnv(s, remotes, packages) {
  const names = new Set();
  const collect = (list) => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (typeof e === "string") { if (e) names.add(e); continue; }
      if (e && typeof e === "object") {
        if (e.isRequired === false) continue;
        const n = e.name || e.key;
        if (typeof n === "string" && n) names.add(n);
      }
    }
  };
  collect(s.environmentVariables);
  for (const r of remotes) if (r && typeof r === "object") collect(r.environmentVariables);
  for (const k of packages) if (k && typeof k === "object") collect(k.environmentVariables);
  return [...names].sort();
}

// The registry does not rank (two identical queries returned different first
// results minutes apart), so this ranking is ours and is labelled as such.
function rank(s, needle) {
  const k = s.key.toLowerCase(), d = s.description.toLowerCase();
  if (k === needle) return 0;
  if (k.startsWith(needle)) return 1;
  if (k.includes(needle)) return 2;
  if (d.includes(needle)) return 3;
  return 4;
}

async function search() {
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { if (VALUE_FLAGS.has(argv[i])) i++; continue; }
    positional.push(argv[i]);
  }
  const q = get("--query") || positional[0];
  if (!q) fail("usage: factory-mcp.mjs search <query> [--limit N] [--refresh] [--offline]", "usage", {});
  const rawLimit = get("--limit");
  const limit = rawLimit === undefined ? 10 : Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0)
    fail(`--limit must be a positive number (got "${rawLimit}")`, "usage", {});

  const url = registryUrl();
  const sep = url.includes("?") ? "&" : "?";
  let payload = null, fromCache = false;

  if (has("--offline")) {
    payload = readCache(url, q);
    if (!payload) fail(`--offline and no cached answer for "${q}" (${cacheFile(url, q)}) - ` +
      "run once without --offline, or allow network", "registry-unreachable", { url, query: q });
    fromCache = true;
  } else {
    const cached = has("--refresh") ? null : readCache(url, q);
    if (cached) { payload = cached; fromCache = true; }
    else payload = await fetchRegistry(`${url}${sep}search=${encodeURIComponent(q)}&limit=100`,
      Number(get("--timeout") || DEFAULT_TIMEOUT));
  }
  if (!fromCache) writeCache(url, q, payload);

  const rows = payload && Array.isArray(payload.servers) ? payload.servers
    : (Array.isArray(payload) ? payload : null);
  if (!rows) fail(`registry response has no servers array (top-level keys: ` +
    `${payload && typeof payload === "object" ? Object.keys(payload).join(",") : typeof payload}) - ` +
    "the registry may have changed shape; refusing to report zero matches", "registry-shape", { url });

  const needle = q.toLowerCase();
  const all = collapse(rows.map(flattenServer).filter((s) => s.name));
  const hits = all
    .filter((s) => s.key.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle)
      || s.description.toLowerCase().includes(needle))
    .sort((a, b) => rank(a, needle) - rank(b, needle) || a.key.localeCompare(b.key));
  const shown = hits.slice(0, limit);
  const atCap = rows.length >= 100;

  if (!shown.length) {
    // Reached the registry and it really had nothing. Still non-zero: "I found
    // nothing" and "I could not look" should not share an exit code.
    say(`no server in the registry matches "${q}" (looked at ${all.length} returned entries; ranking is ours, not the registry's)`);
    out({ ok: true, query: q, count: 0, examined: all.length, results: [], registry: url, cached: fromCache, truncated: atCap });
    return;
  }
  for (const s of shown) {
    const how = [s.local ? "local" : null, s.remote ? "remote" : null].filter(Boolean).join("+") || "NO TARGET";
    say(`${s.key}  [${how}]${s.version ? "  v" + s.version : ""}`);
    if (s.description) say(`    ${s.description.split("\n")[0].slice(0, 160)}`);
    say(`    registry name: ${s.name}`);
  }
  if (hits.length > shown.length) say(`  ... ${hits.length - shown.length} more (raise --limit)`);
  // Say so rather than let "10 of 10" read as "there are 10".
  if (atCap) say(`  note: the registry page cap was hit (${rows.length} rows examined) - there may be more matches off this page`);
  out({ ok: true, query: q, count: shown.length, total_matches: hits.length, examined: all.length,
        registry: url, cached: fromCache, ranking: "local", truncated: atCap, results: shown });
}

// The registry lists EVERY version as its own entry, so "github" comes back as
// v1.0.3, v1.0.4 and v1.0.6 with the same name. Printed raw that is three
// identical-looking lines, and `add <name>` is ambiguous about which one it
// means. Collapse to one entry per config key, keeping the highest version.
function vnum(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [+m[1], +m[2], +m[3]] : null;
}
// Compares whole entries, not version strings: the caller spreads the winner,
// and spreading a string yields an object of characters that happens to survive
// until something downstream reads a property that is not there.
function newer(a, b) {
  const x = vnum(a.version), y = vnum(b.version);
  if (!x) return b;
  if (!y) return a;
  for (let i = 0; i < 3; i++) {
    // Equal components must be SKIPPED, not decided on. Returning on the first
    // pair makes 1.0.9 lose to 1.0.5 because 1 > 1 is false - the comparison
    // has to walk to the component that actually differs.
    if (x[i] === y[i]) continue;
    return x[i] > y[i] ? a : b;
  }
  return a;
}
function collapse(list) {
  const best = new Map();
  for (const s of list) {
    const prev = best.get(s.key);
    best.set(s.key, prev ? { ...newer(prev, s), local: prev.local || s.local, remote: prev.remote || s.remote,
           pkg: s.pkg || prev.pkg, rem: s.rem || prev.rem } : s);
  }
  return [...best.values()];
}

// A write that reads back is not the same as a write that reads back
// CORRECTLY. opencode ignores an entry whose shape it does not recognise, so
// presence alone is not evidence - the definition is compared in full.
// Exported so the suite can drive it with pairs that a real write cannot produce.


async function add() {
  // Every refusal below is the same failure: a config that looks installed and
  // is not. None of them writes anything, and none of them says "done".
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { if (VALUE_FLAGS.has(argv[i])) i++; continue; }
    positional.push(argv[i]);
  }
  const want = get("--name") || positional[0];
  if (!want) fail("usage: factory-mcp.mjs add <registry-name>", "usage", {});

  const url = registryUrl();
  // Keyed on the exact name, not a query: search collapses versions because a
  // human chooses; here the caller named one, so a second parser that disagreed
  // with search about what the registry said would be the bug.
  const ck = "add:" + want;
  // Ask the registry FOR this server by name. Fetching unfiltered and scanning the
  // reply looks equivalent and is not: an unfiltered request comes back as some
  // arbitrary default page, so a name `search` just found is not in it and every
  // real install refuses with not-found. The live registry proved that; a fixture
  // which filters every request hides it completely.
  const term = want.includes("/") ? want.slice(want.lastIndexOf("/") + 1) : want;
  const fetchUrl = url + (url.includes("?") ? "&" : "?") + "search=" + encodeURIComponent(term) + "&limit=100";
  let rows = has("--refresh") ? null : readCache(fetchUrl, ck);
  let cached = true;
  if (!rows) { rows = (await fetchRegistry(fetchUrl, registryTimeout())).servers; writeCache(fetchUrl, ck, rows); cached = false; }
  if (!Array.isArray(rows)) fail("registry did not return a list of servers", "registry-shape", { url });
  const flat = rows.map(flattenServer);
  // filter, not find: a namespaced name appears once per published version, and
  // taking only the first would silently discard the newest version and any remote
  // endpoint that only an older one shipped.
  const byExact = flat.filter((s) => s.name === want);
  const matches = byExact.length ? byExact : flat.filter((s) => s.key === want);
  if (!matches.length) {
    const offered = [...new Set(flat.map((s) => s.key))].slice(0, 5);
    fail(`no server named "${want}" in the registry. this page offers: ${offered.join(", ") || "(none)"}`,
      "not-found", { name: want, offered });
  }
  const best = collapse(matches)[0];
  const key = get("--key") || best.key;
  if (!/^[A-Za-z0-9._-]+$/.test(key))
    fail(`"${key}" is not usable as a config key - opencode reads it as a property name` +
      ` (letters, digits, dot, underscore, hyphen only)`, "bad-key", { key });

  const rem = best.rem;
  const pkg = best.pkg;
  if (!pkg && !rem)
    fail(`${want} has no runnable target - the registry lists neither a package nor a remote`,
      "no-target", { name: want });
  if (has("--remote") && !rem)
    fail(`${want} has no remote endpoint; it only ships a local package`, "no-target", { name: want });
  // Local when a package exists, remote when it does not. --remote only forces
  // the choice; without it a remote-only server must not fall into the local branch
  // and dereference a package that was never there.
  const useRemote = has("--remote") || !pkg;

  // No placeholder token is ever written. An entry with an empty credential
  // looks installed and fails the first time it is used.
  const env = {};
  for (let i = 1; i < argv.length; i++)
    if (argv[i] === "--env" && argv[i + 1]) {
      const eq = argv[i + 1].indexOf("=");
      if (eq > 0) env[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
      i++;
    }
  const missing = (best.requiredEnv || []).filter((n) => !(n in env));
  if (missing.length)
    fail(`${want} needs ${missing.join(", ")} - supply with --env NAME=value. A placeholder` +
      ` would produce an entry that looks installed and fails at first use.`,
      "credential-required", { name: want, missing });

  const def = useRemote
    ? { type: "remote", url: rem.url, headers: {}, disabled: false }
    : { type: "local", command: ["npx", "-y", pkg.identifier], disabled: false };
  if (Object.keys(env).length) def.environment = env;

  const target = projectConfigPath();
  if (!target)
    fail("no project found (no .git above this directory) - refusing to write a global config, " +
      "which would change every project on the machine", "no-project", { cwd: process.cwd() });
  const projectRaw = existsSync(target) ? readFileSync(target, "utf8") : "{}";
  const projectCfg = parseOrFail(projectRaw, target, "project config");
  const existing = projectCfg.mcp && projectCfg.mcp.servers && projectCfg.mcp.servers[key];
  if (existing && typeof existing === "object" && existing.command && existing.type && !has("--force"))
    fail(`"${key}" is already defined in ${displayPath(target)}; pass --force to replace it`,
      "already-defined", { key, config: target });

  if (has("--dry-run")) {
    say(`${key}: would write ${def.type} definition, disabled=false, to ${displayPath(target)}`);
    out({ ok: true, changed: false, dryRun: true, scope: "project", key, from: best.name,
      version: best.version, target: def.type, requiredEnv: best.requiredEnv || [], config: target });
    return;
  }

  const before = projectRaw;
  const next = JSON.parse(JSON.stringify(projectCfg));
  next.mcp = next.mcp || {};
  next.mcp.servers = next.mcp.servers || {};
  next.mcp.servers[key] = { ...(typeof existing === "object" ? existing : {}), ...def };
  const rollback = () => { if (before === "{}") rmSync(target, { force: true }); else writeFileSync(target, before, "utf8"); };
  writeFileSync(target, JSON.stringify(next, null, 2) + NEWLINE_TAIL, "utf8");

  // Deliberately NOT parseOrFail here: it fails on a bad parse, which would
  // throw straight past the rollback below and leave the damage in place.
  let verify;
  try { verify = JSON.parse(stripJsonc(readFileSync(target, "utf8"))); }
  catch (e) { rollback(); fail(`wrote ${key} but could not re-read the config (${e.message}); original restored`, "write-unreadable", { config: target }); }
  const got = verify.mcp && verify.mcp.servers && verify.mcp.servers[key];
  if (!defMatches(got, def)) {
    rollback();
    fail(`wrote ${key} but the file does not read back as the definition opencode needs; original restored`,
      "write-unverified", { config: target });
  }
  say(`${key} installed (${def.type}, ${best.name}${best.version ? " " + best.version : ""}) for THIS PROJECT in ${displayPath(target)}`);
  say(`  global config untouched - other projects are unaffected`);
  say(platform().reloadHint(displayPath(target)));
  out({ ok: true, changed: true, scope: "project", key, from: best.name, version: best.version,
    target: def.type, definition: def, config: target, cached, restartRequired: true });
}

const cmd = argv[0];
if (cmd === "handshake") await handshake();
else if (cmd === "audit") audit();
else if (cmd === "enable" || cmd === "disable") toggle();
else if (cmd === "scope") scope();
else if (cmd === "search") await search();
else if (cmd === "add") await add();
else {
  console.error("usage: factory-mcp.mjs handshake [--name <server>] [--requirements <file>] [--config <path>] [--timeout <ms>] [--quiet] [--json]");
  console.error("       factory-mcp.mjs audit    [--config <path>] [--requirements <file>] [--quiet] [--json]");
  console.error("       factory-mcp.mjs enable   <server> [--config <path>] [--dry-run] [--quiet] [--json]");
  console.error("       factory-mcp.mjs disable  <server> [--config <path>] [--dry-run] [--quiet] [--json]");
  console.error("       factory-mcp.mjs scope    [--allow a,b] [--requirements <file>] [--config <path>] [--dry-run] [--quiet] [--json]");
  console.error("       factory-mcp.mjs search   <query> [--limit N] [--registry <url>] [--refresh] [--offline] [--timeout <ms>] [--quiet] [--json]");
  process.exit(1);
}
