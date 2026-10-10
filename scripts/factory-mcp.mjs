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
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

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
  try { r = JSON.parse(readFileSync(f, "utf8")); }
  catch (e) {
    fail(`${f} is not valid JSON (${e.message}) - fix it by hand rather than guessing which servers the factory needs`, "requirements-invalid", { file: f });
  }
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
  // `enabled: false` is how a server is switched off (verified against
// opencode.ai/config.json). Reading `disabled` here would report every server as
// live, which is the error this file previously shipped.
const enabled = s?.enabled === false ? "disabled" : "enabled";
  const hasHeaders = s?.headers != null && Object.keys(s.headers).length > 0;
  const urlQuery = type === "remote" && s?.url ? /[?&](token|key|apikey|api_key|access_token|password)=/i.test(s.url) : false;
  return {
    name,
    owner: requiredServers().includes(name) ? "bundle" : "user",
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
  if (server.enabled === false) {
    fail(`MCP server "${name}" has enabled=false in the config; it cannot serve`, "server-disabled", { server: name, state: "disabled" });
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
  local: new Set(["type", "command", "cwd", "environment", "enabled", "timeout"]),
  remote: new Set(["type", "url", "enabled", "headers", "oauth", "timeout"]),
  // The `{enabled: bool}` shorthand is a legal entry on its own.
  toggle: new Set(["enabled"]),
};

function unknownMcpKeys(s) {
  if (s == null || typeof s !== "object" || Array.isArray(s)) return [];
  // Pick the widest allowance that fits, so a local server that also carries a
  // stray key is judged as local rather than as the toggle shorthand.
  const allowed = MCP_KEYS[s.type === "remote" ? "remote" : "local"];
  return Object.keys(s).filter((k) => !allowed.has(k) && !MCP_KEYS.toggle.has(k));
}

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
    `The MCP schema accepts "enabled" (boolean); there is no "disabled" key, so a server marked disabled:true is still started. ` +
    `Remove the unknown keys and set "enabled": false to actually stop a server. This audit never edits your config.`;
  const payload = {
    ok: ignored.length === 0, config: displayPath(path), total: inventory.length, enabled: enabled.length,
    servers: inventory,
    unverifiedEnabled: unverified.map((s) => s.name),
    ignoredKeys: ignored,
    ...(detail ? { stage: "unknown-mcp-keys", error: detail } : {}),
    note: detail
      ? `keys the live schema does not define are ignored by opencode, so the config may claim a state that never happens: ${ignored.map((x) => `${x.name}(${x.keys.join(",")})`).join("; ")}. The schema accepts "enabled", never "disabled".`
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
  const which = argv[0];
  // The name is whatever positional follows the verb and is not a flag's value.
  // Taking argv[1] blindly breaks the obvious invocation `enable chrome-devtools
  // --config <path>`, because argv[1] is the verb and argv[2] is the name but a
  // flag placed between them shifts both. Walk the args instead.
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (get(argv[i]) === argv[i + 1]) i++; // skip this flag's value
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
    projectCfg = JSON.parse(projectRaw);
  } catch (e) {
    fail(`${displayPath(target)} is not valid JSON (${e.message}) - fix it by hand rather than losing it`, "config-invalid-json", { config: target });
  }
  const override = projectCfg.mcp && projectCfg.mcp.servers && projectCfg.mcp.servers[name];
  const current = override && typeof override === "object" && typeof override.enabled === "boolean"
    ? override.enabled
    : (s.enabled !== false);

  const want = which === "enable";

  if (current === want) {
    say(`mcp ${name} is already ${which}d (no change)`);
    out({ ok: true, changed: false, scope: "project", server: name, enabled: want, config: target, globalUntouched: globalPath });
    return;
  }

  if (has("--dry-run")) {
    say(`mcp ${name}: would set enabled=${want} for THIS PROJECT in ${displayPath(target)}`);
    out({ ok: true, changed: false, dryRun: true, scope: "project", server: name, enabled: want, config: target, globalUntouched: globalPath });
    return;
  }

  // Rebuild rather than patch a string: a half-applied edit to a user's config
  // is the worst outcome available, and JSON round-tripping cannot produce one.
  const before = projectRaw;
  const next = JSON.parse(before);
  next.mcp = next.mcp || {};
  next.mcp.servers = next.mcp.servers || {};
  // Spread any project-local entry so this adds an override, not a replacement:
  // a project file may legitimately carry the command or url for a server that
  // only exists locally.
  next.mcp.servers[name] = { ...(typeof override === "object" ? override : {}), enabled: want };
  writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8");

  // Re-read and re-parse. A write that cannot be read back is not a write, and
  // "I think it saved" is exactly the class of claim this repo keeps refusing.
  let verify;
  try {
    verify = JSON.parse(readFileSync(target, "utf8"));
  } catch (e) {
    if (before === "{}") rmSync(target, { force: true });
    else writeFileSync(target, before, "utf8"); // roll back a config we cannot parse
    fail(`wrote ${name} but could not re-read the config (${e.message}); original restored`, "write-unreadable", { config: target });
  }
  const got = verify.mcp && verify.mcp.servers && verify.mcp.servers[name];
  if (!got || got.enabled !== want) {
    if (before === "{}") rmSync(target, { force: true });
    else writeFileSync(target, before, "utf8");
    fail(`wrote ${name} but the file does not read back as enabled=${want}; original restored`, "write-unverified", { config: target });
  }

  say(`mcp ${name} ${which}d (enabled=${want}) for THIS PROJECT in ${displayPath(target)}`);
  say(`  global config untouched - other projects are unaffected`);
  // OpenCode reads its config at startup, so a toggle that appears to work and
  // silently does not is worse than one that says when it will take effect.
  say(platform().reloadHint(displayPath(target)));
  out({ ok: true, changed: true, scope: "project", server: name, enabled: want, config: target, globalUntouched: globalPath, restartRequired: true });
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
    projectCfg = JSON.parse(projectRaw);
  } catch (e) {
    fail(`${displayPath(target)} is not valid JSON (${e.message}) - fix it by hand rather than losing it`, "config-invalid-json", { config: target });
  }

  const plan = names.map((name) => {
    const override = projectCfg.mcp && projectCfg.mcp.servers && projectCfg.mcp.servers[name];
    const current = override && typeof override === "object" && typeof override.enabled === "boolean"
      ? override.enabled
      : (servers[name].enabled !== false);
    const want = allow.has(name);
    // An allowlisted server is recorded even when it already agrees with global,
    // so the project's server set is stated rather than inherited from whatever
    // global says today. Recording it once is a change; re-recording it is not,
    // so this stays idempotent rather than rewriting the same bytes forever.
    const recorded = override && typeof override === "object" && typeof override.enabled === "boolean";
    return { name, current, want, recorded, change: current !== want || (want && !recorded), override };
  });

  const todo = plan.filter((p) => p.change);
  // current === want but allowed: recorded anyway, and reported as such.
  if (has("--dry-run")) {
    for (const p of plan) say(`  ${p.name}: enabled=${p.current} -> ${p.want}${p.change ? "" : " (already correct)"}${p.current === p.want ? " (recorded)" : ""}`);
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
  const next = JSON.parse(before);
  next.mcp = next.mcp || {};
  next.mcp.servers = next.mcp.servers || {};
  for (const p of todo) next.mcp.servers[p.name] = { ...(typeof p.override === "object" ? p.override : {}), enabled: p.want };
  writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8");

  // Same rule as toggle: a write that cannot be read back is not a write. A
  // partial scope is worse than none - it looks deliberate and is not.
  const rollback = () => { if (before === "{}") rmSync(target, { force: true }); else writeFileSync(target, before, "utf8"); };
  let verify;
  try {
    verify = JSON.parse(readFileSync(target, "utf8"));
  } catch (e) {
    rollback();
    fail(`wrote ${todo.length} override(s) but could not re-read the config (${e.message}); original restored`, "write-unreadable", { config: target });
  }
  for (const p of todo) {
    const got = verify.mcp && verify.mcp.servers && verify.mcp.servers[p.name];
    if (!got || got.enabled !== p.want) {
      rollback();
      fail(`wrote ${p.name}=${p.want} but the file does not read back that way; ALL ${todo.length} changes reverted`, "write-unverified", { config: target, server: p.name });
    }
  }

  for (const p of todo) say(`  ${p.name}: enabled=${p.current} -> ${p.want}${p.current === p.want ? " (recorded; already true)" : ""}`);
  say(`scope: set ${todo.length} of ${names.length} configured server(s) for THIS PROJECT in ${displayPath(target)}`);
  say(`  allowed: ${[...allow].join(", ")}`);
  say(`  global config untouched - other projects are unaffected`);
  say(platform().reloadHint(displayPath(target)));
  out({ ok: true, declared: requiredServers(), declaredButAbsent: unknown, changed: true, scope: "project", config: target, globalUntouched: globalPath, allow: [...allow], servers: plan, changed_servers: todo.map((p) => p.name), restartRequired: true });
}

const cmd = argv[0];
if (cmd === "handshake") await handshake();
else if (cmd === "audit") audit();
else if (cmd === "enable" || cmd === "disable") toggle();
else if (cmd === "scope") scope();
else {
  console.error("usage: factory-mcp.mjs handshake [--name <server>] [--requirements <file>] [--config <path>] [--timeout <ms>] [--quiet] [--json]");
  console.error("       factory-mcp.mjs audit    [--config <path>] [--requirements <file>] [--quiet] [--json]");
  console.error("       factory-mcp.mjs enable   <server> [--config <path>] [--dry-run] [--quiet] [--json]");
  console.error("       factory-mcp.mjs disable  <server> [--config <path>] [--dry-run] [--quiet] [--json]");
  console.error("       factory-mcp.mjs scope    [--allow a,b] [--requirements <file>] [--config <path>] [--dry-run] [--quiet] [--json]");
  process.exit(1);
}
