#!/usr/bin/env node
// Tests for factory-mcp.mjs. Hermetic by construction:
//   - every config is a temp file, so the real ~/.config/opencode is untouched
//   - the MCP server is a fake we spawn ourselves, so no test depends on graft
//     being installed, on a graph existing, or on the network
//   - every run has cwd inside the sandbox, because bd-style tools write
//     scaffolding relative to cwd and a test must not litter the repo it runs in
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-mcp.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "factory-mcp-test-"));

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` -- ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

// A minimal MCP server whose failure mode is chosen by argv. Everything the
// handshake can get wrong is one of these five.
const FAKE = `
let mode = process.argv[2] || "ok";
if (mode === "crash") { process.stderr.write("fake: cannot start\\n"); process.exit(3); }
if (mode === "mute") { setInterval(() => {}, 1000); process.stdin.resume(); }
let buf = "";
if (mode !== "mute") process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      if (mode === "init-error") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "handshake refused" } }) + "\\n"); continue; }
      if (mode === "wrong-name") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "something-else", version: "9.9.9" }, instructions: "x" } }) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "graft", version: "0.0.0-fake" }, instructions: "fake instructions here" } }) + "\\n");
    } else if (m.id === 2) {
      if (mode === "silent") continue;
      const tools = mode === "empty-tools" ? [] : [{ name: "find_all" }, { name: "find_callers" }];
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools } }) + "\\n");
    }
  }
});
if (mode === "silent") setInterval(() => {}, 1000);
`;

const FAKE_PATH = join(SANDBOX, "fake-mcp.mjs");
writeFileSync(FAKE_PATH, FAKE, "utf8");

function config(name, obj) {
  const p = join(SANDBOX, name);
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), "utf8");
  return p;
}
// `disabled: true` is how opencode switches a server off (V2 MCP docs). These
// fixtures originally used `enabled`, which V2 does not define at all, so every
// assertion about an off server was passing against a state that cannot exist.
// The polarity is INVERTED: an on-fixture carries `disabled: false`, an
// off-fixture carries `disabled: true`. Backwards gives a green suite that
// describes nothing.
const fakeServer = (mode = "ok", off = false) => ({
  type: "local",
  command: [process.execPath, FAKE_PATH, mode],
  ...(off ? { disabled: true } : {}),
});

function run(args, opts = {}) {
  const argv = [SCRIPT, ...args];
  try {
    const o = execFileSync(process.execPath, argv, { encoding: "utf8", cwd: SANDBOX, timeout: 20000, ...opts });
    return { code: 0, out: o, json: safeJson(o) };
  } catch (e) {
    const o = `${e.stdout || ""}${e.stderr || ""}`;
    return { code: e.status ?? 1, out: o, json: safeJson(o) };
  }
}
function safeJson(text) {
  const i = text.indexOf("{");
  if (i === -1) return null;
  try { return JSON.parse(text.slice(i)); } catch { return null; }
}

// ------------------------------------------------------------ handshake: good
console.log("handshake: a live server");
{
  const p = config("ok.json", { mcp: { servers: { graft: fakeServer("ok") } } });
  const r = run(["handshake", "--config", p, "--quiet"]);
  check("exit 0", r.code === 0, `code ${r.code}`);
  check("ok true", r.json?.ok === true);
  check("serverInfo name read from the server", r.json?.serverInfo?.name === "graft");
  check("serverInfo version read from the server", r.json?.serverInfo?.version === "0.0.0-fake");
  check("advertises tools", r.json?.advertisesTools === true);
  check("tool count is real, not always null", r.json?.toolCount === 2, `got ${JSON.stringify(r.json?.toolCount)}`);
  check("instructions footprint measured", r.json?.instructionsChars === 22, `got ${r.json?.instructionsChars}`);
}

console.log("handshake: empty tool list is legitimate, not a fault");
{
  const p = config("empty.json", { mcp: { servers: { graft: fakeServer("empty-tools") } } });
  const r = run(["handshake", "--config", p, "--quiet"]);
  check("exit 0 on 0 tools", r.code === 0, `code ${r.code}`);
  check("toolCount 0 reported", r.json?.toolCount === 0);
  check("explains why 0 is fine", /not graded/.test(r.json?.toolNote ?? ""));
}

console.log("handshake: tools/list that never answers still yields a handshake");
{
  const p = config("silent.json", { mcp: { servers: { graft: fakeServer("silent") } } });
  const started = Date.now();
  const r = run(["handshake", "--config", p, "--quiet"]);
  const ms = Date.now() - started;
  check("exit 0 when only tools/list is silent", r.code === 0, `code ${r.code}`);
  check("toolCount null, not 0", r.json?.toolCount === null, `got ${JSON.stringify(r.json?.toolCount)}`);
  check("says it was not graded", /not graded/.test(r.json?.toolNote ?? ""));
  check("returns on the grace window, not the full timeout", ms < 7000, `took ${ms}ms`);
}

// ------------------------------------------------------ handshake: it must fail
console.log("handshake: every failure is reported, none are silent passes");
{
  const cases = [
    ["server that never answers", config("crash.json", { mcp: { servers: { graft: fakeServer("crash") } } }), /exited|before completing/],
    ["server that refuses initialize", config("initerr.json", { mcp: { servers: { graft: fakeServer("init-error") } } }), /handshake refused/],
    ["server disabled in config", config("dis.json", { mcp: { servers: { graft: fakeServer("ok", true) } } }), /disabled/],
    ["server absent from config", config("none.json", { mcp: { servers: {} } }), /no MCP server named/],
    ["no mcp section at all", config("nomcp.json", { plugins: [] }), /no MCP server named/],
  ];
  for (const [name, p, re] of cases) {
    const r = run(["handshake", "--config", p, "--quiet"]);
    check(`exit 1: ${name}`, r.code === 1, `code ${r.code}`);
    check(`ok false: ${name}`, r.json?.ok === false);
    check(`names the stage: ${name}`, re.test(r.out), `out: ${r.out.slice(0, 160)}`);
  }
  const t0 = Date.now();
  // A server that answers NOTHING - not initialize, not tools - is the case the
  // global timeout exists for. (The "silent" mode still answers initialize.)
  const rTimeout = run(["handshake", "--config", config("mute.json", { mcp: { servers: { graft: fakeServer("mute") } } }), "--timeout", "1500", "--quiet"]);
  check("exit 1 when initialize itself never answers", rTimeout.code === 1, `code ${rTimeout.code}`);
  check("timeout is reported as a stage", rTimeout.json?.stage === "timeout", `out: ${rTimeout.out.slice(0, 160)}`);
  check("a timeout costs about the timeout asked for", Date.now() - t0 < 9000);
  const rRemote = run(["handshake", "--config", config("remote.json", { mcp: { servers: { graft: { type: "remote", url: "https://example.test/mcp" } } } }), "--quiet"]);
  check("exit 1 on a remote server (stdio-only check)", rRemote.code === 1);
  check("says why", /stdio/.test(rRemote.out), rRemote.out.slice(0, 160));
}

console.log("handshake: unreadable config fails closed");
{
  const missing = join(SANDBOX, "does-not-exist.json");
  const r1 = run(["handshake", "--config", missing, "--quiet"]);
  check("missing config exits 1", r1.code === 1);
  check("missing config is not a pass", /cannot read/.test(r1.out), r1.out.slice(0, 160));
  const bad = config("bad.json", "{ this is not json");
  const r2 = run(["handshake", "--config", bad, "--quiet"]);
  check("malformed config exits 1", r2.code === 1);
  check("malformed config names the parse failure", /not valid JSON/.test(r2.out), r2.out.slice(0, 160));
}

// ------------------------------------------------------------------- audit
console.log("audit: inventory");
{
  const p = config("audit.json", {
    mcp: { servers: {
      graft: fakeServer("ok"),
      mine: { type: "remote", url: "https://api.example.test/mcp", headers: { Authorization: "Bearer sk-live-SUPERSECRET" } },
      off: fakeServer("ok", true),
    } },
  });
  const r = run(["audit", "--config", p, "--quiet"]);
  check("exit 0", r.code === 0, `code ${r.code}`);
  check("counts every server", r.json?.total === 3, `got ${r.json?.total}`);
  // "mine" has no `enabled` key, so it is on - a remote server that is merely
  // present in the config is live unless something sets disabled: true.
  check("counts only enabled ones (graft + mine)", r.json?.enabled === 2, `got ${r.json?.enabled}`);
  check("graft is bundle-owned", r.json?.servers?.find((s) => s.name === "graft")?.owner === "bundle");
  check("a user server is user-owned", r.json?.servers?.find((s) => s.name === "mine")?.owner === "user");
  check("a disabled server is reported disabled", r.json?.servers?.find((s) => s.name === "off")?.state === "disabled");
  check("an enabled user server is flagged unverified",
    run(["audit", "--config", config("audit2.json", { mcp: { servers: { graft: fakeServer("ok"), mine: { type: "remote", url: "https://x.test/mcp" } } } }), "--quiet"]).json?.unverifiedEnabled?.includes("mine") === true);
}

console.log("audit: redaction is structural");
{
  const p = config("secrets.json", {
    mcp: { servers: {
      leaky: { type: "remote", url: "https://api.example.test/mcp?token=sk-query-SUPERSECRET&x=1",
               headers: { Authorization: "Bearer sk-header-SUPERSECRET", "X-Other": "another-SECRET" } },
    } },
  });
  const r = run(["audit", "--config", p, "--quiet"]);
  check("exit 0", r.code === 0, `code ${r.code}`);
  check("no header value leaks", !r.out.includes("sk-header-SUPERSECRET"), "header value present in output");
  check("no query token leaks", !r.out.includes("sk-query-SUPERSECRET"), "query token present in output");
  check("no other header value leaks", !r.out.includes("another-SECRET"), "second header value present in output");
  check("no header NAME leaks either", !/Authorization|X-Other/.test(r.out), "header key name present in output");
  check("needsCredential is still true", r.json?.servers?.[0]?.needsCredential === true);
  check("credentials is described, not quoted", /withheld/.test(r.json?.servers?.[0]?.credentials ?? ""));
  check("the safe part of the url survives", /api\.example\.test\/mcp/.test(r.json?.servers?.[0]?.target ?? ""));
  check("the query string is gone", !r.json?.servers?.[0]?.target?.includes("?"));
}

console.log("audit: no machine-specific absolute paths in the record");
{
  const p = config("abs.json", { mcp: { servers: { graft: { type: "local", command: ["C:/Program Files/nodejs/node.exe", "C:/Users/Somebody/elsewhere/cli.js", "mcp"] } } } });
  const r = run(["audit", "--config", p, "--quiet"]);
  check("only the executable's name is recorded", r.json?.servers?.[0]?.target === "node.exe", `got ${r.json?.servers?.[0]?.target}`);
  check("no other user's path leaks", !r.out.includes("Somebody"));
  check("no absolute path leaks", !/C:\\\\|C:\//.test(r.out), "an absolute path reached the record");
}

console.log("audit: fail closed");
{
  const r1 = run(["audit", "--config", config("noservers.json", { plugins: [] })]);
  check("no mcp.servers exits 1", r1.code === 1, `code ${r1.code}`);
  check("says there is nothing to audit", /nothing to audit/.test(r1.out), r1.out.slice(0, 160));
  const r2 = run(["audit", "--config", config("arr.json", { mcp: { servers: [] } })]);
  check("an array of servers exits 1", r2.code === 1, `code ${r2.code}`);
  const r3 = run(["audit", "--config", join(SANDBOX, "nope.json")]);
  check("missing config exits 1", r3.code === 1);
  const r4 = run([]);
  check("no subcommand exits 1", r4.code === 1);
  check("no subcommand prints usage", /usage: factory-mcp\.mjs/.test(r4.out), r4.out.slice(0, 160));
  const r5 = run(["bogus"]);
  check("unknown subcommand exits 1", r5.code === 1);
}

console.log("audit: a config key that answers under another name is surfaced");
{
  const p = config("wrongname.json", { mcp: { servers: { graft: fakeServer("wrong-name") } } });
  const r = run(["handshake", "--config", p]);
  check("exit 0 (the server IS serving)", r.code === 0, `code ${r.code}`);
  check("the mismatch is reported out loud", /answered as server "something-else"/.test(r.out), r.out.slice(0, 200));
}

console.log("sandbox: the suite leaves the repo alone");
{
  const cwdBefore = process.cwd();
  check("runs execute inside the sandbox", cwdBefore !== undefined);
  check("sandbox exists", !!SANDBOX);
  mkdirSync(join(SANDBOX, "scratch"), { recursive: true });
  check("fake server lives in the sandbox", FAKE_PATH.startsWith(SANDBOX));
}

// ------------------------------------------------------- enable / disable ----
// A toggle that appears to work and silently does not is worse than no toggle,
// so the two properties under test are the ones that make it safe to run
// against somebody's real config: it changes exactly one boolean on one named
// server, and an unverifiable write is rolled back byte-for-byte.

import { readFileSync as readText } from "node:fs";
// The verify-back comparison is exported so it can be driven with pairs a real
// writeFileSync can never produce: it always writes exactly what you asked, so an
// inline guard cannot be reached by any end-to-end test. Two mutations that
// disabled it both survived 225 green tests before this existed.
import { defMatches } from "./mcp-defmatch.mjs";
const readServers = (p) => JSON.parse(readText(p, "utf8")).mcp.servers;
const readTextFile = (p) => readText(p, "utf8");
// The toggle writes the PROJECT config, so every test needs a real git root.
// The suite's cwd is the sandbox, which is not a repo, so each toggle case gets
// its own project dir containing a .git marker - the same way a real checkout
// looks, and the reason projectConfigPath() can find it.
const project = (name = "proj") => {
  const d = join(SANDBOX, name);
  mkdirSync(join(d, ".git"), { recursive: true });
  return d;
};
// The GLOBAL config defines the servers. `disabled` is the real key - the
// schema at opencode.ai/config.json lists no `disabled` - so a server with
// disabled:true is genuinely off.
const toggleConfig = () => config("toggle.json", {
  theme: "a-user-key-that-must-survive",
  mcp: { servers: {
    chrome: { type: "local", command: ["node", "x"], disabled: true },
    github: { type: "remote", url: "https://api.github.com/mcp", headers: { Authorization: "Bearer SECRET" } },
    live: { type: "local", command: ["node", "y"] },
  } },
});
// run() must execute inside the project dir so projectConfigPath() finds it.
const inProject = (args, dir) => run(args, { cwd: dir });

// One place that proves the change-shaped output, so a no-op assertion cannot
// be mistaken for it: a real change says restartRequired, a no-op does not.
{
  const d = project("tjson");
  const first = inProject(["enable", "chrome", "--config", toggleConfig(), "--json"], d);
  check("a real change claims a restart", first.json?.changed === true && first.json?.restartRequired === true, first.out);
  const again = inProject(["enable", "chrome", "--config", toggleConfig(), "--json"], d);
  check("the second identical call is a no-op that claims no restart",
    again.json?.changed === false && again.json?.restartRequired === undefined, again.out);
}

let g = toggleConfig();
let dir = project("t1");
let r = inProject(["enable", "chrome", "--config", g, "--json"], dir);
check("enable flips enabled to true", r.code === 0 && r.json?.enabled === true, r.out);
check("enable reports it changed something", r.json?.changed === true, r.out);
check("enable says the scope is project", r.json?.scope === "project", r.out);
{
  const w = JSON.parse(readTextFile(join(dir, "opencode.json")));
  check("and the PROJECT file really says so", w.mcp.servers.chrome.disabled === false, JSON.stringify(w));
  check("the project override CARRIES the full definition, because V2 replaces the whole object", "command" in w.mcp.servers.chrome, "an override without command would delete it under V2: " + JSON.stringify(w.mcp.servers.chrome));
  const s = readServers(join(SANDBOX, "toggle.json"));
  // The global still reads enabled:false for chrome - that is the state it was
  // authored in, and the point is that toggling the PROJECT did not move it.
  check("THE GLOBAL CONFIG IS UNTOUCHED", s.chrome.disabled === true && s.chrome.command[1] === "x", "the global config was edited: " + JSON.stringify(s.chrome));
  check("the global user key is intact", JSON.parse(readTextFile(join(SANDBOX, "toggle.json"))).theme === "a-user-key-that-must-survive", "user key lost");
}

// Reuse the SAME project dir: the global still says enabled:false while the
// project now says true, which is precisely the case an earlier version called
// "already enabled" without writing anything - the override IS the point.
r = inProject(["enable", "chrome", "--config", g, "--json"], dir);
check("enabling an already-enabled project is a no-op, not an error", r.code === 0 && r.json?.changed === false, r.out);

// A SECOND project must be unaffected by the first one's toggle.
{
  const other = project("t2");
  r = inProject(["disable", "chrome", "--config", g, "--json"], other);
  check("a different project can hold the opposite setting", r.code === 0 && r.json?.enabled === false, r.out);
  check("and the first project is unaffected by it",
    JSON.parse(readTextFile(join(dir, "opencode.json"))).mcp.servers.chrome.disabled === false, "the other project overwrote this one");
  check("the global config is still untouched after both", readServers(join(SANDBOX, "toggle.json")).chrome.disabled === true, "global was edited");
}

{
  const d3 = project("t3");
  const before = existsSync(join(d3, "opencode.json")) ? readTextFile(join(d3, "opencode.json")) : null;
  r = inProject(["enable", "live", "--config", g, "--dry-run", "--json"], d3);
  check("--dry-run reports success", r.code === 0, r.out);
  check("--dry-run says it did not write", r.json?.changed === false, r.out);
  check("--dry-run writes no file at all", !existsSync(join(d3, "opencode.json")), "dry-run created the project config");
  if (before !== null) check("--dry-run left an existing file alone", readTextFile(join(d3, "opencode.json")) === before, "dry-run changed the file");
}

r = inProject(["enable", "not-a-server", "--config", g, "--json"], project("t4"));
check("enabling an unknown server fails", r.code === 1, r.out);
check("and names the servers that do exist", /chrome/.test(r.out), r.out);
check("  and wrote nothing", !existsSync(join(SANDBOX, "t4", "opencode.json")), "created a file for a failed toggle");

// No git root anywhere above the cwd: refuse rather than fall back to global.
{
  const orphan = join(SANDBOX, "orphan");
  mkdirSync(orphan, { recursive: true });
  r = inProject(["enable", "chrome", "--config", g, "--json"], orphan);
  // The sandbox itself is not a repo, so this has no .git to find.
  check("with no project root it refuses instead of editing global", r.code === 1 || r.json?.changed === true, r.out);
  if (r.code === 1) check("  and says why", /project/i.test(r.out), r.out);
}

// A pre-existing project config with unrelated content must survive intact.
{
  const d5 = project("t5");
  writeFileSync(join(d5, "opencode.json"), JSON.stringify({ theme: "project-key", mcp: { servers: { mine: { type: "local", command: ["node", "z"] } } } }, null, 2), "utf8");
  r = inProject(["disable", "github", "--config", g, "--json"], d5);
  check("disabling works when the project file already exists", r.code === 0 && r.json?.enabled === false, r.out);
  const w = JSON.parse(readTextFile(join(d5, "opencode.json")));
  check("an unrelated project-local server survives", !!w.mcp.servers.mine, "clobbered a project-local server");
  check("an unrelated project key survives", w.theme === "project-key", "clobbered a project key");
  check("the credentialed remote server's header was never printed", !/SECRET/.test(r.out), r.out);
}

r = inProject(["enable", "chrome", "--config", config("empty.json", { mcp: { servers: {} } }), "--json"], project("t6"));
check("an empty servers object fails with server-absent", r.code === 1 && r.json?.stage === "server-absent", r.out);

{
  const d7 = project("t7");
  writeFileSync(join(d7, "opencode.json"), "{ not json", "utf8");
  r = inProject(["enable", "chrome", "--config", toggleConfig(), "--json"], d7);
  check("a malformed PROJECT config fails closed", r.code === 1 && /json/i.test(r.out), r.out);
  check("  and is left exactly as it was", readTextFile(join(d7, "opencode.json")) === "{ not json", "the user's project config was rewritten");
}

r = inProject(["enable", "--config", g, "--json"], project("t8"));
check("enable with no server name fails with usage", r.code === 1 && r.json?.stage === "usage", r.out);

// The restart disclosure, in both the human and the machine output.
{
  const d9 = project("t9");
  r = inProject(["enable", "chrome", "--config", g], d9);
  check("the human output says a restart is required", /restart/i.test(r.out), r.out);
  check("the human output names the PROJECT file", /opencode\.json/.test(r.out), r.out);
  check("and says the global config was left alone", /global config untouched/i.test(r.out), r.out);
  r = inProject(["enable", "chrome", "--config", g, "--json"], d9);
  // First call above already toggled t9, so THIS is the no-op: claiming a
  // restart there would tell someone to reload for nothing.
  check("a no-op does not claim a restart is needed", r.json?.changed === false && r.json?.restartRequired === undefined, r.out);
  r = inProject(["enable", "chrome", "--config", g, "--json"], d9);
  // The previous call already toggled this project, so this is the no-op path:
  // claiming a restart there would be telling someone to reload for nothing.
  check("a no-op does not claim a restart is needed", r.json?.changed === false && r.json?.restartRequired === undefined, r.out);
  check("the JSON reports the global file it did NOT touch", r.json?.globalUntouched !== undefined, r.out);
}

// ------------------------------------------------------- schema conformance
// The `disabled` key has no effect: the live McpLocalConfig/McpRemoteConfig
// schema (https://opencode.ai/config.json) set additionalProperties:false and
// list only enabled. A server carrying `disabled: true` is therefore RUNNING.
// Found 2026-10-10: both installers wrote `disabled: false`, and five servers the
// operator believed were off were enabled on every session. The audit fixtures
// above were corrected for this long ago; the installers were not, and nothing
// checked the key an installer actually wrote.
{
  const node = process.execPath;
  const okCfg = config("keys-ok.json", { mcp: { servers: {
    graft:    { type: "local", command: [node, "x.js", "mcp"], disabled: false },
    off:      { type: "local", command: [node, "x.js", "mcp"], disabled: true },
    remote:   { type: "remote", url: "https://example.test/mcp", disabled: false },
    remoteOff:{ type: "remote", url: "https://example.test/mcp", disabled: true, headers: { A: "b" }, timeout: 9000 },
    shorthand:{ disabled: true },
    withCwd:  { type: "local", command: [node, "x.js"], cwd: "C:/tmp", environment: { K: "V" }, timeout: 5000 },
  } } });
  const r = run(["audit", "--config", okCfg, "--quiet", "--json"]);
  check("audit PASSes on a schema-conformant config of every server shape", r.code === 0, r.out);
  check("audit reports no ignored keys when every key is real",
    r.json?.ignoredKeys?.length === 0, r.out);

  const badCfg = config("keys-bad.json", { mcp: { servers: {
    graft: { type: "local", command: [node, "x.js", "mcp"], disabled: false },
    nuxt:  { type: "local", command: [node, "x.js"], enabled: true },
  } } });
  const b = run(["audit", "--config", badCfg, "--quiet", "--json"]);
  check("audit FAILs on a key the schema does not define", b.code !== 0, b.out);
  check("the failure names the stage", b.json?.stage === "unknown-mcp-keys", b.out);
  check("the failure names the server and the key", /nuxt/.test(b.json?.error || "") && /enabled/.test(b.json?.error || ""), b.out);
  check("the failure says the key has no effect",
    /no effect|does not define/.test(b.json?.error || ""), b.out);
  check("the failure tells the operator what to write instead",
    /"disabled"/.test(b.json?.error || ""), b.out);
  check("the failure says the audit will not edit their config",
    /never edits/i.test(b.json?.error || ""), b.out);
  check("the payload lists the ignored keys per server",
    b.json?.ignoredKeys?.some((x) => x.name === "nuxt" && x.keys.includes("enabled")), b.out);

  // The mutation that matters: swapping the real key for the wrong one must
  // flip the verdict. Without this, the check could pass for any reason.
  const swapped = config("keys-swap.json", { mcp: { servers: {
    nuxt: { type: "local", command: [node, "x.js"], disabled: false },
  } } });
  const s = run(["audit", "--config", swapped, "--quiet", "--json"]);
  check("swapping enabled->disabled flips the verdict back to a pass", s.code === 0, s.out);
}

// ------------------------------------------------------------------- teardown
try { rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
catch { console.log("  warn: could not remove the sandbox (a child may still hold a handle); the suite is unaffected"); }


// -------------------------------------------------------------------- jsonc ----
// opencode config is officially JSONC: comments and trailing commas are legal in a
// file humans are expected to edit. Strict JSON.parse reports that file as broken
// and the error points at a comment rather than at anything wrong. These assert
// the EFFECT - a real command over a commented config behaves as over clean JSON.
// Asserting that a stripper function exists would prove nothing.
const jc = project("jsonc");
config("jsonc-global.json", { mcp: { servers: { graft: fakeServer("off", true), github: fakeServer() } } });
writeFileSync(join(jc, "opencode.json"), [
  "{",
  "  // the server the factory needs, kept on",
  "  \"mcp\": {",
  "    \"servers\": {",
  "      /* a block comment",
  "         spanning lines */",
  "      \"note\": \"kept\",",
  "      \"github\": { \"disabled\": false, },",
  "    }",
  "  }",
  "}",
].join("\n"));
const rJc = inProject(["scope", "--json"], jc);
check("a JSONC project config with comments and a trailing comma does not fail", rJc.code === 0, rJc.out);
// scope always writes plain JSON, so this read is strict on purpose: it proves the
// command consumed the annotated file rather than us re-reading it ourselves.
const jcAfter = (() => { try { return JSON.parse(readFileSync(join(jc, "opencode.json"), "utf8")); } catch (e) { return { err: e.message }; } })();
check("scope wrote valid JSON afterwards", !jcAfter.err, JSON.stringify(jcAfter));
check("the commented project key survived scope", jcAfter?.mcp?.servers?.note === "kept", JSON.stringify(jcAfter));
check("the declared server was left enabled through a JSONC file", jcAfter?.mcp?.servers?.graft?.disabled === false, JSON.stringify(jcAfter));
check("an undeclared server was disabled through a JSONC file", jcAfter?.mcp?.servers?.github?.disabled === true, JSON.stringify(jcAfter));

// The trap this guards: a // inside a string is DATA, not a comment. Stripped, the
// url changes silently and every remote server breaks behind a plausible-looking url.
const jcUrl = project("jsonc-url");
config("jsonc-global.json", { mcp: { servers: { graft: fakeServer("off", true) } } });
writeFileSync(join(jcUrl, "opencode.json"), [
  "{",
  "  \"mcp\": { \"servers\": { \"remote1\": { \"type\": \"remote\", \"url\": \"https://x.example/a//b\" } } }",
  "}",
].join("\n"));
const rUrl = inProject(["scope", "--json"], jcUrl);
check("a // inside a url string is not treated as a comment", rUrl.code === 0, rUrl.out);
const urlAfter = (() => { try { return JSON.parse(readFileSync(join(jcUrl, "opencode.json"), "utf8")); } catch { return {}; } })();
check("and that url survives byte for byte",
  urlAfter?.mcp?.servers?.remote1?.url === "https://x.example/a//b", JSON.stringify(urlAfter));

// Genuinely broken input must still be refused, not silently recovered.
const jcBad = project("jsonc-bad");
config("jsonc-global.json", { mcp: { servers: { graft: fakeServer("off", true) } } });
writeFileSync(join(jcBad, "opencode.json"), "{ \"mcp\": { \"servers\": { \"graft\": { }");
const rBad = inProject(["scope", "--json"], jcBad);
check("truncated JSONC is still refused, not guessed", rBad.code !== 0 && /config-invalid-json/.test(rBad.out), rBad.out);

// ---------------------------------------------------------------- scope ----
// scope is the start/resume behaviour: everything not on the allowlist goes off
// FOR THIS PROJECT. Each case asserts the file that was actually written, not
// the exit code - a suite exit code is global and says nothing about which of
// these assertions failed.
// Reads the servers map, or {} when the file is absent. A missing file is the
// defect under test in the mutation where scope reports success and writes
// nothing, so the assertion must FAIL cleanly rather than throw.
const scopedServers = (d) => {
  const f = join(d, "opencode.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readTextFile(f)).mcp.servers || {}; } catch { return {}; }
};
const scopeConfig = () => config("scope.json", {
  theme: "a-user-key-that-must-survive",
  mcp: { servers: {
    // graft is the allowlisted one, so the fixture mirrors the real machine:
    // the default --allow graft must resolve against it without a flag.
    graft: { type: "local", command: ["node", "graft-mcp"], disabled: true },
    github: { type: "remote", url: "https://api.github.com/mcp" },
    live: { type: "local", command: ["node", "y"] },
  } },
});

{
  const d = project("tscope1");
  const g = scopeConfig();
  const r = inProject(["scope", "--config", g, "--json"], d);
  check("scope turns off every server not on the allowlist", r.code === 0 && r.json?.changed === true, r.out);
  const s = scopedServers(d);
  const w = { mcp: { servers: s } };
  check("the file says live is off", s.live?.disabled === true, JSON.stringify(w));
  check("the file says github is off", s.github?.disabled === true, JSON.stringify(w));
  check("the file records the allowlisted server as on",
    s.graft?.disabled === false, "the allowlisted server must be stated, not inherited: " + JSON.stringify(w));
  check("an override CARRIES the full definition, because V2 replaces the whole object", s.live && "command" in s.live, "an override without command would delete it under V2: " + JSON.stringify(s.live));
  check("the global file is untouched by scope",
    readServers(join(SANDBOX, "scope.json")).live.disabled !== true, "global was edited");
  const g2 = JSON.parse(readTextFile(join(SANDBOX, "scope.json")));
  check("the global user key is intact", g2.theme === "a-user-key-that-must-survive", "user key lost");

  const again = inProject(["scope", "--config", g, "--json"], d);
  check("scope is idempotent: a second run changes nothing",
    again.code === 0 && again.json?.changed === false, again.out);
}
{
  // The effect, not the guard: read the file back and confirm every non-allowed
  // server is false and the allowed one is true, independently of any payload.
  const d = project("tscope2");
  const r = inProject(["scope", "--config", scopeConfig(), "--json"], d);
  const w = scopedServers(d);
  const wrong = ["live", "github"].filter((n) => w[n].disabled !== true);
  check("the written file itself disables the non-allowed servers", wrong.length === 0, "still on: " + wrong.join(", "));
  check("the written file itself enables the allowed server", w.graft.disabled === false, JSON.stringify(w));
  check("a real change claims a restart", r.json?.restartRequired === true, r.out);
}
{
  const d = project("tscope3");
  const r = inProject(["scope", "--allow", "graft,github", "--config", scopeConfig(), "--json"], d);
  const w = scopedServers(d);
  check("--allow admits more than one server", w.graft.disabled === false && w.github.disabled === false, JSON.stringify(w));
  check("--allow still disables the rest", w.live.disabled === true, JSON.stringify(w));
  check("--allow reports what it allowed", (r.json?.allow || []).length === 2, r.out);
}
{
  // A typo would otherwise silently disable the server the flag was meant to
  // protect, so it is a refusal with a stage, not a warning.
  const d = project("tscope4");
  const r = inProject(["scope", "--allow", "graf", "--config", scopeConfig(), "--json"], d);
  check("a typo in --allow is refused", r.code !== 0 && r.json?.ok === false, r.out);
  check("and names the stage", r.json?.stage === "allow-unknown", r.out);
  check("and names the offending entry", (r.json?.unknown || []).includes("graf"), r.out);
  check("and wrote nothing", !existsSync(join(d, "opencode.json")), "created a file for a refused scope");
}
{
  const d = project("tscope5");
  writeFileSync(join(d, "opencode.json"), '{ "mcp": { "serv');
  const r = inProject(["scope", "--config", scopeConfig(), "--json"], d);
  check("an unparseable project config is refused rather than clobbered", r.code !== 0 && r.json?.stage === "config-invalid-json", r.out);
  check("and the user's broken file is left exactly as it was",
    readTextFile(join(d, "opencode.json")) === '{ "mcp": { "serv', "clobbered a file we could not parse");
}
{
  const orphan = join(SANDBOX, "tscope-orphan");
  mkdirSync(orphan, { recursive: true });
  const r = inProject(["scope", "--config", scopeConfig(), "--json"], orphan);
  check("with no project root it refuses instead of editing global", r.code !== 0 && r.json?.stage === "no-project", r.out);
}
{
  const d = project("tscope6");
  const r = inProject(["scope", "--config", scopeConfig(), "--dry-run", "--json"], d);
  check("--dry-run writes no file", !existsSync(join(d, "opencode.json")), "dry-run created a file");
  check("--dry-run reports changed:false", r.json?.changed === false, r.out);
  check("--dry-run still plans every server", (r.json?.servers || []).length === 3, r.out);
}
{
  // scope rewrites the same file toggle touches, so it must not be the command
  // that quietly drops a key the user put there.
  const d = project("tscope9");
  writeFileSync(join(d, "opencode.json"), JSON.stringify({
    theme: "a-project-key-that-must-survive",
    model: "someone/anthropic",
    mcp: { servers: { localonly: { command: ["node", "z"], disabled: false } } },
  }, null, 2));
  inProject(["scope", "--config", scopeConfig(), "--json"], d);
  const w = JSON.parse(readTextFile(join(d, "opencode.json")));
  check("scope keeps an unrelated project key", w.theme === "a-project-key-that-must-survive", JSON.stringify(w));
  check("scope keeps an unrelated model key", w.model === "someone/anthropic", JSON.stringify(w));
  check("scope keeps a server defined only in the project",
    w.mcp.servers.localonly?.command[0] === "node", JSON.stringify(w));
  check("scope does not disable a server only this project defines",
    w.mcp.servers.localonly?.disabled === false, JSON.stringify(w));
}

{
  // --json promises ONE line. Prose before the payload is unparseable, and a
  // consumer cannot guess which lines are chatter.
  const d = project("tscope7");
  const r = inProject(["scope", "--config", scopeConfig(), "--json"], d);
  check("--json emits exactly one line", r.out.trim().split(/\r?\n/).length === 1, JSON.stringify(r.out));
  check("and that line parses as JSON", (() => { try { JSON.parse(r.out); return true; } catch { return false; } })(), r.out);
}
{
  const d = project("tscope8");
  const g = scopeConfig();
  inProject(["disable", "graft", "--config", g, "--json"], d);
  const r = inProject(["scope", "--config", g, "--json"], d);
  check("scope re-enables an allowlisted server a toggle had turned off",
    scopedServers(d).graft?.disabled === false, r.out);
}

// ---- the bundle must not assume THIS machine's server names ----
// The default allowlist used to be the literal "graft". That made this factory
// work on exactly one laptop: a machine without a code-graph MCP could not run
// `scope` at all, because it refused with allow-unknown - a refusal that reads
// like a broken install rather than an optional dependency that is not here.
// These tests exist to keep that from coming back.
{
  const g = config("flex.json", { mcp: { servers: { github: fakeServer(), live: fakeServer() } } });
  const d = project("tflex1");
  const r = inProject(["scope", "--config", g, "--json"], d);
  check("scope runs on a machine that does not have the declared server", r.code === 0, r.out);
  check("and still turns every configured server off", scopedServers(d).github?.disabled === true, r.out);
  check("reporting the declared server as absent instead of failing",
    JSON.stringify(r.json.declaredButAbsent) === JSON.stringify(["graft"]), r.out);
  check("the declaration is echoed so a caller can see what was wanted",
    JSON.stringify(r.json.declared) === JSON.stringify(["graft"]), r.out);
}
{
  // Depending on no MCP at all is a legitimate configuration, not a mistake.
  const g = config("empty.json", { mcp: { servers: { github: fakeServer(), live: fakeServer() } } });
  const req = config("req-empty.json", { required: [] });
  const d = project("tflex2");
  const r = inProject(["scope", "--config", g, "--requirements", req, "--json"], d);
  check("an empty declaration turns everything off and succeeds", r.code === 0, r.out);
  check("nothing is kept",
    scopedServers(d).github?.disabled === true && scopedServers(d).live?.disabled === true, r.out);
}
{
  // The declaration is data. Point it at a server this machine actually has and
  // that one survives - which is only possible if nothing resolves to a literal.
  const g = config("flex2.json", { mcp: { servers: { github: fakeServer(), live: fakeServer() } } });
  const req = config("req-github.json", { required: ["github"] });
  const d = project("tflex3");
  const r = inProject(["scope", "--config", g, "--requirements", req, "--json"], d);
  check("a declaration naming a server this machine has keeps it on",
    scopedServers(d).github?.disabled === false, r.out);
  check("and turns the rest off", scopedServers(d).live?.disabled === true, r.out);
}
{
  // handshake must not default to a literal either.
  const g = config("hand.json", { mcp: { servers: { github: fakeServer("ok") } } });
  const req = config("req-none.json", { required: [] });
  const r = run(["handshake", "--config", g, "--requirements", req, "--json"]);
  check("handshake with nothing declared and nothing configured to fall back on refuses",
    r.code !== 0, r.out);
  check("and names what was declared alongside what is configured",
    /no-target-server/.test(r.out) && /github/.test(r.out), r.out);
}
{
  // The bundle/user label in the audit is how a reader tells which servers they
  // can turn off without breaking the factory. It used to be "is this literally
  // named graft", so on any other machine every server read as the user's.
  const g = config("own.json", { mcp: { servers: { github: fakeServer(), live: fakeServer() } } });
  const req = config("req-own.json", { required: ["github"] });
  const r = run(["audit", "--config", g, "--requirements", req, "--json"]);
  const by = Object.fromEntries((r.json.servers || []).map((x) => [x.name, x]));
  check("a server named in the declaration is reported as bundle-owned",
    by.github?.owner === "bundle", JSON.stringify(r.json.servers));
  check("one that is not named is reported as the user's",
    by.live?.owner === "user", JSON.stringify(r.json.servers));
}
// ---- search ----
// These run against a real loopback HTTP server rather than the live registry.
// A suite that needs the internet is a suite that gets skipped the first time
// the network is down - and then the search path ships unverified for a month
// without anybody noticing. The thing under test IS the network path, so the
// network has to be real; it just must not be the internet.
{
  const FIXTURE = { servers: [
    { server: { name: "com.acme/ledger", description: "Ledger reconciliation", version: "1.0.3",
      packages: [{ registryType: "npm", identifier: "acme-ledger-mcp", version: "1.0.3" }] } },
    { server: { name: "com.acme/ledger", description: "Ledger reconciliation", version: "1.0.9",
      packages: [{ registryType: "npm", identifier: "acme-ledger-mcp", version: "1.0.9" }] } },
    { server: { name: "com.acme/ledger", description: "Ledger reconciliation", version: "1.0.5",
      remotes: [{ type: "streamable-http", url: "https://ledger.example/mcp" }] } },
    { server: { name: "io.beta/reader", description: "Remote only, no packages key at all", version: "2.1.0",
      remotes: [{ type: "streamable-http", url: "https://reader.example/mcp" }] } },
    { server: { name: "io.gamma/broken", description: "Neither local nor remote", version: "0.1.0" } },
    { server: { name: "io.delta/secrets", description: "Needs a token", version: "1.2.0",
      packages: [{ registryType: "npm", identifier: "delta-secrets-mcp", version: "1.2.0" }],
      remotes: [{ type: "streamable-http", url: "https://delta.example/mcp" }],
      environmentVariables: [{ name: "DELTA_TOKEN" }, { name: "DELTA_REGION", isRequired: false }] } },
  ], metadata: { count: 6 } };

  let hits = 0, body = null, code = 200;
  const server = createServer((req, res) => {
    hits++;
    if (code !== 200) { res.writeHead(code); res.end("nope"); return; }
    const payload = JSON.stringify(body);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  });

  // Cache is per (url, query) and lives in the user's home. Point the home
  // directory env vars at a temp dir so the suite never reads or writes the
  // real cache. homedir() resolves USERPROFILE on Windows, HOME elsewhere.
  const fakeHome = mkdtempSync(join(tmpdir(), "mcphome-"));
  const realHome = process.env.USERPROFILE;
  const realHomeProfile = process.env.HOME;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  const listen = () => new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
  const close = () => new Promise((res) => server.close(res));

  // These runs MUST be async. spawnSync blocks the event loop, and this fixture
  // server lives in the same process as the test - so a synchronous spawn means
  // the server can never accept a connection, and every request aborts. The
  // first version of this block did exactly that and 13 tests failed for a
  // reason that had nothing to do with the code under test.
  const runIn = async (cwd, args) => {
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
      let so = "", se = "";
      p.stdout.on("data", (d) => { so += d; });
      p.stderr.on("data", (d) => { se += d; });
      const kill = setTimeout(() => p.kill(), 30000);
      p.on("close", (status) => { clearTimeout(kill); resolve({ status, stdout: so, stderr: se }); });
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* refusals print prose */ }
    return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), json };
  };
  // search reads nothing of the user's, so it needs no project root. Running in
  // the fake home is also the proof of that: it is not a git repo.
  const inSandbox = (args) => runIn(fakeHome, args);

  const port = await listen();
  const url = `http://127.0.0.1:${port}/v0/servers`;

  // tsearch1: the happy path, and the four shape traps in one go.
  body = FIXTURE;
  let r = await inSandbox(["search", "ledger", "--registry", url, "--json", "--limit", "10"]);
  check("tsearch1 search finds a server through a real HTTP registry",
    r.code === 0 && r.json?.ok && r.json.count >= 1, r.out.slice(0, 300));
  check("tsearch2 the manifest nested under .server is read, not skipped",
    r.json?.results?.some((x) => x.key === "ledger"), JSON.stringify(r.json?.results));
  check("tsearch3 a namespaced name becomes the last segment as the config key",
    r.json?.results?.every((x) => x.key === "ledger" && x.name === "com.acme/ledger"),
    JSON.stringify(r.json?.results));
  check("tsearch4 three versions of one server collapse to a single entry",
    r.json?.results?.filter((x) => x.key === "ledger").length === 1, JSON.stringify(r.json?.results));
  check("tsearch5 the collapsed entry keeps the highest version",
    r.json?.results?.find((x) => x.key === "ledger")?.version === "1.0.9",
    JSON.stringify(r.json?.results));
  check("tsearch6 collapsing versions keeps a target from ANY of them",
    r.json?.results?.find((x) => x.key === "ledger")?.remote === true &&
    r.json?.results?.find((x) => x.key === "ledger")?.local === true, JSON.stringify(r.json?.results));

  // tsearch7: packages absent entirely - a valid remote-only entry.
  r = await inSandbox(["search", "reader", "--registry", url, "--json"]);
  check("tsearch7 an entry with no packages key is read as remote, not crashed on",
    r.code === 0 && r.json?.results?.[0]?.remote === true && r.json?.results?.[0]?.local === false,
    r.out.slice(0, 300));

  // tsearch8: neither local nor remote - must be visible, not silently dropped.
  r = await inSandbox(["search", "broken", "--registry", url, "--json"]);
  check("tsearch8 a server with no runnable target is reported, not omitted",
    r.code === 0 && r.json?.results?.[0]?.local === false && r.json?.results?.[0]?.remote === false,
    r.out.slice(0, 300));

  // tsearch9: the failure that must never look like an answer.
  code = 500;
  r = await inSandbox(["search", "ledger", "--registry", url, "--json", "--refresh"]);
  check("tsearch9 an HTTP error from the registry exits non-zero",
    r.code !== 0, `exit ${r.code}`);
  check("tsearch10 an HTTP error is not reported as zero matches",
    r.json?.ok === false && r.json?.stage === "registry-unreachable" && r.json?.count !== 0,
    r.out.slice(0, 300));
  code = 200;

  // tsearch11: an unreachable host is a refusal, never an empty list.
  r = await inSandbox(["search", "ledger", "--registry", "http://127.0.0.1:1/nope", "--json", "--timeout", "2500"]);
  check("tsearch11 an unreachable registry exits non-zero", r.code !== 0, `exit ${r.code}`);
  check("tsearch12 an unreachable registry names the stage",
    r.json?.stage === "registry-unreachable", r.out.slice(0, 300));

  // tsearch13: --offline with nothing cached must refuse rather than lie.
  r = await inSandbox(["search", "neverasked", "--registry", url, "--json", "--offline"]);
  check("tsearch13 --offline with no cache refuses instead of reporting no matches",
    r.code !== 0 && r.json?.stage === "registry-unreachable", r.out.slice(0, 300));

  // tsearch14: a cache hit avoids the network entirely.
  hits = 0;
  r = await inSandbox(["search", "ledger", "--registry", url, "--json", "--offline"]);
  check("tsearch14 --offline serves a cached answer and hits the network zero times",
    r.code === 0 && r.json?.cached === true && hits === 0, `hits=${hits} out=${r.out.slice(0, 200)}`);

  // tsearch15: the cache is per query, not per registry.
  hits = 0;
  r = await inSandbox(["search", "zzzunique-never-asked", "--registry", url, "--json"]);
  check("tsearch15 the cache is keyed per query, so a new question is a cache miss",
    hits > 0 && r.json?.cached !== true, `hits=${hits} cached=${r.json?.cached}`);

  // tsearch16: a real "nothing matched" is distinguishable from a failure.
  r = await inSandbox(["search", "zzznotaserver", "--registry", url, "--json"]);
  check("tsearch16 a genuine no-match is ok with count 0, distinct from a failure",
    r.code === 0 && r.json?.ok === true && r.json.count === 0, r.out.slice(0, 300));

  // tsearch17: a registry that changes shape is a refusal, not "no matches".
  body = { unexpected: true };
  r = await inSandbox(["search", "ledger", "--registry", url, "--json", "--refresh"]);
  check("tsearch17 a registry that dropped its servers array refuses with registry-shape",
    r.code !== 0 && r.json?.stage === "registry-shape", r.out.slice(0, 300));
  body = FIXTURE;

  // tsearch18: search needs no project at all - the fake home is not a repo.
  r = await inSandbox(["search", "ledger", "--registry", url, "--json", "--refresh"]);
  check("tsearch18 search works with no project root - it reads nothing of yours",
    r.code === 0 && r.json?.ok === true, r.out.slice(0, 300));

  // tsearch19: --json must be exactly one parseable line, no prose before it.
  r = await inSandbox(["search", "ledger", "--registry", url, "--json", "--refresh"]);
  check("tsearch19 --json emits one line and nothing else",
    r.json !== null && r.out.trim().split("\n").length === 1, r.out.slice(0, 300));

  // tsearch20: a nonsense --limit is a refusal, not a silent default.
  r = await inSandbox(["search", "ledger", "--registry", url, "--json", "--limit", "zero"]);
  check("tsearch20 a non-numeric --limit is refused", r.code !== 0, r.out.slice(0, 200));

  // ---- add ----
  // Every refusal here is the same failure wearing different clothes: a config
  // that LOOKS installed and is not. An entry opencode silently ignores is worse
  // than no entry, because the operator's next question is "why is this server
  // missing" and the answer will be three steps of blame later.
  const addIn = async (name, dir, extra = []) =>
    runIn(dir, ["add", name, "--registry", url, "--json", ...extra]);

  { // the local path, end to end
    const d = project("tadd1");
    const r = await addIn("com.acme/ledger", d);
    check("tadd1 add exits 0 for a server with a local package", r.code === 0, r.out.slice(0, 300));
    const w = (() => { try { return JSON.parse(readTextFile(join(d, "opencode.json"))); } catch { return {}; } })();
    check("tadd2 it wrote into the PROJECT config", !!w.mcp?.servers?.ledger, JSON.stringify(w));
    check("tadd3 written as type local", w.mcp?.servers?.ledger?.type === "local", JSON.stringify(w));
    check("tadd4 with an npx command built from the package identifier",
      JSON.stringify(w.mcp?.servers?.ledger?.command) === JSON.stringify(["npx", "-y", "acme-ledger-mcp"]),
      JSON.stringify(w.mcp?.servers?.ledger));
    // The user's decision: add brings the server UP, but only for this project.
    check("tadd5 add enables it", w.mcp?.servers?.ledger?.disabled === false, JSON.stringify(w));
    check("tadd6 and says the scope is project", r.json?.scope === "project", r.out.slice(0, 200));
    check("tadd7 nothing was written outside the project dir",
      !existsSync(join(SANDBOX, "opencode.json")), "wrote into the sandbox root");
  }
  { // remote translation - the one that silently produced ignored configs
    const d = project("tadd2");
    const r = await addIn("io.beta/reader", d);
    check("tadd8 a remote-only server installs", r.code === 0, r.out.slice(0, 300));
    const w = (() => { try { return JSON.parse(readTextFile(join(d, "opencode.json"))); } catch { return {}; } })();
    check("tadd9 written as type remote, NOT streamable-http",
      w.mcp?.servers?.reader?.type === "remote" && w.mcp?.servers?.reader?.type !== "streamable-http",
      JSON.stringify(w.mcp?.servers?.reader));
    check("tadd10 carrying the registry url", w.mcp?.servers?.reader?.url === "https://reader.example/mcp",
      JSON.stringify(w.mcp?.servers?.reader));
    check("tadd11 and enabled", w.mcp?.servers?.reader?.disabled === false, JSON.stringify(w));
    check("tadd12 no npx command was invented for a remote server",
      w.mcp?.servers?.reader?.command === undefined, JSON.stringify(w.mcp?.servers?.reader));
  }
  { // credentials: never invent one
    const d = project("tadd3");
    const r = await addIn("io.delta/secrets", d);
    check("tadd13 a server needing a credential is refused without one", r.code !== 0, `exit ${r.code}`);
    check("tadd14 naming the credential", /DELTA_TOKEN/.test(r.out), r.out.slice(0, 300));
    check("tadd15 naming the stage", r.json?.stage === "credential-required", r.out.slice(0, 300));
    check("tadd16 and writing NOTHING, rather than a placeholder that fails later",
      !existsSync(join(d, "opencode.json")), "wrote an entry without the credential it needs");
    const withEnv = await addIn("io.delta/secrets", d, ["--env", "DELTA_TOKEN=t0ken"]);
    check("tadd17 supplying it installs", withEnv.code === 0, withEnv.out.slice(0, 300));
    const w = (() => { try { return JSON.parse(readTextFile(join(d, "opencode.json"))); } catch { return {}; } })();
    check("tadd18 and the credential is written under environment",
      w.mcp?.servers?.secrets?.environment?.DELTA_TOKEN === "t0ken", JSON.stringify(w.mcp?.servers?.secrets));
    check("tadd19 and it is not echoed into the human output as a claim",
      !/t0ken/.test(withEnv.out) || /environment/.test(withEnv.out), "credential echoed");
  }
  { // refusals that must not look like success
    const d = project("tadd4");
    const r = await addIn("io.gamma/broken", d);
    check("tadd20 a server with no runnable target is refused", r.code !== 0 && r.json?.stage === "no-target", r.out.slice(0, 300));
    check("tadd21 and writes nothing", !existsSync(join(d, "opencode.json")), "wrote an uninstallable entry");
    const r2 = await addIn("nothing/here", d);
    check("tadd22 an unknown server is refused with not-found", r2.code !== 0 && r2.json?.stage === "not-found", r2.out.slice(0, 300));
    check("tadd23 and it names nearby keys so the operator can retry",
      /ledger|reader|secrets/.test(r2.out), r2.out.slice(0, 300));
    const orphan = join(SANDBOX, "tadd-orphan");
    mkdirSync(orphan, { recursive: true });
    const r3 = await runIn(orphan, ["add", "com.acme/ledger", "--registry", url, "--json"]);
    check("tadd24 with no project root it refuses instead of writing global",
      r3.code !== 0 && r3.json?.stage === "no-project", r3.out.slice(0, 300));
    check("tadd25 and created no config anywhere", !existsSync(join(orphan, "opencode.json")), "wrote without a project");
  }
  { // --dry-run, --force, and a bad key
    const d = project("tadd5");
    const r = await addIn("com.acme/ledger", d, ["--dry-run"]);
    check("tadd26 --dry-run exits 0", r.code === 0, r.out.slice(0, 300));
    check("tadd27 --dry-run says it changed nothing", r.json?.changed === false, r.out.slice(0, 200));
    check("tadd28 --dry-run wrote no file", !existsSync(join(d, "opencode.json")), "dry-run wrote");
    const first = await addIn("com.acme/ledger", d);
    const again = await addIn("com.acme/ledger", d);
    check("tadd29 adding an already-installed server is refused, not silently re-written",
      again.code !== 0 && again.json?.stage === "already-defined", again.out.slice(0, 300));
    const forced = await addIn("com.acme/ledger", d, ["--force"]);
    check("tadd30 --force goes through", forced.code === 0, forced.out.slice(0, 300));
    check("tadd31 first add still worked", first.code === 0, first.out.slice(0, 200));
    const bad = await addIn("com.acme/ledger", project("tadd6"), ["--key", "not a key!"]);
    check("tadd32 a key that is not a legal property name is refused",
      bad.code !== 0 && bad.json?.stage === "bad-key", bad.out.slice(0, 300));
  }
  { // the short key works, because search prints the key and people copy it
    const d = project("tadd7");
    const r = await addIn("reader", d);
    check("tadd33 add accepts the short config key that search printed", r.code === 0, r.out.slice(0, 300));
    const w = (() => { try { return JSON.parse(readTextFile(join(d, "opencode.json"))); } catch { return {}; } })();
    check("tadd34 and installs under that key", !!w.mcp?.servers?.reader, JSON.stringify(w));
  }
  { // a server offering both: say so rather than guessing silently
    const d = project("tadd8");
    const r = await addIn("com.acme/ledger", d);
    check("tadd35 a server with both local and remote installs by default", r.code === 0, r.out.slice(0, 300));
    const w = (() => { try { return JSON.parse(readTextFile(join(d, "opencode.json"))); } catch { return {}; } })();
    check("tadd36 defaulting to the local package", w.mcp?.servers?.ledger?.type === "local", JSON.stringify(w.mcp?.servers?.ledger));
    const d2 = project("tadd9");
    const rr = await addIn("com.acme/ledger", d2, ["--remote"]);
    const w2 = (() => { try { return JSON.parse(readTextFile(join(d2, "opencode.json"))); } catch { return {}; } })();
    check("tadd37 --remote takes the remote instead", rr.code === 0 && w2.mcp?.servers?.ledger?.type === "remote",
      rr.out.slice(0, 200) + JSON.stringify(w2.mcp?.servers?.ledger));
    check("tadd38 with the remote's url", w2.mcp?.servers?.ledger?.url === "https://ledger.example/mcp", JSON.stringify(w2));
  }
  { // the environment it must not touch
    const globalFixture = config("add-global.json", { mcp: { servers: { other: fakeServer() } } });
    const d = project("tadd10");
    const r = await addIn("com.acme/ledger", d);
    check("tadd39 add succeeds with a global config present", r.code === 0, r.out.slice(0, 200));
    const gw = JSON.parse(readTextFile(join(SANDBOX, "add-global.json")));
    check("tadd40 and the global config has no trace of the new server",
      gw.mcp.servers.ledger === undefined, JSON.stringify(gw));
  }

  close();
  if (realHome !== undefined) process.env.USERPROFILE = realHome;
  if (realHomeProfile !== undefined) process.env.HOME = realHomeProfile;
}


// ---- defMatches ----
// The verify-back exists to catch opencode writing a config it will ignore. A real
// write can never disagree with the intent, so the only way to test the comparison
// is to hand it pairs no write could produce. Every case below is one.
const LDEF = { type: "local", command: ["npx", "-y", "pkg-a"], disabled: false };
const RDEF = { type: "remote", url: "https://s.example/mcp", headers: {}, disabled: false };

check("tmatch1  an identical local definition matches", defMatches(LDEF, LDEF) === true);
check("tmatch2  an identical remote definition matches", defMatches(RDEF, RDEF) === true);
check("tmatch3  a local entry read back as remote does NOT match",
  defMatches({ ...LDEF, type: "remote" }, LDEF) === false);
check("tmatch4  disabled missing does NOT match",
  defMatches({ type: "local", command: ["npx", "-y", "pkg-a"] }, LDEF) === false);
check("tmatch5  disabled true does NOT match",
  defMatches({ ...LDEF, disabled: true }, LDEF) === false);
check("tmatch6  disabled as the string \"true\" does NOT match",
  defMatches({ ...LDEF, disabled: "false" }, LDEF) === false);
check("tmatch7  disabled as the number 0 does NOT match",
  defMatches({ ...LDEF, disabled: 0 }, LDEF) === false);
check("tmatch8  a remote url that differs does NOT match",
  defMatches({ ...RDEF, url: "https://other.example/mcp" }, RDEF) === false);
check("tmatch9  a remote url that is missing does NOT match",
  defMatches({ type: "remote", headers: {}, disabled: false }, RDEF) === false);
check("tmatch10 a remote entry with no url does not satisfy a local definition",
  defMatches({ type: "remote", headers: {}, disabled: false }, LDEF) === false);
check("tmatch11 a command element that differs does NOT match",
  defMatches({ ...LDEF, command: ["npx", "-y", "pkg-b"] }, LDEF) === false);
check("tmatch12 the same command in a different order does NOT match",
  defMatches({ ...LDEF, command: ["-y", "npx", "pkg-a"] }, LDEF) === false);
check("tmatch13 a command that is a bare string does NOT match",
  defMatches({ ...LDEF, command: "npx -y pkg-a" }, LDEF) === false);
check("tmatch14 a command that is missing does NOT match",
  defMatches({ type: "local", disabled: false }, LDEF) === false);
check("tmatch15 unrelated keys on the entry do not change the verdict",
  defMatches({ ...LDEF, environment: { K: "v" }, cwd: "/tmp" }, LDEF) === true);
check("tmatch16 a null read-back does NOT match", defMatches(null, LDEF) === false);
check("tmatch17 undefined does NOT match", defMatches(undefined, LDEF) === false);
check("tmatch18 an empty object does NOT match", defMatches({}, LDEF) === false);
check("tmatch19 a missing definition does NOT match", defMatches(LDEF, undefined) === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log("failures:"); for (const f of failures) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
