#!/usr/bin/env node
// test-fake-ship.mjs - walks the red team's cheapest path to "shipped" and
// proves every step is refused.
//
// This is the M0 exit criterion: one command that answers "can a run fake a
// ship?" with no. The six cheapest paths, cheapest first:
//
//   1. whitespace evidence         -> complete 0 --evidence "   "
//   2. repeated-letter gate reason -> gate A --evidence "aaaaaaaaaaaa"
//   3. a bare bd gate resolve      -> close the gate by hand, then try enter 3
//   4. no beads workspace at all   -> status from an empty directory
//   5. a stale artifact            -> attested at one commit, then the work moved on
//   6. an edited artifact          -> attested, then one byte changed
//
//   node scripts/test-fake-ship.mjs
//
// Exit 0 = all six refused ("6/6 fake-ship paths refused."). Anything else is
// a defect in the machine it drives, not an excuse to weaken a case here.
//
// Cases 5 and 6 are the M1a half: they need a git repo, a policy and a bead
// that has walked to phase 5, all created AFTER the M0 cases so those four
// still run policy-free.
//
// Every probe drives the REAL `bd` CLI and the REAL machine against a throwaway
// sandbox it creates and deletes itself, so the repo does not need a .beads of
// its own and the second run starts from nothing.
//
// FAKE_SHIP_PHASE_SCRIPT is a verification seam, for mutation testing only:
// point it at a scratch COPY of factory-phase.mjs to prove a case can fail when
// its guard is removed. It defaults to the real machine and is never set by a
// normal run, so it cannot weaken anything.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.FAKE_SHIP_PHASE_SCRIPT || join(HERE, "factory-phase.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "fake-ship-test-"));
const BEADS = join(SANDBOX, ".beads");

let pass = 0, fail = 0;
const failures = [];

function run(cmd, args, env = {}) {
  // Same shape as scripts/test-factory-phase.mjs: stdout AND stderr captured on
  // both paths, cwd pinned to the sandbox so bd's agent scaffolding is written
  // into the throwaway directory and not into this repo.
  const opts = { encoding: "utf8", env: { ...process.env, ...env }, cwd: SANDBOX };
  try {
    return { code: 0, out: execFileSync(cmd, args, opts) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}
const bd = (args) => run("bd", args, { BEADS_DIR: BEADS, BEADS_NO_DOLT: "1" });
const phase = (args) => run(process.execPath, [SCRIPT, ...args], { BEADS_DIR: BEADS });

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const has = (s, sub) => String(s).includes(sub);

// ---------------------------------------------------------------- setup
mkdirSync(BEADS, { recursive: true });
const init = run("bd", ["init"], { BEADS_DIR: BEADS, BEADS_NO_DOLT: "1" });
if (init.code !== 0) { console.error("bd init failed:\n" + init.out); process.exit(1); }

const created = bd(["create", "--title", "fake-ship probe", "--json"]);
const bead = (() => {
  try {
    const j = JSON.parse(created.out);
    return Array.isArray(j) ? (j[0] && j[0].id) : (j && j.id);
  } catch { return null; }
})();
if (!bead) { console.error("could not create the probe bead:\n" + created.out); process.exit(1); }

console.log(`\nsandbox: ${SANDBOX}`);
console.log(`bead:    ${bead}`);
console.log(`machine: ${SCRIPT}\n`);

// Bead-scoped on purpose (the plan snippet used a global `bd gate list --all
// --json`, which can hand back another bead's gate): list THE PROBE BEAD's
// gates. bd 1.3.0 prints the literal `null` for an empty scope, so a parse of
// `null` is an empty list, not a crash; the resolution text, if any, lives in
// `close_reason` (probed, not assumed - the same row the machine reads).
function gateList(b) {
  const raw = bd(["gate", "list", b, "--all", "--json"]);
  try {
    const rows = JSON.parse(raw.out) ?? [];
    return Array.isArray(rows) ? rows : (rows && rows.gates) || [];
  } catch { return []; }
}
const isOpen = (g) => ["open", "pending"].includes(String(g.status || g.state || "open").toLowerCase());

// ---------------------------------------------------------------- case 1
// Whitespace evidence on a VIRGIN bead. cmdComplete judges the evidence before
// it judges the phase, so this is not "cannot complete": it is the evidence
// floor speaking, exit 1. " " is truthy - a machine without the floor accepts
// it, which is the exact lying this milestone exists to kill.
let r = phase(["complete", bead, "0", "--evidence", "   ", "--quiet"]);
check("case 1: whitespace evidence is REFUSED", r.code === 1 && has(r.out, "not informative") && !has(r.out, "cannot complete"),
  `code ${r.code} ${r.out.slice(0, 200)}`);

// ---------------------------------------------------------------- setup
// The walk's legal steps, with real evidence so only the fake parts below get
// refused. Stop at `enter 2` (Correction A): entering 2 is what raises GATE A,
// and the gate cases do not need phase 2 completed - completing it would
// require the gate approved, which is the refusal they are about to test.
// Step 0 first: a fresh bead has NO phase recorded, and `complete` refuses
// "(none)", so the walk onboards before it completes. These are legal steps,
// not cases - each failure here is a broken setup, reported and stopped.
const must = (label, res, okSub) => {
  if (res.code !== 0 || (okSub && !has(res.out, okSub))) {
    console.error(`setup: ${label} failed (code ${res.code}):\n` + res.out.slice(0, 400));
    process.exit(1);
  }
};
must("enter 0", phase(["enter", bead, "0", "--reason", "onboarding the walk", "--quiet"]));
must("complete 0", phase(["complete", bead, "0", "--evidence", "ran bd init and bd ready: a fresh workspace came up with no blockers", "--quiet"]));
must("enter 1", phase(["enter", bead, "1", "--reason", "walking the cheapest fake-ship path", "--quiet"]));
// G1 is raised by enter 1. Approve it so the only gate left open below is the
// spec gate this suite is testing; otherwise the open-gate counts would include it.
must("approve G1", phase(["gate", bead, "G1", "--evidence", "worth building: one direction survived the cheapest-path probe", "--quiet"]));
must("complete 1", phase(["complete", bead, "1", "--evidence", "brainstormed the design; 4 directions captured, 1 kept and 3 rejected", "--quiet"]));
// enter 2 requires a brainstorm artifact on disk; make sure the refusal, when
// the cases below get one, is about the fake content and not this file.
const BRAINSTORM = join(SANDBOX, "docs", "superpowers", "brainstorms", "0000-00-00-fake-ship-probe.md");
mkdirSync(dirname(BRAINSTORM), { recursive: true });
writeFileSync(BRAINSTORM, "# fake-ship probe brainstorm\n");
// No --quiet here: the GATE G2a chatter the assertion needs is suppressed by it
// (a lesson already paid for in the phase suite).
must("enter 2 raises GATE G2a", phase(["enter", bead, "2", "--reason", "the spec is written"]), "GATE G2a");

// ---------------------------------------------------------------- case 2
// A repeated-letter gate reason: twelve letters, one distinct character. Same
// floor as phase evidence, and it must not silently resolve the gate either -
// a refusal that flips the gate open is a bypass, so assert the gate is still
// standing after the refusal.
r = phase(["gate", bead, "A", "--evidence", "aaaaaaaaaaaa", "--quiet"]);
const openAfter = gateList(bead).filter(isOpen).length;
check("case 2: repeated-letter gate reason is REFUSED and leaves the gate open",
  r.code === 1 && has(r.out, "not informative") && openAfter === 1,
  `code ${r.code} open=${openAfter} ${r.out.slice(0, 200)}`);

// ---------------------------------------------------------------- case 3
// A bare `bd gate resolve` (no --reason) is not an approval: the row goes
// "closed" with no close_reason, and the machine reads a record from the
// factory, not a hand-closed status. Find the open gate bead-scoped, close it
// by hand with no reason, and demand phase 3 anyway.
const open = gateList(bead).find(isOpen);
const gateId = open && (open.id || open.gate_id);
let refused3 = { code: -1, out: "" };
let resolveCode = -1;
if (gateId) {
  // No --reason. bd 1.3.0 accepts the bare resolve; the machine must not count
  // it. (Passing a reason here would feed the guard its own approve-shaped
  // text, so the bypass is deliberately left naked.)
  const raw = bd(["gate", "resolve", gateId]);
  resolveCode = raw.code;
  refused3 = phase(["enter", bead, "3", "--reason", "the gate row says closed, let me into phase 3", "--quiet"]);
}
check("case 3: a bare resolve is not an approval - phase 3 stays BLOCKED",
  !!gateId && resolveCode === 0 && refused3.code === 2 && has(refused3.out, "GATE G2a is pending"),
  `gateId=${gateId} resolve=${resolveCode} enter=${refused3.code} ${refused3.out.slice(0, 200)}`);

// ---------------------------------------------------------------- case 4
// No beads workspace at all. run() pins cwd: SANDBOX, so this one goes through
// execFileSync directly (Correction C): the child must run in a directory with
// NO .beads and BEADS_DIR empty, where an unfailing gate reader used to report
// "nothing pending" instead of refusing.
const empty = mkdtempSync(join(tmpdir(), "fake-ship-no-beads-"));
let escaped;
try {
  escaped = { code: 0, out: execFileSync(process.execPath, [SCRIPT, "status", bead, "--quiet"], {
    encoding: "utf8", cwd: empty, env: { ...process.env, BEADS_DIR: "" },
  }) };
} catch (e) {
  escaped = { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
}
try { rmSync(empty, { recursive: true, force: true }); } catch { /* locked */ }
check("case 4: a run outside a beads workspace is REFUSED, not reported gate-free",
  escaped.code === 1 && has(escaped.out, "no beads workspace"),
  `code ${escaped.code} ${escaped.out.slice(0, 200)}`);

// ---------------------------------------------------------------- setup for 5 and 6
// M1a cases: completion against a manifest needs a git repo (the manifest records
// a commit), a policy (without one, `complete` is M0 and there is nothing to
// attest), and a bead that has legally walked to phase 5. All three are created
// here, after the M0 cases, so those four still run policy-free.
//
// A fresh `git init` on a tree with no tracked files has nothing to `git add`,
// but the commit is only there so HEAD exists - so the base commit is allowed to
// be empty and the add step is skipped when it would fail on an empty index.
must("git init", run("git", ["init", "-q"]));
// Nothing tracked yet is fine: the commit below is `--allow-empty` for exactly this.
run("git", ["add", "-A"]);
must("git base commit", run("git", ["-c", "user.email=fake@ship", "-c", "user.name=fake ship", "commit", "-q", "--allow-empty", "-m", "sandbox base"]));

mkdirSync(join(SANDBOX, "config"), { recursive: true });
writeFileSync(join(SANDBOX, "config", "factory.policy.yaml"), [
  "version: 1",
  "tier: prototype",
  "profile: web",
  "",
  "tiers:",
  "  prototype:",
  "    checks: [run]",
  "",
  "profiles:",
  "  web:",
  "    checks: []",
  "",
  "checks:",
  "  run:",
  "    phase: 5",
  "    kind: transcript",
  "    command: npm run dev",
  "",
].join("\n"));

// Phase 5's `--artifact` must name a file that exists; the walk below writes it.
const BOOT_LOG = join(SANDBOX, "boot.log");
writeFileSync(BOOT_LOG, "200 OK\n");

// The sanctioned walk, copied from scripts/test-factory-phase.mjs (never
// imported - that file runs a 20-minute suite on import). Each step carries
// real-looking evidence so only the fake parts under test get refused.
const RAN_CLAIM = "npm run dev -> 200 OK on GET /health at 2026-10-20T10:00:00Z";
const GATE_LETTER = { "2": "A", "3": "B" };

function newBead(title) {
  const res = bd(["create", "--title", title, "--json"]);
  try {
    const j = JSON.parse(res.out);
    return Array.isArray(j) ? (j[0] && j[0].id) : (j && j.id) || null;
  } catch {
    console.error(`could not parse bead id for "${title}":\n${res.out}`);
    return null;
  }
}
const approveGate = (b, letter, why) => phase(["gate", b, letter, "--evidence", why, "--quiet"]);

// Walk a fresh bead to `target`, clearing exactly the gates that stand in the
// way: Gate A before completing phase 2, Gate B before completing phase 3. Every
// step's failure is a broken setup and is reported as one - a broken setup is not
// a refusal, so these throw rather than count a pass.
function walkTo(b, target) {
  if (!b) throw new Error("walkTo: no bead to walk");
  for (const p of ["0", "1", "2", "3", "4"]) {
    if (Number(p) >= Number(target)) break;
    const entered = phase(["enter", b, p, "--reason", `walk to phase ${p}`, "--quiet"]);
    if (entered.code !== 0) throw new Error(`walkTo: enter ${p} failed: ${entered.out.slice(0, 300)}`);
    if (p === "1") {
      const g = approveGate(b, "G1", "worth building: one direction survived and three were rejected");
      if (g.code !== 0) throw new Error(`walkTo: gate G1 failed: ${g.out.slice(0, 300)}`);
    }
    const letter = GATE_LETTER[p];
    if (letter) {
      const g = approveGate(b, letter, `the ${letter} gate evidence is on disk and the checklist passed`);
      if (g.code !== 0) throw new Error(`walkTo: gate ${letter} failed: ${g.out.slice(0, 300)}`);
    }
    const done = phase(["complete", b, p, "--evidence", `phase ${p} ran its checks and they passed`, "--quiet"]);
    if (done.code !== 0) throw new Error(`walkTo: complete ${p} failed: ${done.out.slice(0, 300)}`);
  }
  const target_ = phase(["enter", b, String(target), "--reason", `walk to phase ${target}`, "--quiet"]);
  if (target_.code !== 0) throw new Error(`walkTo: enter ${target} failed: ${target_.out.slice(0, 300)}`);
  return b;
}

const ATTEST = join(HERE, "factory-attest.mjs");
const attest = (beadId, path, id) =>
  run(process.execPath, [ATTEST, "attest", beadId, path, "--id", id, "--kind", "transcript"], { BEADS_DIR: BEADS });
const gitCommit = (msg) =>
  run("git", ["-c", "user.email=fake@ship", "-c", "user.name=fake ship", "commit", "-q", "--allow-empty", "-m", msg]);

// ---------------------------------------------------------------- case 5
// Attested, then the repository moved on. The bytes are unchanged, so a
// hash-only check would pass - freshness is the check that catches this.
const b5 = walkTo(newBead("fake-ship stale"), "5");
r = attest(b5, "boot.log", "run");
must("case 5 setup: the artifact attests", r, "attested");
must("case 5 setup: the work moved on", gitCommit("the work moved on"));
r = phase(["complete", b5, "5", "--evidence", "ran the app locally and the health endpoint answered", "--ran", RAN_CLAIM, "--artifact", "boot.log", "--quiet"]);
check("case 5: a stale artifact is REFUSED", r.code === 1 && has(r.out, "STALE") && has(r.out, "factory-attest attest"),
  `code ${r.code} ${r.out.slice(0, 300)}`);

// ---------------------------------------------------------------- case 6
// Attested, then one byte changed. Freshness holds (no new commit), so the hash
// is the check that catches this one.
const b6 = walkTo(newBead("fake-ship edited"), "5");
writeFileSync(join(SANDBOX, "run2.txt"), "npm run dev -> 200 OK\n");
r = attest(b6, "run2.txt", "run");
must("case 6 setup: the artifact attests", r, "attested");
appendFileSync(join(SANDBOX, "run2.txt"), "x");
r = phase(["complete", b6, "5", "--evidence", "ran the app locally and the health endpoint answered", "--ran", RAN_CLAIM, "--artifact", "boot.log", "--quiet"]);
check("case 6: an edited artifact is REFUSED", r.code === 1 && has(r.out, "HASH run") && has(r.out, "factory-attest attest"),
  `code ${r.code} ${r.out.slice(0, 300)}`);

// ---------------------------------------------------------------- report
if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
try { rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* locked temp: note, not a verdict */ }
console.log(`\n${pass}/${pass + fail} fake-ship paths refused.`);
process.exit(fail ? 1 : 0);
