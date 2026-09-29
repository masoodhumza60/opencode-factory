// Token measurement -- reads the OpenCode session DB read-only and reports
// where the tokens actually went.
//
// Why this exists: the factory's cost claim is that work done in fresh, short
// subagent sessions costs far less than work piled into one long orchestrator
// session. That claim is only worth anything if the measurement is right, so
// two rules govern this file:
//
//   1. Never report zero when zero is suspicious. An empty table that reads as
//      "no sessions, therefore free" is worse than no instrument at all -- it
//      would make an expensive run look free. Every path that finds nothing
//      says so loudly and prints the directories that DO exist.
//   2. Report input and cache-read SEPARATELY. Cache reads are billed at ~0.1x
//      base input, so collapsing them into one "sent" number makes a session
//      that re-read 2M cached tokens look comparable to one that genuinely
//      consumed 2M fresh tokens. They are not comparable. The P1 baseline
//      (~300-400k per task) is an INPUT number, so this reports input as the
//      headline and cache-read beside it.
//
// This is a REPORTING tool, not a gate. It enforces nothing and blocks nothing:
// the turn budget is a judgement the human makes with this number in front of
// them, not a threshold this file can police. Making it a hard limit on n=1
// evidence would be inventing precision.
//
// Usage:
//   node scripts/measure.mjs                 # the project you are standing in
//   node scripts/measure.mjs --dir "<dir>"   # any project
//   node scripts/measure.mjs [--json] [--since <iso>]
//
// Path handling: OpenCode stores session directories with FORWARD slashes, even
// on Windows. A backslash path matches nothing. Both sides are normalised to
// forward slashes and compared case-insensitively before querying.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const DB = join(homedir(), ".local", "share", "opencode", "opencode.db");

// Cache reads cost about 0.1x a base input token. Used only to put a rough
// input-equivalent figure on the same line; it is an estimate, not a bill.
const CACHE_READ_WEIGHT = 0.1;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const shortId = (id) => String(id).replace(/^ses_/, "").slice(0, 8);
const n = (x) => Number(x || 0);
const commas = (x) => Number(x).toLocaleString("en-US");

function open() {
  try {
    return new DatabaseSync(DB, { readOnly: true });
  } catch (e) {
    console.error(`measure: cannot open the session DB at ${DB}\n  ${e.message}`);
    console.error("  Without it there is no measurement, so this refuses to report numbers.");
    process.exit(1);
  }
}

// Defaulting to the current directory is what makes the tool usable without
// remembering a flag; pass --dir to look at another project.
const wantDir = arg("dir", process.cwd());
const asJson = !!arg("json");
const since = arg("since", null);

const db = open();

// --- the loud-failure gate -------------------------------------------------
// If the caller asked for a directory and it matched nothing, we stop here
// rather than printing an empty table. An empty table is indistinguishable
// from a free run, and that ambiguity is exactly how a broken instrument
// produces a false conclusion.
{
  const target = norm(wantDir);
  const probe = db.prepare("select count(*) as n from session_v2").get().n;
  if (probe === 0) {
    console.error("measure: the session DB has no sessions at all. That is not a zero-cost run;");
    console.error("         it is a broken read. Refusing to report.");
    process.exit(1);
  }
  const hit = db
    .prepare("select count(*) as n from session_v2 where lower(replace(directory,'\\','/')) = ?")
    .get(target).n;
  if (hit === 0) {
    const dirs = db
      .prepare("select directory, count(*) as n from session_v2 group by directory order by n desc limit 10")
      .all();
    console.error(`measure: no sessions recorded for "${wantDir}".`);
    console.error("         This is almost always a path-format mismatch, not an idle project:");
    console.error("         OpenCode stores directories with forward slashes.");
    console.error("         Directories that DO have sessions:");
    for (const d of dirs) console.error(`           ${n(d.n).toLocaleString("en-US").padStart(4)}  ${d.directory}`);
    process.exit(1);
  }
}

const where = ["lower(replace(directory,'\\','/')) = ?"];
const params = [norm(wantDir)];
if (since && typeof since === "string") {
  where.push("time_created >= ?");
  params.push(new Date(since).getTime());
}
const sql =
  `select id, parent_id, directory, title, agent, model,
          tokens_input, tokens_cache_read, tokens_output, tokens_reasoning,
          time_created, time_updated
     from session_v2` +
  ` where ${where.join(" and ")}` +
  ` order by time_created asc`;

const rows = db.prepare(sql).all(...params);

const sessions = rows.map((r) => {
  const input = n(r.tokens_input);
  const cache = n(r.tokens_cache_read);
  const output = n(r.tokens_output);
  const reasoning = n(r.tokens_reasoning);
  const created = Number(r.time_created);
  const updated = Number(r.time_updated);
  return {
    id: r.id,
    role: r.parent_id ? "subagent" : "orchestrator",
    title: r.title || "(untitled)",
    agent: r.agent || "",
    model: r.model || "",
    input,
    cacheRead: cache,
    output,
    reasoning,
    // Rough input-equivalent, for comparing runs without pretending the
    // cache-read rate is exactly 0.1x on every provider.
    inputEquiv: Math.round(input + cache * CACHE_READ_WEIGHT),
    // Wall time from creation to last update. For a session that has finished,
    // time_updated is whatever the last write was, so this is a LOWER bound on
    // session age, not its duration. Reported to one decimal because the raw
    // difference is often sub-millisecond and printing it to 16 decimals makes
    // the whole report look untrustworthy.
    minutes: Number.isFinite(created) && Number.isFinite(updated) ? Math.round(Math.max(0, (updated - created) / 60000) * 10) / 10 : 0,
  };
});

const sum = (xs, f) => xs.reduce((a, s) => a + f(s), 0);
const byRole = (role) => sessions.filter((s) => s.role === role);
const orch = byRole("orchestrator");
const subs = byRole("subagent");
const grand = (xs) => ({
  sessions: xs.length,
  input: sum(xs, (s) => s.input),
  cacheRead: sum(xs, (s) => s.cacheRead),
  output: sum(xs, (s) => s.output),
  inputEquiv: sum(xs, (s) => s.inputEquiv),
  minutes: Math.round(sum(xs, (s) => s.minutes)),
});

const totals = grand(sessions);
const orchTotals = grand(orch);
const subTotals = grand(subs);
const totalInputEquiv = totals.inputEquiv || 1;

const report = {
  directory: String(wantDir),
  counts: { total: totals.sessions, orchestrator: orchTotals.sessions, subagent: subTotals.sessions },
  totals,
  orchestrator: { ...orchTotals, shareOfInputEquiv: `${((orchTotals.inputEquiv / totalInputEquiv) * 100).toFixed(1)}%` },
  subagents: {
    ...subTotals,
    shareOfInputEquiv: `${((subTotals.inputEquiv / totalInputEquiv) * 100).toFixed(1)}%`,
    meanInput: subTotals.sessions ? Math.round(subTotals.input / subTotals.sessions) : 0,
    maxInput: subs.length ? Math.max(...subs.map((s) => s.input)) : 0,
  },
  sessions: sessions.map((s) => ({ ...s, id: shortId(s.id) })),
};

if (asJson) {
  console.log(JSON.stringify(report));
  process.exit(0);
}

const pct = (v) => `${v.toFixed(1)}%`;
console.log(`\nsessions in ${report.directory}`);
console.log(`${totals.sessions} total  =  ${orchTotals.sessions} orchestrator + ${subTotals.sessions} subagent\n`);

const head = ["id", "role", "input", "cacheRead", "~inputEq", "output", "age*", "title"];
const w = { id: 9, role: 12, input: 9, cacheRead: 11, "~inputEq": 9, output: 8, min: 5 };
console.log(head.map((h, i) => h.padEnd(w[head[i]] ?? 10)).join(""));
console.log("-".repeat(88));
for (const s of sessions) {
  const row = [
    shortId(s.id).padEnd(w.id),
    s.role.padEnd(w.role),
    commas(s.input).padStart(w.input),
    commas(s.cacheRead).padStart(w.cacheRead),
    commas(s.inputEquiv).padStart(w["~inputEq"]),
    commas(s.output).padStart(w.output),
    String(s.minutes).padStart(w.min),
  ];
  console.log(row.join(" ") + "  " + String(s.title).slice(0, 40));
}

console.log("\n" + "-".repeat(88));
const line = (label, g) =>
  `${label.padEnd(13)} ${String(g.sessions).padStart(3)} sessions   input ${commas(g.input).padStart(11)}   cacheRead ${commas(g.cacheRead).padStart(12)}   ~inputEq ${commas(g.inputEquiv).padStart(11)}   out ${commas(g.output).padStart(9)}`;
console.log(line("ORCHESTRATOR", orchTotals));
console.log(line("SUBAGENTS", subTotals));
console.log(line("TOTAL", totals));
console.log(
  `\nsubagents: ${pct((subTotals.inputEquiv / totalInputEquiv) * 100)} of ~input-equivalent, ` +
    `mean input ${commas(report.subagents.meanInput)}, max input ${commas(report.subagents.maxInput)}`
);
console.log(`cache reads are weighted at ${CACHE_READ_WEIGHT}x base input; input is the figure comparable to the ~300-400k/task baseline.`);
console.log(`* age* = minutes from session creation to last update. For a finished session that is a lower bound, not its duration.`);
