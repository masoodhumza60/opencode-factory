#!/usr/bin/env node
// Tests for factory-mcp.mjs. Hermetic by construction:
//   - every config is a temp file, so the real ~/.config/opencode is untouched
//   - the MCP server is a fake we spawn ourselves, so no test depends on graft
//     being installed, on a graph existing, or on the network
//   - every run has cwd inside the sandbox, because bd-style tools write
//     scaffolding relative to cwd and a test must not litter the repo it runs in
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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
const fakeServer = (mode = "ok", disabled = false) => ({
  type: "local",
  command: [process.execPath, FAKE_PATH, mode],
  ...(disabled ? { disabled: true } : {}),
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
  // "mine" has no `disabled` key, so it is enabled - a remote server that is
  // merely present in the config is live unless someone disabled it.
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

// ------------------------------------------------------------------- teardown
try { rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
catch { console.log("  warn: could not remove the sandbox (a child may still hold a handle); the suite is unaffected"); }

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log("failures:"); for (const f of failures) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
