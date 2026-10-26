// test-factory-protect.mjs - the pinned grading machinery.
//
// `protect` records sha256 for the five scripts that decide what evidence is.
// `protectedProblems` says why that record cannot be trusted. The phase suite
// proves the ship gate uses them; this proves the checks themselves, in throwaway
// homes, so a real re-baseline never depends on a test.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  protect, protectedProblems, PROTECTED_FILES, PROTECTED_SET,
} from "./factory-attest.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const homes = [];
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "factory-protect-"));
  homes.push(home);
  for (const file of PROTECTED_FILES) {
    mkdirSync(join(home, dirname(file)), { recursive: true });
    writeFileSync(join(home, file), `// ${file}\n`);
  }
  mkdirSync(join(home, "config"), { recursive: true });
  return home;
}

function commit(home) {
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", home], { stdio: "ignore" });
  execFileSync("git", ["-C", home, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", home, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-qm", "baseline"], { stdio: "ignore" });
}

function withRole(role, fn) {
  const before = process.env.FACTORY_ROLE;
  if (role === undefined) delete process.env.FACTORY_ROLE;
  else process.env.FACTORY_ROLE = role;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.FACTORY_ROLE;
    else process.env.FACTORY_ROLE = before;
  }
}

// ---- the set must exist, parse, and describe this install --------------------
console.log("\nprotected set");

const home = makeHome();
{
  const problems = protectedProblems(home);
  check("a missing set is a refusal that names the fix",
    problems.length === 1 && problems[0].includes("no protected set") &&
    problems[0].includes("protect --write"), JSON.stringify(problems));
}

{
  const dry = protect([], home);
  check("protect without --write prints a table and writes nothing",
    !existsSync(join(home, PROTECTED_SET)) && dry.includes("would write") &&
    dry.includes("ok") === false && dry.includes("new     scripts/factory-attest.mjs"),
    dry.split("\n")[0]);
}

{
  let refused = null;
  try { withRole("builder", () => protect(["--write"], home)); } catch (e) { refused = e.message; }
  check("only a human may re-baseline the grading machinery",
    refused !== null && refused.includes("only a human may re-baseline"),
    String(refused));
  check("a refused re-baseline writes nothing", !existsSync(join(home, PROTECTED_SET)));
}

{
  withRole("human", () => protect(["--write"], home));
  check("a human baseline is written for all five scripts",
    existsSync(join(home, PROTECTED_SET)) &&
    Object.keys(JSON.parse(readFileSync(join(home, PROTECTED_SET), "utf8")).files).length === PROTECTED_FILES.length);
  const problems = protectedProblems(home);
  check("an uncommitted baseline is refused even when it matches",
    problems.length === 1 && problems[0].includes("not committed"), JSON.stringify(problems));
}

commit(home);
{
  const problems = protectedProblems(home);
  check("a committed baseline that matches the scripts passes", problems.length === 0, JSON.stringify(problems));
}

// ---- a changed, missing, or unparseable set --------------------------------
console.log("\nwhat breaks the pin");

{
  writeFileSync(join(home, "scripts", "factory-phase.mjs"), "// edited by the builder\n");
  const problems = protectedProblems(home);
  check("an edited script is refused by name",
    problems.some((p) => p.includes("the grading machinery changed: scripts/factory-phase.mjs")),
    JSON.stringify(problems));
  withRole("human", () => protect(["--write"], home));
  commit(home);
  check("a human re-baseline followed by a commit clears it",
    protectedProblems(home).length === 0, JSON.stringify(protectedProblems(home)));
}

{
  unlinkSync(join(home, "scripts", "factory-policy.mjs"));
  const problems = protectedProblems(home);
  check("a missing script is refused by name",
    problems.some((p) => p.includes("is missing scripts/factory-policy.mjs")), JSON.stringify(problems));
}

{
  const other = makeHome();
  writeFileSync(join(other, PROTECTED_SET), "{ not json\n");
  const problems = protectedProblems(other);
  check("unparseable JSON is a refusal, not a crash",
    problems.length === 1 && problems[0].includes("is not valid JSON"), JSON.stringify(problems));
}

{
  const other = makeHome();
  withRole("human", () => protect(["--write"], other));
  const set = JSON.parse(readFileSync(join(other, PROTECTED_SET), "utf8"));
  set.version = 2;
  writeFileSync(join(other, PROTECTED_SET), JSON.stringify(set));
  const problems = protectedProblems(other);
  check("a future version is refused rather than guessed at",
    problems.length === 1 && problems[0].includes("is not a version 1 protected set"),
    JSON.stringify(problems));
}

{
  const other = makeHome();
  withRole("human", () => protect(["--write"], other));
  const set = JSON.parse(readFileSync(join(other, PROTECTED_SET), "utf8"));
  delete set.files["scripts/factory-review.mjs"];
  writeFileSync(join(other, PROTECTED_SET), JSON.stringify(set));
  const problems = protectedProblems(other);
  check("a set that stops naming a script is refused",
    problems.some((p) => p.includes("records no hash for scripts/factory-review.mjs")),
    JSON.stringify(problems));
}

// ---- the table tells the truth ---------------------------------------------
console.log("\nthe table");
{
  const other = makeHome();
  withRole("human", () => protect(["--write"], other));
  writeFileSync(join(other, "scripts", "factory-attest.mjs"), "// changed\n");
  const table = protect([], other);
  check("an unchanged file says ok and a changed one says changed",
    /ok\s+scripts\/factory-manifest\.mjs/.test(table) &&
    /changed\s+scripts\/factory-attest\.mjs/.test(table), table);
}

for (const home of homes) {
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (e) { console.log(`  cleanup warning: ${home} left behind (${e.code})`); }
}

console.log(`\n${pass}/${pass + fail} protect tests passed.`);
process.exit(fail ? 1 : 0);
