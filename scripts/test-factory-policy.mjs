import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PolicyError, parseYamlSubset, loadPolicy, effectiveChecks, requiredForPhase, validatePolicy,
  DECLARABLE_KINDS,
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

console.log("\nclosed vocabulary");
// One list, two readers: the policy validates declarations against it and
// factory-attest derives what it accepts from it. This pins the list itself so
// neither side can quietly grow a kind the other has never heard of.
check("the policy exports the vocabulary", Array.isArray(DECLARABLE_KINDS) && DECLARABLE_KINDS.length > 0);
check("the vocabulary has no duplicates",
  new Set(DECLARABLE_KINDS).size === DECLARABLE_KINDS.length,
  `${DECLARABLE_KINDS.length} entries, ${new Set(DECLARABLE_KINDS).size} distinct`);
const vocabRoot = mkdtempSync(join(tmpdir(), "factory-policy-vocab-"));
mkdirSync(join(vocabRoot, "config"), { recursive: true });
let vocabText = "version: 1\ntiers:\n  prototype:\n    checks: [" +
  DECLARABLE_KINDS.map((_, i) => `k${i}`).join(", ") + "]\nprofiles:\n  web:\n    checks: []\nchecks:\n";
DECLARABLE_KINDS.forEach((kind, i) => {
  vocabText += `  k${i}:\n    phase: 3\n    kind: ${kind}\n    command: null\n`;
});
writeFileSync(join(vocabRoot, "config", "factory.policy.yaml"), vocabText);
let vocabErr = null;
try { loadPolicy(vocabRoot); } catch (e) { vocabErr = e.message; }
check("a policy may declare every kind in the vocabulary", vocabErr === null, String(vocabErr));
rmSync(vocabRoot, { recursive: true, force: true });

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

const dirRoot = mkdtempSync(join(tmpdir(), "factory-policy-dir-"));
mkdirSync(join(dirRoot, "config", "factory.policy.yaml"), { recursive: true });
check("a directory at the policy path is refused as unreadable", (() => {
  try { loadPolicy(dirRoot); return false; }
  catch (e) { return e instanceof PolicyError && /factory\.policy\.yaml: cannot read the policy file \(EISDIR\)/.test(e.message); }
})());

console.log("\neffectiveChecks");
const eff = effectiveChecks(policy, { tier: "public", profile: "web" });
check("public+web dedupes a11y and perf", eff.checks.length === 13, String(eff.checks.length));
check("tier ids come first", eff.checks[0] === "tests" && eff.checks.slice(0, 13).join(",") === TIER_CHECKS.public.join(","));
check("prototype+web is five", effectiveChecks(policy, { tier: "prototype", profile: "web" }).checks.length === 5);
check("metadata tier beats the file default",
  effectiveChecks(policy, { tier: "regulated", profile: "api" }).tier === "regulated");
check("metadata profile beats the file default",
  effectiveChecks(policy, { tier: "regulated", profile: "api" }).profile === "api");
check("an undeclared metadata tier is refused, naming the legal tiers", (() => {
  try { effectiveChecks(policy, { tier: "nope", profile: "web" }); return false; }
  catch (e) {
    return e instanceof PolicyError &&
      /tier "nope" is not declared under tiers; declared: prototype, internal, public, regulated$/.test(e.message);
  }
})());
check("an undeclared metadata profile is refused, naming the legal profiles", (() => {
  try { effectiveChecks(policy, { tier: "prototype", profile: "nope" }); return false; }
  catch (e) {
    return e instanceof PolicyError &&
      /profile "nope" is not declared under profiles; declared: web, api, cli, library, mobile, desktop, data-ml, infra, embedded, game$/.test(e.message);
  }
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
  /check "x" has kind "telepathy", which is not one of the known kinds/);
expect("a phase of 9 is refused, naming the allowed phase ids",
  "version: 1\ntiers:\n  prototype:\n    checks: [x]\nprofiles:\n  web:\n    checks: []\nchecks:\n  x:\n    phase: 9\n    kind: prr\n    command: null\n",
  /check "x" has phase 9, which is not a phase; allowed phase ids are 0, 1, 2, 3, 4, 4p, 5, 6, 7, 8$/);
expect("a phase id the machine does not know is refused, naming the allowed phase ids",
  "version: 1\ntiers:\n  prototype:\n    checks: [x]\nprofiles:\n  web:\n    checks: []\nchecks:\n  x:\n    phase: x\n    kind: prr\n    command: null\n",
  /check "x" has phase "x", which is not a phase; allowed phase ids are 0, 1, 2, 3, 4, 4p, 5, 6, 7, 8$/);
expect("a check with no phase is refused, in the checklist's own voice",
  "version: 1\ntiers:\n  prototype:\n    checks: [x]\nprofiles:\n  web:\n    checks: []\nchecks:\n  x:\n    kind: prr\n    command: null\n",
  /check "x" has no phase; every check gates a phase \(0-8, or 4p\)/);
expect("an unknown top-level profile is still refused",
  "version: 1\ntier: prototype\nprofile: nope\ntiers:\n  prototype:\n    checks: []\nprofiles:\n  web:\n    checks: []\nchecks:\n",
  /profile "nope" is not declared under profiles/);

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

// The milestone's exit criterion is arithmetic: ONE policy file, and
// `prototype` requires exactly 3 checks while `regulated` requires exactly
// 20. These assertions pin both numbers against a single parsed object.
console.log("\ntier arithmetic: one policy file, prototype 3, regulated 20");
const ARITHMETIC = `version: 1
tier: prototype
profile: web

tiers:
  prototype:
    checks: [tests, run, review]
  internal:
    checks: [tests, run, review, lint, types, contract]
  public:
    checks: [tests, run, review, lint, types, contract, a11y, perf, security, migration, rollback, observability, privacy]
  regulated:
    checks: [tests, run, review, lint, types, contract, a11y, perf, security, migration, rollback, observability, privacy, audit, retention, incident, dr, segregation, training, attestation]

profiles:
  web:
    checks: [a11y, perf]

checks:
  tests:
    phase: 2
    kind: check-output
    command: npm test
  run:
    phase: 5
    kind: transcript
    command: npm run dev
  review:
    phase: 7
    kind: prr
    command: null
  lint:
    phase: 2
    kind: check-output
    command: npm run lint
  types:
    phase: 2
    kind: check-output
    command: npm run typecheck
  contract:
    phase: 3
    kind: contract
    command: npm run contract
  a11y:
    phase: 6
    kind: check-output
    command: npm run a11y
  perf:
    phase: 6
    kind: check-output
    command: npm run perf
  security:
    phase: 6
    kind: check-output
    command: npm run security
  migration:
    phase: 4
    kind: golden-file
    command: npm run migration
  rollback:
    phase: 4
    kind: golden-file
    command: npm run rollback
  observability:
    phase: 5
    kind: check-output
    command: npm run observability
  privacy:
    phase: 7
    kind: prr
    command: null
  audit:
    phase: 7
    kind: prr
    command: null
  retention:
    phase: 7
    kind: plan
    command: null
  incident:
    phase: 8
    kind: plan
    command: null
  dr:
    phase: 8
    kind: plan
    command: null
  segregation:
    phase: 7
    kind: plan
    command: null
  training:
    phase: 8
    kind: hil-log
    command: null
  attestation:
    phase: 8
    kind: check-output
    command: npm run attestation
`;
const ARITH_IDS = [
  "tests", "run", "review", "lint", "types", "contract", "a11y", "perf",
  "security", "migration", "rollback", "observability", "privacy", "audit",
  "retention", "incident", "dr", "segregation", "training", "attestation",
];
// One parse of the fixture is the object every assertion below reads.
const arith = validatePolicy(parseYamlSubset(ARITHMETIC, "fixture"), "fixture");

const arithPrototype = arith.tiers.prototype.checks;
check("the prototype tier requires exactly three checks, ids in order",
  arithPrototype.length === 3 && arithPrototype.join(",") === "tests,run,review",
  JSON.stringify(arithPrototype));

const arithRegulated = arith.tiers.regulated.checks;
check("the regulated tier requires exactly twenty checks",
  arithRegulated.length === 20 &&
  JSON.stringify([...arithRegulated].sort()) === JSON.stringify([...ARITH_IDS].sort()),
  JSON.stringify(arithRegulated));

check("both numbers come from the same parsed file",
  arith.tiers.prototype !== undefined && arith.tiers.regulated !== undefined &&
  (() => { const again = parseYamlSubset(ARITHMETIC, "fixture");
    return again.tiers.prototype.checks.length === arithPrototype.length &&
      again.tiers.regulated.checks.length === arithRegulated.length; })(),
  `${arithPrototype.length} and ${arithRegulated.length}`);

// The profile union does not change the tier arithmetic: prototype+web is five
// because the web profile adds a11y and perf to the tier's three. That way of
// counting lives in effectiveChecks, which is exactly why the 3-vs-20 claim
// above is made on policy.tiers, not on effectiveChecks.
const arithProfiled = effectiveChecks(arith, { tier: "prototype", profile: "web" });
check("the profile union does not change the tier arithmetic (3 tier + 2 profile dedupe to 5)",
  arithProfiled.checks.length === 5 &&
  arithProfiled.checks.join(",") === "tests,run,review,a11y,perf",
  JSON.stringify(arithProfiled.checks));

const arithMeta = effectiveChecks(arith, { tier: "regulated" });
check("a bead's metadata overrides the file's tier (regulated via metadata, 20 unique ids)",
  arithMeta.tier === "regulated" && arithMeta.checks.length === 20 &&
  new Set(arithMeta.checks).size === 20,
  JSON.stringify(arithMeta.checks));

check("an unknown tier is refused naming the legal values", (() => {
  try { effectiveChecks(arith, { tier: "payments" }); return false; }
  catch (e) {
    return e instanceof PolicyError && e.message.includes("payments") &&
      e.message.includes("is not declared under tiers; declared: prototype, internal, public, regulated");
  }
})(), (() => { try { effectiveChecks(arith, { tier: "payments" }); return ""; }
  catch (e) { return e.message; } })());

// M2a: the shipped example policy is a real policy. The ten profiles from
// docs/factory-domain-profiles.md live there as data, and the parser's own
// guarantee - every profile check id is declared - is proven against the real
// file, not a fixture shaped like it.
console.log("\nprofiles: the example policy is a real policy");
const EXAMPLE = fileURLToPath(new URL("../config/factory.policy.example.yaml", import.meta.url));
const example = loadPolicy(root, EXAMPLE);
const EXAMPLE_PROFILES = ["web", "api", "cli", "library", "infra", "mobile", "desktop", "embedded", "game", "data-ml"];
check("config/factory.policy.example.yaml parses with loadPolicy",
  example !== null && example.version === 1);
check("the example declares exactly ten profiles",
  example !== null && JSON.stringify(Object.keys(example.profiles)) === JSON.stringify(EXAMPLE_PROFILES),
  JSON.stringify(Object.keys(example.profiles)));
check("each of the ten profiles names at least one check",
  example !== null && EXAMPLE_PROFILES.every((p) =>
    Array.isArray(example.profiles[p].checks) && example.profiles[p].checks.length >= 1));
check("every check id named by every profile is declared under checks (the parser's own guarantee, on the real file)",
  example !== null && EXAMPLE_PROFILES.every((p) =>
    example.profiles[p].checks.every((id) => Object.prototype.hasOwnProperty.call(example.checks, id))));
check("the example's new checks are declared with kinds and phases the parser accepts",
  example !== null && example.checks.visual.kind === "screenshot" &&
  example.checks["plan-diff"].phase === 5 &&
  example.checks["data-quality"].kind === "data-quality");

const exWeb = effectiveChecks(example, { tier: "prototype", profile: "web" });
check("prototype+web unions to exactly six unique ids (3 tier + 3 profile, no overlap)",
  exWeb.checks.length === 6 && exWeb.checks.join(",") === "tests,run,review,a11y,perf,visual",
  JSON.stringify(exWeb.checks));
const exApi = effectiveChecks(example, { tier: "prototype", profile: "api" });
check("prototype+api unions to exactly six unique ids (contract is profile-only at this tier)",
  exApi.checks.length === 6 && exApi.checks.join(",") === "tests,run,review,contract,authz,load",
  JSON.stringify(exApi.checks));
const exInfra = effectiveChecks(example, { tier: "prototype", profile: "infra" });
check("prototype+infra unions to exactly six unique ids (rollback is not in prototype, so no overlap)",
  exInfra.checks.length === 6 && exInfra.checks.join(",") === "tests,run,review,plan-diff,policy-check,rollback",
  JSON.stringify(exInfra.checks));
const exPublic = effectiveChecks(example, { tier: "public", profile: "web" });
check("public+web unions without duplicates (length equals the distinct-id count)",
  exPublic.checks.length === 14 &&
  JSON.stringify([...new Set(exPublic.checks)]) === JSON.stringify(exPublic.checks),
  `${exPublic.checks.length} total, ${new Set(exPublic.checks).size} distinct`);
check("the dedupe keeps tier ids first and appends only web's new visual",
  exPublic.checks.slice(0, 13).join(",") === TIER_CHECKS.public.join(",") &&
  exPublic.checks[13] === "visual",
  JSON.stringify(exPublic.checks));

rmSync(root, { recursive: true, force: true });
rmSync(bare, { recursive: true, force: true });
rmSync(bad, { recursive: true, force: true });
rmSync(dirRoot, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} policy tests passed.`);
process.exit(fail ? 1 : 0);
