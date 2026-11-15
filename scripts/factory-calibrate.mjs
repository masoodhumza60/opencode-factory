#!/usr/bin/env node
// factory-calibrate.mjs - the review-model calibration corpus and its scorer.
//
// Calls NO model. It builds a frozen set of 30 diffs (20 synthetic defects
// produced by deterministic templates over the two seed apps, 10 real-history
// commits pinned in REAL_CASES), scaffolds human labels, records verdicts
// appended/upserted per (case, reviewer), and scores them into an agreement
// report. Labels are written by the human, not by this harness.
//
//   node scripts/factory-calibrate.mjs package   # regenerate cases + manifest (deterministic)
//   node scripts/factory-calibrate.mjs record --case syn-03 --reviewer gpt-x --verdict changes [--note "..."]
//   node scripts/factory-calibrate.mjs score [--reviewer gpt-x]
//
// FACTORY_CAL_ROOT overrides the root for tests only.
// Exit codes: 0 on success; 1 on every refusal.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";

const ROOT = process.env.FACTORY_CAL_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)));
const CAL = join(ROOT, "docs", "calibration");
const CASES = join(CAL, "cases");
const LABELS = join(CAL, "labels");
const MANIFEST = join(CAL, "manifest.json");
const VERDICTS = join(CAL, "verdicts.jsonl");

const A_MAP = "      return seed.map((o) => ({ ...o }));";
const A_FMT = '  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);';
const A_STATUS = 'export const STATUSES: OrderStatus[] = ["pending", "paid", "shipped", "cancelled"];';
const A_CATCH = '        if (live) setError(e instanceof Error ? e.message : "failed to load orders");';
const A_NULL = "  if (orders === null) {";
const A_LENGTH = "  if (orders.length === 0) {";
const A_PLACED = "              <td>{o.placedAt.slice(0, 10)}</td>";
const A_KEY = "            <tr key={o.id}>";
const A_MAPR = "          {orders.map((o) => (";
const A_SET = "        if (live) setOrders(rows);";

const STORE = "testapps/orderboard/src/orders/store.ts";
const PAGE = "testapps/orderboard/src/orders/OrdersPage.tsx";

const SYNTH = [
  { id: "syn-01", cls: "wrong-condition", file: STORE, a: A_MAP, b: '      return seed.filter((o) => o.status === "shipped").map((o) => ({ ...o }));' },
  { id: "syn-02", cls: "wrong-condition", file: PAGE, a: A_LENGTH, b: "  if (orders.length !== 0) {" },
  { id: "syn-03", cls: "missing-validation", file: STORE, a: A_FMT, b: '  return new Intl.NumberFormat("en-US").format(cents / 100);' },
  { id: "syn-04", cls: "missing-validation", file: PAGE, a: A_CATCH, b: '        if (live) setError((e as Error).message);' },
  { id: "syn-05", cls: "contract-break", file: STORE, a: A_MAP, b: "      return seed;" },
  { id: "syn-06", cls: "contract-break", file: PAGE, a: A_KEY, b: "            <tr key={o.customer}>" },
  { id: "syn-07", cls: "dropped-error-path", file: PAGE, a: A_CATCH, b: "        if (live) setOrders([]);" },
  { id: "syn-08", cls: "dropped-error-path", file: PAGE, a: A_NULL, b: "  if (false) {" },
  { id: "syn-09", cls: "off-by-one", file: PAGE, a: A_PLACED, b: "              <td>{o.placedAt.slice(0, 9)}</td>" },
  { id: "syn-10", cls: "off-by-one", file: PAGE, a: A_PLACED, b: "              <td>{o.placedAt.slice(0, 11)}</td>" },
  { id: "syn-11", cls: "off-by-one", file: PAGE, a: A_PLACED, b: "              <td>{o.placedAt.slice(0, 7)}</td>" },
  { id: "syn-12", cls: "silent-swallow", file: PAGE, a: A_CATCH, b: '        if (live) setError("");' },
  { id: "syn-13", cls: "silent-swallow", file: STORE, a: A_MAP, b: "      return [];" },
  { id: "syn-14", cls: "silent-swallow", file: PAGE, a: A_CATCH, b: '        if (live) console.debug("list failed", e);' },
  { id: "syn-15", cls: "over-broad-delete", file: PAGE, a: A_MAPR, b: "          {orders.slice(0, 1).map((o) => (" },
  { id: "syn-16", cls: "over-broad-delete", file: PAGE, a: A_MAPR, b: "          {orders.slice(0, 2).map((o) => (" },
  { id: "syn-17", cls: "over-broad-delete", file: PAGE, a: A_MAPR, b: "          {orders.slice(0, 3).map((o) => (" },
  { id: "syn-18", cls: "stale-comment", file: STORE, a: A_STATUS, b: "// keep these four in lockstep with the DB check constraint\nexport const STATUSES: OrderStatus[] = [\"pending\", \"shipped\", \"cancelled\"];" },
  { id: "syn-19", cls: "stale-comment", file: PAGE, a: A_PLACED, b: "              {/* ISO strings arrive UTC-normalized; no timezone handling needed */}\n              <td>{o.placedAt.slice(0, 10)}</td>" },
  { id: "syn-20", cls: "stale-comment", file: STORE, a: A_STATUS, b: "// status values mirror the database enum, never reorder\nexport const STATUSES: OrderStatus[] = [\"pending\", \"shipped\", \"cancelled\"];" },
];

// 10 real-history pins from this repo's history (M1b-M3), pinned once here.
const REAL_CASES = [
  ["a432cf6", "gates are named G1-G3, old letters still work (M1c)"],
  ["2fe689b", "acceptance is a signed tag, not a JSON file (M1c)"],
  ["896cf63", "ship requires a signed acceptance tag (M1c)"],
  ["90d42c6", "resolve project skills into a pinned lockfile (M2a)"],
  ["c434f0e", "per-profile check lists as data (M2a)"],
  ["1229e7f", "hidden acceptance tests are the orchestrator's (M2a)"],
  ["0ff2b13", "a screenshot cannot stand in for a transcript (M2a)"],
  ["3dac181", "check the shape of a directions artifact (M2b)"],
  ["41fd16d", "capture every state at every width, or fail loud (M2b)"],
  ["f8a6a0c", "security, QA and SRE are evidence kinds (M2c)"],
];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function simpleDiff(file, before, after) {
  const A = before.split("\n"), B = after.split("\n");
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let sA = A.length - 1, sB = B.length - 1;
  while (sA >= p && sB >= p && A[sA] === B[sB]) { sA--; sB--; }
  const ctx = 3;
  const aStart = Math.max(0, p - ctx), aEnd = Math.min(A.length - 1, sA + ctx);
  const bStart = Math.max(0, p - ctx), bEnd = Math.min(B.length - 1, sB + ctx);
  const out = [`--- a/${file}`, `+++ b/${file}`];
  out.push(`@@ -${aStart + 1},${aEnd - aStart + 1} +${bStart + 1},${bEnd - bStart + 1} @@`);
  for (let i = aStart; i < p; i++) out.push(" " + A[i]);
  for (let i = p; i <= sA; i++) out.push("-" + A[i]);
  for (let i = p; i <= sB; i++) out.push("+" + B[i]);
  for (let i = sA + 1; i <= aEnd; i++) out.push(" " + A[i]);
  return out.join("\n");
}

function synthCase(c) {
  const src = readFileSync(join(ROOT, c.file), "utf8");
  // c.file is repo-relative; resolve from ROOT
  const at = src.indexOf(c.a);
  if (at === -1) throw new Error(`${c.id}: anchor not found in ${c.file} - the seed changed; refusing to generate a stale case`);
  if (src.indexOf(c.a, at + 1) !== -1) throw new Error(`${c.id}: anchor not unique in ${c.file}`);
  const after = src.slice(0, at) + c.b + src.slice(at + c.a.length);
  return `// CALIBRATION-CASE id=${c.id} corpus=synthetic class=${c.cls}\n` +
    `// Defect injected at ${c.file}\n` +
    simpleDiff(c.file, src, after) + "\n";
}

function realCase(id, sha, title) {
  let diff;
  try {
    diff = execFileSync("git", ["show", "--no-color", "--stat=10000", sha], { cwd: ROOT, encoding: "utf8" });
  } catch (e) {
    throw new Error(`real case ${id} (${sha}): git show failed - the pin is wrong or the repo is partial`);
  }
  return `// CALIBRATION-CASE id=${id} corpus=real-history sha=${sha}\n` +
    `// ${title}\n` + diff;
}

function buildManifest(entries) {
  const cases = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => ({ id: e.id, corpus: e.corpus, class: e.cls, sha256: e.sha256 }));
  return JSON.stringify({ version: 1, cases }, null, 2) + "\n";
}

function cmdPackage() {
  mkdirSync(CASES, { recursive: true });
  mkdirSync(LABELS, { recursive: true });
  const entries = [];
  const write = (name, content) => writeFileSync(join(CASES, name), content);
  for (const c of SYNTH) { const text = synthCase(c); write(`${c.id}.diff`, text); entries.push({ id: c.id, corpus: "synthetic", cls: c.cls, sha256: sha256(text) }); }
  REAL_CASES.forEach(([sha, title], i) => {
    // FACTORY_CAL_SYNTH_ONLY is a test-only switch: the sandbox fixture has no
    // decade of history to show. Production runs the real pins.
    if (process.env.FACTORY_CAL_SYNTH_ONLY === "1") return;
    const id = `real-${String(i + 1).padStart(2, "0")}`;
    const text = realCase(id, sha, title);
    write(`${id}.diff`, text);
    entries.push({ id, corpus: "real-history", cls: "real-history", sha256: sha256(text) });
  });
  for (const e of entries) {
    const label = join(LABELS, `${e.id}.md`);
    if (!existsSync(label)) writeFileSync(label, `---\nVerdict:\nWhy:\n---\n`);
  }
  writeFileSync(MANIFEST, buildManifest(entries));
  console.log(`packaged ${entries.length} cases -> ${CASES}; labels scaffolded, filled labels untouched`);
}

function verdicts() {
  if (!existsSync(VERDICTS)) return [];
  const out = [];
  const lines = readFileSync(VERDICTS, "utf8").split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try { out.push(JSON.parse(t)); } catch { throw new Error(`verdicts.jsonl line ${i + 1} is corrupt: ${t.slice(0, 120)}`); }
  });
  return out;
}

function cmdRecord(argv) {
  const [c, reviewer] = [argv[argv.indexOf("--case") + 1], argv[argv.indexOf("--reviewer") + 1]];
  const verdict = argv[argv.indexOf("--verdict") + 1];
  if (!c || !reviewer || !["pass", "changes"].includes(verdict ?? "")) {
    console.error("usage: record --case <id> --reviewer <model-id> --verdict pass|changes [--note ...]");
    process.exit(1);
  }
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { cases: [] };
  if (!manifest.cases.some((k) => k.id === c)) {
    console.error(`ERROR: case ${c} not in the manifest - run package first`);
    process.exit(1);
  }
  const note = argv[argv.indexOf("--note") + 1];
  const kept = verdicts().filter((v) => !(v.case === c && v.reviewer === reviewer));
  kept.push({ at: new Date().toISOString(), case: c, reviewer, verdict, ...(note && note !== "--note" ? { note } : {}) });
  kept.sort((a, b) => `${a.case} ${a.reviewer}`.localeCompare(`${b.case} ${b.reviewer}`));
  writeFileSync(VERDICTS, kept.map((v) => JSON.stringify(v)).join("\n") + "\n");
  console.log(`recorded ${c} ${reviewer} ${verdict}`);
}

function splitStats(cases, labels, vs, corpus) {
  const parts = cases.filter((c) => c.corpus === corpus);
  let labeled = 0, agree = 0, fa = 0, fr = 0;
  const disagreements = [];
  for (const c of parts) {
    const lab = labels.get(c.id);
    if (!lab || lab.verdict === "unlabelable" || lab.verdict === null) continue;
    const v = vs.find((v) => v.case === c.id);
    if (!v) continue;
    labeled++;
    if (v.verdict === lab.verdict) agree++;
    else {
      if (lab.verdict === "changes" && v.verdict === "pass") fa++;
      else fr++;
      disagreements.push({ id: c.id, cls: c.class, human: lab.verdict, reviewer: v.verdict });
    }
  }
  const missing = parts.length - labeled;
  return { parts: parts.length, labeled, agree, fa, fr, disagreements, missing };
}

function cmdScore(argv) {
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
  if (!manifest) { console.error("no manifest - run package first"); process.exit(1); }
  const labels = new Map();
  for (const e of manifest.cases) {
    const f = join(LABELS, `${e.id}.md`);
    if (!existsSync(f)) { labels.set(e.id, { verdict: null }); continue; }
    const m = /^Verdict:\s*(\S+)/im.exec(readFileSync(f, "utf8"));
    labels.set(e.id, { verdict: m ? m[1].toLowerCase() : null });
  }
  const idx = argv.indexOf("--reviewer");
  const wantReviewer = idx >= 0 ? argv[idx + 1] : null;
  const byReviewer = new Map();
  for (const v of verdicts()) {
    if (wantReviewer && v.reviewer !== wantReviewer) continue;
    if (!byReviewer.has(v.reviewer)) byReviewer.set(v.reviewer, []);
    byReviewer.get(v.reviewer).push(v);
  }
  if (byReviewer.size === 0) {
    console.error(wantReviewer ? `no recorded verdicts for ${wantReviewer}` : "no recorded verdicts");
    process.exit(1);
  }
  const day = new Date().toISOString().slice(0, 10);
  const outFile = join(CAL, `${day}-agreement.md`);
  if (existsSync(outFile)) { console.error(`ERROR: ${outFile} exists - will not overwrite an agreement report`); process.exit(1); }
  const blocks = [];
  for (const [reviewer, vs] of [...byReviewer.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    blocks.push(`## Reviewer: ${reviewer}\n`);
    for (const corpus of ["synthetic", "real-history"]) {
      const s = splitStats(manifest.cases, labels, vs, corpus);
      const pct = s.labeled ? ((s.agree / s.labeled) * 100).toFixed(1) : "n/a";
      blocks.push(`### ${corpus}\n- labeled split: ${s.labeled} / ${s.parts} (${s.missing} unlabeled)\n- agreement: ${s.labeled ? `${s.agree}/${s.labeled} (${pct}%)` : "n/a"}\n- false-accepts (human: changes -> reviewer: pass): ${s.fa}\n- false-rejects (human: pass -> reviewer: changes): ${s.fr}\n`);
      if (s.labeled >= 10 && s.agree === s.labeled) {
        blocks.push(`**MIRROR-RISK: 100.0% agreement on ${s.labeled} labeled ${corpus} cases.** A reviewer that never disagrees with this human is not a gate; it is a mirror. Use a different reviewer before trusting this one.\n`);
      }
      if (s.disagreements.length) {
        blocks.push(`disagreements:\n${s.disagreements.map((d) => `- ${d.id} (${d.cls}) human=${d.human} reviewer=${d.reviewer}`).join("\n")}\n`);
      }
    }
  }
  const body = `# Calibration agreement - ${day}\n\nHarness: scripts/factory-calibrate.mjs (calls no model). Labels: ${LABELS} (human-written). Missing labels are excluded and counted.\n\n${blocks.join("\n")}`;
  writeFileSync(outFile, body);
  console.log(`wrote ${outFile}`);
}

export { SYNTH, REAL_CASES, simpleDiff, buildManifest, splitStats, synthCase, realCase };
export const _paths = { CASES, LABELS, MANIFEST, VERDICTS, ROOT };

function main(argv) {
  const [cmd] = argv;
  if (cmd === "package") return cmdPackage();
  if (cmd === "record") return cmdRecord(argv);
  if (cmd === "score") return cmdScore(argv);
  console.error("usage: factory-calibrate.mjs package | record --case <id> --reviewer <model-id> --verdict pass|changes [--note ...] | score [--reviewer <id>]");
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
