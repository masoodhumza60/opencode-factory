#!/usr/bin/env node
// factory-plan.mjs - the plan, as a queryable dependency graph in beads.
//
// P3 of the factory plan. The evidence: medical-claims-ai had TWO beads against a
// 331 KB / 7,476-line plan with commits landing through Task 5; etsy had seven
// beads for sixteen tasks. The markdown was the real ledger and beads was
// decoration, because a plan document is only readable by whoever is already
// holding it in context. This turns an approved plan into beads that `bd ready`
// can order, `bd lint` can hold to a standard, and a fresh session can pick up
// without reading a word of the prose.
//
//   node scripts/factory-plan.mjs validate <plan.json> [--json]
//   node scripts/factory-plan.mjs graph    <plan.json> --issue <bead> [--dry-run] [--force] [--json]
//
// Exit: 0 ok | 1 invalid or error | 2 already applied
//
// WHY THIS VALIDATES BEFORE IT WRITES. bd 1.3.0's graph schema is strict in a
// quiet way: `bd create --graph` SILENTLY DROPS fields it does not know, and it
// names the fix in a warning that scrolls past ("acceptance" is not the field -
// use "acceptance_criteria"). A plan author who wrote "skills" or "acceptance"
// would watch the command succeed and believe the plan carried those
// requirements. A silent drop is the same class of defect as silent skill
// discovery, which this factory already refuses to ship. So an unknown field is
// an error here, not a shrug, and the misnamings come with the fix attached.
//
// Plan format (docs/plan-format.md):
//   { "nodes": [ { "key": "t1", "title": "...", "acceptance_criteria": "...",
//                  "deps": [ { "target": "t2" } ], "parent": "t3", ... } ] }
// Node fields bd 1.3.0 accepts: key, title, description, acceptance_criteria,
// type, labels, priority, estimate, metadata, status, id, spec_id, external_ref,
// assignee, notes, design, parent, deps[].target.
// Rejected: acceptance (use acceptance_criteria), skills, depends_on (use
// deps), blocked_by, milestone.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const KNOWN = new Set([
  "key", "title", "description", "acceptance_criteria", "type", "labels",
  "priority", "estimate", "metadata", "status", "id", "spec_id", "external_ref",
  "assignee", "notes", "design", "parent", "deps",
]);

// bd lint's own per-type requirements, verified from `bd lint --help`. Mirrored
// here so a malformed plan is refused before a single bead is written, rather
// than after the ledger exists in a state that fails its own lint.
const LINT_REQUIRES_ACCEPTANCE = new Set(["bug", "task", "feature", "epic", "story"]);

const MISNAMED = {
  acceptance: 'use "acceptance_criteria" (the field bd actually reads)',
  acceptanceCriteria: 'use "acceptance_criteria"',
  depends_on: 'use "deps": [{ "target": "<key>" }]',
  blocked_by: 'use "deps" on the blocking node instead',
  skills: "graph nodes cannot carry required skills in bd 1.3.0 - set them per-issue with bd create --skills, or record them in the plan notes",
  milestone: "not a graph node field; use labels or a separate milestone issue",
  blockedBy: 'use "deps"',
  requires: 'use "deps"',
};

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};
const asJson = args.includes("--json");
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const quiet = args.includes("--quiet");

class PlanError extends Error {}
class Applied extends Error {}

let BD = "bd";
function bd(argv, { allowFail = false } = {}) {
  try {
    return execFileSync(BD, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (allowFail) return null;
    const d = (e.stderr || e.message || "").trim();
    throw new PlanError(d || "bd failed");
  }
}

// --quiet suppresses the chatter, never the payload: the payload is the answer.
const say = (...a) => { if (!quiet) console.log(...a); };
const out = (o) => console.log(asJson ? JSON.stringify(o, null, 2) : o.text);

// ---- validation (no db, no writes) ---------------------------------------------

function validate(plan) {
  const problems = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    throw new PlanError("plan must be a JSON object with a \"nodes\" array");
  const unknownTop = Object.keys(plan).filter((k) => k !== "nodes");
  if (unknownTop.length) problems.push(`plan: unknown top-level field(s): ${unknownTop.join(", ")} (only "nodes" is read)`);
  const nodes = plan.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0)
    throw new PlanError("plan has no nodes - a plan with no tasks is not a plan");

  const keys = new Set();
  nodes.forEach((n, i) => {
    const at = `node ${i}`;
    if (!n || typeof n !== "object" || Array.isArray(n)) {
      problems.push(`${at}: is not an object`);
      return;
    }
    // Unknown fields are an error, not a warning: bd drops them silently, and a
    // requirement that silently vanished is how a task ships without its
    // acceptance criteria.
    for (const f of Object.keys(n)) {
      if (KNOWN.has(f)) continue;
      const hint = MISNAMED[f];
      problems.push(`${n.key ? `node "${n.key}"` : at}: field "${f}" is not part of the graph schema${hint ? ` - ${hint}` : " (bd would silently drop it)"}`);
    }
    const key = typeof n.key === "string" ? n.key.trim() : "";
    if (!key) problems.push(`${at}: "key" is required and must be non-empty`);
    else if (!/^[A-Za-z0-9._-]+$/.test(key))
      // A restricted charset is not cosmetic: created ids are parsed back out of
      // bd's "  t1 -> bd-x-9ab" output, and a key containing spaces or newlines
      // would make that mapping ambiguous.
      problems.push(`${at}: key "${key}" must match [A-Za-z0-9._-]+ (spaces and punctuation make the id mapping ambiguous)`);
    else if (keys.has(key)) problems.push(`${at}: duplicate key "${key}"`);
    else keys.add(key);

    if (typeof n.title !== "string" || !n.title.trim()) problems.push(`${n.key ?? at}: "title" is required and must be non-empty`);

    const type = typeof n.type === "string" ? n.type : "task";
    if (LINT_REQUIRES_ACCEPTANCE.has(type) &&
        (typeof n.acceptance_criteria !== "string" || !n.acceptance_criteria.trim()))
      problems.push(`${n.key ?? at}: type "${type}" requires non-empty "acceptance_criteria" (bd lint would flag it)`);

    if (n.estimate !== undefined && !Number.isInteger(n.estimate))
      problems.push(`${n.key ?? at}: "estimate" must be an integer`);
    if (n.priority !== undefined && !Number.isInteger(n.priority))
      problems.push(`${n.key ?? at}: "priority" must be an integer 0-4`);
    if (n.deps !== undefined && !Array.isArray(n.deps))
      problems.push(`${n.key ?? at}: "deps" must be an array of { "target": "<key>" }`);
  });

  // Reference integrity: a dep or parent pointing at a key that is not in this
  // plan is the failure mode that makes a graph lie about what is ready.
  nodes.forEach((n, i) => {
    if (!n || typeof n !== "object") return;
    const k = n.key || `node ${i}`;
    (Array.isArray(n.deps) ? n.deps : []).forEach((d, j) => {
      if (!d || typeof d !== "object" || typeof d.target !== "string" || !d.target.trim())
        problems.push(`${k}: dep ${j} has no "target" (deps entries are objects, not strings)`);
      else if (!keys.has(d.target))
        problems.push(`${k}: dep target "${d.target}" is not a key in this plan`);
    });
    if (n.parent !== undefined) {
      if (typeof n.parent !== "string" || !n.parent.trim())
        problems.push(`${k}: "parent" must be a key in this plan`);
      else if (!keys.has(n.parent))
        problems.push(`${k}: parent key "${n.parent}" is not a key in this plan`);
    }
  });

  if (problems.length) {
    const e = new PlanError(`plan is invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n  - ${problems.join("\n  - ")}`);
    e.problems = problems;
    throw e;
  }
  return nodes;
}

function readPlan(file) {
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch { throw new PlanError(`cannot read plan file: ${file}`); }
  let j;
  try { j = JSON.parse(text); }
  catch (e) { throw new PlanError(`plan file is not valid JSON (${file}): ${e.message}`); }
  return { json: j, fingerprint: createHash("sha256").update(canonical(j)).digest("hex").slice(0, 16) };
}

// Order-insensitive so reformatting the file does not read as a changed plan,
// while any real change to a title, a dep or a criterion does.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

function readMeta(bead) {
  const raw = bd(["show", bead, "--json"], { allowFail: true });
  if (!raw) return {};
  let j;
  try { j = JSON.parse(raw); } catch { return {}; }
  const issue = Array.isArray(j) ? j[0] : (j.issue || j);
  return issue?.metadata || {};
}

// ---- commands -------------------------------------------------------------------

function cmdValidate(file) {
  if (!file) throw new PlanError("a plan file is required");
  const { json, fingerprint } = readPlan(file);
  const nodes = validate(json);
  const deps = nodes.reduce((n, x) => n + (Array.isArray(x.deps) ? x.deps.length : 0), 0);
  const roots = nodes.filter((n) => n.parent === undefined).length;
  out({
    text: [
      `plan:     ${file}`,
      `fingerprint: ${fingerprint}`,
      `nodes:    ${nodes.length} (${roots} root, ${nodes.length - roots} nested)`,
      `deps:     ${deps}`,
      `valid:    yes`,
    ].join("\n"),
    file, fingerprint, nodes: nodes.length, deps, roots, valid: true,
  });
}

function cmdGraph(file, issue) {
  if (!file) throw new PlanError("a plan file is required");
  if (!issue) throw new PlanError("--issue <bead> is required: the plan's tasks hang off the feature bead");
  const { json, fingerprint } = readPlan(file);
  const nodes = validate(json);                    // refuse before writing

  const meta = readMeta(issue);
  if (meta.plan_fingerprint === fingerprint && !force)
    throw new Applied(`this plan is already applied to ${issue} (fingerprint ${fingerprint}). Re-running would create a second copy of every task, because bd create --graph is not idempotent. Pass --force only if you mean it.`);
  if (meta.plan_fingerprint && meta.plan_fingerprint !== fingerprint)
    say(`note: ${issue} already carries a different plan (${meta.plan_fingerprint}); applying ${fingerprint} alongside it`);

  if (dryRun) {
    out({
      text: [
        `[dry-run] would create ${nodes.length} issue(s) under ${issue}`,
        `[dry-run] ${nodes.filter((n) => n.parent === undefined).length} root(s) would be parented to ${issue}`,
        `[dry-run] then run: bd lint <created ids>`,
        `fingerprint: ${fingerprint}`,
      ].join("\n"),
      dry_run: true, fingerprint, would_create: nodes.length, issue,
    });
    return;
  }

  // The plan file IS the graph plan, so we apply exactly the bytes we validated.
  const res = bd(["create", "--graph", file]);
  // bd prints "  t1 -> opencode-factory-0vn" per created issue.
  const map = {};
  for (const line of String(res).split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+->\s+(\S+)/);
    if (m) map[m[1]] = m[2];
  }
  const missing = nodes.map((n) => n.key).filter((k) => !map[k]);
  // Fail closed: a partial apply would leave a ledger that disagrees with the plan
  // it came from, and the next session would trust the ledger.
  if (missing.length)
    throw new PlanError(`bd did not report ids for: ${missing.join(", ")} - the graph may be half-applied. Inspect with: bd list`);

  const roots = nodes.filter((n) => n.parent === undefined);
  for (const n of roots) bd(["update", map[n.key], "--parent", issue], { allowFail: true });

  bd(["update", issue, "--metadata", JSON.stringify({
    ...meta,
    plan_file: file,
    plan_fingerprint: fingerprint,
    plan_issues: map,
  })], { allowFail: true });

  const ids = Object.values(map);
  const lint = bd(["lint", ...ids], { allowFail: true });
  const lintFailed = lint === null;
  say(`created ${ids.length} issue(s) under ${issue} (fingerprint ${fingerprint})`);
  for (const [k, v] of Object.entries(map)) say(`  ${k} -> ${v}`);

  out({
    text: [
      `plan:     ${file}`,
      `fingerprint: ${fingerprint}`,
      `feature:  ${issue}`,
      `created:  ${ids.length} issue(s), ${roots.length} parented to ${issue}`,
      `lint:     ${lintFailed ? "bd lint FAILED - see stderr" : (lint || "").trim().split(/\r?\n/)[0] || "ok"}`,
    ].join("\n"),
    file, fingerprint, issue, created: map, count: ids.length, lint_ok: !lintFailed,
  });
  if (lintFailed) process.exitCode = 1;
}

try {
  if (!cmd) {
    console.error("usage: factory-plan.mjs <validate|graph> <plan.json> [--issue <bead>] [--dry-run] [--force]");
    process.exit(1);
  }
  if (cmd === "validate") cmdValidate(args[1]);
  else if (cmd === "graph") cmdGraph(args[1], flag("issue"));
  else throw new PlanError(`unknown command "${cmd}"`);
} catch (e) {
  const applied = e instanceof Applied;
  console.error(`${applied ? "ALREADY APPLIED" : "ERROR"}: ${e.message}`);
  process.exit(applied ? 2 : 1);
}
