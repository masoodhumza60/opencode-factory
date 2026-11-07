#!/usr/bin/env node
// Shape, not judgment. Each check answers one question: could a reviewer judge
// this artifact? It never answers whether the system is secure, tested or
// operable. A file that passes here is ready to be reviewed; it is not
// approved by this script, ever.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class ComplianceError extends Error {}

// The heading text is user data, so escape it before it becomes a pattern.
function section(text, aliases) {
  for (const heading of aliases) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^##\\s+${escaped}\\s*$`, "im");
    const m = re.exec(text);
    if (!m) continue;
    const rest = text.slice(m.index + m[0].length);
    const next = /^##\s+/m.exec(rest);
    return { heading, body: (next ? rest.slice(0, next.index) : rest).trim() };
  }
  return null;
}

function hasListItem(body) {
  return /^\s*(?:[-*]|\d+[.)])\s+\S/m.test(body);
}

function requireSections(src, groups) {
  const problems = [];
  const bodies = {};
  for (const [label, aliases] of groups) {
    const found = section(src, aliases);
    if (found === null) { problems.push(`missing section: ${label}`); continue; }
    if (found.body === "") { problems.push(`empty section: ${label}`); continue; }
    bodies[label] = found.body;
  }
  return { problems, bodies };
}

const THREAT_GROUPS = [
  ["Assets", ["Assets"]],
  ["Entry points", ["Entry points", "Entry Points"]],
  ["Threats", ["Threats", "Risks"]],
  ["Mitigations", ["Mitigations"]],
];

const RUNBOOK_GROUPS = [
  ["Purpose", ["Purpose", "Service"]],
  ["Ownership", ["Ownership", "Owner"]],
  ["Detection", ["Detection", "Symptoms"]],
  ["Response", ["Response", "Procedure"]],
  ["Escalation or Rollback", ["Escalation", "Rollback"]],
];

export function checkThreatModel(text) {
  const { problems, bodies } = requireSections(String(text ?? ""), THREAT_GROUPS);
  for (const label of ["Threats", "Mitigations"]) {
    if (bodies[label] && !hasListItem(bodies[label])) {
      problems.push(`${label} must list at least one item (a line starting "- " or "1. ")`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export function checkRunbook(text) {
  const { problems } = requireSections(String(text ?? ""), RUNBOOK_GROUPS);
  return { ok: problems.length === 0, problems };
}

function parseReport(text, type) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ""));
  } catch (e) {
    return { problems: [`not JSON: ${e.message}`] };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { problems: [`a ${type} report must be a JSON object`] };
  }
  return { doc, problems: [] };
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

export function checkSbom(text) {
  const { doc, problems } = parseReport(text, "sbom");
  if (problems.length) return { ok: false, problems };

  const cyclonedx =
    doc.bomFormat === "CycloneDX" &&
    nonEmpty(doc.specVersion) &&
    Array.isArray(doc.components);
  const spdx =
    nonEmpty(doc.spdxVersion) &&
    (Array.isArray(doc.packages) || (doc.files && typeof doc.files === "object") ||
      nonEmpty(doc.documentNamespace));

  if (!cyclonedx && !spdx) {
    problems.push(
      "the report matches neither CycloneDX (bomFormat, specVersion, components) " +
      "nor SPDX (spdxVersion and packages/files/documentNamespace)");
  }
  return { ok: problems.length === 0, problems };
}

export function checkTraceability(text) {
  const { doc, problems } = parseReport(text, "traceability");
  if (problems.length) return { ok: false, problems };

  if (!Array.isArray(doc.criteria) || doc.criteria.length === 0) {
    return { ok: false, problems: ["criteria must be a non-empty array"] };
  }
  doc.criteria.forEach((c, i) => {
    const where = `criterion ${i + 1}`;
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const id = nonEmpty(c.id) ? c.id : `<no id at ${where}>`;
    if (!nonEmpty(c.id)) problems.push(`${where} has no id`);
    if (!nonEmpty(c.description)) problems.push(`criterion "${id}" has no description`);
    if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
      problems.push(`criterion "${id}" has no evidence: map it to at least one kind and ref`);
      return;
    }
    c.evidence.forEach((e, j) => {
      const ok = nonEmpty(e) ||
        (e && typeof e === "object" && !Array.isArray(e) && nonEmpty(e.kind) && nonEmpty(e.ref));
      if (!ok) {
        problems.push(`criterion "${id}" evidence ${j + 1} must be a string or {kind, ref}`);
      }
    });
  });
  return { ok: problems.length === 0, problems };
}

export function checkSlo(text) {
  const { doc, problems } = parseReport(text, "slo");
  if (problems.length) return { ok: false, problems };

  if (!nonEmpty(doc.service)) problems.push("service must be a non-empty string");
  if (!Array.isArray(doc.objectives) || doc.objectives.length === 0) {
    problems.push("objectives must be a non-empty array");
    return { ok: false, problems };
  }
  doc.objectives.forEach((o, i) => {
    const where = `objective ${i + 1}`;
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const id = nonEmpty(o.name) ? o.name : `<no name at ${where}>`;
    if (!nonEmpty(o.name)) problems.push(`${where} has no name`);
    if (!nonEmpty(o.indicator)) problems.push(`objective "${id}" has no indicator`);
    const targetOk =
      (typeof o.target === "string" && o.target.trim() !== "") ||
      (typeof o.target === "number" && Number.isFinite(o.target));
    if (!targetOk) problems.push(`objective "${id}" has no target`);
  });
  return { ok: problems.length === 0, problems };
}

const CHECKS = {
  "threat-model": checkThreatModel,
  sbom: checkSbom,
  traceability: checkTraceability,
  runbook: checkRunbook,
  slo: checkSlo,
};
const TYPES = Object.keys(CHECKS);
const USAGE = `usage: node scripts/factory-compliance.mjs check <${TYPES.join("|")}> <bead> <path>`;

function main(argv) {
  const [command, type, bead, path] = argv;
  if (command !== "check" || !type || !bead || !path) {
    console.error(USAGE);
    return 1;
  }
  const check = CHECKS[type];
  if (!check) {
    console.error(`unknown type "${type}"; the types are: ${TYPES.join(", ")}`);
    return 1;
  }
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    console.error(`ERROR: ${abs} does not exist: a ${type} artifact has to be written before it can be checked`);
    return 1;
  }
  if (!statSync(abs).isFile()) {
    console.error(`ERROR: ${abs} is a directory; point check at the ${type} file`);
    return 1;
  }
  const { ok, problems } = check(readFileSync(abs, "utf8"));
  if (!ok) {
    console.error(`ERROR: ${path} is not a ${type} artifact yet, for ${bead}:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("Shape is checked here. Whether it is adequate is a reviewer or human call.");
    return 1;
  }
  console.log(`compliance ok -> ${path}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
