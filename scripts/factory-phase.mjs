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
//       --ran "<command> -> <observed result> at <ISO-8601>" --artifact <path>
//   node scripts/factory-phase.mjs handoff  <bead> --next "<action>"
//   node scripts/factory-phase.mjs gate     <bead> <A|B|C> --evidence "..."
//
// Exit: 0 ok | 1 illegal or error | 2 blocked (a human gate is still pending)
//
// The design rule that shapes this file: fail closed. An unreadable state, an
// unknown phase, or a gate we cannot evaluate means STOP. Inferring intent from
// prose is how a plan file full of the word "approved" once convinced an agent to
// start implementing.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
// The mechanical half of completion. factory-manifest and factory-policy import
// nothing from this file, so there is no cycle: the phase machine is free to
// read the evidence store and the policy that says which evidence is required.
import { appendTrail, isWorkspaceBeads } from "./factory-manifest.mjs";
import { loadPolicy } from "./factory-policy.mjs";
import { verifyChecks } from "./factory-attest.mjs";
// One definition of "is this acceptance still true", shared with the writer, so
// the ship gate cannot drift from what `review accept` checked.
import { acceptanceProblems } from "./factory-review.mjs";

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
// Which phase raises which gate, straight from the table above so the two can
// never drift apart. cmdGate's backfill only conjures a gate for a bead that is
// actually sitting in the phase that encodes it - a gate for any other phase
// cannot be created out of thin air.
const GATE_RAISE = Object.fromEntries(PHASES.filter((p) => p.gate).map((p) => [p.gate, p.id]));
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

// The phases whose completion needs a record of the thing actually running, not
// just its tests passing. Verify is the only one today, and the reason is
// evidence from a real run: a project in that condition reached 22 tasks and
// ~11,600 messages, and the person driving it still had to ask "how do I run
// it", then "run it and check its working properly". Every gate in the pipeline
// had passed by then. A green suite is not a running app, and nothing in the
// pipeline was able to tell the difference.
const RAN_PHASES = new Set(["5"]);
const RAN_DIM = "booted";

// Probed against bd 1.3.0 rather than assumed: a dimension value longer than
// this is REJECTED ("field exceeds maximum length"), and one containing a
// double quote is split by bd's own argument parser ("accepts 2 arg(s),
// received 3"). Both are loud, so nothing is silently mangled - but a raw bd
// error is not something an agent can act on, so both are checked here first.
const RAN_MAX = 255;

// ---- artifacts and staleness (added after a real run stalled for ten days) -----
//
// A run entered implement on 2026-09-29 and was still sitting in phase 4 on
// 2026-10-09, with nobody looking at it. Every guard in this file was working
// the entire time - they simply never got asked a question. A machine that only
// speaks when spoken to cannot notice that it has been abandoned, and that is
// the failure this section exists to catch.

// Phases that must have left a file behind before the run may leave them. The
// path is the one the factory's own docs and a real 7b run both used; if a
// project puts it elsewhere the check says so and names what it looked for,
// rather than silently passing because the directory was missing.
const ARTIFACTS = {
  2: { dir: join("docs", "superpowers", "brainstorms"), ext: ".md",
       what: "a brainstorm from phase 1" },
};

// How long a run may sit in one phase with no recorded activity before status
// says so out loud. This is a REPORTING threshold, not an enforced one: it can
// only change what you see, never cause you to stop, which is exactly why a
// number is defensible here and was not on the handoff rule.
const STALE_DAYS = 3;

function artifactPath(phase) { return ARTIFACTS[phase]; }

function missingArtifact(phase) {
  const a = artifactPath(phase);
  if (!a) return null;
  const dir = join(process.cwd(), a.dir);
  let found;
  try {
    found = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(a.ext))
      : [];
  } catch { return `${a.what}: could not read ${a.dir}`; }
  return found.length ? null : `${a.what}: no ${a.ext} file in ${a.dir}`;
}

// Days since the bead was last touched, or null if the shape is not recognised.
// Several field names are tried because bd's JSON shape is not something to
// assume; returning null (rather than 0) on an unrecognised shape is the whole
// point, because a wrong "0 days" reads as "healthy" and that is the failure.
function staleDays(bead) {
  // Read the ISSUE, not readMeta: readMeta returns only the metadata sub-object,
  // and the timestamps are fields on the issue itself. Reading the wrong object
  // returns null, which is indistinguishable from "never updated" - the exact
  // ambiguity this function exists to remove.
  const raw = bd(["show", bead, "--json"], { allowFail: true });
  if (!raw) return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  const issue = Array.isArray(j) ? j[0] : (j.issue || j);
  if (!issue || typeof issue !== "object") return null;
  const t = Date.parse(issue.updated_at || issue.time_updated || issue.modified || "");
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// bd resolves its database from the working directory, or BEADS_DIR. A run
// started one directory away finds no database; the old allGates() turned that
// error into "there are no gates", which opened every gate at once. Whether a
// `.beads` directory counts as a workspace is decided by isWorkspaceBeads, in
// factory-manifest, so `attest` and `complete` can never anchor on different
// roots. An explicit BEADS_DIR is trusted exactly as the user gave it - it is
// the escape hatch for backends whose on-disk shape this code does not know.

function findWorkspace() {
  const declared = (process.env.BEADS_DIR || "").trim();
  if (declared) {
    if (!existsSync(declared) || !statSync(declared).isDirectory()) {
      throw new Illegal(
        `BEADS_DIR points at ${declared}, which is not a directory; ` +
          "point it at the .beads directory or unset it"
      );
    }
    return resolve(declared);
  }
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, ".beads");
    if (existsSync(candidate) && isWorkspaceBeads(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Illegal(
        "no beads workspace found: there is no .beads directory here or in any parent, so the gate list cannot be read. " +
          "Run this from the project root (the directory that contains .beads), or set BEADS_DIR."
      );
    }
    dir = parent;
  }
}

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
// (flag("reason"), flag("evidence"), flag("ran"), flag("artifact"),
// flag("booted"), flag("next")) or tested with includes(), so this list and
// those reads must stay in step.
const FLAG_NAMES = new Set(["reason", "evidence", "booted", "ran", "artifact", "next", "json", "quiet"]);
// The flags that consume the argument after them. Needed to tell a positional
// from a flag's value: counting `--reason "why"` as two positionals is what made
// this check reject every correct invocation.
const VALUE_FLAGS = new Set(["reason", "evidence", "booted", "ran", "artifact", "next"]);

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

// The detour's recorded completion, or null if none. Never read by any legality
// check (they use `done`), so this exists purely to report that a record outlived
// the phase that created it.
function readRepair(bead) {
  let raw;
  try {
    raw = bd(["state", bead, REPAIR_DIM]);
  } catch { return null; }
  const s = String(raw).trim();
  if (!s || /^\(no .* state set\)$/i.test(s)) return null;
  const m = s.match(/^(\S+)$/) || s.match(/repair_done[:=]\s*(\S+)/);
  return m ? m[1] : null;
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
  // No allowFail: a read failure is not "no gates". If bd exits non-zero, or
  // returns something that is not JSON, the run stops rather than opening.
  const raw = bd(["gate", "list", "--all", "--json"]);
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (e) {
    throw new Illegal(
      `could not read the gate list: bd returned output that is not JSON (${e.message}). ` +
        "Refusing to guess whether a gate is pending. Run `bd gate list --all --json` by hand to see what bd said."
    );
  }
  const list = Array.isArray(rows) ? rows : rows && rows.gates;
  // With NO gates in the database, bd prints the literal `null` and exits 0 -
  // probed, not assumed, and the same encoding it uses for a bead with no gate.
  // That null is bd's empty list, so it is the one non-array shape that must
  // not refuse: returning [] for it still fails closed on every FAILURE, which
  // is the exploit this fix exists to close.
  if (list === null) return [];
  if (!Array.isArray(list)) {
    throw new Illegal(
      "could not read the gate list: bd did not return a list. " +
        "Refusing to guess whether a gate is pending. Run `bd gate list --all --json` by hand to see what bd said."
    );
  }
  return list;
}

// bd's `gate resolve` takes --reason as optional, so a gate resolved by hand
// and a gate approved by the factory are both just "closed". Only a reason
// written by cmdGate carries the [factory-gate:<id>] token; anything else is
// treated as still pending.
// Probed against bd 1.3.0 rather than assumed: the resolution reason is carried
// by `close_reason` on the gate row - visible in BOTH `bd gate list --all --json`
// and `bd gate show <id> --json` - and a bare resolve leaves the row in the
// `--all` list with status "closed" and no close_reason at all. Several field
// names are tried because bd's shape is not something to implement against a
// guess; the fallbacks cost nothing and fail closed if the shape changes.
function gateReason(g) {
  const candidates = [g.reason, g.close_reason, g.resolved_reason, g.resolution_reason];
  const value = candidates.find((x) => typeof x === "string" && x.trim());
  return value ? value.trim() : null;
}

function factoryApproved(g) {
  const reason = gateReason(g);
  return Boolean(reason && /\[factory-gate:[^\]]+\]/.test(reason));
}

function gatePending(bead, meta, key) {
  const id = meta?.[key];
  if (!id) return null;                       // no gate was ever created
  const g = allGates().find((x) => (x.id || x.gate_id) === id);
  // Probed: bd 1.3.0 keeps closed gates in the `--all` list (status "closed"),
  // so an absent row means bd genuinely lost it - approved, as before.
  if (!g) return null;
  const status = String(g.status || g.state || "open");
  if (status === "open" || status === "pending") return id;
  // Resolved. It counts only if cmdGate wrote the token.
  return factoryApproved(g) ? null : id;
}

// A gate id is recorded in the bead's metadata by the phase that raised it
// (2 -> GATE A, 3 -> GATE B, 7 -> GATE C). A missing record is not "no gate":
// gatePending() would return null and the transition would sail through with a
// gate nobody can evaluate. Refuse and name the repair.
function requireGateRecord(bead, meta, letter) {
  const key = GATE_KEY[letter];
  if (meta?.[key]) return;
  throw new Illegal(
    `GATE ${letter} has no recorded gate id for this bead, so it cannot be shown pending or approved. ` +
      `Run \`bd gate create --type=human --blocks ${bead} --reason "GATE ${letter} backfill"\`, then ` +
      `\`bd update ${bead} --set-metadata ${key}=<id>\`, and retry.`
  );
}

// The one detour in the pipeline, derived from the table rather than hardcoded,
// so changing the table cannot silently leave a magic "4p" behind.
const REPAIR = PHASES.find((p) => p.detour);

// Phases that exist to FIND defects, and therefore need somewhere to go and fix
// them. Ship (7) is deliberately absent: once you are shipping, a human decides
// at Gate C, not the machine.
const FINDING_PHASES = new Set(["5", "6"]);

// An UNFINISHED ship phase joins them, for one reason, and only while unfinished.
// The gate at 7 is machine-enforced, so when a human rejects the work there
// is nothing left to appeal to: resolving the gate leaves `complete 7` - which
// ships exactly what was rejected - and 7 was the one phase with nowhere to go.
// A real run hit this: the approver ruled "fix it" and the only legal moves
// were to ship it or to go nowhere. Ship is deliberately still absent from
// FINDING_PHASES, so a run that has ALREADY shipped is still offered no
// detour - there is nothing left to reject. Only an unfinished one is.
const UNFINISHED_REPAIR_PHASES = new Set(["7"]);

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
    // Listed but blocked, except the detour, which is always available. An
    // unfinished phase that can still produce a finding needs somewhere to go
    // and fix it BEFORE it is complete - that is the whole point of a phase
    // that finds things. Offering the detour only once the phase is complete
    // would mean the finding has to be carried into the next phase by hand.
    const repair = (FINDING_PHASES.has(phase) || UNFINISHED_REPAIR_PHASES.has(phase)) && REPAIR
      ? [REPAIR.id]
      : [];
    return repair.length
      ? {
          phase, done, candidates: [nxt.id, ...repair], blockedOn: phase, alwaysLegal: repair,
          note: `phase ${phase} (${cur.name}) is in progress - complete it before advancing; ${repair[0]} is always available`,
        }
      : {
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
  // Staleness is computed here, not guessed at: a run sitting in an unfinished
  // phase with nothing recorded for days is the shape of the ten-day stall, and
  // status is the one command someone opens when they wonder what happened.
  const idle = staleDays(bead);
  const stale = idle !== null && phase !== null && done !== phase && idle >= STALE_DAYS;
  // repair_done is never cleared by bd (1.3.0 offers no documented way to unset a
  // dimension), so a run that returned from a debug detour to phase 4 kept
  // asserting a completed detour as standing state. It broke no legality check,
  // because those read `done`, but a state layer that asserts something untrue is
  // the exact thing this file exists to prevent. Report it rather than clear it.
  const repairStale = !byId.get(phase)?.detour && readRepair(bead) !== null;
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
      `idle:     ${idle === null ? "(could not be read)" : `${idle} day${idle === 1 ? "" : "s"} since last activity`}${stale ? `  ** STALE ** nothing has moved in ${idle} days while phase ${phase} is unfinished` : ""}`,
      ...(repairStale ? [`warning:  repair_done is still set but the run is in phase ${phase}. bd cannot unset a dimension, so that record is stale - treat it as history, not standing state.`] : []),
    ].join("\n"),
    bead, phase, done, completed: done === phase, gates_pending: pending.map(([g]) => g),
    idle_days: idle, stale, repair_done_stale: repairStale,
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

function gatesFor(bead) {
  // Read-only, and deliberately tolerant of bd's output shapes but NOT of read
  // failures: callers must know whether the gate list was actually read, so a
  // rollback that saw nothing is reported as "unknown", never as "resolved".
  const raw = bd(["gate", "list", bead, "--all", "--json"], { allowFail: true });
  if (raw === null) return { ok: false, list: [] }; // bd exited non-zero
  try {
    const rows = JSON.parse(raw);
    const list = Array.isArray(rows) ? rows : rows && rows.gates;
    if (list === null) return { ok: true, list: [] }; // bd's empty list
    if (!Array.isArray(list)) return { ok: false, list: [] };
    return { ok: true, list };
  } catch {
    return { ok: false, list: [] };
  }
}

function rollbackGate(bead, g, beforeIds, phaseBefore) {
  // Resolve any gate that appeared during the failed creation, then put the
  // phase back. A gate we cannot name is a gate nobody can resolve, so leaving
  // it behind is what made the bead permanently stuck. Returns the outcome the
  // caller may report, never the intent:
  //   "unreadable" - the gate list could not be read; nothing was resolved;
  //   "resolved"   - the list was read and at least one `bd gate resolve`
  //                  actually succeeded;
  //   "none"       - the list was read and no resolution was performed, so the
  //                  caller must not claim an orphan was resolved.
  const seen = gatesFor(bead);
  let outcome;
  if (!seen.ok) {
    outcome = "unreadable";
  } else {
    let resolvedCount = 0;
    for (const gt of seen.list) {
      if (beforeIds.has(String(gt.id))) continue;
      const state = String(gt.status || gt.state || "open").toLowerCase();
      if (state !== "open" && state !== "pending") continue;
      // Count a resolution only when the resolve call succeeded. allowFail
      // returns null on failure, and a failed resolve is not a resolution.
      const done = bd(["gate", "resolve", String(gt.id), "--reason",
        `factory: rollback, GATE ${g} id could not be recorded`], { allowFail: true });
      if (done !== null) resolvedCount++;
    }
    outcome = resolvedCount > 0 ? "resolved" : "none";
  }
  bd(["set-state", bead, `phase=${phaseBefore ?? "0"}`,
    "--reason", "factory: rollback after an unrecorded gate"], { allowFail: true });
  return outcome;
}

function cmdEnter(bead, target, reason) {
  // A spec written on a brainstorm that was never written down is a spec resting
  // on nothing. Checked on the way IN to the phase that depends on it, because
  // that is the moment the dependency becomes real.
  const gap = missingArtifact(target);
  if (gap) throw new Illegal(`${bead} cannot enter ${target} (${byId.get(target).name}): ${gap}`);
  if (!byId.has(target)) throw new Illegal(`unknown phase "${target}"`);
  if (!reason) throw new Illegal("--reason is required: every transition is an event bead");
  const { phase, candidates, blockedOn, alwaysLegal } = legalNext(bead);
  const meta = readMeta(bead);

  // A gate id is recorded in the bead's metadata by the phase that raised it
  // (2 -> GATE A, 3 -> GATE B, 7 -> GATE C). If the record is missing, then
  // gatePending() returns null ("no gate was ever created") and the transition
  // sails through with a gate nobody can evaluate - this is the fail-open hole.
  // So the record is demanded BEFORE the pending check: refuse to enter rather
  // than guess whether an unrecorded gate is open.
  if (target === "3") {
    requireGateRecord(bead, meta, "A");
    if (gatePending(bead, meta, "gate_a"))
      throw new Blocked("GATE A is pending - the human has not approved the spec");
  }
  if (target === "4") {
    requireGateRecord(bead, meta, "B");
    if (gatePending(bead, meta, "gate_b"))
      throw new Blocked("GATE B is pending - the human has not approved the plan");
  }
  if (target === "8") {
    requireGateRecord(bead, meta, "C");
    if (gatePending(bead, meta, "gate_c"))
      throw new Blocked("GATE C is pending - the human has not approved the ship");
  }
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

  // Phases that end at a human gate create it now, so bd withholds the next
  // phase from `bd ready` instead of us having to remember to ask.
  const g = byId.get(target).gate;
  // The rollback can only tell the gates it created apart from gates already
  // open if it has a snapshot of what was there before, and a refusal must
  // never leave a half state. So the snapshot is read BEFORE the phase is
  // written: a failed read refuses with the bead exactly where it was, and
  // "then retry" is a legal re-enter, not an illegal one.
  let gatesBefore = null;
  if (g) {
    const snapshot = gatesFor(bead);
    if (!snapshot.ok) {
      throw new Illegal(
        `could not read the gate list for ${bead} (\`bd gate list ${bead} --all --json\` failed), ` +
          `so entering phase ${target} would risk raising a GATE ${g} that could not be rolled back. ` +
          `Run the command by hand to see what bd said, then retry.`
      );
    }
    gatesBefore = new Set(snapshot.list.map((x) => String(x.id)));
  }

  bd(["set-state", bead, `phase=${target}`, "--reason", reason]);

  if (g) {
    const phaseBefore = phase;
    // A test seam, not production behaviour: it can only make the id
    // unparseable, which now refuses instead of succeeding. Never a bypass.
    const noise = process.env.BD_GATE_CREATE_NOISE ? "noise: " : "";
    const res = bd(["gate", "create", "--type=human", "--blocks", bead,
      "--reason", `GATE ${g}: ${byId.get(target).name} awaiting human approval`], { allowFail: true });
    // bd prints: "✓ Created gate opencode-factory-gyc (type: human)". Ids contain
    // two or more hyphens, so a naive [a-z]+-[a-z]+ match would capture only the
    // prefix and record a gate id that can never be resolved. With the seam set
    // the output is mangled noise: the id is unparseable by definition, which
    // is the parse failure this block must recover from.
    const id = noise ? null : (res || "").match(/Created gate\s+(\S+)/)?.[1];
    if (!id) {
      const outcome = rollbackGate(bead, g, gatesBefore, phaseBefore);
      const orphanClause = outcome === "resolved"
        ? `Phase rolled back to ${phaseBefore ?? "(none)"} and the orphan gate was resolved. ` +
          `Run \`bd gate list ${bead} --all --json\` to confirm, then retry.`
        : outcome === "none"
          ? `Phase rolled back to ${phaseBefore ?? "(none)"}; no orphan gate was found to resolve. ` +
            `Run \`bd gate list ${bead} --all --json\` to check, then retry.`
          : `Phase rolled back to ${phaseBefore ?? "(none)"}; the gate list could not be read, so an orphan gate may still be open; ` +
            `run \`bd gate list ${bead} --all --json\` to check.`;
      throw new Illegal(
        `could not record GATE ${g}: bd created a gate but its id was not in the output. ${orphanClause}`
      );
    }
    // --set-metadata merges. --metadata replaces, and would wipe the other gate ids.
    bd(["update", bead, "--set-metadata", `${GATE_KEY[g]}=${id}`], { allowFail: true });
    const recorded = readMeta(bead)?.[GATE_KEY[g]];
    if (recorded !== id) {
      bd(["gate", "resolve", id, "--reason", "factory: rollback, gate id could not be recorded"], { allowFail: true });
      const after = gatesFor(bead);
      const stillOpen = after.ok && after.list.some((x) => String(x.id) === id &&
        ["open", "pending"].includes(String(x.status || x.state || "open").toLowerCase()));
      rollbackGate(bead, g, gatesBefore, phaseBefore);
      const orphanClause = !after.ok
        ? `the gate list could not be read, so the orphan gate ${id} may still be open. ` +
          `Run \`bd gate list ${bead} --all --json\`, resolve any open gate by id, then retry.`
        : stillOpen
          ? `the orphan gate ${id} is still open - the resolve did not take effect. ` +
            `Run \`bd gate list ${bead} --all --json\`, resolve it by id, then retry.`
          : `the orphan gate ${id} was resolved. ` +
            `Run \`bd gate list ${bead} --all --json\` to confirm, then retry.`;
      throw new Illegal(
        `could not record GATE ${g}: bd accepted the metadata write but the id is not there. ` +
          `Phase rolled back to ${phaseBefore ?? "(none)"}; ${orphanClause}`
      );
    }
    say(`GATE ${g} created (${id}) - blocks ${bead} until resolved`);
  }

  say(`entered phase ${target} (${byId.get(target).name}) on ${bead}`);
}

// The human's own transition is the only write in this machine that used to be
// permitted to carry no content. Every machine transition demands one (--reason
// on enter, --evidence on complete, --next on handoff), and a gate was resolved by
// raw `bd gate resolve <id>` with no argument at all - so "ok" was not laziness, it
// was the only shape the interface accepted. This command is that shape.
//
// bd already has the field: `bd gate resolve <gate-id> --reason`. No event bead,
// no parallel store. The reason goes where bd keeps reasons.
//
// A stoplist is a floor, not a proof. It refuses the words that carry no
// information; it cannot tell you whether the sentence after them is true. That
// is why --ran, --evidence and --reason all still exist: the human's job is to
// add something only a human knows.
const GATE_WORDS = [
  "ok", "okay", "k", "yes", "y", "yeah", "yep", "go", "go ahead", "continue", "next",
  "approve", "approved", "lgtm", "looks good", "look good", "fine", "good", "done",
  "ship it", "yes please", "sure", "whatev", "yeah sure", "do it", "proceed", "confirmed",
];
const GATE_MAX = 600;
// Presence is not evidence. " " is truthy, "aaaaaaaaaaaa" is long, and
// "ok done" is two words. None of them says what was checked or what it
// answered, so none of them may finish a phase or resolve a gate.
function uninformativeEvidence(text) {
  const v = String(text ?? "").trim();
  if (!v) return "it is empty or only whitespace";
  const letters = v.replace(/[\s\p{P}\p{S}]/gu, "");
  if (letters.length < 12) return "it is too short to be checkable";
  if (new Set(letters).size < 4) return "it repeats one or two characters, which is not a result";
  const words = v.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length < 3 || new Set(words).size < 3)
    return "it does not name what was checked and what it answered";
  return null;
}

function uninformative(evidence) {
  const base = uninformativeEvidence(evidence);
  if (base) return base;
  const norm = evidence.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (norm.length < 12) return "it is too short to carry a reason";
  // An unconditional floor measured in words, not just characters. "go ahead looks
  // fine to me" is six words of approval and names nothing that was checked, yet it
  // used to slip past the stoplist: the stop-word check only fired while fewer than
  // 4 words followed the stop word, and this sentence has exactly 4. The existing
  // checks below are kept; this floor applies first, to every reason.
  const words = norm.split(" ").length;
  if (words < 8)
    return `it is only ${words} words: a reason that thin names nothing that was checked`;
  for (const w of GATE_WORDS) {
    if (norm === w) return `"${evidence}" is a decision, not a reason`;
    if (norm.startsWith(w + " ") && norm.slice(w.length + 1).trim().split(" ").length < 4)
      return `"${evidence}" opens with "${w}" and then adds almost nothing`;
  }
  return null;
}

function cmdGate(bead, which, evidence) {
  const key = GATE_KEY[String(which || "").toUpperCase()];
  if (!key) throw new Illegal(`unknown gate "${which}" - expected A, B or C`);
  // The cheap rejections first: a missing reason says nothing, a quote would be
  // recorded broken by bd's parser, and an over-long reason would be refused by
  // bd itself. Only after those does what the text SAYS get judged.
  const v = String(evidence ?? "").trim();
  if (!v)
    throw new Illegal(
      "--evidence is not informative: it is empty or only whitespace. A gate is the one transition a human makes, so it is the one that cannot be a bare yes"
    );
  if (v.includes('"'))
    throw new Illegal(
      "--evidence cannot contain a double quote: bd's argument parser splits on it, so the reason would be recorded broken. " +
        "Say the same thing without quotes."
    );
  if (v.length > GATE_MAX)
    throw new Illegal(`--evidence is ${v.length} characters, over the ${GATE_MAX} limit: keep it to the decision and the reason, not a transcript`);
  const thin = uninformative(v);
  if (thin) throw new Illegal(`--evidence is not informative: ${thin}. Say what you decided and why - e.g. "shipping this; the empty state is the page, so there is nothing to dismiss"`);

  const meta = readMeta(bead);
  let id = gatePending(bead, meta, key);
  const letter = String(which || "").toUpperCase();
  if (!id && !meta?.[key] && readPhase(bead) === GATE_RAISE[letter]) {
    // Legacy repair, the same remedy requireGateRecord names: a bead that
    // reached this phase on old code has no recorded gate id, so there is
    // nothing pending to resolve - cmdGate used to bail with "nothing to
    // resolve" here and the bead was stuck, refused by `complete` and refused
    // by the gate command. Raise the gate now, record its id, and let the
    // approval below land on a gate whose id the bead actually points at.
    const created = bd(["gate", "create", "--type=human", "--blocks", bead,
      "--reason", `GATE ${letter} backfill: the bead has no recorded gate id for this gate`]);
    const raised = (created || "").match(/Created gate\s+(\S+)/)?.[1];
    if (!raised) {
      throw new Illegal(
        `could not backfill GATE ${letter}: bd did not report a new gate id. ` +
          `Run \`bd gate list ${bead} --all --json\` to see what exists, then retry.`
      );
    }
    bd(["update", bead, "--set-metadata", `${key}=${raised}`]);
    // The block below re-reads the gate row through this id, so the approval
    // must be evaluated against the gate we just raised, never the missing one.
    id = raised;
  } else if (!id) {
    const phase = readPhase(bead);
    throw new Illegal(
      `no ${letter} gate is pending on ${bead}` +
        (phase ? ` (phase ${phase} ${byId.get(phase)?.name ?? ""})` : "") +
        ". There is nothing to resolve - a gate that does not exist cannot be approved, and approving one by id alone would let anyone past a gate the machine never raised. " +
        `Run factory-phase.mjs gate <bead> ${letter} --evidence "..." while the gate is open, or status <bead> to see which gates exist.`
    );
  }
  // Probed bd 1.3.0: a gate resolved with no --reason stays in the `--all`
  // list as "closed" with no close_reason, which gatePending() now reports as
  // pending. Before resolving, re-raise such a gate: the approval is recorded
  // on a gate whose id the bead actually points at, so the recorded approval
  // and the passing gatePending check describe the same row.
  const row = allGates().find((x) => (x.id || x.gate_id) === id);
  const closedWithoutToken = row && (row.status || row.state) !== "open" && (row.status || row.state) !== "pending" && !factoryApproved(row);
  let target = id;
  if (closedWithoutToken) {
    // The gate was resolved outside the factory. Re-raise it so the approval is
    // recorded on a gate whose id the bead actually points at.
    const res = bd(["gate", "create", "--type=human", "--blocks", bead,
      "--reason", `GATE ${String(which).toUpperCase()} re-raised: the previous gate was resolved without a factory record`]);
    const raised = res.match(/Created gate\s+(\S+)/)?.[1];
    if (!raised) {
      throw new Illegal(
        `could not re-raise GATE ${String(which).toUpperCase()}: bd did not report a new gate id. ` +
          `Run \`bd gate list ${bead} --all --json\` to see what exists, then retry.`
      );
    }
    bd(["update", bead, "--set-metadata", `${key}=${raised}`]);
    target = raised;
  }
  // The close_reason is the evidence of record, so the token that proves the
  // factory wrote it rides in the same field. A value over the limit or one
  // with a quote was refused above; this reason is larger than the evidence by
  // the token's length, which is the point of the token check: a reason with
  // the token in it, but not written here, stays pending.
  bd(["gate", "resolve", target, "--reason", `${v} [factory-gate:${target}]`]);

  // Fail closed: re-read rather than trust the write. bd returning 0 is a claim,
  // the same class of claim as an installer that printed success.
  const after = gatePending(bead, readMeta(bead), key);
  if (after)
    throw new Error(`bd reported resolving gate ${id} but ${key} is still pending (${after})`);
  out({
    ok: true,
    gate: String(which).toUpperCase(),
    gate_id: target,
    bead,
    resolved: true,
    reason_recorded: true,
    // out() prints `text` in human mode. A command that omits it prints the
    // string "undefined" and then its own success line on the next line, which
    // is how this command read in the wild. Every other command here carries its
    // human-readable form in this field. `say` used to do this job, but it is
    // suppressed by --quiet while out() is not, so the message could vanish on
    // the one call where a human most wants to see it recorded.
    text: [`gate ${String(which).toUpperCase()} resolved on ${bead} (${target}) - reason recorded in bd`],
  });
}

// G4 asks one question and checks only that the answer exists: did it work, and
// what changes next time. The content is judged by a human later; a missing
// record is a refusal, not a warning.
function outcomeProblems(root, bead) {
  const rel = `.factory/${bead}/outcome.md`;
  const path = join(root, rel);
  if (!existsSync(path)) return [`no outcome record at ${rel}`];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return [`${rel} cannot be read: ${e.message}`];
  }
  const problems = [];
  if (text.trim() === "") problems.push(`${rel} is empty`);
  if (!/^##\s+What changed\s*$/im.test(text)) {
    problems.push(`${rel} has no "## What changed" section`);
  }
  const measured = /^##\s+Measured before\s*\/\s*after\s*$/im.test(text) || /^Not measurable:/im.test(text);
  if (!measured) {
    problems.push(`${rel} has no "## Measured before / after" section and no "Not measurable: <why>" line`);
  }
  return problems;
}

function cmdComplete(bead, target, evidence, ranArg, artifactArg) {
  if (!byId.has(target)) throw new Illegal(`unknown phase "${target}"`);
  const thinEvidence = uninformativeEvidence(evidence);
  if (thinEvidence)
    throw new Illegal(
      `--evidence is not informative: ${thinEvidence}. Say what you checked and what it answered - e.g. "ran the export; 12 rows, header order matches the contract".`
    );
  const phase = readPhase(bead);
  if (phase !== target)
    throw new Illegal(`${bead} is in phase ${phase ?? "(none)"}, cannot complete ${target}`);
  // Starting the ship phase raised GATE C, and completing it must not sail past
  // the human who has not approved the ship yet. Phase 2 refuses on Gate A and
  // phase 3 on Gate B; 7 was the one gate-bearing phase whose completion never
  // looked at its gate. This is the same check, phased the same way: evaluate
  // the gate before any evidence predicate, so a pending ship gate is reported
  // as blocked (exit 2), never as bad evidence (exit 1).
  if (target === "7") {
    // The same demand cmdEnter makes for targets 3/4/8. Without it, a bead that
    // reached phase 7 on the old code - which warned and returned success when
    // the gate id could not be parsed - completes ship with Gate C unknown.
    requireGateRecord(bead, readMeta(bead), "C");
    const pending = gatePending(bead, readMeta(bead), GATE_KEY.C);
    if (pending) {
      throw new Blocked(
        `GATE C is pending (${pending}): the ship gate has not been approved. ` +
          `Resolve it with \`factory-phase gate ${bead} C --evidence "<decision and why>"\` after the evidence is on disk.`
      );
    }
  }
  // --ran is validated and RECORDED before phase_done, in that order. If the
  // ran claim cannot be written, phase_done must stay unset so the machine
  // still refuses to advance. Writing phase_done first would leave a run able
  // to move past verify having never recorded the app running, which is
  // precisely the defect this exists to prevent: the guard present, the effect
  // absent.
  let ran = null;
  let artifact = null;
  if (RAN_PHASES.has(target)) {
    if (!ranArg)
      throw new Illegal(
        `--ran is required to complete ${target} (${byId.get(target).name}): a passing suite is not a running app. ` +
          `Record it as --ran "npm run dev -> 200 OK on GET /health at 2026-10-20T10:00:00Z" --artifact boot.log`
      );
    const v = String(ranArg).trim();
    if (v.includes('"')) throw new Illegal("--ran cannot contain a double quote: bd splits arguments on it");
    if (v.length > RAN_MAX) throw new Illegal(`--ran is ${v.length} characters, over the ${RAN_MAX} character limit`);
    const parts = v.split("->");
    if (parts.length !== 2)
      throw new Illegal("--ran must contain exactly one `->` separating the command that ran from what it answered");
    if (!parts[0].trim())
      throw new Illegal("--ran must name the command that ran, before `->`: a result with no command is not a run");
    if (!parts[1].trim())
      throw new Illegal("--ran must say what the command answered, after `->`: a command with no result is not a run");
    if (!/T\d\d:\d\d/.test(v)) throw new Illegal("--ran must carry an ISO-8601 timestamp, e.g. 2026-10-20T10:00:00Z");
    if (!/\bat\b/.test(v)) throw new Illegal("--ran must put the timestamp after the word `at`");
    if (!artifactArg)
      throw new Illegal("--artifact is required: the evidence file the run wrote, e.g. --artifact boot.log");
    if (!existsSync(artifactArg))
      throw new Illegal(`--artifact "${artifactArg}" does not exist: the claim points at nothing`);
    ran = v;
    artifact = artifactArg;
  }
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
  if (ran) {
    bd(["set-state", bead, `${RAN_DIM}=${ran}`, "--reason", `ran: ${ran} (artifact ${artifact})`]);
    say(`ran: ${ran} (artifact ${artifact})`);
  }
  // A policy turns "the evidence sentence is informative" into "the artifact the
  // phase requires is on disk, unmodified, at this commit". The gate below is
  // the last refusal that must win over it, and `bd set-state` is the first
  // write that must not happen on a refusal, so this sits exactly between them:
  // a refused completion leaves phase_done untouched, the same as the --ran gate
  // above. With no config/factory.policy.yaml, loadPolicy returns null and
  // nothing here runs - every repo without a policy behaves as it did before.
  //
  // Deliberately NOT wrapped in a try/catch: a malformed policy is a loud
  // failure, never a quiet fall back to "no policy, no gate". loadPolicy's null
  // is the only branch that skips verification.
  // The project root is the directory holding .beads, not the cwd: findWorkspace
  // returns the .beads directory itself, so running `complete` from a
  // subdirectory must still find config/factory.policy.yaml. Using the raw cwd
  // here would silently skip the policy and pass - the exact false pass this
  // milestone exists to make impossible.
  const policyRoot = dirname(findWorkspace());
  const policy = loadPolicy(policyRoot);
  if (policy) {
    const verdict = verifyChecks(policyRoot, bead, target, policy);
    const failed = verdict.checks.filter((r) => r.result !== "ok" && r.result !== "not-applicable");
    // Two mutually exclusive events, because a trail that records a refusal as a
    // completion is a log that lies. The refusal is written HERE, immediately
    // before the throw, so the trail still says "we tried" without saying "we
    // shipped" - and it is written only when there is a policy, because without
    // one there was no verdict to record.
    if (failed.length) {
      appendTrail(policyRoot, bead, {
        event: "refusal",
        command: "complete",
        phase: String(target),
        problems: failed.map((r) => `${r.id}: ${r.result}`),
      });
      throw new Illegal(
        `phase ${target} needs ${verdict.counts.total} verified artifact(s) from ` +
        `.factory/${bead}/manifest.json; ${failed.length} failed:\n` +
        failed.map((r) => `  ${r.result.toUpperCase()} ${r.id} - ${r.detail || "see factory-attest verify"}`).join("\n") +
        `\nRecord them with:\n` +
        failed.map((r) => `  ${r.fix}`).join("\n")
      );
    }

    // A green evidence set is not an acceptance, and closing is not shipping.
    // Both records are checked here, after the artifacts and before the state
    // write, so a refusal leaves phase_done untouched like every other refusal.
    const problems = target === "7" ? acceptanceProblems(policyRoot, bead)
      : target === "8" ? outcomeProblems(policyRoot, bead)
      : [];
    if (problems.length) {
      appendTrail(policyRoot, bead, {
        event: "refusal",
        command: "complete",
        phase: String(target),
        problems,
      });
      throw new Illegal(
        target === "7"
          ? `phase 7 (ship) needs a human acceptance at .factory/${bead}/acceptance.json:\n` +
            problems.map((p) => `  ${p}`).join("\n") +
            `\nA passing review is not an acceptance. Record one with:\n` +
            `  FACTORY_ROLE=reviewer FACTORY_SESSION=review:<you> node scripts/factory-review.mjs record ${bead} --file .factory/${bead}/review.md --verdict pass\n` +
            `  FACTORY_ROLE=human FACTORY_SESSION=human:<you> node scripts/factory-review.mjs accept ${bead} --note "<what you read>"`
          : `phase 8 (close) needs an outcome record at .factory/${bead}/outcome.md (G4):\n` +
            problems.map((p) => `  ${p}`).join("\n") +
            `\nWrite what changed and what it measured, before and after.`
      );
    }
  }
  bd(["set-state", bead, `${dim}=${target}`, "--reason", `completed ${target} (${byId.get(target).name}): ${evidence}`]);
  // The success event lands only AFTER bd set-state returned: the trail must not
  // claim a completion that did not reach the state layer.
  if (policy) {
    appendTrail(policyRoot, bead, {
      event: "complete",
      command: "complete",
      phase: String(target),
      ok: true,
    });
  }
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
  findWorkspace();
  if (!cmd) {
    console.error("usage: factory-phase.mjs <status|next|enter|complete|handoff|gate> ...");
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
  const takesPhase = cmd === "enter" || cmd === "complete" || cmd === "gate";
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
  else if (cmd === "complete") {
    // --booted stays parseable for one release as a deprecated alias: an old
    // command line still completes, with a note pointing at the new form.
    const ranArg = flag("ran") ?? flag("booted");
    const artifactArg = flag("artifact");
    if (args.includes("--booted") && !args.includes("--ran"))
      say('--booted is deprecated; use --ran "<command> -> <observed result> at <ISO-8601>" --artifact <path>');
    cmdComplete(bead, args[2], flag("evidence"), ranArg, artifactArg);
  }
  else if (cmd === "handoff") cmdHandoff(bead, flag("next"));
  else if (cmd === "gate") cmdGate(bead, args[2], flag("evidence"));
  else throw new Illegal(`unknown command "${cmd}"`);
} catch (e) {
  const blocked = e instanceof Blocked;
  console.error(`${blocked ? "BLOCKED" : "ERROR"}: ${e.message}`);
  process.exit(blocked ? 2 : 1);
}
