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
// A real walk across the pipeline has to clear the human gates, or it stalls at
// phase 3 and every later assertion fails for a reason that has nothing to do
// with what is being tested. Two of my first test attempts forgot this and
// cascaded four failures out of one missing helper.
function openGate() {
  try {
    const rows = JSON.parse(bd(["gate", "list", "--all", "--json"]).out);
    const list = Array.isArray(rows) ? rows : (rows.gates || []);
    const open = list.find((x) => ["open", "pending"].includes(String(x.status || x.state || "open")));
    if (open) bd(["gate", "resolve", open.id || open.gate_id]);
  } catch { /* no gate to resolve */ }
}
const legalOf = (o) => (o.match(/legal next:.*/) || [""])[0];

// Completing verify requires a boot claim (see the boot-condition block below).
// Every walk in this file that passes through phase 5 supplies one, so it lives
// in a helper rather than a literal at each call site: a forgotten call site then
// fails as a test-setup problem rather than reading like a machine defect.
const BOOT_CLAIM = "ran: npm run dev -> 200 OK on GET /health";
const completeVerify = (b, evidence) =>
  phase(["complete", b, "5", "--evidence", evidence, "--booted", BOOT_CLAIM, "--quiet"]);
// Completing verify needs a boot claim; every other phase does not. A single
// literal for all six phases of a walk silently skipped the claim and produced
// eight correct failures downstream, so the distinction lives in one helper
// rather than being repeated - and forgotten - inside each walk loop.
const completePhase = (b, p, evidence) =>
  p === "5" ? completeVerify(b, evidence)
            : phase(["complete", b, p, "--evidence", evidence, "--quiet"]);

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

// A skip and an unfinished phase are two DIFFERENT mistakes and must produce
// two different messages. Entering 5 from 0 is a skip (5 is not the successor
// of 0 at all), so legality is the right complaint even while 0 is unfinished.
r = phase(["enter", bead, "5", "--reason", "jump", "--quiet"]);
check("skipping to 5 from 0 is REFUSED as a skip", r.code === 1 && has(r.out, "illegal transition"), r.out);
check("that message lists the only legal successor", has(r.out, "legal: 1"), r.out);

// The successor of an unfinished phase is refused for the OTHER reason, and
// that message has to name the command that fixes it.
r = phase(["enter", bead, "1", "--reason", "not done yet", "--quiet"]);
check("entering the successor of an unfinished phase is REFUSED", r.code === 1 && has(r.out, "has not been completed"), r.out);
check("it names the phase and the command that fixes it", has(r.out, "complete ") && has(r.out, bead), r.out);
r = phase(["complete", bead, "0", "--evidence", "bd init; graft build 9/9", "--quiet"]);
check("completing 0 succeeds", r.code === 0, r.out);
r = phase(["enter", bead, "1", "--reason", "onboard complete", "--quiet"]);
check("entering 1 is allowed once 0 is complete", r.code === 0, r.out);
r = phase(["complete", bead, "1", "--evidence", "back to 0 state", "--quiet"]);
check("completing 1 returns the bead to a walkable state", r.code === 0, r.out);

r = phase(["enter", bead, "9", "--reason", "bogus", "--quiet"]);
check("unknown phase is REFUSED", r.code === 1 && has(r.out, "unknown phase"), r.out);

r = phase(["enter", bead, "1", "--quiet"]);
check("enter without --reason is REFUSED", r.code === 1 && has(r.out, "--reason is required"), r.out);

// Argument order is the most common way to get this command wrong, and the
// phase table is the wrong place to be sent when it happens. `--issue` was the
// flag named in this script's design notes, so an agent working from a
// half-remembered design writes it out of habit, and the phase parser used to
// swallow it and report `unknown phase "--issue"`.
r = phase(["enter", "1", "--issue", bead, "--reason", "wrong order"]);
check("a flag this command does not have is named", r.code === 1 && has(r.out, "unknown flag --issue"), r.out);
check("that error does not blame the phase table", r.code === 1 && !has(r.out, "unknown phase"), r.out);
check("that error shows the positional form", r.code === 1 && has(r.out, "enter <bead> <phase>"), r.out);

r = phase(["enter", bead, "1", "2"]);
check("a surplus positional is REFUSED with the expected shape", r.code === 1 && has(r.out, "too many arguments") && has(r.out, "enter <bead> <phase>"), r.out);

// Its own bead: the main walk has phase 1 completed by now, so asserting
// "the successor of an unfinished phase is refused" here would pass for the
// wrong reason. This is the exact transition 7b found unguarded.
const u = newBead("unfinished phase feature");
if (u) {
  phase(["enter", u, "1", "--reason", "start", "--quiet"]);
  r = phase(["enter", u, "2", "--reason", "advance without completing 1", "--quiet"]);
  check("advancing without completing the current phase is REFUSED", r.code === 1 && has(r.out, "has not been completed"), r.out);
  r = phase(["next", u, "--quiet"]);
  check("next reports the unfinished phase as the blocker", has(r.out, "2 (phase 1 not completed)"), r.out);
  check("and exits 2 when nothing is open", r.code === 2, `code ${r.code}`);
  r = phase(["status", u, "--quiet"]);
  check("status says the current phase is not completed", has(r.out, "not completed"), r.out);
  // No --quiet: the assertion below is on the reported next phase, which is
  // chatter, not payload. --quiet is for tests that only care about the exit code.
  r = phase(["complete", u, "1", "--evidence", "done properly"]);
  check("completing it unblocks the successor", r.code === 0 && has(r.out, "next legal: 2"), r.out);
  r = phase(["enter", u, "2", "--reason", "now allowed", "--quiet"]);
  check("and the successor is now enterable", r.code === 0, r.out);
} else {
  check("could create a bead for the unfinished-phase test", false, "newBead returned nothing");
}

console.log("\nphase 2 creates GATE A and blocks phase 3");
// Phase 1 was entered AND completed above, so the successor is legal here.
// No --quiet here: this test asserts on the gate being created and reported.
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
  r = phase(["complete", bead, "2", "--evidence", "spec approved at GATE A", "--quiet"]);
  check("completing 2 after GATE A resolves succeeds", r.code === 0, r.out);
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
r = phase(["complete", bead, "3", "--evidence", "plan.md + plan.json applied", "--quiet"]);
check("completing 3 succeeds", r.code === 0, r.out);
r = phase(["enter", bead, "4", "--reason", "gate B approved", "--quiet"]);
check("after resolving GATE B, entering 4 succeeds", r.code === 0, r.out);

console.log("\ncompletion is evidence-gated");
r = phase(["complete", bead, "4", "--quiet"]);
check("complete without --evidence is REFUSED", r.code === 1 && has(r.out, "--evidence is required"), r.out);
r = phase(["complete", bead, "5", "--evidence", "x", "--quiet"]);
check("completing a phase you are not in is REFUSED", r.code === 1 && has(r.out, "cannot complete"), r.out);
r = phase(["complete", bead, "4", "--evidence", "tests green: 12/12", "--quiet"]);
check("completing the current phase succeeds", r.code === 0, r.out);

// The defect 7b found: `complete` printed the evidence and persisted nothing,
// so `phase: 4` could mean "working on it" or "finished it". These three
// assertions are the ones that would have caught it.
const doneState = bd(["state", bead, "phase_done"]);
check("completion is recorded in the state layer", has(doneState.out, "4"), doneState.out.slice(0, 200));
r = phase(["status", bead, "--quiet"]);
check("status reports the completed phase", has(r.out, "done:") && has(r.out, "4"), r.out);
check("status distinguishes complete-but-current from unfinished", has(r.out, "ready to advance"), r.out);

console.log("\ndebug detour and handoff");
r = phase(["enter", bead, "4p", "--reason", "build failed", "--quiet"]);
check("entering the debug detour from 4 succeeds", r.code === 0, r.out);
r = phase(["next", bead, "--quiet"]);
check("from debug, 4 or 5 are both legal", has(r.out, "legal next: 4, 5"), r.out);
r = phase(["enter", bead, "4", "--reason", "debugged", "--quiet"]);
check("returning from debug to 4 succeeds", r.code === 0, r.out);

// The detour must be reachable from an UNCOMPLETED 4, or the debug loop is
// unreachable - and it must not become a back door past implement.
const d = newBead("detour feature");
if (d) {
  r = phase(["enter", d, "0", "--reason", "onboard", "--quiet"]);
  r = phase(["complete", d, "0", "--evidence", "ok", "--quiet"]);
  for (const p of ["1", "2"]) {
    phase(["enter", d, p, "--reason", "walk", "--quiet"]);
    phase(["complete", d, p, "--evidence", "ok", "--quiet"]);
  }
  bd(["gate", "resolve", (() => {
    try { const rows = JSON.parse(bd(["gate", "list", "--all", "--json"]).out);
      const l = Array.isArray(rows) ? rows : (rows.gates || []); return l[0] && (l[0].id || l[0].gate_id); } catch { return null; }
  })()]);
  phase(["enter", d, "3", "--reason", "plan", "--quiet"]);
  phase(["complete", d, "3", "--evidence", "ok", "--quiet"]);
  const gb = (() => {
    try { const rows = JSON.parse(bd(["gate", "list", "--all", "--json"]).out);
      const l = (Array.isArray(rows) ? rows : (rows.gates || [])).filter((g) => {
        const s = String(g.status || g.state || "open"); return s === "open" || s === "pending"; });
      return l[0] && (l[0].id || l[0].gate_id); } catch { return null; }
  })();
  if (gb) bd(["gate", "resolve", gb]);
  r = phase(["enter", d, "4", "--reason", "implement", "--quiet"]);
  check("a second feature reaches implement", r.code === 0, r.out);
  r = phase(["enter", d, "4p", "--reason", "build failed mid-implement", "--quiet"]);
  check("the detour is reachable from an UNCOMPLETED 4", r.code === 0, r.out);
  r = phase(["enter", d, "5", "--reason", "skip implement", "--quiet"]);
  check("the detour is NOT a back door past an incomplete 4", r.code === 1 && has(r.out, "has not been completed"), r.out);
  r = phase(["enter", d, "4", "--reason", "back to implement", "--quiet"]);
  check("but returning to 4 from the detour is allowed", r.code === 0, r.out);
}

// The detour is a BRANCH, not a mandatory step. Found by a real 7b run: after
// completing phase 4 cleanly, `enter 5` was refused with "illegal transition
// 4 -> 5 (legal: 4p)", so a successful implement could not reach verify without
// first inventing a debug detour to pass through. Every test above exercised
// only the UNCOMPLETED 4, which is why all 51 of them passed while the machine
// was broken for the ordinary, successful case.
const branched = newBead("completed implement feature");
if (branched) {
  const resolveOpenGate = () => {
    try {
      const rows = JSON.parse(bd(["gate", "list", "--all", "--json"]).out);
      const list = Array.isArray(rows) ? rows : (rows.gates || []);
      const open = list.find((x) => ["open", "pending"].includes(String(x.status || x.state || "open")));
      if (open) bd(["gate", "resolve", open.id || open.gate_id]);
    } catch { /* no gate to resolve */ }
  };
  for (const p of ["0", "1", "2", "3"]) {
    phase(["enter", branched, p, "--reason", `walk toward implement (${p})`, "--quiet"]);
    phase(["complete", branched, p, "--evidence", `phase ${p} done`, "--quiet"]);
    resolveOpenGate();
  }
  r = phase(["enter", branched, "4", "--reason", "implement", "--quiet"]);
  check("reached implement with a clean history", r.code === 0, r.out);
  phase(["complete", branched, "4", "--evidence", "implemented", "--quiet"]);
  r = phase(["next", branched, "--quiet"]);
  // Assert on the `legal next:` line itself, not the whole output: the note text
  // also mentions "5" ("...or proceed to 5"), so `has(out, "5")` would pass even
  // when verify is NOT offered. A test that passes for the wrong reason is
  // decoration - the first version of this assertion did exactly that.
  const legalLine = (r.out.match(/legal next:.*/) || [""])[0];
  check("from a COMPLETED 4 the detour and verify are BOTH legal", /\b4p\b/.test(legalLine) && /(^|[\s,])5($|[\s,])/.test(legalLine) && !r.out.includes("(phase 4 not completed"), r.out);
  r = phase(["enter", branched, "4p", "--reason", "debug after a clean implement", "--quiet"]);
  check("the detour is still reachable from a COMPLETED 4", r.code === 0, r.out);
  r = phase(["enter", branched, "4", "--reason", "back to implement", "--quiet"]);
  check("and returning to 4 from there still works", r.code === 0, r.out);
  r = phase(["enter", branched, "5", "--reason", "verify a clean implement", "--quiet"]);
  check("verify is reachable DIRECTLY from a COMPLETED 4, with no detour in between", r.code === 0, r.out);
}

// The mirror image of the bug above, found by the same 7b run a few phases
// later: verify returned four findings and the machine's only legal next move
// was to advance past them. A run that reaches verify carrying a defect has to
// be able to go and fix it, otherwise the only routes are editing files behind
// the guard's back or reviewing known-broken code. The detour is a branch off
// every FINDING phase (verify, review) - deliberately not off ship, because once
// you are shipping a human decides at Gate C, not the machine.
const findings = newBead("verify found defects feature");
if (findings) {
  for (const p of ["0", "1", "2", "3", "4", "5"]) {
    phase(["enter", findings, p, "--reason", `walk toward verify (${p})`, "--quiet"]);
    completePhase(findings, p, `phase ${p} done`);
    openGate();
  }
  r = phase(["next", findings, "--quiet"]);
  check("from a COMPLETED 5 review AND the repair detour are BOTH legal",
    /\b4p\b/.test(legalOf(r.out)) && /(^|[\s,])6($|[\s,])/.test(legalOf(r.out)), r.out);
  r = phase(["enter", findings, "4p", "--reason", "fix what verify found", "--quiet"]);
  check("a verify finding can be routed to the repair detour", r.code === 0, r.out);
  r = phase(["enter", findings, "5", "--reason", "re-verify the fix", "--quiet"]);
  check("and the fix can be re-verified from the detour", r.code === 0, r.out);
  completeVerify(findings, "re-verified");
  phase(["enter", findings, "6", "--reason", "review", "--quiet"]);
  phase(["complete", findings, "6", "--evidence", "reviewed", "--quiet"]);
  r = phase(["next", findings, "--quiet"]);
  check("from a COMPLETED 6 ship AND the repair detour are BOTH legal",
    /\b4p\b/.test(legalOf(r.out)) && /(^|[\s,])7($|[\s,])/.test(legalOf(r.out)), r.out);
  phase(["enter", findings, "7", "--reason", "ship", "--quiet"]);
  phase(["complete", findings, "7", "--evidence", "shipped", "--quiet"]);
  r = phase(["next", findings, "--quiet"]);
  check("but the repair detour is NOT offered once shipping - Gate C decides that",
    !/\b4p\b/.test(legalOf(r.out)), r.out);
}

r = phase(["handoff", bead, "--quiet"]);
check("handoff without --next is REFUSED", r.code === 1 && has(r.out, "--next is required"), r.out);
r = phase(["handoff", bead, "--next", "run vitest"]);
check("handoff with a next action succeeds", r.code === 0 && has(r.out, "next: run vitest"), r.out);

console.log("\nfail-closed on junk state");
// A HARD DEADLOCK, found by a real 7b run. A run completes a SET of phases but
// phase_done holds one scalar, so `complete 4p` overwrote the record that verify
// had been completed. The machine was then livelocked in 4 <-> 4p and could
// never reach verify, review, ship or close: the repair destroyed the state it
// was supposed to restore. The detour now records in repair_done instead.
const deadlock = newBead("detour must not erase completion");
if (deadlock) {
  for (const p of ["0", "1", "2", "3", "4", "5"]) {
    phase(["enter", deadlock, p, "--reason", `walk to verify (${p})`, "--quiet"]);
    completePhase(deadlock, p, `phase ${p} done`);
    openGate();
  }
  r = phase(["enter", deadlock, "4p", "--reason", "fix what verify found", "--quiet"]);
  check("the repair detour is reachable from a completed verify", r.code === 0, r.out);
  r = phase(["complete", deadlock, "4p", "--evidence", "spec amended, tests pinned", "--quiet"]);
  check("completing the detour succeeds", r.code === 0, r.out);
  // The assertion that would have caught the deadlock. Before the fix this read
  // 4p, because the detour overwrote phase_done.
  const after = bd(["state", deadlock, "phase_done"]);
  check("completing the detour does NOT erase the phase it repaired",
    has(after.out, "5") && !has(after.out, "4p"), after.out.slice(0, 200));
  const rep = bd(["state", deadlock, "repair_done"]);
  check("the detour records its work in its own dimension", has(rep.out, "4p"), rep.out.slice(0, 200));
  // From the detour the only way on is to re-verify, which is the point of a
  // repair detour. My first attempt asserted `enter 6` straight from 4p, which
  // is correctly refused: 4p's candidates are 4 and 5. The run advances only
  // after the re-verification, and before the fix it could not do even that.
  r = phase(["enter", deadlock, "5", "--reason", "re-verify the repair", "--quiet"]);
  check("and the repair can be re-verified - the livelock is gone", r.code === 0, r.out);
  completeVerify(deadlock, "re-verified after the repair");
  r = phase(["enter", deadlock, "6", "--reason", "review the repaired feature", "--quiet"]);
  check("and the run advances past the repaired verify", r.code === 0, r.out);
}

// The other half of the same invariant: the detour must not become a back door
// either. A detour taken during an UNFINISHED implement still leaves verify
// blocked, because nothing was ever verified.
const backdoor = newBead("detour must not be a back door");
if (backdoor) {
  for (const p of ["0", "1", "2", "3"]) {
    phase(["enter", backdoor, p, "--reason", `walk toward implement (${p})`, "--quiet"]);
    phase(["complete", backdoor, p, "--evidence", `phase ${p} done`, "--quiet"]);
    openGate();
  }
  // Entered and deliberately NOT completed. My first version completed it in the
  // walk loop and then asserted the back door was closed - which it correctly
  // was not, because a finished implement may always fall through to verify.
  phase(["enter", backdoor, "4", "--reason", "implement, and stop", "--quiet"]);
  phase(["enter", backdoor, "4p", "--reason", "build failed, fixing", "--quiet"]);
  r = phase(["complete", backdoor, "4p", "--evidence", "fixed the build", "--quiet"]);
  check("a detour taken during unfinished implement still completes", r.code === 0, r.out);
  r = phase(["enter", backdoor, "5", "--reason", "skipping verify", "--quiet"]);
  check("but verify is STILL refused - the detour is not a back door",
    r.code !== 0 && has(r.out, "has not been completed"), r.out);
}

// ---- the boot condition on phase 5 (verify) -----------------------------------
// A real run reached 22 tasks with every gate passing and nobody had ever
// started the app. The last test in this block is the one that matters most: the
// guards are easy, and the original 31-test suite had 31 of them while the
// recording effect was never checked once. That is how four defects shipped.

// Walk a fresh bead all the way into phase 5, resolving the human gates on the
// way. Every phase is COMPLETED, not merely entered, because leaving a phase
// unfinished is refused by design and would make these tests fail for a reason
// that has nothing to do with the boot condition.
function intoVerify(title) {
  const b = newBead(title);
  for (const p of ["0", "1", "2", "3", "4"]) {
    phase(["enter", b, p, "--reason", `walk to ${p}`]);
    phase(["complete", b, p, "--evidence", `walk evidence for ${p}`]);
    openGate();
  }
  phase(["enter", b, "5", "--reason", "walk to verify"]);
  return b;
}

const bootBead = intoVerify("boot condition");
if (bootBead) {
  r = phase(["status", bootBead, "--quiet"]);
  check("the walk lands in phase 5", has(r.out, "5"), r.out);

  r = phase(["complete", bootBead, "5", "--evidence", "tests pass"]);
  check("completing verify without --booted is refused", r.code !== 0, `code ${r.code}`);
  check("the refusal names --booted", has(r.out, "--booted"), r.out);
  check("the refusal says a test suite is not a running app", has(r.out, "not a running app"), r.out);

  r = bd(["state", bootBead, "phase_done"]);
  check("a refused completion left phase_done at 4, not 5", has(r.out, "4"), r.out);

  // bd's own argument parser splits on a double quote, so a claim like this one
  // is realistic. Caught here so the message is something an agent can act on
  // rather than bd's raw "accepts 2 arg(s), received 3".
  r = phase(["complete", bootBead, "5", "--evidence", "e", "--booted", 'ran: curl -H "X-Test: 1" /health -> ok']);
  check("a double quote in --booted is refused", r.code !== 0, `code ${r.code}`);
  check("the quote refusal explains why", has(r.out, "double quote"), r.out);

  // bd rejects a value over 255 characters. Refused rather than truncated: a
  // half-recorded boot claim is a claim nobody can check.
  r = phase(["complete", bootBead, "5", "--evidence", "e", "--booted", "x".repeat(300)]);
  check("an over-long --booted is refused", r.code !== 0, `code ${r.code}`);
  check("the length refusal names the limit", has(r.out, "255"), r.out);
  r = bd(["state", bootBead, "booted"]);
  check("neither refusal wrote a booted value", !has(r.out, "x"), r.out.slice(0, 80));

  r = phase(["complete", bootBead, "5", "--evidence", "tests pass, app answered",
             "--booted", "ran: npm run dev -> 200 OK on GET /health"]);
  check("completing verify WITH --booted succeeds", r.code === 0, `code ${r.code} ${r.out}`);
  const readBack = bd(["state", bootBead, "booted"]);
  check("the boot claim is recorded in the state layer",
    has(readBack.out, "npm run dev") && has(readBack.out, "/health"), readBack.out);
  const doneBack = bd(["state", bootBead, "phase_done"]);
  check("and phase_done=5 is recorded too", has(doneBack.out, "5"), doneBack.out);

  r = phase(["next", bootBead]);
  check("after a boot claim the run advances to review", has(legalOf(r.out), "6"), legalOf(r.out));
} else {
  check("could walk a bead into verify", false, "newBead returned null");
}

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
