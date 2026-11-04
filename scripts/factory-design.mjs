#!/usr/bin/env node
// Shape, not taste. This reads a directions artifact and refuses one that a
// reader could not judge: no user, no journey, fewer than two named directions,
// a direction with no critique or no fit verdict, nothing chosen, or nothing
// rejected with a reason longer than an adjective. A file that passes here is
// ready to be judged at G1; it is not approved by this script, ever.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIT = new Set(["fits", "strains", "rejects"]);
const USAGE = "usage: node scripts/factory-design.mjs check <bead> <path/to/directions.md>";

export class DesignError extends Error {}

function section(text, heading) {
  // The heading text is user data, so escape it before it becomes a pattern.
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*$`, "im");
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function directionsOf(body) {
  const re = /^###\s+(.+?)\s*$/gm;
  const heads = [...body.matchAll(re)];
  return heads.map((h, i) => ({
    name: h[1].trim(),
    body: body.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : body.length).trim(),
  }));
}

function critiqueOf(body) {
  const m = /^[-*]\s*Critique:\s*(.+)$/im.exec(body);
  return m ? m[1].trim() : "";
}

function fitOf(body) {
  const m = /^[-*]\s*Fit:\s*(\S+)\s*$/im.exec(body);
  return m ? m[1].trim() : "";
}

// More than an adjective: at least six words, so "uglier" and "too busy" are
// refused while "it promises drag the page cannot do" is not.
function substantive(reason) {
  return reason.trim().split(/\s+/).filter(Boolean).length >= 6;
}

export function checkDirections(text) {
  const problems = [];
  const src = String(text ?? "");

  for (const heading of ["User", "Journey", "Directions", "Chosen", "Rejected (with reasons)"]) {
    const body = section(src, heading);
    if (body === null) problems.push(`missing section: ${heading}`);
    else if (body === "") problems.push(`empty section: ${heading}`);
  }
  if (problems.length) return { ok: false, problems };

  const dirs = directionsOf(section(src, "Directions"));
  if (dirs.length < 2) {
    problems.push(`Directions names ${dirs.length} direction(s); at least two are required, each with a critique`);
    return { ok: false, problems };
  }
  for (const d of dirs) {
    if (critiqueOf(d.body) === "") {
      problems.push(`direction "${d.name}" has no critique (a line starting "- Critique:")`);
    }
    const fit = fitOf(d.body);
    if (fit === "") {
      problems.push(`direction "${d.name}" has no fit verdict (a line starting "- Fit: fits|strains|rejects")`);
    } else if (!FIT.has(fit)) {
      problems.push(`direction "${d.name}" has fit "${fit}"; expected one of fits, strains, rejects`);
    }
  }

  const chosen = section(src, "Chosen");
  if (!dirs.some((d) => chosen.includes(d.name))) {
    problems.push(`Chosen names no direction; it must name one of: ${dirs.map((d) => d.name).join(", ")}`);
  }

  const rejected = section(src, "Rejected (with reasons)")
    .split(/^[-*]\s+/m)
    .map((r) => r.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (rejected.length === 0) {
    problems.push("Rejected (with reasons) lists no rejected direction");
  }
  for (const r of rejected) {
    if (!substantive(r)) {
      problems.push(`rejected direction "${r}" has no reason: say what the direction costs, in more than an adjective`);
    }
  }

  return { ok: problems.length === 0, problems };
}

function main(argv) {
  const [command, bead, path] = argv;
  if (command !== "check" || !bead || !path) {
    console.error(USAGE);
    return 1;
  }
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    console.error(`ERROR: ${abs} does not exist: a directions artifact has to be written before it can be checked`);
    return 1;
  }
  if (!statSync(abs).isFile()) {
    console.error(`ERROR: ${abs} is a directory; point check at the directions file`);
    return 1;
  }
  const { ok, problems } = checkDirections(readFileSync(abs, "utf8"));
  if (!ok) {
    console.error(`ERROR: ${path} is not a directions artifact yet, for ${bead}:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("Shape is checked here. Whether a direction is any good is judged at G1.");
    return 1;
  }
  console.log(`directions ok -> ${path}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
