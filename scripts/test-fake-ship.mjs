#!/usr/bin/env node
// test-fake-ship.mjs - walks the red team's cheapest path to "shipped" and
// proves every step is refused.
//
// This is the M0 exit criterion: one command that answers "can a run fake a
// ship?" with no. The four cheapest paths, cheapest first:
//
//   1. whitespace evidence         -> complete 0 --evidence "   "
//   2. repeated-letter gate reason -> gate A --evidence "aaaaaaaaaaaa"
//   3. a bare bd gate resolve      -> close the gate by hand, then try enter 3
//   4. no beads workspace at all   -> status from an empty directory
//
//   node scripts/test-fake-ship.mjs
//
// Exit 0 = all four refused ("4/4 fake-ship paths refused."). Anything else is
// a defect in the machine it drives, not an excuse to weaken a case here.
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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
check("case 1: whitespace evidence is REFUSED", r.code === 1 && has(r.out, "not informative"),
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
must("complete 1", phase(["complete", bead, "1", "--evidence", "brainstormed the design; 4 directions captured, 1 kept and 3 rejected", "--quiet"]));
// enter 2 requires a brainstorm artifact on disk; make sure the refusal, when
// the cases below get one, is about the fake content and not this file.
const BRAINSTORM = join(SANDBOX, "docs", "superpowers", "brainstorms", "0000-00-00-fake-ship-probe.md");
mkdirSync(dirname(BRAINSTORM), { recursive: true });
writeFileSync(BRAINSTORM, "# fake-ship probe brainstorm\n");
// No --quiet here: the GATE A chatter the assertion needs is suppressed by it
// (a lesson already paid for in the phase suite).
must("enter 2 raises GATE A", phase(["enter", bead, "2", "--reason", "the spec is written"]), "GATE A");

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
  !!gateId && resolveCode === 0 && refused3.code === 2 && has(refused3.out, "GATE A is pending"),
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

// ---------------------------------------------------------------- report
if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
try { rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* locked temp: note, not a verdict */ }
console.log(`\n${pass}/${pass + fail} fake-ship paths refused.`);
process.exit(fail ? 1 : 0);
