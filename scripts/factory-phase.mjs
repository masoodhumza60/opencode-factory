#!/usr/bin/env node
// factory-phase.mjs - the phase machine as an enforced state machine.
//
// P2 of the factory plan. The conductor used to describe the pipeline in prose
// and trust the model to follow it. This makes the same pipeline a gate that
// refuses illegal transitions, so "no implementation files before spec AND plan
// approval" is a fact the state layer will not let you violate.
//
//   node scripts/factory-phase.mjs status   <bead> [--json]
//   node scripts/factory-phase.mjs next     <bead> [--json]
//   node scripts/factory-phase.mjs enter    <bead> <phase> --reason "..."
//   node scripts/factory-phase.mjs complete <bead> <phase> --evidence "..."
//   node scripts/factory-phase.mjs handoff  <bead> --next "<action>"
//
// Exit: 0 ok | 1 illegal or error | 2 blocked (a human gate is still pending)
//
// The design rule that shapes this file: fail closed. An unreadable state, an
// unknown phase, or a gate we cannot evaluate means STOP. Inferring intent from
// prose is how a plan file full of the word "approved" once convinced an agent to
// start implementing.

import { execFileSync } from "node:child_process";

const PHASES = [
  { id: "0", name: "onboard", gate: null },
  { id: "1", name: "brainstorm", gate: null },
  { id: "2", name: "spec", gate: "A" },
  { id: "3", name: "plan", gate: "B" },
  { id: "4", name: "implement", gate: null },
  { id: "4p", name: "debug", gate: null, detour: true },
  { id: "5", name: "verify", gate: null },
  { id: "6", name: "review", gate: null },
  { id: "7", name: "ship", gate: "C" },
  { id: "8", name: "close", gate: null },
];
const byId = new Map(PHASES.map((p) => [p.id, p]));
const GATE_KEY = { A: "gate_a", B: "gate_b", C: "gate_c" };
// Which phase was last COMPLETED, as distinct from which phase is CURRENT.
// These were the same fact until 7b ran a real phase and found `complete`
// persisted nothing: it printed the evidence and threw it away, so
// `phase=1` could mean "working on it" or "finished it" and nothing in the
// state layer could tell the difference. A crash between enter and complete was
// indistinguishable from an abandoned phase. Completion needs its own recorded
// value, or resume is guesswork and the `--evidence` gate is decoration.
const DONE_DIM = "phase_done";

// The detour's own dimension, kept separate from DONE_DIM on purpose. A run
// completes a SET of phases; phase_done holds one value, so recording a detour
// there overwrote whatever phase had actually been completed. See cmdComplete.
const REPAIR_DIM = "repair_done";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const asJson = args.includes("--json");
const quiet = args.includes("--quiet");
// The complete set of flags this script understands, so a flag used as a
// positional can be reported as exactly that. Every flag is read by name above
// (flag("reason"), flag("evidence"), flag("next")) or tested with includes(), so
// this list and those reads must stay in step.
const FLAG_NAMES = new Set(["reason", "evidence", "next", "json", "quiet"]);
// The flags that consume the argument after them. Needed to tell a positional
// from a flag's value: counting `--reason "why"` as two positionals is what made
// this check reject every correct invocation.
const VALUE_FLAGS = new Set(["reason", "evidence", "next"]);

let BD = "bd";
function bd(args2, { allowFail = false } = {}) {
  try {
    return execFileSync(BD, args2, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (allowFail) return null;
    const detail = (e.stderr || e.message || "").trim();
    throw new BdError(detail || "bd failed");
  }
}
class BdError extends Error {}
class Illegal extends Error {}
class Blocked extends Error {}

// --quiet suppresses the chatter ("entered phase 2", "handoff recorded") but
// NEVER the payload: the payload is the answer to the question that was asked,
// and a script that goes silent when asked something is a script you cannot
// assert on. Errors always go to stderr regardless.
const say = (...a) => { if (!quiet) console.log(...a); };
const out = (o) => console.log(asJson ? JSON.stringify(o, null, 2) : o.text);

// ---- state reads (fail closed) ------------------------------------------------

function readPhase(bead) {
  let raw;
  try {
    raw = bd(["state", bead, "phase"]);
  } catch (e) {
    throw new BdError(`cannot read phase for ${bead}: ${e.message}`);
  }
  // Verified bd 1.3.0 output: "(no phase state set)" when unset (exit 0), and
  // the bare value ("2") when set. Anything else is a shape we do not
  // understand, and guessing is how a plan file full of the word "approved"
  // once convinced an agent to start implementing.
  const s = String(raw).trim();
  if (!s || /^\(no .* state set\)$/i.test(s)) return null;
  const m = s.match(/(?:^|\s)phase[:=]\s*(\S+)/) || s.match(/^(\S+)$/);
  if (!m) throw new Illegal(`unrecognized phase state for ${bead}: ${JSON.stringify(s)}`);
  const id = m[1];
  if (!byId.has(id)) throw new Illegal(`unknown phase "${id}" recorded on ${bead}`);
  return id;
}

// The last phase recorded as complete, or null if none. Same fail-closed
// posture as readPhase: bd's unset sentinel is trusted, a shape we do not
// recognise throws rather than being guessed at. This is NOT validated against
// the phase table the way `phase` is, because a detour's completion is recorded
// under its own id and a hand-edited value should surface as "not the phase I
// expect" rather than as a parse crash.
function readDone(bead) {
  let raw;
  try {
    raw = bd(["state", bead, DONE_DIM]);
  } catch (e) {
    throw new BdError(`cannot read ${DONE_DIM} for ${bead}: ${e.message}`);
  }
  const s = String(raw).trim();
  if (!s || /^\(no .* state set\)$/i.test(s)) return null;
  const m = s.match(/(?:^|\s)phase_done[:=]\s*(\S+)/) || s.match(/^(\S+)$/);
  if (!m) throw new Illegal(`unrecognized ${DONE_DIM} state for ${bead}: ${JSON.stringify(s)}`);
  return m[1];
}

function readMeta(bead) {
  const raw = bd(["show", bead, "--json"], { allowFail: true });
  if (!raw) return {};
  let j;
  try { j = JSON.parse(raw); } catch { return {}; }
  const issue = Array.isArray(j) ? j[0] : (j.issue || j);
  return issue?.metadata || {};
}

// bd 1.3.0's gate JSON has no "blocked_issue" field - the blocked bead appears
// only inside the description text. Rather than scrape prose, we look gates up
// by the id we recorded in the bead's metadata when we created them.
function allGates() {
  const raw = bd(["gate", "list", "--all", "--json"], { allowFail: true });
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : (rows.gates || []);
  } catch { return []; }
}

function gatePending(bead, meta, key) {
  const id = meta?.[key];
  if (!id) return null;                       // no gate was ever created
  const g = allGates().find((x) => (x.id || x.gate_id) === id);
  if (!g) return null;                        // resolved gates drop out of the list
  const status = String(g.status || g.state || "open");
  return status === "open" || status === "pending" ? id : null;
}

// The one detour in the pipeline, derived from the table rather than hardcoded,
// so changing the table cannot silently leave a magic "4p" behind.
const REPAIR = PHASES.find((p) => p.detour);

// Phases that exist to FIND defects, and therefore need somewhere to go and fix
// them. Ship (7) is deliberately absent: once you are shipping, a human decides
// at Gate C, not the machine.
const FINDING_PHASES = new Set(["5", "6"]);

// ---- legality ------------------------------------------------------------------

function legalNext(bead) {
  const phase = readPhase(bead);
  const done = readDone(bead);
  const meta = readMeta(bead);
  if (phase === null) return { phase, done, candidates: ["0", "1"] };
  const cur = byId.get(phase);
  if (cur.detour) {
    // Falling through to 5 is allowed when the phase you arrived from was
    // completed - 4, 5 or 6, because the detour is now reachable from all three.
    // It is refused when nothing from implement onwards is done, which is the
    // back door this check exists to close: enter 4, never complete it, hop
    // through the detour, land on verify with implement unfinished. The first
    // version of the broadened detour tested `done === "4"`, so arriving from a
    // completed verify was told implement was unfinished - found by the tests
    // added with that change.
    const arrivedFromFinished = done === "4" || done === "5" || done === "6";
    return arrivedFromFinished
      ? { phase, done, candidates: ["4", "5"], note: "debug detour: return to 4 or proceed to 5" }
      : {
          // 5 is still listed, because "5 is not next" is a less useful thing
          // to tell someone than "5 is blocked because implement is unfinished".
          phase, done, candidates: ["4", "5"], blockedOn: "4", alwaysLegal: ["4"],
          note: "debug detour: no phase from implement onwards is complete yet, so falling through to 5 is refused",
        };
  }
  const i = PHASES.findIndex((p) => p.id === phase);
  const nxt = PHASES[i + 1];
  if (!nxt) return { phase, done, candidates: [], note: "final phase reached" };
  // A detour is a BRANCH off the current phase, not the next step in a sequence.
  // From phase 4 both the detour (4p, debug) and the phase after it (5, verify)
  // are legal, because a run that implemented cleanly must be able to verify
  // without first inventing a debug detour to pass through. Modelling 4p as the
  // next list entry forced every successful implement through it - found by a
  // real 7b run, which could not enter verify at all. The conductor has always
  // described 4p as reachable FROM 4, never as a step that must be taken.
  if (nxt.detour) {
    const after = PHASES[i + 2];
    const cands = after ? [nxt.id, after.id] : [nxt.id];
    if (done !== phase) {
      return {
        phase, done, candidates: cands, blockedOn: phase, alwaysLegal: [nxt.id],
        note: `phase ${phase} (${cur.name}) is in progress - complete it before verifying; the ${nxt.id} debug detour is always available`,
      };
    }
    return {
      phase, done, candidates: cands,
      note: after ? `${nxt.id} is an optional debug detour; ${after.id} is next` : `${nxt.id} is an optional debug detour`,
    };
  }
  // Advancing requires the current phase to have been completed. The one
  // exception is entering the debug detour, because debugging is exactly what
  // you do when a phase is NOT complete, and requiring completion first would
  // make the detour unreachable. Everything else must go through `complete`.
  //
  // `candidates` still lists the next phase while completion is outstanding:
  // the gate blocker is the more immediate thing to tell someone, and
  // `bd ready`-style emptiness would hide "GATE A pending" behind a phase that
  // is merely unfinished. `blockedOn` is what actually refuses the entry.
  if (done !== phase && !nxt.detour) {
    return {
      phase, done, candidates: [nxt.id], blockedOn: phase,
      note: `phase ${phase} (${cur.name}) is in progress - complete it before advancing`,
    };
  }
  // The debug detour is a BRANCH off every phase that can surface a defect, not
  // just off implement. Verify and review exist to find things that are wrong,
  // so a run that reaches them carrying a finding has to be able to go and fix
  // it. Found by a real 7b run: verify returned four findings and the machine's
  // only legal next move was to advance past them - which is either a route
  // around the guard or a review of known-broken code. Both are worse than a
  // detour. Coming back out is already handled: 4p's own candidates are 4 and
  // 5, so a fix made from verify can be re-verified.
  if (FINDING_PHASES.has(phase)) {
    return {
      phase, done, candidates: [nxt.id, REPAIR.id], meta,
      note: `${REPAIR.id} is the repair detour; ${nxt.id} is next`,
    };
  }
  return { phase, done, candidates: [nxt.id], meta };
}

// ---- commands -------------------------------------------------------------------

function cmdStatus(bead) {
  const phase = readPhase(bead);
  const done = readDone(bead);
  const meta = readMeta(bead);
  const pending = Object.entries(GATE_KEY)
    .map(([g, k]) => [g, gatePending(bead, meta, k)])
    .filter(([, v]) => v);
  const cur = phase ? byId.get(phase) : null;
  // "current" alone is not enough for a resuming session: phase 1 with nothing
  // completed is a phase to finish, and phase 1 with phase 1 complete is a phase
  // to leave. Reporting both is the difference between resuming and guessing.
  const state = phase === null
    ? "not started"
    : done === phase
      ? `IN PROGRESS (complete, ready to advance)`
      : `IN PROGRESS (not completed)`;
  out({
    text: [
      `bead:     ${bead}`,
      `phase:    ${phase === null ? "(none - not started)" : `${phase} ${cur.name} - ${state}`}`,
      `done:     ${done === null ? "(no phase completed yet)" : `${done} ${byId.get(done)?.name ?? ""}`.trim()}`,
      `gates:    ${pending.length ? pending.map(([g, id]) => `${g} PENDING (${id})`).join(", ") : "none pending"}`,
      `blockers: ${gatePending(bead, meta, "gate_a") ? "GATE A" : ""}${gatePending(bead, meta, "gate_b") ? " GATE B" : ""}${gatePending(bead, meta, "gate_c") ? " GATE C" : ""}`.trim() || "none",
    ].join("\n"),
    bead, phase, done, completed: done === phase, gates_pending: pending.map(([g]) => g),
  });
}

function cmdNext(bead) {
  const { phase, done, candidates, note, blockedOn, alwaysLegal } = legalNext(bead);
  const meta = readMeta(bead);
  const blocked = [];
  for (const c of candidates) {
    if (c === "3" && gatePending(bead, meta, "gate_a")) blocked.push("3 (GATE A pending)");
    if (c === "4" && gatePending(bead, meta, "gate_b")) blocked.push("4 (GATE B pending)");
    if (c === "8" && gatePending(bead, meta, "gate_c")) blocked.push("8 (GATE C pending)");
    // An unfinished phase blocks its successor just as a pending gate does.
    // Reporting it here is what lets a resuming session see both problems at
    // once instead of discovering the second one after fixing the first.
    // String + number concatenates: "1" + 1 is "11", which matches nothing, and
    // the blocker silently disappeared from `next`. Phases are strings
    // everywhere else, so the conversion has to be explicit.
    if (blockedOn != null && c === String(Number(blockedOn) + 1) && !(alwaysLegal || []).includes(c))
      blocked.push(`${c} (phase ${blockedOn} not completed)`);
  }
  const open = candidates.filter((c) => !blocked.some((b) => b.startsWith(c)));
  out({
    text: [`current:  ${phase ?? "(none)"}`, `done:     ${done ?? "(none)"}`,
      `legal next: ${open.join(", ") || "(none)"}`,
      blocked.length ? `blocked:  ${blocked.join(", ")}` : null, note ? `note:     ${note}` : null]
      .filter(Boolean).join("\n"),
    bead, phase, done, candidates, open, blocked, completed: blockedOn == null,
  });
  if (!open.length && blocked.length) process.exitCode = 2;
}

function cmdEnter(bead, target, reason) {
  if (!byId.has(target)) throw new Illegal(`unknown phase "${target}"`);
  if (!reason) throw new Illegal("--reason is required: every transition is an event bead");
  const { phase, candidates, blockedOn, alwaysLegal } = legalNext(bead);
  const meta = readMeta(bead);

  if (target === "3" && gatePending(bead, meta, "gate_a"))
    throw new Blocked("GATE A is pending - the human has not approved the spec");
  if (target === "4" && gatePending(bead, meta, "gate_b"))
    throw new Blocked("GATE B is pending - the human has not approved the plan");
  if (target === "8" && gatePending(bead, meta, "gate_c"))
    throw new Blocked("GATE C is pending - the human has not approved the ship");
  // Legality applies to a virgin bead too. An earlier draft guarded this with
  // `phase !== null &&`, which meant a feature with no recorded phase could
  // enter ANY phase - exactly the transition the tests exist to forbid.
  if (!candidates.includes(target)) {
    // A skipped phase is the failure this must explain well, and the generic
    // "legal: (nothing)" message explains nothing. Say which phase is
    // unfinished and what to run instead.
    throw new Illegal(
      `illegal transition ${phase === null ? "(none)" : phase} -> ${target} (legal: ${candidates.join(", ")})`
    );
  }
  // An unfinished current phase refuses the advance, but NOT the debug detour
  // back to it - that is how you get back to a phase you are still working on.
  if (blockedOn != null && !(alwaysLegal || []).includes(target)) {
    throw new Illegal(
      `phase ${blockedOn} (${byId.get(blockedOn).name}) has not been completed - ` +
      `run: factory-phase.mjs complete ${bead} ${blockedOn} --evidence "..." (then enter ${target})`
    );
  }

  bd(["set-state", bead, `phase=${target}`, "--reason", reason]);
  say(`entered phase ${target} (${byId.get(target).name}) on ${bead}`);

  // Phases that end at a human gate create it now, so bd withholds the next
  // phase from `bd ready` instead of us having to remember to ask.
  const g = byId.get(target).gate;
  if (g) {
    const res = bd(["gate", "create", "--type=human", "--blocks", bead,
      "--reason", `GATE ${g}: ${byId.get(target).name} awaiting human approval`], { allowFail: true });
    // bd prints: "Created gate opencode-factory-gyc (type: human)". Ids contain
    // two or more hyphens, so a naive [a-z]+-[a-z]+ match would capture only the
    // prefix and record a gate id that can never be resolved.
    const id = (res || "").match(/Created gate\s+(\S+)/)?.[1];
    if (id) {
      const m = { ...meta, [GATE_KEY[g]]: id };
      bd(["update", bead, "--metadata", JSON.stringify(m)], { allowFail: true });
      say(`GATE ${g} created (${id}) - blocks ${bead} until resolved`);
    } else {
      say(`WARNING: gate created but its id could not be parsed; resolve it and re-run status`);
    }
  }
}

function cmdComplete(bead, target, evidence) {
  if (!byId.has(target)) throw new Illegal(`unknown phase "${target}"`);
  if (!evidence) throw new Illegal("--evidence is required: completion must be checkable, not asserted");
  const phase = readPhase(bead);
  if (phase !== target)
    throw new Illegal(`${bead} is in phase ${phase ?? "(none)"}, cannot complete ${target}`);
  // A detour is an ACTION, not a phase of the run, so completing it must not
  // write to phase_done. Found by a real 7b run that deadlocked: completion is a
  // SET of phases, but phase_done holds one scalar, so `complete 4p` overwrote
  // the record that verify had been completed. From then on the machine was
  // livelocked in 4 <-> 4p and could never reach verify, review, ship or close -
  // the repair destroyed the state it was supposed to restore. The detour
  // records its own work in its own dimension instead, which leaves the
  // back-door protection free: enter 4 -> 4p -> complete 4p still leaves
  // phase_done empty, so phase 5 is still correctly refused.
  const dim = byId.get(target).detour ? REPAIR_DIM : DONE_DIM;
  bd(["set-state", bead, `${dim}=${target}`, "--reason", `completed ${target} (${byId.get(target).name}): ${evidence}`]);
  const n = legalNext(bead);
  say(`completed ${target} (${byId.get(target).name}) - recorded as ${dim}=${target}`);
  say(`evidence: ${evidence}`);
  say(`next legal: ${n.candidates.join(", ") || "(none - see status)"}`);
}

function cmdHandoff(bead, next) {
  if (!next) throw new Illegal("--next is required: a handoff without a next action is a dead end");
  bd(["update", bead, "--append-notes", `next: ${next}`], { allowFail: true });
  const phase = readPhase(bead);
  say(`handoff recorded on ${bead} (phase ${phase ?? "none"}) - next: ${next}`);
}

// ---- main -----------------------------------------------------------------------

try {
  if (!cmd) {
    console.error("usage: factory-phase.mjs <status|next|enter|complete|handoff> ...");
    process.exit(1);
  }
  const bead = args[1];
  if (cmd !== "status" && cmd !== "next" && !bead) throw new Illegal("a bead id is required");
  // Catch a flag where a positional belongs, and say so. `enter <bead> 1 --reason`
  // is the documented form, but the design notes for this script used
  // `--issue <bead>`, and an agent working from a half-remembered design
  // writes `enter 1 --issue <bead>`. Without this the phase parser swallows the
  // flag and reports `unknown phase "--issue"`, which points at the phase table
  // instead of at the argument order - a diagnostic that sends the reader to
  // the wrong file. Verified real: it cost me one wasted invocation.
  // A flag this command does not have (`--issue` came from the design notes for
  // this script) is the fault worth naming. A *known* flag sitting in a
  // positional slot is deliberately NOT diagnosed separately: there was no
  // reachable case for it, and a branch nobody can reach is a branch nobody has
  // tested. One real diagnosis beats two with one fictional.
  const takesPhase = cmd === "enter" || cmd === "complete";
  const maxPositional = takesPhase ? 2 : 1;
  const given = args.slice(1);
  const shape = `factory-phase.mjs ${cmd} <bead>${takesPhase ? " <phase>" : ""} --reason "..."`;
  const unknownFlag = given.find((a) => a.startsWith("--") && !FLAG_NAMES.has(a.replace(/^--/, "").split("=")[0]));
  if (unknownFlag) {
    throw new Illegal(`unknown flag ${unknownFlag}. This command is: ${shape} (the bead and phase are POSITIONAL, not flags)`);
  }
  const positionals = given.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has((given[i - 1] ?? "").replace(/^--/, "")));
  if (positionals.length > maxPositional) {
    throw new Illegal(
      `too many arguments: ${maxPositional} positional expected, got ${positionals.length} (${positionals.join(", ")}). This command is: ${shape}`,
    );
  }
  if (cmd === "status") cmdStatus(bead);
  else if (cmd === "next") cmdNext(bead);
  else if (cmd === "enter") cmdEnter(bead, args[2], flag("reason"));
  else if (cmd === "complete") cmdComplete(bead, args[2], flag("evidence"));
  else if (cmd === "handoff") cmdHandoff(bead, flag("next"));
  else throw new Illegal(`unknown command "${cmd}"`);
} catch (e) {
  const blocked = e instanceof Blocked;
  console.error(`${blocked ? "BLOCKED" : "ERROR"}: ${e.message}`);
  process.exit(blocked ? 2 : 1);
}
