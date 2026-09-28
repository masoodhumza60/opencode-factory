#!/usr/bin/env node
// test-factory-phase.mjs - proves the phase machine refuses illegal transitions.
//
// Every test drives the real `bd` CLI against a throwaway database, so this
// exercises the actual gate semantics rather than a mock. The tests that matter
// most are the refusals: a state machine that cannot say no is decoration.
//
//   node scripts/test-factory-phase.mjs
//
// Exit 0 = every case behaved as specified.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-phase.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "factory-phase-test-"));
const BEADS = join(SANDBOX, ".beads");

let pass = 0, fail = 0;
const failures = [];

function run(cmd, args, env = {}) {
  // cwd matters as much as BEADS_DIR: bd writes its agent scaffolding
  // (AGENTS.md, CLAUDE.md, .claude/, .codex/, .cursor/, .agents/) relative to
  // the working directory, so a suite that only redirected BEADS_DIR still
  // littered whichever repo it was launched from. Every bd call runs inside
  // the throwaway sandbox instead.
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
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const has = (s, sub) => String(s).includes(sub);

// ---------------------------------------------------------------- setup
mkdirSync(BEADS, { recursive: true });
const init = run("bd", ["init"], { BEADS_DIR: BEADS, BEADS_NO_DOLT: "1" });
if (init.code !== 0) { console.error("bd init failed:\n" + init.out); process.exit(1); }
function newBead(title) {
  const r = bd(["create", "--title", title, "--json"]);
  try {
    const j = JSON.parse(r.out);
    return Array.isArray(j) ? (j[0] && j[0].id) : (j && j.id) || null;
  } catch {
    console.error(`could not parse bead id for "${title}":\n${r.out}`);
    return null;
  }
}
const bead = newBead("test feature");
if (!bead) process.exit(1);

// Fail closed on a dirty sandbox. Every test below assumes a virgin bead; if
// that is not true the suite reports nonsense instead of a real failure.
const virgin = bd(["state", bead, "phase"]);
if (!/\(no .* state set\)/.test(virgin.out)) {
  console.error(`sandbox is NOT virgin - ${bead} already has phase state:\n${virgin.out}`);
  console.error(`BEADS_DIR=${BEADS}`);
  process.exit(1);
}

console.log(`\nsandbox: ${SANDBOX}\nbead:    ${bead}\n`);

// ---------------------------------------------------------------- tests
console.log("fresh bead");
let r = phase(["next", bead, "--quiet"]);
check("no phase recorded -> 0 and 1 are legal", has(r.out, "legal next: 0, 1"), r.out);
check("fresh next exits 0", r.code === 0, `code ${r.code}`);

console.log("\nlegality");
r = phase(["enter", bead, "5", "--reason", "skip ahead", "--quiet"]);
check("jumping straight to 5 from nothing is REFUSED", r.code === 1 && has(r.out, "illegal transition"), r.out);

r = phase(["enter", bead, "0", "--reason", "onboarded", "--quiet"]);
check("entering 0 succeeds", r.code === 0, r.out);

r = phase(["enter", bead, "5", "--reason", "jump", "--quiet"]);
check("skipping to 5 from 0 is REFUSED", r.code === 1 && has(r.out, "illegal"), r.out);

r = phase(["enter", bead, "9", "--reason", "bogus", "--quiet"]);
check("unknown phase is REFUSED", r.code === 1 && has(r.out, "unknown phase"), r.out);

r = phase(["enter", bead, "1", "--quiet"]);
check("enter without --reason is REFUSED", r.code === 1 && has(r.out, "--reason is required"), r.out);

console.log("\nphase 2 creates GATE A and blocks phase 3");
r = phase(["enter", bead, "1", "--reason", "brainstormed", "--quiet"]);
check("entering 1 succeeds", r.code === 0, r.out);
// No --quiet here: this test asserts on the side effect being reported.
r = phase(["enter", bead, "2", "--reason", "spec written"]);
check("entering 2 succeeds and creates GATE A", r.code === 0 && has(r.out, "GATE A created"), r.out);

r = phase(["next", bead, "--quiet"]);
check("next reports 3 blocked by GATE A", has(r.out, "3 (GATE A pending)"), r.out);
check("blocked next exits 2", r.code === 2, `code ${r.code}`);

r = phase(["enter", bead, "3", "--reason", "planning", "--quiet"]);
check("entering 3 while GATE A pending is BLOCKED", r.code === 2 && has(r.out, "GATE A is pending"), r.out);

r = phase(["status", bead, "--quiet"]);
check("status shows GATE A pending", has(r.out, "A PENDING"), r.out);

const gates = bd(["gate", "list", "--all", "--json"]);
const gateId = (() => {
  try {
    const rows = JSON.parse(gates.out);
    const list = Array.isArray(rows) ? rows : (rows.gates || []);
    return list[0] && (list[0].id || list[0].gate_id);
  } catch { return null; }
})();
check("gate id was recorded", !!gateId, gates.out.slice(0, 200));

if (gateId) {
  bd(["gate", "resolve", gateId]);
  r = phase(["enter", bead, "3", "--reason", "gate A approved", "--quiet"]);
  check("after resolving GATE A, entering 3 succeeds", r.code === 0, r.out);
}

console.log("\nphase 3 creates GATE B and blocks implementation");
r = phase(["enter", bead, "4", "--reason", "writing code", "--quiet"]);
check("entering 4 while GATE B pending is BLOCKED", r.code === 2 && has(r.out, "GATE B is pending"), r.out);

const gates2 = bd(["gate", "list", "--all", "--json"]);
const g2 = (() => {
  try {
    const rows = JSON.parse(gates2.out);
    const list = (Array.isArray(rows) ? rows : (rows.gates || [])).filter((g) => {
      const s = String(g.status || g.state || "open");
      return s === "open" || s === "pending";
    });
    return list[0] && (list[0].id || list[0].gate_id);
  } catch { return null; }
})();
if (g2) bd(["gate", "resolve", g2]);
r = phase(["enter", bead, "4", "--reason", "gate B approved", "--quiet"]);
check("after resolving GATE B, entering 4 succeeds", r.code === 0, r.out);

console.log("\ncompletion is evidence-gated");
r = phase(["complete", bead, "4", "--quiet"]);
check("complete without --evidence is REFUSED", r.code === 1 && has(r.out, "--evidence is required"), r.out);
r = phase(["complete", bead, "5", "--evidence", "x", "--quiet"]);
check("completing a phase you are not in is REFUSED", r.code === 1 && has(r.out, "cannot complete"), r.out);
r = phase(["complete", bead, "4", "--evidence", "tests green: 12/12", "--quiet"]);
check("completing the current phase succeeds", r.code === 0, r.out);

console.log("\ndebug detour and handoff");
r = phase(["enter", bead, "4p", "--reason", "build failed", "--quiet"]);
check("entering the debug detour from 4 succeeds", r.code === 0, r.out);
r = phase(["next", bead, "--quiet"]);
check("from debug, 4 or 5 are both legal", has(r.out, "legal next: 4, 5"), r.out);
r = phase(["enter", bead, "4", "--reason", "debugged", "--quiet"]);
check("returning from debug to 4 succeeds", r.code === 0, r.out);

r = phase(["handoff", bead, "--quiet"]);
check("handoff without --next is REFUSED", r.code === 1 && has(r.out, "--next is required"), r.out);
r = phase(["handoff", bead, "--next", "run vitest"]);
check("handoff with a next action succeeds", r.code === 0 && has(r.out, "next: run vitest"), r.out);

console.log("\nfail-closed on junk state");
const badBead = newBead("corrupt");
if (badBead) {
  r = phase(["status", "no-such-bead-xyz", "--quiet"]);
  check("status on a nonexistent bead does not crash or exit 0", r.code === 1 || r.code === 2, `code ${r.code}`);
  check("status on a nonexistent bead says so", has(r.out, "ERROR") || has(r.out, "no beads") || has(r.out, "not found"), r.out);
} else {
  check("could create a second bead for the fail-closed test", false, bad.out.slice(0, 120));
}

// ---------------------------------------------------------------- report
console.log(`\n${pass}/${pass + fail} phase-machine tests passed.`);
if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
// bd's Dolt database can stay locked for a moment after the last command, so
// retry the remove; a locked temp dir is a cleanup note, never a test result.
try { rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
process.exit(fail ? 1 : 0);
