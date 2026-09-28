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

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const asJson = args.includes("--json");
const quiet = args.includes("--quiet");

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

// ---- legality ------------------------------------------------------------------

function legalNext(bead) {
  const phase = readPhase(bead);
  const meta = readMeta(bead);
  if (phase === null) return { phase: null, candidates: ["0", "1"] };
  const cur = byId.get(phase);
  const outp = [];
  if (cur.detour) {
    // 4p (debug) is a detour: you return to 4 when it's done, or fall through
    // to 5. It never blocks forward progress.
    return { phase, candidates: ["4", "5"], note: "debug detour: return to 4 or proceed to 5" };
  }
  const i = PHASES.findIndex((p) => p.id === phase);
  const nxt = PHASES[i + 1];
  if (!nxt) return { phase, candidates: [], note: "final phase reached" };
  outp.push(nxt.id);
  return { phase, candidates: outp, meta };
}

// ---- commands -------------------------------------------------------------------

function cmdStatus(bead) {
  const phase = readPhase(bead);
  const meta = readMeta(bead);
  const pending = Object.entries(GATE_KEY)
    .map(([g, k]) => [g, gatePending(bead, meta, k)])
    .filter(([, v]) => v);
  const cur = phase ? byId.get(phase) : null;
  out({
    text: [
      `bead:     ${bead}`,
      `phase:    ${phase === null ? "(none - not started)" : `${phase} ${cur.name}`}`,
      `gates:    ${pending.length ? pending.map(([g, id]) => `${g} PENDING (${id})`).join(", ") : "none pending"}`,
      `blockers: ${gatePending(bead, meta, "gate_a") ? "GATE A" : ""}${gatePending(bead, meta, "gate_b") ? " GATE B" : ""}${gatePending(bead, meta, "gate_c") ? " GATE C" : ""}`.trim() || "none",
    ].join("\n"),
    bead, phase, gates_pending: pending.map(([g]) => g),
  });
}

function cmdNext(bead) {
  const { phase, candidates, note } = legalNext(bead);
  const meta = readMeta(bead);
  const blocked = [];
  for (const c of candidates) {
    if (c === "3" && gatePending(bead, meta, "gate_a")) blocked.push("3 (GATE A pending)");
    if (c === "4" && gatePending(bead, meta, "gate_b")) blocked.push("4 (GATE B pending)");
    if (c === "8" && gatePending(bead, meta, "gate_c")) blocked.push("8 (GATE C pending)");
  }
  const open = candidates.filter((c) => !blocked.some((b) => b.startsWith(c)));
  out({
    text: [`current:  ${phase ?? "(none)"}`, `legal next: ${open.join(", ") || "(none)"}`,
      blocked.length ? `blocked:  ${blocked.join(", ")}` : null, note ? `note:     ${note}` : null]
      .filter(Boolean).join("\n"),
    bead, phase, candidates, open, blocked,
  });
  if (!open.length && blocked.length) process.exitCode = 2;
}

function cmdEnter(bead, target, reason) {
  if (!byId.has(target)) throw new Illegal(`unknown phase "${target}"`);
  if (!reason) throw new Illegal("--reason is required: every transition is an event bead");
  const { phase, candidates } = legalNext(bead);
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
  if (!candidates.includes(target))
    throw new Illegal(
      `illegal transition ${phase === null ? "(none)" : phase} -> ${target} (legal: ${candidates.join(", ")})`
    );

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
  const n = legalNext(bead);
  say(`completed ${target} (${byId.get(target).name}) - evidence: ${evidence}`);
  say(`next legal: ${n.candidates.join(", ")}`);
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
