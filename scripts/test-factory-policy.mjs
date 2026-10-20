import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PolicyError, parseYamlSubset, loadPolicy, effectiveChecks, requiredForPhase, validatePolicy,
} from "./factory-policy.mjs";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const root = mkdtempSync(join(tmpdir(), "factory-policy-"));
mkdirSync(join(root, "config"), { recursive: true });
const policyPath = join(root, "config", "factory.policy.yaml");

// The full policy: every kind, every tier, every profile.
const TIER_CHECKS = {
  prototype: ["tests", "run", "review"],
  internal: ["tests", "run", "review", "lint", "types", "contract"],
  public: ["tests", "run", "review", "lint", "types", "contract", "a11y", "perf", "security", "migration", "rollback", "observability", "privacy"],
  regulated: ["tests", "run", "review", "lint", "types", "contract", "a11y", "perf", "security", "migration", "rollback", "observability", "privacy", "audit", "retention", "incident", "dr", "segregation", "training", "attestation"],
};
const PROFILE_CHECKS = {
  web: ["a11y", "perf"],
  api: ["contract"],
  cli: ["help"],
  library: ["api-diff"],
  mobile: [],
  desktop: [],
  "data-ml": ["eval"],
  infra: ["plan-diff"],
  embedded: ["device-capture"],
  game: [],
};
const KIND = {
  tests: "check-output", run: "transcript", review: "prr", lint: "check-output",
  types: "check-output", contract: "contract", a11y: "screenshot", perf: "transcript",
  security: "transcript", migration: "plan", rollback: "plan", observability: "transcript",
  privacy: "golden-file", audit: "hil-log", retention: "hil-log", incident: "hil-log",
  dr: "hil-log", segregation: "hil-log", training: "hil-log", attestation: "hil-log",
  help: "help-snapshot", "api-diff": "api-diff", eval: "eval", "plan-diff": "plan",
  "device-capture": "device-capture",
};

let policyText = "version: 1\ntier: prototype\nprofile: web\n\ntiers:\n";
// placeholder, tiers/profiles/checks are appended below

for (const [tier, ids] of Object.entries(TIER_CHECKS)) {
  policyText += `  ${tier}:\n    checks: [${ids.join(", ")}]\n`;
}
policyText += "\nprofiles:\n";
for (const [profile, ids] of Object.entries(PROFILE_CHECKS)) {
  policyText += `  ${profile}:\n    checks: [${ids.join(", ")}]\n`;
}
policyText += "\nchecks:\n";
for (const [id, kind] of Object.entries(KIND)) {
  const phase = id === "tests" ? 2 : id === "run" ? 5 : id === "review" ? 6 : 1;
  const command = id === "review" ? "null" : id === "tests" ? "npm test" : id === "run" ? "npm run dev" : `npm run ${id}`;
  policyText += `  ${id}:\n    phase: ${phase}\n    kind: ${kind}\n    command: ${command}\n`;
}
writeFileSync(policyPath, policyText);

console.log("\nfull policy");
const policy = loadPolicy(root);
check("loadPolicy reads config/factory.policy.yaml", policy !== null && policy.version === 1);
check("prototype has three checks", policy.tiers.prototype.checks.length === 3, String(policy.tiers.prototype.checks.length));
check("regulated has twenty checks", policy.tiers.regulated.checks.length === 20, String(policy.tiers.regulated.checks.length));
check("a null command stays null", policy.checks.review.command === null);
check("nested block parses to the right shape",
  JSON.stringify(policy.checks.tests) === JSON.stringify({ phase: 2, kind: "check-output", command: "npm test" }),
  JSON.stringify(policy.checks.tests));

console.log("\ninline lists");
check("an inline empty list is []", JSON.stringify(parseYamlSubset("a:\n  checks: []\n", "f").a.checks) === "[]");
check("an inline list of scalars parses", JSON.stringify(parseYamlSubset("a: [x, y]\n", "f").a) === JSON.stringify(["x", "y"]));
check("a block list under an empty key parses",
  JSON.stringify(parseYamlSubset("a:\n  b:\n    - x\n    - y\n", "f")) === JSON.stringify({ a: { b: ["x", "y"] } }));
check("a block list yields typed items",
  JSON.stringify(parseYamlSubset("a:\n  - 1\n  - true\n", "f")) === JSON.stringify({ a: [1, true] }));

console.log("\ncomments");
const cmt = parseYamlSubset("command: npm test # fast\n# whole line\na: a#b\n", "f");
check("a trailing comment is stripped", cmt.command === "npm test", cmt.command);
check("a comment-only line is skipped", !("whole" in cmt));
check("a hash inside a token is kept", cmt.a === "a#b", String(cmt.a));

console.log("\ntyped scalars");
const typed = parseYamlSubset("t: true\nf: false\nn: -3\nz: null\ns: hello world\n", "f");
check("true is a boolean", typed.t === true);
check("false is a boolean", typed.f === false);
check("-3 is a number", typed.n === -3);
check("null is null", typed.z === null);
check("a plain string is verbatim", typed.s === "hello world");

console.log("\nloadPolicy and overrides");
const bare = mkdtempSync(join(tmpdir(), "factory-policy-bare-"));
check("an absent policy file returns null", loadPolicy(bare) === null);
mkdirSync(join(bare, "config"), { recursive: true });
writeFileSync(join(bare, "config", "factory.policy.yaml"), policyText);
check("a written policy file is read", loadPolicy(bare) !== null);

const overridePath = join(bare, "elsewhere.yaml");
writeFileSync(overridePath, "version: 1\ntiers:\n  prototype:\n    checks: []\nprofiles:\n  web:\n    checks: []\nchecks:\ntier: prototype\nprofile: web\n");
const overridden = loadPolicy(root, overridePath);

console.log("\nloadPolicy edge cases");
check("a missing override is refused with its path in the message", (() => {
  try { loadPolicy(root, join(bare, "nope.yaml")); return false; }
  catch (e) { return e instanceof PolicyError && /nope\.yaml/.test(e.message); }
})());
check("an explicit override path is read", overridden.tiers.prototype.checks.length === 0);

console.log("\neffectiveChecks");
const eff = effectiveChecks(policy, { tier: "public", profile: "web" });
check("public+web dedupes a11y and perf", eff.checks.length === 13, String(eff.checks.length));
check("tier ids come first", eff.checks[0] === "tests" && eff.checks.slice(0, 13).join(",") === TIER_CHECKS.public.join(","));
check("prototype+web is five", effectiveChecks(policy, { tier: "prototype", profile: "web" }).checks.length === 5);
check("metadata tier beats the file default",
  effectiveChecks(policy, { tier: "regulated", profile: "api" }).tier === "regulated");
check("metadata profile beats the file default",
  effectiveChecks(policy, { tier: "regulated", profile: "api" }).profile === "api");
check("an undeclared metadata tier is refused", (() => {
  try { effectiveChecks(policy, { tier: "nope", profile: "web" }); return false; }
  catch (e) { return e instanceof PolicyError && /tier "nope" is not declared/.test(e.message); }
})());

console.log("\nrequiredForPhase");
const seven = requiredForPhase(policy, { tier: "regulated", profile: "web" }, "7");
check("phase 7 returns only phase-7 ids", seven.every((id) => policy.checks[id].phase === 7));
check("phase 7 is found when declared", (() => {
  const p2 = parseYamlSubset(policyText, policyPath);
  p2.checks.audit.phase = 7;
  return requiredForPhase(p2, { tier: "regulated", profile: "web" }, "7").includes("audit");
})());
check("phase 7 from prototype+web is empty", requiredForPhase(policy, {}, "7").length === 0);

console.log("\nvalidation");
const bad = mkdtempSync(join(tmpdir(), "factory-policy-bad-"));
mkdirSync(join(bad, "config"), { recursive: true });
const badPath = join(bad, "config", "factory.policy.yaml");
function expect(name, text, pattern, file = badPath) {
  writeFileSync(file, text);
  try {
    const p = parseYamlSubset(readFileSync(file, "utf8"), file);
    validatePolicy(p, file);
    check(name, false, "no error thrown");
  } catch (e) {
    check(name, e instanceof PolicyError && pattern.test(e.message), e.message);
  }
}

expect("an undeclared check reference names the id and the section",
  "version: 1\ntiers:\n  prototype:\n    checks: [ghost]\nprofiles:\n  web:\n    checks: []\nchecks:\n",
  /check "ghost" is referenced by tiers\.prototype\.checks but not declared/);
expect("an undeclared profile reference names the id and the section",
  "version: 1\ntiers:\n  prototype:\n    checks: []\nprofiles:\n  web:\n    checks: [ghost]\nchecks:\n",
  /check "ghost" is referenced by profiles\.web\.checks but not declared/);
expect("version must be 1",
  "version: 2\ntiers:\nprofiles:\nchecks:\n", /version must be 1/);
expect("an unknown kind is refused",
  "version: 1\ntiers:\n  prototype:\n    checks: [x]\nprofiles:\n  web:\n    checks: []\nchecks:\n  x:\n    phase: 2\n    kind: telepathy\n    command: null\n",
  /check "x" has kind "telepathy", which is not one of the sixteen kinds/);
expect("a phase of 9 is refused",
  "version: 1\ntiers:\n  prototype:\n    checks: [x]\nprofiles:\n  web:\n    checks: []\nchecks:\n  x:\n    phase: 9\n    kind: prr\n    command: null\n",
  /check "x" has phase 9/);

console.log("\nrefusals name the line");
function refuse(name, text, pattern, line) {
  const file = badPath;
  writeFileSync(file, text);
  try {
    parseYamlSubset(readFileSync(file, "utf8"), file);
    check(name, false, "no error thrown");
  } catch (e) {
    const want = `${file}:${line}: `;
    check(name, e instanceof PolicyError && e.message.startsWith(want) && pattern.test(e.message),
      e.message);
  }
}
refuse("a tab is refused at its line", "a: 1\n\tb: 2\n", /tabs are not allowed/, 2);
refuse("a tab inside a value is refused at its line", "a: 1\nb: x\ty\n", /tabs are not allowed/, 2);
refuse("a brace map is refused at its line", "a: 1\nb: {x: 1}\n", /"\{"/, 2);
refuse("a literal block is refused at its line", "a: 1\nb: |\n", /"\|"/, 2);
refuse("a quote is refused at its line", "a: 1\nb: 'x'\n", /"'"/, 2);
refuse("a double quote is refused at its line", "a: 1\nb: \"x\"\n", /"""/, 2);
refuse("an anchor is refused at its line", "a: 1\nb: *x\n", /"\*"/, 2);
refuse("an alias ampersand is refused at its line", "a: 1\nb: &x\n", /"&"/, 2);
refuse("a four-space child is refused at its line", "a:\n    b: 1\n", /indentation jumps from 0 to 4/, 2);
refuse("a three-space indent is refused at its line", "a:\n   b: 1\n", /multiple of two spaces/, 2);
refuse("a missing colon is refused at its line", "a: 1\njust words\n", /expected "key: value"/, 2);
refuse("a duplicate key is refused at its line", "a: 1\na: 2\n", /duplicate key "a"/, 2);
refuse("a list under a scalar key is refused at its line", "a: 1\n  - x\n", /"a" is already a scalar, so it cannot take a list/, 2);
check("every refusal is a PolicyError named at file:line", (() => {
  writeFileSync(badPath, "a: 1\n\tb: 2\n");
  try { parseYamlSubset(readFileSync(badPath, "utf8"), badPath); return false; }
  catch (e) { return e.name === "PolicyError"; }
})());

console.log("\nno partial policy, no cached state");
check("a malformed file throws and a fixed file recovers", (() => {
  writeFileSync(policyPath, "version: 1\ntier: prototype\ntier: prototype\n");
  let threw = false;
  try { loadPolicy(root); } catch (e) { threw = e instanceof PolicyError; }
  if (!threw) return false;
  writeFileSync(policyPath, policyText);
  const fixed = loadPolicy(root);
  return fixed !== null && fixed.tiers.regulated.checks.length === 20;
})());
check("an empty block at EOF is an empty map",
  JSON.stringify(parseYamlSubset("a:\n", "f")) === JSON.stringify({ a: {} }));

rmSync(root, { recursive: true, force: true });
rmSync(bare, { recursive: true, force: true });
rmSync(bad, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} policy tests passed.`);
process.exit(fail ? 1 : 0);
