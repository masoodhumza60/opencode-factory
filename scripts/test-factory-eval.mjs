#!/usr/bin/env node
// Suite for scripts/factory-eval.mjs. The plan scopes this suite to harness
// behaviour that does not need the heavy seeds: the zero-install cli seed
// (fully runnable from a scratch copy semantics) and the refusal paths. The
// 12/12 proof line for all three seeds comes from a real `check` run and is
// pasted into docs/factory-eval.md.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-eval.mjs");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

console.log("factory-eval suite");

const bogus = run(["check", "not-a-seed"]);
check("an unknown seed is refused by name",
  bogus.status === 1 && bogus.stderr.includes("not-a-seed"),
  `${bogus.status}\n${bogus.stderr}${bogus.stdout}`);

const noArgs = run([]);
check("no subcommand prints usage", noArgs.status === 1 && noArgs.stderr.includes("usage:"), `${noArgs.status}\n${noArgs.stderr}`);

const cli = run(["check", "orderboard-cli"]);
check("the cli seed check exits 0", cli.status === 0, `${cli.status}\n${cli.stdout}${cli.stderr}`);
check("the cli check prints NOT APPLICABLE for the three discrimination proofs",
  (cli.stdout.match(/NOT APPLICABLE/g) || []).length === 3,
  cli.stdout);
check("the cli check still proves its own suite is green",
  /ok orderboard-cli own/.test(cli.stdout),
  cli.stdout);

const outMatch = /machine record: (.+)/.exec(cli.stdout);
check("the run reports a machine record path", outMatch !== null, cli.stdout);
if (outMatch) {
  const p = outMatch[1].trim();
  check("the machine record exists", existsSync(p), p);
  if (existsSync(p)) {
    const rows = readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    check("every row is {at, seed, proof, ok} with an ISO timestamp",
      rows.length > 0 && rows.every((r) => typeof r.at === "string" && Date.parse(r.at) && typeof r.seed === "string" && typeof r.proof === "string" && typeof r.ok === "boolean"),
      JSON.stringify(rows[0]));
    check("the cli rows carry ok:true for own and NOT APPLICABLE proofs",
      rows.filter((r) => r.seed === "orderboard-cli").every((r) => r.ok === true));
  }
}

console.log(`\n${pass}/${pass + fail} factory-eval tests passed.`);
process.exit(fail ? 1 : 0);
