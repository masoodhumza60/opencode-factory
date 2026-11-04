#!/usr/bin/env node
// The capture adapter's job is to fail when it captured nothing. This suite
// drives the real script against the real fixture. Without a browser it prints
// an explicit SKIPPED line and exits 1, so a green run always means a browser
// did the work.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-capture.mjs");
const FIXTURE = join(HERE, "..", "fixtures", "testapp");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};
const run = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 240000 });

console.log("factory-capture");

const help = run(["--help"]);
check("--help explains the invocation without a browser",
  help.status === 0 && help.stdout.includes("--fixture") && help.stdout.includes("never attests"),
  `${help.status}\n${help.stdout}${help.stderr}`);

const missing = run(["--fixture", join(HERE, "no-such-fixture")]);
check("a missing fixture directory is refused by name",
  missing.status === 1 && missing.stderr.includes("no-such-fixture") && missing.stderr.includes("does not exist"),
  `${missing.status}\n${missing.stderr}`);

const noFixture = run([]);
check("no --fixture is a usage error", noFixture.status === 1 && noFixture.stderr.includes("--fixture"),
  `${noFixture.status}\n${noFixture.stderr}`);

const out = mkdtempSync(join(tmpdir(), "factory-capture-test-"));
const full = run(["--fixture", FIXTURE, "--out", out]);
if (full.stderr.includes("SKIPPED: no browser")) {
  console.log(`SKIPPED: no browser (${full.stderr.trim()})`);
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}
check("a full capture exits 0", full.status === 0, `${full.status}\n${full.stdout}\n${full.stderr}`);

const widths = ["1440", "768", "390"];
const states = ["default", "loading", "empty", "error", "disabled"];
for (const s of states) {
  for (const w of widths) {
    const p = join(out, `${s}-${w}.png`);
    const big = existsSync(p) && readFileSync(p).length > 2000;
    check(`${s}-${w}.png exists and is not blank`, big, p);
  }
}
check("the run prints the artifact count", /captured 16 artifacts/.test(full.stdout), full.stdout);

const axe = join(out, "axe.json");
let axeJson = null;
try { axeJson = JSON.parse(readFileSync(axe, "utf8")); } catch { axeJson = null; }
check("axe.json is report-shaped: url, violations array, rule count",
  axeJson !== null && typeof axeJson.violations === "object" && Array.isArray(axeJson.violations)
    && typeof axeJson.passes === "object" && typeof axeJson.rules === "number",
  axe);

check("capture attests nothing: no manifest is written",
  !existsSync(join(out, "..", "manifest.json")) && !existsSync(join(out, "manifest.json")));

// A console error must fail the run. The probe is driven by an env var the
// adapter passes through to the fixture URL's state query.
const probeOut = mkdtempSync(join(tmpdir(), "factory-capture-probe-"));
const probe = run(["--fixture", FIXTURE, "--out", probeOut, "--state", "console-error"]);
check("a console error fails the run and names the state",
  probe.status === 1 && /console-error/.test(`${probe.stdout}${probe.stderr}`) && /console/i.test(probe.stderr),
  `${probe.status}\n${probe.stdout}${probe.stderr}`);

const unknown = run(["--fixture", FIXTURE, "--out", probeOut, "--state", "nonsense"]);
check("a state the fixture does not implement is refused by name",
  unknown.status === 1 && /nonsense/.test(unknown.stderr), `${unknown.status}\n${unknown.stderr}`);

rmSync(out, { recursive: true, force: true });
rmSync(probeOut, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} capture tests passed.`);
process.exit(fail ? 1 : 0);
