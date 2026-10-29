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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
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
// Declared before it is used. A const below its first call site is a temporal
// dead zone ReferenceError, which is exactly what happened when this helper was
// defined further down beside the other helpers.
const BRAINSTORM_DIR = join(SANDBOX, "docs", "superpowers", "brainstorms");
function ensureBrainstorm() {
  mkdirSync(BRAINSTORM_DIR, { recursive: true });
  const f = join(BRAINSTORM_DIR, "0000-00-00-test-brainstorm.md");
  if (!existsSync(f)) writeFileSync(f, "# test brainstorm\n");
  return f;
}
const removeBrainstorm = () => { try { rmSync(BRAINSTORM_DIR, { recursive: true, force: true }); } catch { /* locked */ } };
const init = run("bd", ["init"], { BEADS_DIR: BEADS, BEADS_NO_DOLT: "1" });
if (init.code !== 0) { console.error("bd init failed:\n" + init.out); process.exit(1); }
ensureBrainstorm();
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
//
// Probed against bd 1.3.0 (a scratch sandbox, a real human gate resolved both
// with `--reason "probe"` and with no reason at all): the resolution reason is
// carried by `close_reason` on the gate row, in BOTH `bd gate list --all
// --json` and `bd gate show <id> --json`, and a bare `bd gate resolve` leaves
// the row in the `--all` list with status "closed" and no close_reason at all.
// The machine reads exactly that (gateReason / factoryApproved in
// factory-phase.mjs), so a bare resolve no longer counts as an approval - which
// is the defect this task closes. A setup must therefore clear gates through
// the factory command, never with a raw resolve and never by writing the
// [factory-gate:<id>] token itself - that would test the token check with the
// token.
function approveGate(bead, letter, why = `the ${letter} gate evidence is on disk and the checklist passed`) {
  return phase(["gate", bead, letter, "--evidence", why, "--quiet"]);
}
// The gate standing in the way at the end of phase p, as the phase table has
// it: 2 -> GATE G2a, 3 -> GATE G2b. These deliberately use the old letters, so
// every walk here also exercises the alias path. G1 (phase 1) is approved only
// where a policy makes it required; G3 is raised by entering 7, which walkTo()
// and the walk loops clear explicitly when they mean to.
const GATE_LETTER = { "2": "A", "3": "B" };
const legalOf = (o) => (o.match(/legal next:.*/) || [""])[0];

// Completing verify requires a record of the thing that actually ran and the
// artifact it left behind (see the --ran block below). Every walk in this file
// that passes through phase 5 supplies both, so they live in a helper rather
// than a literal at each call site: a forgotten call site then fails as a
// test-setup problem rather than reading like a machine defect. The artifact is
// written on demand because a claim that points at no file is refused.
const RAN_CLAIM = "npm run dev -> 200 OK on GET /health at 2026-10-20T10:00:00Z";
// (ensureBrainstorm / removeBrainstorm are declared up in the setup block, above
// their first use.)

const completeVerify = (b, evidence) => {
  const f = join(SANDBOX, "boot.log");
  if (!existsSync(f)) writeFileSync(f, "200 OK\n");
  return phase(["complete", b, "5", "--evidence", evidence, "--ran", RAN_CLAIM, "--artifact", f, "--quiet"]);
};
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
check("entering 1 creates the policy-gated G1", has(bd(["show", bead, "--json"]).out, "gate_g1"), "gate_g1 missing");
approveGate(bead, "G1");
r = phase(["complete", bead, "1", "--evidence", "ran the rollback walk; the state was cleared and re-entered clean", "--quiet"]);
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
  r = phase(["complete", u, "1", "--evidence", "ran the blocked phase's work through; it finished and 2 became legal"]);
  check("completing it unblocks the successor", r.code === 0 && has(r.out, "next legal: 2"), r.out);
  r = phase(["enter", u, "2", "--reason", "now allowed", "--quiet"]);
  check("and the successor is now enterable", r.code === 0, r.out);
} else {
  check("could create a bead for the unfinished-phase test", false, "newBead returned nothing");
}

console.log("\nphase 2 creates GATE G2a and blocks phase 3");
// Phase 1 was entered AND completed above, so the successor is legal here.
// No --quiet here: this test asserts on the gate being created and reported.
r = phase(["enter", bead, "2", "--reason", "spec written"]);
check("entering 2 succeeds and creates GATE G2a", r.code === 0 && has(r.out, "GATE G2a created"), r.out);

r = phase(["next", bead, "--quiet"]);
check("next reports 3 blocked by GATE G2a", has(r.out, "3 (GATE G2a pending)"), r.out);
check("blocked next exits 2", r.code === 2, `code ${r.code}`);

r = phase(["enter", bead, "3", "--reason", "planning", "--quiet"]);
check("entering 3 while GATE G2a pending is BLOCKED", r.code === 2 && has(r.out, "GATE G2a is pending"), r.out);

r = phase(["status", bead, "--quiet"]);
check("status shows GATE G2a pending", has(r.out, "G2a PENDING"), r.out);

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
  // GATE G2a was raised by enter 2; clearing it through the machine (approveGate,
  // not a raw resolve) so the setup matches the semantics it is walking under.
  approveGate(bead, "A");
  r = phase(["complete", bead, "2", "--evidence", "spec approved at GATE G2a", "--quiet"]);
  check("completing 2 after GATE G2a resolves succeeds", r.code === 0, r.out);
  r = phase(["enter", bead, "3", "--reason", "gate G2a approved", "--quiet"]);
  check("after resolving GATE G2a, entering 3 succeeds", r.code === 0, r.out);
}

console.log("\nphase 3 creates GATE G2b and blocks implementation");
r = phase(["enter", bead, "4", "--reason", "writing code", "--quiet"]);
check("entering 4 while GATE G2b pending is BLOCKED", r.code === 2 && has(r.out, "GATE G2b is pending"), r.out);

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
if (g2) approveGate(bead, "B");
r = phase(["complete", bead, "3", "--evidence", "plan.md + plan.json applied", "--quiet"]);
check("completing 3 succeeds", r.code === 0, r.out);
r = phase(["enter", bead, "4", "--reason", "gate G2b approved", "--quiet"]);
check("after resolving GATE G2b, entering 4 succeeds", r.code === 0, r.out);

console.log("\ncompletion is evidence-gated");
r = phase(["complete", bead, "4", "--quiet"]);
check("complete without --evidence is REFUSED", r.code === 1 && has(r.out, "not informative"), r.out);
r = phase(["complete", bead, "5", "--evidence", "verified the export path; 12 rows matched the contract", "--quiet"]);
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
  r = phase(["complete", d, "0", "--evidence", "ran the onboarding walk; bd open listed no open issues", "--quiet"]);
  for (const p of ["1", "2"]) {
    phase(["enter", d, p, "--reason", "walk", "--quiet"]);
    phase(["complete", d, p, "--evidence", `walked phase ${p}: ran its checks and answered cleanly`, "--quiet"]);
  }
  approveGate(d, "A");
  phase(["enter", d, "3", "--reason", "plan", "--quiet"]);
  phase(["complete", d, "3", "--evidence", "applied plan.md and plan.json; 4 tasks planned", "--quiet"]);
  const gb = (() => {
    try { const rows = JSON.parse(bd(["gate", "list", "--all", "--json"]).out);
      const l = (Array.isArray(rows) ? rows : (rows.gates || [])).filter((g) => {
        const s = String(g.status || g.state || "open"); return s === "open" || s === "pending"; });
      return l[0] && (l[0].id || l[0].gate_id); } catch { return null; }
  })();
  if (gb) approveGate(d, "B");
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
  for (const p of ["0", "1", "2", "3"]) {
    phase(["enter", branched, p, "--reason", `walk toward implement (${p})`, "--quiet"]);
    phase(["complete", branched, p, "--evidence", `phase ${p} walked: ran its checks and answered cleanly`, "--quiet"]);
    const letter = GATE_LETTER[p];
    if (letter) approveGate(branched, letter);
  }
  r = phase(["enter", branched, "4", "--reason", "implement", "--quiet"]);
  check("reached implement with a clean history", r.code === 0, r.out);
  phase(["complete", branched, "4", "--evidence", "wrote the parser and tests; suite green 12/12", "--quiet"]);
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
    completePhase(findings, p, `phase ${p} walked: ran its checks and answered cleanly`);
    const letter = GATE_LETTER[p];
    if (letter) approveGate(findings, letter);
  }
  r = phase(["next", findings, "--quiet"]);
  check("from a COMPLETED 5 review AND the repair detour are BOTH legal",
    /\b4p\b/.test(legalOf(r.out)) && /(^|[\s,])6($|[\s,])/.test(legalOf(r.out)), r.out);
  r = phase(["enter", findings, "4p", "--reason", "fix what verify found", "--quiet"]);
  check("a verify finding can be routed to the repair detour", r.code === 0, r.out);
  r = phase(["enter", findings, "5", "--reason", "re-verify the fix", "--quiet"]);
  check("and the fix can be re-verified from the detour", r.code === 0, r.out);
  completeVerify(findings, "re-ran the verify checks; 4 findings fixed, suite green");
  phase(["enter", findings, "6", "--reason", "review", "--quiet"]);
  phase(["complete", findings, "6", "--evidence", "reviewed the diff; 2 findings filed and both addressed", "--quiet"]);
  r = phase(["next", findings, "--quiet"]);
  check("from a COMPLETED 6 ship AND the repair detour are BOTH legal",
    /\b4p\b/.test(legalOf(r.out)) && /(^|[\s,])7($|[\s,])/.test(legalOf(r.out)), r.out);
  phase(["enter", findings, "7", "--reason", "ship", "--quiet"]);
  // Entering 7 raises GATE C, and completing ship now refuses while it is
  // pending - that refusal is the walk-to-ship test's own subject. Resolving it
  // through the machine's bead-scoped `gate` command (not a first-open-gate
  // scrambler) keeps this block asserting what it
  // always meant to: a COMPLETED ship with an approved gate offers no detour.
  r = phase(["gate", findings, "C", "--evidence", "approved the release: artifact hashes match, smoke test returned 200", "--quiet"]);
  check("the walk to a completed ship resolves GATE C on the way", r.code === 0, r.out.slice(0, 200));
  phase(["complete", findings, "7", "--evidence", "shipped the build; release notes and tag recorded", "--quiet"]);
  r = phase(["next", findings, "--quiet"]);
  check("but the repair detour is NOT offered once shipping - Gate C decides that",
    !/\b4p\b/.test(legalOf(r.out)), r.out);
}

// A human rejecting the work at Gate C is the one finding the machine could
// not act on. The gate is machine-enforced, so resolving it meant the only
// legal move left was `complete 7` - shipping exactly what was rejected -
// and the repair detour, which exists on 5 and 6, was unreachable from 7.
// Found by run 3: the approver ruled "fix it" and the choices were ship it or
// go nowhere. Note the asymmetry this is checking: a COMPLETED ship still
// offers no detour, because there is nothing left to reject. Only an
// unfinished one does.
const rejected = newBead("gate c rejects a review finding feature");
if (rejected) {
  for (const p of ["0", "1", "2", "3", "4", "5", "6"]) {
    phase(["enter", rejected, p, "--reason", `walk toward ship (${p})`, "--quiet"]);
    completePhase(rejected, p, `phase ${p} walked: ran its checks and answered cleanly`);
    const letter = GATE_LETTER[p];
    if (letter) approveGate(rejected, letter);
  }
  phase(["enter", rejected, "7", "--reason", "ship", "--quiet"]);
  approveGate(rejected, "C");
  r = phase(["next", rejected, "--quiet"]);
  check("an UNFINISHED ship phase offers the repair detour, so a Gate C rejection is actionable",
    /\b4p\b/.test(legalOf(r.out)), r.out);
  r = phase(["enter", rejected, "4p", "--reason", "fix what Gate C rejected", "--quiet"]);
  check("and a Gate C rejection can be routed to it", r.code === 0, r.out);
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
    completePhase(deadlock, p, `phase ${p} walked: ran its checks and answered cleanly`);
    const letter = GATE_LETTER[p];
    if (letter) approveGate(deadlock, letter);
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
    phase(["complete", backdoor, p, "--evidence", `phase ${p} walked: ran its checks and answered cleanly`, "--quiet"]);
    const letter = GATE_LETTER[p];
    if (letter) approveGate(backdoor, letter);
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
    // The gate for this phase (A at 2, B at 3) is cleared through the machine
    // so it counts as approved: the next iteration's `enter` requires that.
    const letter = GATE_LETTER[p];
    if (letter) approveGate(b, letter);
  }
  phase(["enter", b, "5", "--reason", "walk to verify"]);
  return b;
}

// Walk a fresh bead to `target`, resolving exactly the gates that stand in the
// way: G1 before completing phase 1 (only required when a policy exists, but
// harmless otherwise), G2a before completing phase 2, G2b before completing
// phase 3. G3 is created by enter 7 and is deliberately left open.
// Resolve ONLY the named gate for the phase standing in the way (see
// approveGate / GATE_LETTER above): a "first open gate anywhere in the
// database" resolve would also clear Gate G3 before complete 7 ever runs.
function walkTo(title, target, prep) {
  const b = newBead(title);
  if (!b) throw new Error(`walkTo: could not create bead for "${title}"`);
  for (const p of ["0", "1", "2", "3", "4", "5", "6"]) {
    if (Number(p) >= Number(target)) break;
    const entered = phase(["enter", b, p, "--reason", `walk to phase ${p}`, "--quiet"]);
    if (entered.code !== 0) throw new Error(`walkTo: enter ${p} failed: ${entered.out.slice(0, 300)}`);
    if (p === "1") {
      const g = phase(["gate", b, "G1", "--evidence", "worth building: one direction survived the brainstorm and three were rejected", "--quiet"]);
      if (g.code !== 0) throw new Error(`walkTo: gate G1 failed: ${g.out.slice(0, 300)}`);
    }
    if (p === "2") {
      const g = phase(["gate", b, "A", "--evidence", "the spec and the design direction are settled and written down", "--quiet"]);
      if (g.code !== 0) throw new Error(`walkTo: gate A failed: ${g.out.slice(0, 300)}`);
    }
    if (p === "3") {
      const g = phase(["gate", b, "B", "--evidence", "the plan names every file to change and every test that proves it", "--quiet"]);
      if (g.code !== 0) throw new Error(`walkTo: gate B failed: ${g.out.slice(0, 300)}`);
    }
    if (p === "5" && prep) prep(b);
    const done = completePhase(b, p, `phase ${p} ran its checks and they passed`);
    if (done.code !== 0) throw new Error(`walkTo: complete ${p} failed: ${done.out.slice(0, 300)}`);
  }
  const target_ = phase(["enter", b, String(target), "--reason", `walk to phase ${target}`, "--quiet"]);
  if (target_.code !== 0) throw new Error(`walkTo: enter ${target} failed: ${target_.out.slice(0, 300)}`);
  return b;
}

const bootBead = intoVerify("boot condition");
if (bootBead) {
  r = phase(["status", bootBead, "--quiet"]);
  check("the walk lands in phase 5", has(r.out, "5"), r.out);

  r = phase(["complete", bootBead, "5", "--evidence", "ran the verify suite; 12 tests green, app up"]);
  check("completing verify without --ran is refused", r.code !== 0, `code ${r.code}`);
  check("the refusal names --ran", has(r.out, "--ran"), r.out);
  check("the refusal says a test suite is not a running app", has(r.out, "not a running app"), r.out);

  r = bd(["state", bootBead, "phase_done"]);
  check("a refused completion left phase_done at 4, not 5", has(r.out, "4"), r.out);

  // bd's own argument parser splits on a double quote, so a claim like this one
  // is realistic. Caught here so the message is something an agent can act on
  // rather than bd's raw "accepts 2 arg(s), received 3".
  r = phase(["complete", bootBead, "5", "--evidence", "ran the verify suite; app answered on /health", "--booted", 'ran: curl -H "X-Test: 1" /health -> ok']);
  check("a double quote in --booted is refused", r.code !== 0, `code ${r.code}`);
  check("the quote refusal explains why", has(r.out, "double quote"), r.out);

  // bd rejects a value over 255 characters. Refused rather than truncated: a
  // half-recorded boot claim is a claim nobody can check.
  r = phase(["complete", bootBead, "5", "--evidence", "ran the verify suite; app answered on /health", "--booted", "x".repeat(300)]);
  check("an over-long --booted is refused", r.code !== 0, `code ${r.code}`);
  check("the length refusal names the limit", has(r.out, "255"), r.out);
  r = bd(["state", bootBead, "booted"]);
  check("neither refusal wrote a booted value", !has(r.out, "x"), r.out.slice(0, 80));

  const artifact = join(SANDBOX, "boot.log");
  if (!existsSync(artifact)) writeFileSync(artifact, "200 OK\n");
  r = phase(["complete", bootBead, "5", "--evidence", "tests pass, app answered",
             "--ran", RAN_CLAIM, "--artifact", artifact]);
  check("completing verify WITH --ran and a real artifact succeeds", r.code === 0, `code ${r.code} ${r.out}`);
  const readBack = bd(["state", bootBead, "booted"]);
  check("the ran claim is recorded in the state layer (the bd dimension is still \"booted\")",
    has(readBack.out, "npm run dev") && has(readBack.out, "/health"), readBack.out);
  const doneBack = bd(["state", bootBead, "phase_done"]);
  check("and phase_done=5 is recorded too", has(doneBack.out, "5"), doneBack.out);

  r = phase(["next", bootBead]);
  check("after a boot claim the run advances to review", has(legalOf(r.out), "6"), legalOf(r.out));
} else {
  check("could walk a bead into verify", false, "newBead returned null");
}

// ---- staleness, artifacts and repair_done (added after a real 10-day stall) ----
// A run entered implement on 2026-09-29 and was still in phase 4 on 2026-10-09.
// Every guard worked the whole time; nobody asked one a question. These are the
// three checks that would have made the silence visible.

console.log("\nthe spec cannot rest on a brainstorm nobody wrote");
const noBrain = newBead("missing brainstorm feature");
if (noBrain) {
  removeBrainstorm();
  r = phase(["enter", noBrain, "0", "--reason", "walk", "--quiet"]);
  phase(["complete", noBrain, "0", "--evidence", "ran the onboarding walk; bd ready showed no blockers", "--quiet"]);
  phase(["enter", noBrain, "1", "--reason", "walk", "--quiet"]);
  phase(["complete", noBrain, "1", "--evidence", "brainstormed the design; 6 ideas captured, 3 kept", "--quiet"]);
  r = phase(["enter", noBrain, "2", "--reason", "write the spec", "--quiet"]);
  check("entering spec with NO brainstorm on disk is REFUSED", r.code !== 0, `code ${r.code}`);
  check("the refusal names the missing artifact", has(r.out, "brainstorm"), r.out);
  check("the refusal names the directory it looked in", has(r.out, "docs"), r.out);
  r = bd(["state", noBrain, "phase"]);
  check("and the refused transition did not enter phase 2", !has(r.out, "2"), r.out);
  // With the artifact present the same transition is allowed - otherwise this
  // check is a wall, not a gate.
  ensureBrainstorm();
  r = phase(["enter", noBrain, "2", "--reason", "write the spec", "--quiet"]);
  check("once the brainstorm exists, entering spec succeeds", r.code === 0, r.out);
} else {
  check("could create a bead for the artifact test", false, "newBead returned null");
}

console.log("\nstaleness and incoherent state are reported, not hidden");
const idleBead = newBead("stale run feature");
if (idleBead) {
  phase(["enter", idleBead, "0", "--reason", "walk", "--quiet"]);
  phase(["complete", idleBead, "0", "--evidence", "ran the onboarding walk; bd ready showed no blockers", "--quiet"]);
  phase(["enter", idleBead, "1", "--reason", "walk", "--quiet"]);
  r = phase(["status", idleBead, "--json"]);
  // An unfinished phase is the precondition; a fresh bead is 0 days idle, so the
  // honest assertion here is that the field EXISTS and is a number, not that it
  // says "stale". Claiming a 3-day stall for a bead created seconds ago would be
  // the exact invention the STALE_DAYS constant is trying not to be.
  const j = (() => { try { return JSON.parse(r.out); } catch { return {}; } })();
  check("status reports an idle_days field", typeof j.idle_days === "number", r.out.slice(0, 120));
  check("a just-created run is not reported as stale", j.stale === false, `stale=${j.stale}`);
  check("status prints an idle line", /idle:/.test(r.out), r.out.slice(0, 160));
  // And the STALE constant is real: a walk that has finished is never stale even
  // though done === phase, so the flag cannot fire on completed work.
  phase(["complete", idleBead, "1", "--evidence", "brainstormed the design; 6 ideas captured, 3 kept", "--quiet"]);
  r = phase(["status", idleBead, "--json"]);
  const j2 = (() => { try { return JSON.parse(r.out); } catch { return {}; } })();
  check("a COMPLETED phase is not stale no matter how old", j2.stale === false, `stale=${j2.stale}`);
} else {
  check("could create a bead for the staleness test", false, "newBead returned null");
}

// repair_done outliving its phase is asserted by bd with no way to unset it, so
// status must say so rather than let a stale record read as standing state.
const repBead = newBead("repair record outlives the detour");
if (repBead) {
  ensureBrainstorm();
  for (const p of ["0", "1", "2", "3", "4"]) {
    phase(["enter", repBead, p, "--reason", `walk to ${p}`, "--quiet"]);
    completePhase(repBead, p, `phase ${p} walked: ran its checks and answered cleanly`);
    const letter = GATE_LETTER[p];
    if (letter) approveGate(repBead, letter);
  }
  phase(["enter", repBead, "4p", "--reason", "found a defect", "--quiet"]);
  phase(["complete", repBead, "4p", "--evidence", "fixed the parsing bug; 3 failing cases now pass", "--quiet"]);
  phase(["enter", repBead, "4", "--reason", "back to implement", "--quiet"]);
  r = phase(["status", repBead, "--json"]);
  const j3 = (() => { try { return JSON.parse(r.out); } catch { return {}; } })();
  check("status flags a repair_done that outlived its phase", j3.repair_done_stale === true, r.out.slice(0, 200));
  check("and says so in the human-readable output", has(r.out, "repair_done"), r.out.slice(0, 300));
  // Reporting it must not break the run: the legality checks read `done`, and a
  // warning that stops the pipeline would be worse than the bug it reports.
  r = phase(["enter", repBead, "5", "--reason", "re-verify", "--quiet"]);
  check("but the run can still advance past it", r.code === 0, r.out);
}

const badBead = newBead("corrupt");
if (badBead) {
  r = phase(["status", "no-such-bead-xyz", "--quiet"]);
  check("status on a nonexistent bead does not crash or exit 0", r.code === 1 || r.code === 2, `code ${r.code}`);
  check("status on a nonexistent bead says so", has(r.out, "ERROR") || has(r.out, "no beads") || has(r.out, "not found"), r.out);
} else {
  check("could create a second bead for the fail-closed test", false, bad.out.slice(0, 120));
}

  // `bd gate resolve` already accepts --reason, which means every gate in this
  // machine could until now be resolved by anyone typing a yes. `gate` exists so
  // a resolution has to carry a reason. Two halves have to be proven and one
  // assertion cannot cover both: a command that refuses everything passes every
  // refusal test, so the accept side needs its own.
  console.log("\ngate command: a bare yes is not a decision");
  {
    const bead = newBead("gate-command");
    check("could create a bead for the gate-command test", !!bead, "");

    // Entering phase 2 requires phase 1 to be completed first, so this setup has
    // to walk the same path a run does. It used to call `enter 2` on a virgin
    // bead, which was refused; no gate was ever created, and every refusal
    // assertion below still passed because they are argument validation that
    // runs before the "is any gate pending" check. Only the accept side failed.
    // That asymmetry is the reason both halves exist, so the setup now asserts
    // it worked rather than leaving the next reader to infer it.
    phase(["enter", bead, "1", "--reason", "gate command test", "--quiet"]);
    approveGate(bead, "G1");
    phase(["complete", bead, "1", "--evidence", "the gate-command test's own setup", "--quiet"]);

    const entered = phase(["enter", bead, "2", "--reason", "gate command test", "--quiet"]);
    // Scoped to THIS bead: `--all` alone lists every gate in the sandbox database,
    // and earlier blocks leave gates behind, so an unscoped `some` could pass for
    // the wrong reason. bd prints the literal `null` when a bead has no gate, and
    // a parse failure must fail this one assertion, not crash the run - so parse
    // defensively, like the gate lookups at the top of this file.
    const gateList = (() => {
      try {
        const rows = JSON.parse(bd(["gate", "list", bead, "--all", "--json"]).out) ?? [];
        return Array.isArray(rows) ? rows : (rows.gates || []);
      } catch { return []; }
    })();
    check("the setup reached phase 2 with a gate pending, so the refusals below mean something",
      entered.code === 0 && gateList.some((g) => ["open", "pending"].includes(String(g.status || g.state || "open"))),
      entered.out.slice(0, 200));

    // Phase 3 needs phase 2 completed before it can even be considered, so that
    // the only thing standing between phase 3 and this run is the gate itself.
    phase(["complete", bead, "2", "--evidence", "the spec the gate is guarding", "--quiet"]);

    let r = phase(["gate", bead, "D", "--evidence", "a genuine reason with plenty of detail"]);
    check("an unknown gate letter is REFUSED", r.code !== 0 && has(r.out, "unknown gate"), r.out.slice(0, 140));
    check(
      "the unknown-gate refusal names the canonical ids and the aliases",
      has(r.out, 'unknown gate "D"; accepted: G1, G2a, G2b, G3 (A, B and C are aliases)'),
      r.out.slice(0, 220)
    );

    r = phase(["gate", bead, "A"]);
    check("a gate with no evidence is REFUSED", r.code !== 0 && has(r.out, "not informative"), r.out.slice(0, 140));

    r = phase(["gate", bead, "A", "--evidence", "ok"]);
    check("a bare ok is REFUSED as uninformative", r.code !== 0 && has(r.out, "not informative"), r.out.slice(0, 140));

    r = phase(["gate", bead, "A", "--evidence", "go ahead looks fine to me"]);
    check("a stopword opening is REFUSED", r.code !== 0 && has(r.out, "not informative"), r.out.slice(0, 140));

    // The refuse side is the point of the stoplist: an approval-shaped sentence
    // that carries no checked fact. Asserting the exact exit code keeps a
    // "blocked" exit (2) from masquerading as a refusal.
    r = phase(["gate", bead, "A", "--evidence", "go ahead looks fine to me"]);
    check("the same reason is REFUSED with exit 1", r.code === 1 && has(r.out, "not informative"), r.out.slice(0, 140));

    r = phase(["gate", bead, "A", "--evidence", "x".repeat(5000)]);
    check("an over-long evidence is REFUSED", r.code !== 0 && has(r.out, "over the"), r.out.slice(0, 140));

    // run() hands execFileSync an ARRAY, so the quote reaches the script intact.
    // Asserting this through a PowerShell literal would prove nothing: PowerShell
    // strips inner quotes from a native command before node ever sees them, which
    // is why an earlier attempt at this test measured its own shell, not the code.
    r = phase(["gate", bead, "A", "--evidence", 'the CSV header is fixed as "id,total"']);
    check("a double quote is REFUSED before bd ever sees it", r.code !== 0 && has(r.out, "double quote"), r.out.slice(0, 170));

    // The claim the last assertion makes - "which only a resolved GATE G2a
    // allows" - is only actually tested by attempting it while the gate is
    // still pending. Phase 2 is completed by now, so the gate is the only thing
    // standing in the way, and without this the final assertion proves nothing
    // about gates at all.
    r = phase(["enter", bead, "3", "--reason", "trying to skip the gate", "--quiet"]);
    check("phase 3 is REFUSED while GATE G2a is still pending", r.code !== 0, r.out.slice(0, 200));

    r = phase(["gate", bead, "A", "--evidence", "the CSV contract is settled: six columns, CRLF separators, no BOM"]);
    check("a real reason RESOLVES the gate", r.code === 0 && has(r.out, "resolved"), r.out.slice(0, 170));

    // Proof it really resolved, taken from the product's own message rather than
    // from bd's JSON shape - guessing a field name is how an assertion passes for
    // the wrong reason.
    r = phase(["gate", bead, "A", "--evidence", "trying twice, with a genuinely detailed reason this time"]);
    check("resolving it again is REFUSED as not pending", r.code !== 0 && has(r.out, "no G2a gate is pending"), r.out.slice(0, 170));

    r = phase(["enter", bead, "3", "--reason", "gate G2a resolved for real", "--quiet"]);
    check("and phase 3 now opens, which only a resolved GATE G2a allows", r.code === 0, r.out.slice(0, 140));

    // Entering 3 raised GATE G2b on the same walk, and it is still pending here,
    // so the accept side can be proved without disturbing the resolve chain above.
    // The reason must clear the same floor the refusals enforced: it would be no
    // test if the machine accepted evidence it refuses elsewhere. The canonical
    // spelling is used here so both spellings are exercised against real gates.
    r = phase(["gate", bead, "G2b", "--evidence", "the spec is settled: six columns, CRLF, no BOM"]);
    check("a factual reason that clears the floor is ACCEPTED", r.code === 0 && has(r.out, "resolved"), r.out.slice(0, 170));
  }

// The old letters and the canonical ids have to be two spellings of one gate,
// not two gates. Both walks write the same gate_a dimension, and an approval
// made with either spelling satisfies the check the machine actually enforces
// (enter 3 requires G2a).
console.log("\nold gate letters are aliases for the canonical ids");
{
  const metaOf = (b, key) => {
    try {
      const rows = JSON.parse(bd(["show", b, "--json"]).out);
      const row = Array.isArray(rows) ? rows[0] : rows;
      return (row && row.metadata && row.metadata[key]) || null;
    } catch { return null; }
  };
  const viaLetter = newBead("gate alias via letter");
  const viaCanonical = newBead("gate alias via canonical");
  for (const b of [viaLetter, viaCanonical]) {
    phase(["enter", b, "0", "--reason", "alias walk", "--quiet"]);
    phase(["complete", b, "0", "--evidence", "onboarded the alias walk; bd ready came up clean", "--quiet"]);
    phase(["enter", b, "1", "--reason", "alias walk", "--quiet"]);
    approveGate(b, "G1");
    phase(["complete", b, "1", "--evidence", "brainstormed the design; four directions, one kept", "--quiet"]);
    phase(["enter", b, "2", "--reason", "alias walk", "--quiet"]);
  }

  const byLetter = approveGate(viaLetter, "A");
  const byCanonical = approveGate(viaCanonical, "G2a");
  check("gate A resolves the canonical G2a gate", byLetter.code === 0 && has(byLetter.out, "gate G2a resolved"), byLetter.out.slice(0, 200));
  check("gate G2a resolves the same gate", byCanonical.code === 0 && has(byCanonical.out, "gate G2a resolved"), byCanonical.out.slice(0, 200));

  const letterDim = metaOf(viaLetter, "gate_a");
  const canonicalDim = metaOf(viaCanonical, "gate_a");
  check("both spellings write the gate_a dimension", Boolean(letterDim) && Boolean(canonicalDim),
    `gate_a via A=${letterDim} via G2a=${canonicalDim}`);
  check("no separate G2a dimension was invented", !metaOf(viaLetter, "gate_G2a") && !metaOf(viaLetter, "gate_g2a"),
    JSON.stringify([metaOf(viaLetter, "gate_G2a"), metaOf(viaLetter, "gate_g2a")]));

  const satisfied = [viaLetter, viaCanonical].map((b) => {
    phase(["complete", b, "2", "--evidence", "the spec is written; three sections and one open question", "--quiet"]);
    return phase(["enter", b, "3", "--reason", "alias approval opened the phase", "--quiet"]);
  });
  check("an approval by either spelling satisfies the G2a check",
    satisfied.every((s) => s.code === 0),
    satisfied.map((s) => `${s.code}: ${s.out.slice(0, 140)}`).join(" | "));
}

console.log("\nthe gate listing shows four canonical gates, once each");
{
  const b = newBead("gate listing");
  let created = 0;
  for (const key of ["gate_g1", "gate_a", "gate_b", "gate_c"]) {
    const res = bd(["gate", "create", "--type=human", "--blocks", b, "--reason", `listing probe: ${key}`]);
    const id = (res.out.match(/Created gate\s+(\S+)/) || [])[1];
    if (!id) continue;
    bd(["update", b, "--set-metadata", `${key}=${id}`]);
    created++;
  }
  check("all four gate records were created for the listing", created === 4, `created=${created}`);

  const st = phase(["status", b, "--json"]);
  let j = {};
  try { j = JSON.parse(st.out); } catch { /* assertion below reports the raw output */ }
  const pending = j.gates_pending || [];
  check("status lists G1, G2a, G2b and G3 exactly once",
    JSON.stringify(pending) === JSON.stringify(["G1", "G2a", "G2b", "G3"]), JSON.stringify(pending));

  const text = phase(["status", b, "--quiet"]).out;
  check("the human-readable listing has no duplicate gate",
    ["G1", "G2a", "G2b", "G3"].every((g) => (text.split(`${g} PENDING`).length - 1) === 1),
    text.slice(0, 300));
}

console.log("\nthe gate list cannot fail open");
{
  // The exploit: run from a directory with no beads database. bd exits
  // non-zero, allGates() returned [], every gate id lookup missed, and a bead
  // with Gate C open reported "nothing pending".
  const empty = mkdtempSync(join(tmpdir(), "factory-no-beads-"));
  const escaped = (() => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [SCRIPT, "status", bead, "--quiet"], {
          encoding: "utf8",
          cwd: empty,
          env: { ...process.env, BEADS_DIR: "" },
        }),
      };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
    }
  })();
  check(
    "a run outside a beads workspace REFUSES instead of reporting no gates",
    escaped.code === 1 && has(escaped.out, "no beads workspace"),
    escaped.out.slice(0, 240)
  );
}

console.log("\na gate that cannot be recorded does not leave the bead stuck");
{
  const b = newBead("gate record failure");
  phase(["enter", b, "1", "--reason", "setup the failure case", "--quiet"]);
  approveGate(b, "G1");
  phase(["complete", b, "1", "--evidence", "setup complete and verified", "--quiet"]);

  const gatesOf = () => {
    const raw = run("bd", ["gate", "list", b, "--all", "--json"], { BEADS_DIR: BEADS, BEADS_NO_DOLT: "1" });
    try {
      const rows = JSON.parse(raw.out);
      const list = Array.isArray(rows) ? rows : rows && rows.gates;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const openCount = () =>
    gatesOf().filter((g) => ["open", "pending"].includes(String(g.status || g.state || "open").toLowerCase())).length;

  const r = run(process.execPath, [SCRIPT, "enter", b, "2", "--reason", "the spec is written and settled"], {
    BEADS_DIR: BEADS,
    BD_GATE_CREATE_NOISE: "1",
  });
  check(
    "a gate whose id cannot be recorded REFUSES and rolls the phase back",
    r.code === 1 && has(r.out, "could not record"),
    r.out.slice(0, 240)
  );

  const st = phase(["status", b, "--json"]);
  let stPhase = null;
  try {
    stPhase = JSON.parse(st.out).phase;
  } catch {
    /* assertion below reports the raw output */
  }
  check("the bead is still in phase 1 after the rollback", String(stPhase) === "1", st.out.slice(0, 200));
  check("the orphan gate was resolved instead of left blocking the bead", openCount() === 0, `open=${openCount()}`);

  const retry = phase(["enter", b, "2", "--reason", "the spec is written and settled"]);
  check(
    "the retry records a gate id and enters phase 2",
    retry.code === 0 && has(retry.out, "GATE G2a created"),
    retry.out.slice(0, 240)
  );
}

console.log("\nevidence has to say something");
{
  const b = newBead("thin evidence");
  phase(["enter", b, "1", "--reason", "start", "--quiet"]);
  for (const [label, value] of [
    ["whitespace", "   "],
    ["one repeated character", "aaaaaaaaaaaa"],
    ["punctuation only", "............"],
    ["two words", "ok done"],
  ]) {
    const r = phase(["complete", b, "1", "--evidence", value, "--quiet"]);
    check(`${label} is REFUSED as evidence`, r.code === 1 && has(r.out, "not informative"), r.out.slice(0, 160));
  }
  const ok = phase(["complete", b, "1", "--evidence", "ran the parser over 3 malformed files; all 3 exited 2", "--quiet"]);
  check("a real result is accepted", ok.code === 0, ok.out.slice(0, 160));
}

console.log("\nship cannot complete while Gate C is open");
{
  const b = walkTo("gate c blocks ship", "7");

  // The suite reads phase through `status --json` (the same pattern the gate
  // rollback block uses) rather than guessing bd's raw `show` shape, and gate
  // status through the same JSON's `gates_pending` — the machine's own report,
  // which statuses C as pending exactly when gatePending() would refuse.
  const st = phase(["status", b, "--json"]);
  const stJson = (() => { try { return JSON.parse(st.out); } catch { return {}; } })();
  check(
    "the walk really reached phase 7 with Gate C open, so the refusal below means something",
    String(stJson.phase) === "7" && (stJson.gates_pending || []).includes("G3"),
    st.out.slice(0, 240)
  );

  const refused = phase(["complete", b, "7", "--evidence", "deployed and smoke-tested; 200 on /health", "--quiet"]);
  check(
    "complete 7 REFUSES while Gate C is pending",
    refused.code === 2 && has(refused.out, "GATE G3 is pending"),
    `${refused.code} ${refused.out.slice(0, 200)}`
  );

  // Positive control: the same bead completes once C is resolved, so the
  // refusal above is about the gate and not about a broken walk.
  const resolved = phase(["gate", b, "C", "--evidence", "reviewed the release: artifact hashes match, smoke test returned 200", "--quiet"]);
  check("resolving Gate C succeeds", resolved.code === 0, resolved.out.slice(0, 200));
  const shipped = phase(["complete", b, "7", "--evidence", "deployed and smoke-tested; 200 on /health", "--quiet"]);
  check("the same bead completes 7 once Gate C is resolved", shipped.code === 0, shipped.out.slice(0, 200));
}

console.log("\n--ran names a command, an observation, a time and an artifact");
{
  const b = walkTo("ran evidence", "5");
  const artifact = join(SANDBOX, "boot.log");
  if (!existsSync(artifact)) writeFileSync(artifact, "200 OK\n");

  for (const [why, bad] of [
    ["no timestamp", "npm run dev -> 200 OK"],
    ["no observation", "npm run dev at 2026-10-20T10:00:00Z"],
    ["no command", "-> 200 OK at 2026-10-20T10:00:00Z"],
  ]) {
    const r = phase(["complete", b, "5", "--evidence", "ran the boot check", "--ran", bad, "--artifact", artifact, "--quiet"]);
    check(`--ran REFUSES a claim with ${why}`, r.code === 1 && has(r.out, "--ran"), r.out.slice(0, 160));
  }

  const missing = phase(["complete", b, "5", "--evidence", "ran the boot check",
    "--ran", "npm run dev -> 200 OK at 2026-10-20T10:00:00Z", "--artifact", join(SANDBOX, "nope.log"), "--quiet"]);
  check("--ran REFUSES an artifact path that does not exist",
    missing.code === 1 && has(missing.out, "does not exist"), missing.out.slice(0, 200));

  // Deliberately NOT --quiet: the assertion reads the "ran:" line, and --quiet
  // suppresses `say` chatter by design. A quiet success would be invisible here.
  const ok = phase(["complete", b, "5", "--evidence", "ran the boot check",
    "--ran", RAN_CLAIM, "--artifact", artifact]);
  check("the same bead completes 5 once --ran names a real artifact",
    ok.code === 0 && has(ok.out, "ran:"), ok.out.slice(0, 200));
}

console.log("\n--booted still works as a deprecated alias");
{
  const b = walkTo("ran alias", "5");
  const artifact = join(SANDBOX, "boot.log");
  if (!existsSync(artifact)) writeFileSync(artifact, "200 OK\n");
  const alias = phase(["complete", b, "5", "--evidence", "the alias still works", "--booted", RAN_CLAIM, "--artifact", artifact, "--quiet"]);
  check("--booted still completes phase 5", alias.code === 0, alias.out.slice(0, 200));
}

console.log("\na gate resolved outside the machine is not an approval");
{
  // Walk to phase 2, complete it, and stop at GATE A: enter 2 creates the gate,
  // and completing 2 leaves the gate as the only thing standing before 3 (the
  // same reasoning the gate-command block records above). If phase 2 were left
  // unfinished, `enter 3` would be refused as an ILLEGAL TRANSITION rather than
  // as a pending gate, and the assertion below would be measuring the wrong
  // refusal.
  const b = newBead("raw gate resolve");
  const steps = [
    ["enter", "0", "walking to the gate"],
    ["complete", "0", "onboarded: bd init and the graft build both ran"],
    ["enter", "1", "walking to the gate"],
    ["complete", "1", "brainstorm written; three directions rejected"],
    ["enter", "2", "walking to the gate"],
    ["complete", "2", "the spec is written and the design direction is settled"],
  ];
  for (const [cmd, p, ev] of steps) {
    const r = cmd === "enter"
      ? phase([cmd, b, p, "--reason", ev, "--quiet"])
      : phase([cmd, b, p, "--evidence", ev, "--quiet"]);
    if (r.code !== 0) throw new Error(`setup failed at ${cmd} ${p}: ${r.out.slice(0, 300)}`);
    // G1 is raised by enter 1. Approve it so the first open gate left below is
    // G2a, which is the gate this block means to close by hand.
    if (cmd === "enter" && p === "1") {
      const g1 = approveGate(b, "G1");
      if (g1.code !== 0) throw new Error(`setup failed approving G1: ${g1.out.slice(0, 300)}`);
    }
  }

  const rows = JSON.parse(bd(["gate", "list", b, "--all", "--json"]).out);
  const list = Array.isArray(rows) ? rows : (rows && rows.gates) || [];
  const gate = list.find((g) => ["open", "pending"].includes(String(g.status || g.state || "open")));
  if (!gate) throw new Error(`setup failed: no open gate on ${b}: ${JSON.stringify(rows).slice(0, 300)}`);

  // The bypass: close it with no reason at all. This is the exact move a hand
  // resolution makes, and after Task 9 it must not read as an approval. A token
  // is deliberately NOT written here - fabricating it would test the token
  // check with the token.
  const raw = bd(["gate", "resolve", gate.id]);
  if (raw.code !== 0) throw new Error(`setup failed: raw resolve: ${raw.out.slice(0, 300)}`);

  const refused = phase(["enter", b, "3", "--reason", "skipping the gate", "--quiet"]);
  check(
    "a gate resolved with no reason is still PENDING",
    refused.code === 2 && has(refused.out, "GATE G2a is pending"),
    `${refused.code} ${refused.out.slice(0, 200)}`
  );

  // Recovery: the factory re-raises the hand-resolved gate and records its own.
  const recovered = phase(["gate", b, "A", "--evidence", "the spec and the design direction are settled and written down", "--quiet"]);
  check("the factory can re-raise and approve a gate that was resolved by hand", recovered.code === 0, recovered.out.slice(0, 240));
  const opened = phase(["enter", b, "3", "--reason", "gate approved by the factory", "--quiet"]);
  check("once the factory approves, the phase opens", opened.code === 0, opened.out.slice(0, 240));
}

console.log("\na bead with no Gate C record cannot complete ship");
{
  // The shape a legacy bead can be in: phase 7 reached on code that warned and
  // returned success when the gate id could not be recorded.
  const b = newBead("legacy ship without gate c");
  const p1 = bd(["set-state", b, "phase=7"]);
  const p2 = bd(["set-state", b, "phase_done=6"]);
  if (p1.code !== 0 || p2.code !== 0) throw new Error(`setup failed: ${p1.out} ${p2.out}`);

  const refused = phase(["complete", b, "7", "--evidence", "deployed and smoke-tested; 200 on /health", "--quiet"]);
  check(
    "complete 7 REFUSES when no Gate C id was ever recorded",
    refused.code === 1 && has(refused.out, "GATE G3 has no recorded gate id"),
    `${refused.code} ${refused.out.slice(0, 220)}`
  );

  // The refusal must not be vacuous in the other direction either: once the
  // record exists and the gate is approved, the same bead ships.
  const gate = phase(["gate", b, "C", "--evidence", "reviewed the release: artifact hashes match, smoke test returned 200", "--quiet"]);
  check("the factory can backfill and approve Gate C on that bead", gate.code === 0, gate.out.slice(0, 220));
  const shipped = phase(["complete", b, "7", "--evidence", "deployed and smoke-tested; 200 on /health", "--quiet"]);
  check("the same bead completes 7 once Gate C is recorded and approved", shipped.code === 0, shipped.out.slice(0, 220));
}

// G1 is policy-gated: without config/factory.policy.yaml, phase 1 completes
// exactly as it did in M0, even on a legacy bead that never recorded a gate id.
console.log("\nphase 1 needs no G1 record without a policy");
{
  const b = newBead("phase 1 without policy");
  const set = bd(["set-state", b, "phase=1"]);
  check("could put a bead in phase 1 with no G1 record", set.code === 0, set.out.slice(0, 160));
  const done = phase(["complete", b, "1", "--evidence", "brainstormed the design; four directions, one kept", "--quiet"]);
  check("complete 1 passes with no policy and no G1 record", done.code === 0, done.out.slice(0, 200));
}

// ---- policy-driven completion ------------------------------------------------
// A repo with a policy says which artifacts each phase needs; with one, `complete`
// reads the bead's manifest and refuses on anything the attest ladder does not
// call `ok`. This block is LAST and it is the only place a policy file appears:
// everything above it runs policy-free (loadPolicy returns null with no
// config/factory.policy.yaml), which is what keeps the M0 behaviour above
// unchanged. This is the 139th, 140th and 141st check() call; the block is also
// the only one that puts a git repo in the sandbox, because attest refuses to
// record outside one.
console.log("\npolicy-driven completion");
const policyDir = join(SANDBOX, "config");
const policyRun = join(SANDBOX, "run.txt");
const policyHashRun = join(SANDBOX, "run2.txt");
const policyArtifact = join(SANDBOX, "boot.log");
// The artifact phase 5's own --ran gate demands. That gate is evaluated BEFORE
// the policy (see cmdComplete), so every complete 5 below has to clear it or the
// refusal under test would be a --ran refusal instead.
writeFileSync(policyArtifact, "200 OK\n");
{
  execFileSync("git", ["init"], { cwd: SANDBOX, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "base"], { cwd: SANDBOX, stdio: "ignore" });
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, "factory.policy.yaml"), [
    "version: 1",
    "tier: prototype",
    "profile: web",
    "tiers:",
    "  prototype:",
    "    checks: [run]",
    "profiles:",
    "  web:",
    "    checks: []",
    "checks:",
    "  run:",
    "    phase: 5",
    "    kind: transcript",
    "    command: npm test",
    "",
  ].join("\n"));

  // With a policy present, G1 stops being advisory: the phase that asks "is
  // this worth building" cannot be completed while the answer is still pending.
  const g1bead = newBead("policy requires G1");
  phase(["enter", g1bead, "0", "--reason", "walk to the G1 check", "--quiet"]);
  phase(["complete", g1bead, "0", "--evidence", "onboarded the G1 check; bd ready came up clean", "--quiet"]);
  phase(["enter", g1bead, "1", "--reason", "walk to the G1 check", "--quiet"]);
  const noG1 = phase(["complete", g1bead, "1", "--evidence", "brainstorm written; four directions, one kept", "--quiet"]);
  check(
    "complete 1 under a policy REFUSES while G1 is pending",
    noG1.code === 2 && has(noG1.out, "GATE G1 is pending") && has(noG1.out, `factory-phase gate ${g1bead} G1`),
    `${noG1.code} ${noG1.out.slice(0, 260)}`
  );
  const approvedG1 = approveGate(g1bead, "G1");
  check("approving G1 succeeds", approvedG1.code === 0, approvedG1.out.slice(0, 160));
  const withG1 = phase(["complete", g1bead, "1", "--evidence", "brainstorm written; four directions, one kept", "--quiet"]);
  check("the same bead completes 1 once G1 is approved", withG1.code === 0, withG1.out.slice(0, 200));

  const p1 = walkTo("policy-missing", "5");
  const missing = phase(["complete", p1, "5", "--evidence", "the artifact is supposedly verified and on disk",
    "--ran", RAN_CLAIM, "--artifact", policyArtifact, "--quiet"]);
  check(
    "a policy that requires an unattested artifact REFUSES completion",
    missing.code === 1 && has(missing.out, "factory-attest attest") && has(missing.out, "MISSING run"),
    `${missing.code} ${missing.out.slice(0, 300)}`
  );

  writeFileSync(policyRun, "ok\n");
  // The absolute path matters: run() pins cwd to SANDBOX, where scripts/ does not exist.
  const attested = run("node", [join(HERE, "factory-attest.mjs"), "attest", p1, "run.txt", "--id", "run", "--kind", "transcript"], { BEADS_DIR: BEADS });
  check("the artifact the policy requires can be attested", attested.code === 0, attested.out.slice(0, 200));

  const accepted = phase(["complete", p1, "5", "--evidence", "the run transcript is attested and its hash matches HEAD",
    "--ran", RAN_CLAIM, "--artifact", policyArtifact, "--quiet"]);
  const p1done = bd(["state", p1, "phase_done"]);
  check(
    "the same bead completes once the required artifact is attested",
    accepted.code === 0 && has(p1done.out, "5"),
    `${accepted.code} ${accepted.out.slice(0, 200)} ${p1done.out.slice(0, 120)}`
  );

  const p2 = walkTo("policy-hash", "5");
  writeFileSync(policyHashRun, "ok\n");
  const attested2 = run("node", [join(HERE, "factory-attest.mjs"), "attest", p2, "run2.txt", "--id", "run", "--kind", "transcript"], { BEADS_DIR: BEADS });
  if (attested2.code === 0) appendFileSync(policyHashRun, "one more byte the hash does not know about\n");
  const tampered = phase(["complete", p2, "5", "--evidence", "the run transcript is attested and its hash matches HEAD",
    "--ran", RAN_CLAIM, "--artifact", policyArtifact, "--quiet"]);
  check(
    "an attested artifact whose bytes changed REFUSES completion",
    tampered.code === 1 && has(tampered.out, "HASH run"),
    `${tampered.code} ${tampered.out.slice(0, 300)}`
  );

  // The project root is the directory holding .beads, not the cwd. If complete
  // resolved the policy from the cwd instead, running it from a subdirectory
  // would find no policy and pass without verifying anything - a false pass.
  // run() pins cwd to SANDBOX, so this one calls the script directly.
  const policySub = join(SANDBOX, "sub");
  mkdirSync(policySub, { recursive: true });
  const p3 = walkTo("policy-subdir", "5");
  let subCode = 0, subOut = "";
  try {
    subOut = execFileSync(process.execPath, [SCRIPT, "complete", p3, "5",
      "--evidence", "the artifact is supposedly verified and on disk",
      "--ran", RAN_CLAIM, "--artifact", policyArtifact, "--quiet"],
      { encoding: "utf8", cwd: policySub, env: { ...process.env, BEADS_DIR: BEADS }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    subCode = e.status ?? 1;
    subOut = `${e.stdout || ""}${e.stderr || ""}`;
  }
  check(
    "the same policy REFUSES completion from a subdirectory",
    subCode === 1 && has(subOut, "MISSING run"),
    `${subCode} ${subOut.slice(0, 300)}`
  );
}

// ---- ship acceptance and the outcome record ---------------------------------
// A passing review is not an acceptance, and completing a phase is not
// accepting its output. These drive the real writers (factory-review record and
// accept) rather than a hand-written fixture, so a drift in either shape fails
// here too.
console.log("\nship acceptance and the outcome record");

const reviewCli = join(HERE, "factory-review.mjs");
const review = (args, env = {}) => run(process.execPath, [reviewCli, ...args], { BEADS_DIR: BEADS, ...env });

// The ship gate demands a signed acceptance tag (factory-accept/<bead>), so the
// suite needs a real signing key: git sign and git verify-tag both go through
// ssh-keygen. Resolved like the review suite: PATH first, then Git for Windows'
// bundled binary; without either there is nothing to prove, so fail loudly.
const keyPath = join(SANDBOX, ".testkey");
let keygenBin = null;
let keygenErr = null;
for (const bin of ["ssh-keygen", "C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe"]) {
  const kg = run(bin, ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
  if (kg.code === 0) { keygenBin = bin; break; }
  keygenErr = kg.out;
}
if (keygenBin === null) {
  throw new Error("ssh-keygen is required for the acceptance-tag tests" +
    (keygenErr ? ` (${keygenErr})` : ""));
}
// The signers file lives beside the policy in config/ (created only if missing:
// the policy block above already owns that directory). It must exist BEFORE the
// first complete 7 of this block, because the first one tests the refusal.
const learnSSH = (args) => run("git", args);
mkdirSync(join(SANDBOX, "config"), { recursive: true });
writeFileSync(join(SANDBOX, "config", "factory.allowed_signers"),
  `* namespaces="git" ${readFileSync(`${keyPath}.pub`, "utf8").trim()}\n`);
learnSSH(["config", "gpg.format", "ssh"]);
learnSSH(["config", "user.signingkey", keyPath]);

// An acceptance is a tag, not a file beside the review.
const hasTag = (b) =>
  run("git", ["rev-parse", "-q", "--verify", `refs/tags/factory-accept/${b}`]).code === 0;
const dropTag = (b) => run("git", ["tag", "-d", `factory-accept/${b}`]);

function shipBead(title, file) {
  // The policy block installs a phase-5 `run` check before this block runs, so
  // the walk must satisfy it or complete 5 refuses. run.txt already exists in
  // the sandbox from that block; attest it for this bead, then let walkTo
  // complete phase 5 normally.
  const b = walkTo(title, "7", (bead) => {
    const a = run(process.execPath,
      [join(HERE, "factory-attest.mjs"), "attest", bead, "run.txt", "--id", "run", "--kind", "transcript", "--command", "npm test"],
      { BEADS_DIR: BEADS, FACTORY_SESSION: "build:1" });
    if (a.code !== 0) throw new Error(`attest run for ${bead} failed: ${a.out.slice(0, 300)}`);
  });
  approveGate(b, "C");
  writeFileSync(join(SANDBOX, file), "ok\n");
  // No second attestation here: the policy declares only the `run` check, and
  // attest refuses an id the policy does not declare. The `run` attestation in
  // the prep already froze the builder session, which is all the acceptance
  // checks need. complete 7 has no policy checks of its own.
  return b;
}

function acceptedReview(b) {
  const started = review(["start", b]);
  if (started.code !== 0) throw new Error(`review start for ${b} failed: ${started.out.slice(0, 300)}`);
  writeFileSync(join(SANDBOX, ".factory", b, "review-1.md"), "# Review\n\nVerdict: pass\n");
  const rec = review(["record", b, "--file", `.factory/${b}/review-1.md`, "--verdict", "pass"],
    { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "review:1" });
  if (rec.code !== 0) throw new Error(`review record for ${b} failed: ${rec.out.slice(0, 300)}`);
  // The tag is created by the real accept command, not a hand-made git call:
  // this proves the shipped signing path, not a fixture that happens to nod at
  // it.
  return review(["accept", b, "--note", "read the diff and the run"],
    { FACTORY_ROLE: "human", FACTORY_SESSION: "human:1" });
}

{
  const p7 = shipBead("ship without acceptance", "ship.txt");
  const noAcc = phase(["complete", p7, "7", "--evidence", "the build is done and the review passed", "--quiet"]);
  check(
    "shipping without a human acceptance REFUSES, naming the tag",
    noAcc.code === 1 && has(noAcc.out, "factory-accept/") && has(noAcc.out, "factory-review.mjs record"),
    `${noAcc.code} ${noAcc.out.slice(0, 300)}`
  );

  const acc = acceptedReview(p7);
  check(
    "a separate reviewer and a human can accept the bead, leaving a signed tag",
    acc.code === 0 && hasTag(p7),
    `${acc.code} ${acc.out.slice(0, 200)} tag=${hasTag(p7)}`
  );

  const shipped = phase(["complete", p7, "7", "--evidence", "the review passed and a human accepted it", "--quiet"]);
  check("ship completes once a human has accepted", shipped.code === 0, `${shipped.code} ${shipped.out.slice(0, 300)}`);

  const entered8 = phase(["enter", p7, "8", "--reason", "close the run", "--quiet"]);
  check("the accepted bead can enter close", entered8.code === 0, entered8.out.slice(0, 200));
  const noOutcome = phase(["complete", p7, "8", "--evidence", "the run is closed", "--quiet"]);
  check(
    "closing without an outcome record REFUSES",
    noOutcome.code === 1 && has(noOutcome.out, "outcome.md"),
    `${noOutcome.code} ${noOutcome.out.slice(0, 300)}`
  );
  writeFileSync(join(SANDBOX, ".factory", p7, "outcome.md"), [
    "# Outcome", "", "## What changed", "", "The feature shipped.", "",
    "## Measured before / after", "", "p95 420ms -> 210ms.", "",
  ].join("\n"));
  const closed = phase(["complete", p7, "8", "--evidence", "the outcome is written down", "--quiet"]);
  check("closing succeeds once the outcome record exists", closed.code === 0, `${closed.code} ${closed.out.slice(0, 300)}`);
}

{
  const p7b = shipBead("ship after a late edit", "ship2.txt");
  const acc = acceptedReview(p7b);
  if (acc.code !== 0) throw new Error(`accept for ${p7b} failed: ${acc.out.slice(0, 300)}`);
  const reaccept = (why) => {
    const r = review(["accept", p7b, "--note", why], { FACTORY_ROLE: "human", FACTORY_SESSION: "human:1" });
    if (r.code !== 0) throw new Error(`re-accept for ${p7b} failed: ${r.out.slice(0, 300)}`);
    return r;
  };

  // Deleting the tag is a withdrawal: a signed gate that is gone is not a pass.
  const dropped = dropTag(p7b);
  const noTag = phase(["complete", p7b, "7", "--evidence", "the review was accepted before this delete", "--quiet"]);
  check(
    "deleting the acceptance tag REFUSES ship again",
    dropped.code === 0 && noTag.code === 1 && has(noTag.out, `no acceptance tag for ${p7b}`) &&
    has(noTag.out, "factory-accept/"),
    `${dropped.code} ${noTag.code} ${noTag.out.slice(0, 300)}`
  );

  // An unsigned lightweight tag wearing the acceptance name is not signed by
  // anybody: verify-tag fails it and the refusal says so, same as a stranger's
  // key would be.
  // The tag is already gone here: the assertion above deleted it to prove
  // `complete 7` refuses without one. Deleting it again fails, and that failure
  // is not part of what this case is about - the forged tag and the refusal are.
  dropTag(p7b);
  const headSha = run("git", ["rev-parse", "HEAD"]).out.trim();
  const forged = run("git", ["tag", `factory-accept/${p7b}`, headSha]);
  const unsigned = phase(["complete", p7b, "7", "--evidence", "a tag of this name exists", "--quiet"]);
  check(
    "an unsigned lightweight tag is REFUSED with the allowed-signer message",
    forged.code === 0 && unsigned.code === 1 &&
    has(unsigned.out, "not signed by an allowed signer"),
    `${forged.code} ${unsigned.code} ${unsigned.out.slice(0, 300)}`
  );

  // Back to a real acceptance before the verdict-drift case: the tag is
  // re-signed from the untouched review, so the only change below is the file.
  dropTag(p7b);
  reaccept("signed again after the unsigned tag was removed");
  appendFileSync(join(SANDBOX, ".factory", p7b, "review-1.md"), "\nAdded after the human read it.\n");
  const late = phase(["complete", p7b, "7", "--evidence", "the review was accepted before this edit", "--quiet"]);
  check(
    "a verdict edited after acceptance REFUSES ship",
    late.code === 1 && has(late.out, "verdict file changed after review"),
    `${late.code} ${late.out.slice(0, 300)}`
  );
}

// ---------------------------------------------------------------- report
console.log(`\n${pass}/${pass + fail} phase-machine tests passed.`);
if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
// bd's Dolt database can stay locked for a moment after the last command, so
// retry the remove; a locked temp dir is a cleanup note, never a test result.
try { rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
process.exit(fail ? 1 : 0);
