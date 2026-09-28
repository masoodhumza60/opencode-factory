#!/usr/bin/env node
// test-factory-plan.mjs - proves factory-plan.mjs can actually fail.
//
// The rule this suite exists to honour: a check that cannot fail is a bug, and a
// check shipped without a negative test is an unfinished check. Every rule in
// the validator has a case here that must FAIL, and the graph path is driven
// against the real `bd` CLI in a throwaway sandbox - no mocks, because a mock
// cannot tell you that bd's graph schema is the shape you assumed.
//
// NOTE the cwd. bd writes its agent scaffolding (AGENTS.md, CLAUDE.md, .claude/,
// .codex/, .cursor/, .agents/) relative to the working directory, so a suite that
// redirected only BEADS_DIR littered whichever repo it was launched from. Every
// call below runs with cwd inside the sandbox.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-plan.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "factory-plan-test-"));
const ENV = { ...process.env, BEADS_DIR: join(SANDBOX, ".beads") };

// bd's agent scaffolding, which this suite must never create in the bundle. The
// check is DIFFERENTIAL, not absolute: the installer itself creates
// .agents/skills/ in the bundle on every run, so asserting these paths are
// absent made the suite pass standalone and fail inside an install - an
// environment-dependent test, the exact trap the selfcheck suite already fell
// into once. We record what was here before we ran and only blame what we added.
const BUNDLE = join(HERE, "..");
const BD_SCAFFOLDING = ["AGENTS.md", "CLAUDE.md", ".claude", ".codex", ".cursor", ".agents"];

// Snapshot the FILES, not just the top-level paths: a pre-existing .agents/
// directory (the installer creates it) could still collect new files from this
// suite, and "the path existed before" must not become an excuse.
function scaffoldSnapshot() {
  const found = new Set();
  for (const p of BD_SCAFFOLDING) {
    const full = join(BUNDLE, p);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) {
      for (const f of readdirSync(full, { recursive: true })) found.add(`${p}/${f}`);
    } else {
      found.add(p);
    }
  }
  return found;
}
const preExisting = scaffoldSnapshot();

// bd does not auto-initialise. Doing it here, with cwd already inside the
// sandbox, is also what keeps its agent scaffolding out of the bundle repo.
const BOOT = execFileSync("bd", ["init"], { encoding: "utf8", cwd: SANDBOX, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
if (!/beads|init|initial/i.test(BOOT) && !existsSync(join(SANDBOX, ".beads"))) {
  console.error("could not initialise a beads database in the sandbox; cannot test the graph path");
  process.exit(1);
}

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Every invocation runs inside the sandbox, both for BEADS_DIR and for cwd.
function run(script, argv, { cwd = SANDBOX, env = ENV } = {}) {
  try {
    return { code: 0, out: execFileSync("node", [script, ...argv], { encoding: "utf8", cwd, env, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}
const plan = (argv) => run(SCRIPT, argv);
const bd = (argv) => {
  try {
    return { code: 0, out: execFileSync("bd", argv, { encoding: "utf8", cwd: SANDBOX, env: ENV, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
};

function fixture(name, json) {
  const p = join(SANDBOX, name);
  writeFileSync(p, typeof json === "string" ? json : JSON.stringify(json), "utf8");
  return p;
}
const GOOD = {
  nodes: [
    { key: "t1", title: "Domain types", acceptance_criteria: "tsc passes", type: "task", priority: 1 },
    { key: "t2", title: "Gateway port", acceptance_criteria: "interface exists", type: "task", deps: [{ target: "t1" }] },
  ],
};
// A plan that passes validate, for the graph tests.
function writeGood(name = "plan.json") { return fixture(name, GOOD); }

function newFeature(title) {
  const r = bd(["create", "--json", title]);
  return (JSON.parse(r.out).id);
}
function issueCount() {
  const r = bd(["list", "--json", "--status", "all"]);
  if (r.code !== 0) return -1;
  const j = JSON.parse(r.out);
  return Array.isArray(j) ? j.length : (j.issues || []).length;
}

// ---- validate: the accepted path ------------------------------------------------
check("validate accepts a well-formed plan", () => {
  const r = plan(["validate", writeGood()]);
  assert(r.code === 0, `expected 0, got ${r.code}: ${r.out}`);
  assert(/valid:\s+yes/.test(r.out), `missing the yes verdict:\n${r.out}`);
  assert(/nodes:\s+2/.test(r.out), `node count wrong:\n${r.out}`);
});
check("validate reports the dependency count", () => {
  const r = plan(["validate", writeGood()]);
  assert(/deps:\s+1/.test(r.out), `expected deps: 1:\n${r.out}`);
});

// ---- validate: every rule must be able to fail ----------------------------------
const MUST_FAIL = [
  ["empty nodes array", { nodes: [] }, /no nodes/i],
  ["nodes is not an array", { nodes: "t1" }, /no nodes/i],
  ["missing key", { nodes: [{ title: "x", acceptance_criteria: "a" }] }, /"key" is required/i],
  ["empty title", { nodes: [{ key: "t1", title: "  ", acceptance_criteria: "a" }] }, /"title" is required/i],
  ["duplicate keys", { nodes: [{ key: "t1", title: "a", acceptance_criteria: "x" }, { key: "t1", title: "b", acceptance_criteria: "y" }] }, /duplicate key/i],
  ["key with a space", { nodes: [{ key: "t 1", title: "a", acceptance_criteria: "x" }] }, /must match/i],
  ["task with no acceptance_criteria", { nodes: [{ key: "t1", title: "a", type: "task" }] }, /requires non-empty "acceptance_criteria"/i],
  ["bug with no acceptance_criteria", { nodes: [{ key: "t1", title: "a", type: "bug" }] }, /requires non-empty "acceptance_criteria"/i],
  ["the misnamed acceptance field", { nodes: [{ key: "t1", title: "a", acceptance: "x" }] }, /acceptance_criteria/],
  ["the unsupported skills field", { nodes: [{ key: "t1", title: "a", acceptance_criteria: "x", skills: ["tdd"] }] }, /cannot carry required skills/i],
  ["depends_on instead of deps", { nodes: [{ key: "t1", title: "a", acceptance_criteria: "x", depends_on: ["t2"] }] }, /deps/],
  ["deps as bare strings", { nodes: [{ key: "t1", title: "a", acceptance_criteria: "x", deps: ["t2"] }] }, /no "target"/i],
  ["dangling dep target", { nodes: [{ key: "t1", title: "a", acceptance_criteria: "x", deps: [{ target: "nope" }] }] }, /not a key in this plan/i],
  ["dangling parent", { nodes: [{ key: "t1", title: "a", acceptance_criteria: "x", parent: "nope" }] }, /not a key in this plan/i],
  ["non-integer estimate", { nodes: [{ key: "t1", title: "a", acceptance_criteria: "x", estimate: "1h" }] }, /estimate" must be an integer/i],
  ["unknown top-level field", { tasks: [], nodes: [{ key: "t1", title: "a", acceptance_criteria: "x" }] }, /unknown top-level field/i],
  ["file is not JSON", "this is not json", /not valid JSON/i],
];
for (const [name, body, want] of MUST_FAIL) {
  check(`validate refuses: ${name}`, () => {
    const r = plan(["validate", fixture(`bad-${name.replace(/\W+/g, "-")}.json`, body)]);
    assert(r.code === 1, `expected exit 1, got ${r.code}: ${r.out}`);
    assert(want.test(r.out), `message did not match ${want}:\n${r.out}`);
  });
}

// ---- validate: the fingerprint must mean something -------------------------------
check("fingerprint ignores formatting but not content", () => {
  const a = plan(["validate", fixture("fp-a.json", { nodes: [{ key: "t1", title: "a", acceptance_criteria: "x" }] })]);
  const b = plan(["validate", fixture("fp-b.json", '{ "nodes" : [ { "title" : "a" , "acceptance_criteria" : "x" , "key" : "t1" } ] }')]);
  const c = plan(["validate", fixture("fp-c.json", { nodes: [{ key: "t1", title: "CHANGED", acceptance_criteria: "x" }] })]);
  const grab = (r) => r.out.match(/fingerprint:\s*(\S+)/)[1];
  assert(grab(a) === grab(b), "reformatting the file changed the fingerprint");
  assert(grab(a) !== grab(c), "changing a title did not change the fingerprint");
});

// ---- graph: dry run must write nothing -------------------------------------------
check("graph --dry-run reports without writing", () => {
  const feat = newFeature("dry-run feature");
  const before = issueCount();
  const r = plan(["graph", writeGood("dry.json"), "--issue", feat, "--dry-run"]);
  assert(r.code === 0, `expected 0, got ${r.code}: ${r.out}`);
  assert(/would create 2 issue/.test(r.out), `no plan summary:\n${r.out}`);
  assert(issueCount() === before, "dry run created issues");
});

// ---- graph: the real thing, against real bd --------------------------------------
const feat = newFeature("feature: payments");
const nested = fixture("nested.json", {
  nodes: [
    { key: "t1", title: "Domain types", acceptance_criteria: "tsc passes", type: "task", priority: 1 },
    { key: "t2", title: "Gateway port", acceptance_criteria: "interface exists", type: "task", deps: [{ target: "t1" }] },
    { key: "t3", title: "Fake adapter", acceptance_criteria: "checkout clickable", type: "task", parent: "t2" },
  ],
});
const applied = plan(["graph", nested, "--issue", feat]);

check("graph creates one issue per node and reports the ids", () => {
  assert(applied.code === 0, `expected 0, got ${applied.code}: ${applied.out}`);
  for (const k of ["t1", "t2", "t3"]) assert(new RegExp(`${k} -> \\S+`).test(applied.out), `no id reported for ${k}:\n${applied.out}`);
  assert(/created:\s+3 issue/.test(applied.out), `wrong count:\n${applied.out}`);
});
// Read the real parent field rather than scraping `bd children` output: that
// command prints the whole subtree, so a substring test cannot tell a direct
// child from a nested one - which is exactly the distinction under test here.
function parentOf(id) {
  const r = bd(["show", id, "--json"]);
  assert(r.code === 0, `bd show ${id} failed: ${r.out}`);
  const j = JSON.parse(r.out);
  const o = Array.isArray(j) ? j[0] : (j.issue || j);
  return o?.parent ?? "";
}

check("graph parents the roots to the feature bead and leaves nested nodes nested", () => {
  const t1 = applied.out.match(/t1 -> (\S+)/)[1];
  const t2 = applied.out.match(/t2 -> (\S+)/)[1];
  const t3 = applied.out.match(/t3 -> (\S+)/)[1];
  assert(parentOf(t1) === feat, `root t1 should hang off the feature bead, got ${parentOf(t1)}`);
  assert(parentOf(t2) === feat, `root t2 should hang off the feature bead, got ${parentOf(t2)}`);
  assert(parentOf(t3) === t2, `nested t3 should hang off t2, got ${parentOf(t3)}`);
});
check("graph leaves dependents off the ready list", () => {
  const r = bd(["ready"]);
  const t1 = applied.out.match(/t1 -> (\S+)/)[1];
  const t2 = applied.out.match(/t2 -> (\S+)/)[1];
  assert(r.out.includes(t1), "the unblocked task is not ready");
  assert(!r.out.includes(t2), "a task with an open dependency was offered as ready");
});
check("graph runs bd lint and it passes", () => {
  assert(/lint:\s+.*No template warnings/.test(applied.out), `lint did not report clean:\n${applied.out}`);
});
check("graph records the fingerprint so a re-run can refuse", () => {
  const r = bd(["show", feat, "--json"]);
  const issue = JSON.parse(r.out);
  const issueObj = Array.isArray(issue) ? issue[0] : (issue.issue || issue);
  assert(issueObj.metadata?.plan_fingerprint, "no fingerprint stored on the feature bead");
});
check("re-applying the same plan is refused (bd is not idempotent)", () => {
  const r = plan(["graph", nested, "--issue", feat]);
  assert(r.code === 2, `expected exit 2, got ${r.code}: ${r.out}`);
  assert(/ALREADY APPLIED/.test(r.out), `no already-applied verdict:\n${r.out}`);
  assert(/--force/.test(r.out), "the refusal does not say how to override it");
});
check("an invalid plan never reaches the database", () => {
  const f = newFeature("feature: never written");
  const before = issueCount();
  const bad = fixture("never.json", { nodes: [{ key: "t1", title: "a", type: "task" }] });
  const r = plan(["graph", bad, "--issue", f]);
  assert(r.code === 1, `expected 1, got ${r.code}: ${r.out}`);
  assert(issueCount() === before, "an invalid plan still wrote issues");
});
check("graph refuses without --issue", () => {
  const r = plan(["graph", writeGood("noissue.json")]);
  assert(r.code === 1, `expected 1, got ${r.code}: ${r.out}`);
  assert(/--issue/.test(r.out), `no mention of the missing flag:\n${r.out}`);
});
check("an unknown command is refused", () => {
  const r = plan(["frobnicate", "x"]);
  assert(r.code === 1, `expected 1, got ${r.code}: ${r.out}`);
  assert(/unknown command/.test(r.out), `no unknown-command message:\n${r.out}`);
});

// ---- the suite must not damage the repo it runs in --------------------------------
check("running this suite left the bundle repo clean", () => {
  for (const f of scaffoldSnapshot()) {
    if (preExisting.has(f)) continue; // already here before we started; not ours
    assert(false, `${f} was created in the bundle repo by this suite`);
  }
});

// Windows can still be holding a handle on bd's Dolt database a moment after
// the last command exits, so removing the sandbox can fail with EPERM. That is a
// cleanup inconvenience, not a test result. Retry, then say so and move on: a
// suite that turns red for a reason unrelated to what it tests is worse than no
// suite, because it teaches people to ignore it.
try {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch (e) {
  console.warn(`\n  warn  sandbox left behind (${e.code}): ${SANDBOX}`);
}

console.log(`\n${pass}/${pass + fails.length} plan tests passed.`);
if (fails.length) { console.log(`failed: ${fails.join(", ")}`); process.exit(1); }
