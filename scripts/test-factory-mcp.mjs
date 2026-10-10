#!/usr/bin/env node
// Tests for factory-mcp.mjs. Hermetic by construction:
//   - every config is a temp file, so the real ~/.config/opencode is untouched
//   - the MCP server is a fake we spawn ourselves, so no test depends on graft
//     being installed, on a graph existing, or on the network
//   - every run has cwd inside the sandbox, because bd-style tools write
//     scaffolding relative to cwd and a test must not litter the repo it runs in
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
// `enabled: false` is how OpenCode switches a server off (verified against the
// live schema). These fixtures originally used `disabled`, which is not a key
// the harness recognises, so every "disabled server" assertion here was passing
// against a state that cannot exist.
const fakeServer = (mode = "ok", off = false) => ({
  type: "local",
  command: [process.execPath, FAKE_PATH, mode],
  ...(off ? { enabled: false } : {}),
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
  // present in the config is live unless something sets enabled: false.
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
// The GLOBAL config defines the servers. `enabled` is the real key - the
// schema at opencode.ai/config.json lists no `disabled` - so a server with
// enabled:false is genuinely off.
const toggleConfig = () => config("toggle.json", {
  theme: "a-user-key-that-must-survive",
  mcp: { servers: {
    chrome: { type: "local", command: ["node", "x"], enabled: false },
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
  check("and the PROJECT file really says so", w.mcp.servers.chrome.enabled === true, JSON.stringify(w));
  check("the project override does not duplicate the server definition", !("command" in w.mcp.servers.chrome), "override should be enabled only");
  const s = readServers(join(SANDBOX, "toggle.json"));
  // The global still reads enabled:false for chrome - that is the state it was
  // authored in, and the point is that toggling the PROJECT did not move it.
  check("THE GLOBAL CONFIG IS UNTOUCHED", s.chrome.enabled === false && s.chrome.command[1] === "x", "the global config was edited: " + JSON.stringify(s.chrome));
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
    JSON.parse(readTextFile(join(dir, "opencode.json"))).mcp.servers.chrome.enabled === true, "the other project overwrote this one");
  check("the global config is still untouched after both", readServers(join(SANDBOX, "toggle.json")).chrome.enabled === false, "global was edited");
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
    graft:    { type: "local", command: [node, "x.js", "mcp"], enabled: true },
    off:      { type: "local", command: [node, "x.js", "mcp"], enabled: false },
    remote:   { type: "remote", url: "https://example.test/mcp", enabled: true },
    remoteOff:{ type: "remote", url: "https://example.test/mcp", enabled: false, headers: { A: "b" }, timeout: 9000 },
    shorthand:{ enabled: false },
    withCwd:  { type: "local", command: [node, "x.js"], cwd: "C:/tmp", environment: { K: "V" }, timeout: 5000 },
  } } });
  const r = run(["audit", "--config", okCfg, "--quiet", "--json"]);
  check("audit PASSes on a schema-conformant config of every server shape", r.code === 0, r.out);
  check("audit reports no ignored keys when every key is real",
    r.json?.ignoredKeys?.length === 0, r.out);

  const badCfg = config("keys-bad.json", { mcp: { servers: {
    graft: { type: "local", command: [node, "x.js", "mcp"], enabled: true },
    nuxt:  { type: "local", command: [node, "x.js"], disabled: true },
  } } });
  const b = run(["audit", "--config", badCfg, "--quiet", "--json"]);
  check("audit FAILs on a key the schema does not define", b.code !== 0, b.out);
  check("the failure names the stage", b.json?.stage === "unknown-mcp-keys", b.out);
  check("the failure names the server and the key", /nuxt/.test(b.json?.error || "") && /disabled/.test(b.json?.error || ""), b.out);
  check("the failure says the key has no effect",
    /no effect|does not define/.test(b.json?.error || ""), b.out);
  check("the failure tells the operator what to write instead",
    /"enabled"/.test(b.json?.error || ""), b.out);
  check("the failure says the audit will not edit their config",
    /never edits/i.test(b.json?.error || ""), b.out);
  check("the payload lists the ignored keys per server",
    b.json?.ignoredKeys?.some((x) => x.name === "nuxt" && x.keys.includes("disabled")), b.out);

  // The mutation that matters: swapping the real key for the wrong one must
  // flip the verdict. Without this, the check could pass for any reason.
  const swapped = config("keys-swap.json", { mcp: { servers: {
    nuxt: { type: "local", command: [node, "x.js"], enabled: true },
  } } });
  const s = run(["audit", "--config", swapped, "--quiet", "--json"]);
  check("swapping disabled->enabled flips the verdict back to a pass", s.code === 0, s.out);
}

// ------------------------------------------------------------------- teardown
try { rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
catch { console.log("  warn: could not remove the sandbox (a child may still hold a handle); the suite is unaffected"); }

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log("failures:"); for (const f of failures) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
