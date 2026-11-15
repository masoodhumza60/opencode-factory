#!/usr/bin/env node
// The outcomes ledger in one place: list, report, lookup, draft. The machine
// never judges a verdict, never rewrites the curated negative-results.md, and
// never attests. `draft` regenerates docs/negative-results.draft.md wholesale
// from the ledger; humans promote entries into the curated doc by hand.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = "usage: node scripts/factory-outcome.mjs <list|report|lookup|draft> [name] [--root <dir>]";
const SEVERITY = { "did-not-work": 0, "worked-with-changes": 1, "worked": 2, "not-measurable": 3 };

const parseArgs = (argv) => {
  let root = ".";
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      if (!argv[i + 1]) throw new Error("--root needs a directory");
      root = argv[i + 1];
      i += 1;
    } else rest.push(argv[i]);
  }
  return { root, rest };
};

const ledgerPath = (root) => join(root, "docs", "outcomes.jsonl");

function readLedger(root) {
  const p = ledgerPath(root);
  if (!existsSync(p)) return [];
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`${p} cannot be read: ${e.message}`);
  }
  const rows = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${p} line ${i + 1} is not valid JSON - fix the ledger; the machine will not half-read it`);
    }
  }
  return rows;
}

const byRound = (a, b) => String(a.at).localeCompare(String(b.at)) || String(a.bead).localeCompare(String(b.bead));

function list(root, verdict) {
  const rows = readLedger(root);
  for (const r of rows) {
    if (verdict && r.verdict !== verdict) continue;
    console.log(JSON.stringify(r));
  }
  return 0;
}

function report(root) {
  const rows = readLedger(root);
  const counts = new Map();
  for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  const order = ["did-not-work", "worked-with-changes", "worked", "not-measurable"];
  for (const v of order) if (counts.has(v)) console.log(`${v}: ${counts.get(v)}`);
  console.log(`total: ${rows.length}`);
  return 0;
}

function lookup(root, name) {
  if (!name) throw new Error("lookup needs a name");
  const needle = name.toLowerCase();
  const hit = (r) =>
    String(r.what_changed ?? "").toLowerCase().includes(needle) ||
    (Array.isArray(r.learned) && r.learned.some((l) => String(l.name ?? "").toLowerCase().includes(needle)));
  const rows = readLedger(root).filter(hit);
  rows.sort((a, b) => SEVERITY[a.verdict] - SEVERITY[b.verdict] || byRound(a, b));
  if (!rows.length) {
    console.log(`no outcomes mention "${name}"`);
    return 0;
  }
  for (const r of rows) {
    const learned = (r.learned ?? []).map((l) => l.name).join(", ");
    console.log(`${r.verdict}  ${r.bead}  ${r.at}  ${r.what_changed ?? ""}${learned ? `  [learned: ${learned}]` : ""}`);
  }
  return 0;
}

function draft(root) {
  const rows = readLedger(root);
  const didNotWork = rows.filter((r) => r.verdict === "did-not-work").sort(byRound);
  const byLearning = new Map();
  for (const r of rows) {
    for (const l of r.learned ?? []) {
      const key = String(l.name).toLowerCase();
      const bucket = byLearning.get(key) ?? { name: l.name, entries: [] };
      bucket.entries.push({ bead: r.bead, line: l.line, at: r.at });
      byLearning.set(key, bucket);
    }
  }
  const repeated = [...byLearning.values()]
    .filter((b) => new Set(b.entries.map((e) => e.bead)).size >= 2)
    .sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));

  const out = [];
  out.push("# Negative results (draft)");
  out.push("");
  out.push("Generated from docs/outcomes.jsonl by `node scripts/factory-outcome.mjs draft`.");
  out.push("This file is a quarantine, not the curated `docs/negative-results.md`; it is regenerated");
  out.push("wholesale from the ledger every time, so by-hand edits here are lost on the next run.");
  out.push("Review entries here by hand, and promote the ones that earn it into `negative-results.md` by hand.");
  out.push("");
  out.push("## Did not work");
  out.push("");
  if (!didNotWork.length) out.push("(none recorded)");
  for (const r of didNotWork) out.push(`- ${r.bead} (${r.at}): ${r.what_changed ?? ""}`);
  out.push("");
  out.push("## Learnings reported by 2 or more beads");
  out.push("");
  if (!repeated.length) out.push("(none recorded)");
  for (const b of repeated) {
    const beads = [...new Set(b.entries.map((e) => e.bead))].sort();
    out.push(`- ${b.name} (${beads.join(", ")})`);
    for (const e of [...b.entries].sort(byRound)) out.push(`  - ${e.bead} (${e.at}): ${e.line}`);
  }
  out.push("");

  const p = join(root, "docs", "negative-results.draft.md");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(p, out.join("\n"), "utf8");
  console.log(`draft regenerated -> ${p} (${didNotWork.length} did-not-work, ${repeated.length} repeated learning(s))`);
  return 0;
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`ERROR: ${e.message}\n${USAGE}`);
    return 1;
  }
  const { root, rest } = parsed;
  const [command, arg] = rest;
  try {
    switch (command) {
      case "list": {
        let verdict = null;
        if (arg === "--verdict" && rest[2]) verdict = rest[2];
        else if (arg && arg !== "--verdict") { console.error(`ERROR: list takes no arguments\n${USAGE}`); return 1; }
        return list(root, verdict);
      }
      case "report": return report(root);
      case "lookup": return lookup(root, arg);
      case "draft": return draft(root);
      default:
        console.error(`${USAGE}`);
        return 1;
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("factory-outcome.mjs")) {
  process.exit(main(process.argv.slice(2)));
}

export { readLedger, draft, list, report, lookup };
