#!/usr/bin/env node
// factory-calibrate.test.mjs - drives the real harness against a throwaway
// root: two seed files copied verbatim, a one-commit git history, and case
// generation via templates. It does NOT touch docs/calibration/ in the repo.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-calibrate.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "factory-cal-test-"));
const ROOT = join(SANDBOX, "repo");
mkdirSync(join(ROOT, "testapps", "orderboard", "src", "orders"), { recursive: true });
mkdirSync(join(ROOT, "docs", "calibration"), { recursive: true });

const copy = (rel) => {
  mkdirSync(dirname(join(ROOT, rel)), { recursive: true });
  copyFileSync(join(HERE, "..", rel), join(ROOT, rel));
};
copy("testapps/orderboard/src/orders/store.ts");
copy("testapps/orderboard/src/orders/OrdersPage.tsx");
execFileSync("git", ["init", "-q"], { cwd: ROOT });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: ROOT });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty-message", "-m", "fixture"], { cwd: ROOT });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};
const run = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env, FACTORY_CAL_ROOT: ROOT, FACTORY_CAL_SYNTH_ONLY: "1" } });

console.log("factory-calibrate");

const pk = run(["package"]);
check("package exits 0 and creates cases", pk.status === 0 && existsSync(join(ROOT, "docs", "calibration", "manifest.json")), `${pk.status}\n${pk.stderr}`);

const manifestPath = join(ROOT, "docs", "calibration", "manifest.json");
const manifest1 = readFileSync(manifestPath, "utf8");
const pkg2 = run(["package"]);
check("package is byte-identical on regeneration", pkg2.status === 0 && readFileSync(manifestPath, "utf8") === manifest1);

const manifest = JSON.parse(manifest1);

// the real-history pins must resolve against this repo's history (catches a rewritten past)
import { REAL_CASES } from "./factory-calibrate.mjs";
const pinsResolve = REAL_CASES.every(([sha]) => {
  try { execFileSync("git", ["cat-file", "-e", sha], { cwd: join(HERE, ".."), timeout: 30000 }); return true; } catch { return false; }
});
check("all ten real-history pins resolve to commits in this repo", pinsResolve);

check("twenty synthetic cases in synth-only mode", manifest.cases.length === 20 && manifest.cases.every((c) => c.corpus === "synthetic"));

const classes = manifest.cases.filter((c) => c.corpus === "synthetic").map((c) => c.class);
check("the eight base classes appear at least twice and twelve mixed variations exist",
  ["wrong-condition", "missing-validation", "contract-break", "dropped-error-path"].every((c) => classes.filter((x) => x === c).length === 2) &&
  ["off-by-one", "silent-swallow", "over-broad-delete", "stale-comment"].every((c) => classes.filter((x) => x === c).length === 3));

const casesDir = join(ROOT, "docs", "calibration", "cases");
const caseFiles = readdirSync(casesDir).sort();
check("every manifest case has a diff file with its header", manifest.cases.every((c) => caseFiles.includes(`${c.id}.diff`) && readFileSync(join(casesDir, `${c.id}.diff`), "utf8").startsWith(`// CALIBRATION-CASE id=${c.id}`)));

const rec = run(["record", "--case", "syn-01", "--reviewer", "model-x", "--verdict", "changes"]);
check("record appends a verdict", rec.status === 0, `${rec.status}\n${rec.stderr}`);
const recUp = run(["record", "--case", "syn-01", "--reviewer", "model-x", "--verdict", "pass"]);
const vLines = readFileSync(join(ROOT, "docs", "calibration", "verdicts.jsonl"), "utf8").trim().split("\n").filter((l) => l);
check("record upserts the same (case, reviewer) instead of stacking", vLines.length === 1 && JSON.parse(vLines[0]).verdict === "pass");

const recBad = run(["record", "--case", "no-such-case", "--reviewer", "model-x", "--verdict", "pass"]);
check("record refuses an unknown case by name", recBad.status === 1 && recBad.stderr.includes("no-such-case"));

const recMiss = run(["record", "--case", "syn-02", "--reviewer", "", "--verdict", "pass"]);
check("record without a reviewer refuses", recMiss.status === 1);

const scoreNone = run(["score", "--reviewer", "nobody"]);
check("score with zero recorded verdicts refuses by name", scoreNone.status === 1 && scoreNone.stderr.includes("nobody"));

// labels: fill two, leave the rest out.
const label = (id, verdict, why = "x") => writeFileSync(join(ROOT, "docs", "calibration", "labels", `${id}.md`), `---\nVerdict: ${verdict}\nWhy: ${why}\n---\n`);
label("syn-01", "changes");
label("syn-02", "changes");
const sc = run(["score", "--reviewer", "model-x"]);
const reportPath = join(ROOT, "docs", "calibration", `${new Date().toISOString().slice(0, 10)}-agreement.md`);
check("score writes the dated agreement report", sc.status === 0 && existsSync(reportPath), `${sc.status}\n${sc.stderr}`);
const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
check("the report counts unlabeled cases as missing, never as disagreement", /unlabeled/.test(report));
check("the report states the reviewer and per-split blocks", report.includes("model-x") && report.includes("### synthetic") && report.includes("### real-history"));
// MIRROR-RISK: 10 labeled synthetic cases, all correct with one reviewer.
for (const id of ["syn-01", "syn-02", "syn-03", "syn-04", "syn-05", "syn-06", "syn-07", "syn-08", "syn-09", "syn-10"]) {
  label(id, "pass");
  run(["record", "--case", id, "--reviewer", "model-y", "--verdict", "pass"]);
}
const sc2 = run(["score", "--reviewer", "model-y"]);
const rp2 = join(ROOT, "docs", "calibration", `${new Date().toISOString().slice(0, 10)}-agreement.md`);
// the second score refuses to overwrite the first report
check("score refuses to overwrite an existing agreement report", sc2.status === 1 && sc2.stderr.includes("will not overwrite"));
rmSync(rp2, { force: true });
const sc3 = run(["score", "--reviewer", "model-y"]);
const report3 = sc3.status === 0 ? readFileSync(rp2, "utf8") : "";
check("100% agreement on >=10 labeled cases is flagged MIRROR-RISK", report3.includes("MIRROR-RISK"));

try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* locked */ }
console.log(`\n${pass}/${pass + fail} calibration tests passed.`);
process.exit(fail ? 1 : 0);
