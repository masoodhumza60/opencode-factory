// Tests for `factory-review start | record | show`: the reviewer's side of
// M1b. The suite drives the real commands as child processes in a throwaway
// sandbox - git repo with one commit, its own beads workspace (BEADS_DIR
// pointed at it, exactly as the attest suite does), a manifest produced by
// actually running factory-attest.mjs attest, and a policy file - and reads
// the package, scope, manifest and trail the commands leave behind. Refusal
// cases sweep the same way, checking exit code 1 and the message from stderr
// (the status comes from the child's exit code, never from stdout parsing).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { sha256File, loadManifest, readTrail } from "./factory-manifest.mjs";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const HERE = dirname(fileURLToPath(import.meta.url));
// The absolute path matters: the runner pins the child's cwd to the sandbox,
// so a relative "scripts/factory-review.mjs" resolves INSIDE the sandbox and
// dies with MODULE_NOT_FOUND.
const REVIEW_SCRIPT = resolve(join(HERE, "factory-review.mjs"));
const ATTEST_SCRIPT = resolve(join(HERE, "factory-attest.mjs"));

// Copied from test-factory-attest.mjs rather than imported: a test suite is
// not a library, and importing that suite would run its 90-plus assertions
// again inside this sandbox. bd holds its embedded dolt database a moment
// after the last child exits, so the first removal may fail with EPERM; one
// waiting retry, and a leftover throwaway temp directory is a note, not a
// test result.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function rmSandbox(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (first) {
    sleep(250);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (second) {
      console.log(`  cleanup warning: ${dir} left behind (${(second && second.code) || second.message})`);
    }
  }
}

const git = (args, cwd, env) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), "factory-review-"));
  const env = { ...process.env, BEADS_DIR: join(sandbox, ".beads") };
  // The role and the session are delegated per case here; whatever the parent
  // environment carries must not leak into a reviewer or builder decision.
  delete env.FACTORY_SESSION;
  delete env.FACTORY_ROLE;
  execFileSync("git", ["-c", "core.autocrlf=false", "init"], { cwd: sandbox, env, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
    { cwd: sandbox, env, stdio: "ignore" });
  execFileSync("bd", ["init"], { cwd: sandbox, env, stdio: "ignore" });
  return { sandbox, env };
}

function makeBead({ sandbox, env }, title) {
  const out = execFileSync("bd", ["create", title, "--json"], { cwd: sandbox, env, encoding: "utf8" });
  return JSON.parse(out).id;
}

// Commit everything in the sandbox, so the porcelain snapshot `review start`
// takes is empty and any later delta is a change somebody made on purpose.
function commitAll(sb, message) {
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "-A"], { cwd: sb.sandbox, env: sb.env, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message],
    { cwd: sb.sandbox, env: sb.env, stdio: "ignore" });
}

// Run one of this repo's scripts as a child and normalise the outcome to
// { status, stdout, stderr } so refusals read as data, not exceptions. The
// status is the child's own exit code; the messages are read from stderr.
function runScript(sb, script, argv, extraEnv = {}) {
  const childEnv = { ...sb.env, ...extraEnv };
  try {
    const stdout = execFileSync("node", [script, ...argv], { cwd: sb.sandbox, env: childEnv, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status == null ? -1 : e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
  }
}
const review = (sb, argv, extraEnv) => runScript(sb, REVIEW_SCRIPT, argv, extraEnv);
const attest = (sb, argv, extraEnv) => runScript(sb, ATTEST_SCRIPT, ["attest", ...argv], extraEnv);

const manifestOf = (sb, bead) => loadManifest(sb.sandbox, bead);
const trailOf = (sb, bead) => readTrail(sb.sandbox, bead);

const POLICY =
  "version: 1\ntier: prototype\nprofile: web\n" +
  "\ntiers:\n" +
  "  prototype:\n    checks: [tests, review]\n" +
  "  internal:\n    checks: []\n" +
  "  public:\n    checks: []\n" +
  "  regulated:\n    checks: []\n" +
  "\nprofiles:\n" +
  "  web:\n    checks: []\n" +
  "\nchecks:\n" +
  "  tests:\n" +
  "    phase: 7\n" +
  "    kind: check-output\n" +
  "    command: npm test\n" +
  "  review:\n" +
  "    phase: 7\n" +
  "    kind: prr\n" +
  "    command: null\n";

// A sentence of builder narrative that must NOT reach the package: the
// reviewer is given evidence, not the story about the evidence.
const NARRATIVE =
  "REVIEW-SUITE-NARRATIVE-MARKER: the builder says everything works, " +
  "so there is nothing to look at. Signed, the build agent.";

// One sandbox for the whole suite: a git repo with one init commit, its own
// beads workspace, a policy file, and beads. The manifest is never written by
// hand - every builder session here is produced by actually running attest.
const sand = makeSandbox();
// bd init commits the .beads workspace on top of the empty init commit, so
// the repository carries both before anything else runs. The root commit is
// what `start` without --base can fall back to; the empty-commit HEAD is just
// the first commit this suite's setup stepped on.
const initSha = git(["rev-parse", "HEAD"], sand.sandbox, sand.env);
const rootSha = git(["rev-list", "--max-parents=0", "HEAD"], sand.sandbox, sand.env);
const bead = makeBead(sand, "review target");
const beadUnattested = makeBead(sand, "never attested bead");
const beadNoStart = makeBead(sand, "attested but unstarted bead");

mkdirSync(join(sand.sandbox, "config"), { recursive: true });
writeFileSync(join(sand.sandbox, "config", "factory.policy.yaml"), POLICY);
mkdirSync(join(sand.sandbox, "out"), { recursive: true });
writeFileSync(join(sand.sandbox, "out", "log.txt"), "npm test -> 7 passed\n");
mkdirSync(join(sand.sandbox, ".superpowers", "sdd", bead), { recursive: true });
writeFileSync(join(sand.sandbox, ".superpowers", "sdd", bead, "task-report.md"), NARRATIVE);
commitAll(sand, "the builder ships evidence and a narrative only it should read");

// attest the setup. The session that touches the manifest first is frozen as
// the builder, so every later independence decision compares against build-A.
const att = attest(sand, [bead, "out/log.txt", "--id", "tests", "--kind", "check-output"],
  { FACTORY_SESSION: "build-A" });
if (att.status !== 0) throw new Error(`setup: attest failed: ${att.stdout}${att.stderr}`);

// A second bead that has been attested but never had a review start: the
// "run review start first" refusal needs exactly this shape. It gets its own
// builder session so its refusal is not shadowed by anything about `bead`.
writeFileSync(join(sand.sandbox, "out", "other.txt"), "a second artifact\n");
commitAll(sand, "the second artifact");
const att2 = attest(sand, [beadNoStart, "out/other.txt", "--id", "tests", "--kind", "check-output"],
  { FACTORY_SESSION: "build-C" });
if (att2.status !== 0) throw new Error(`setup: attest for the unstarted bead failed: ${att2.stdout}${att2.stderr}`);

console.log("\nstart");
let r = review(sand, ["start", beadUnattested]);
check("1 start with nothing attested is refused, naming the bead",
  r.status === 1 && r.stderr.includes(`no manifest for ${beadUnattested}`) &&
  r.stderr.includes("nothing has been attested"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

// HEAD has moved past the product commit (the second artifact came later), so
// the range under review at this start runs from the init commit to now.
const headAtStart = git(["rev-parse", "HEAD"], sand.sandbox, sand.env);
r = review(sand, ["start", bead, "--base", initSha, "--phase", "7"]);
check("2 start exits 0 with an explicit base",
  r.status === 0 && r.stdout.includes(".factory/" + bead + "/review-package.md"),
  `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
const packagePath = join(sand.sandbox, ".factory", bead, "review-package.md");
const pkg = readFileSync(packagePath, "utf8");
check("2 the package states the commit range both ends included",
  pkg.includes(`Base: ${initSha}`) && pkg.includes(`Head: ${headAtStart}`), `Base/Head in:\n${pkg.slice(0, 400)}`);
check("2 the package carries the diff --stat summary",
  pkg.includes("out/log.txt") && pkg.includes("files changed"), `stat in package: ${JSON.stringify(pkg.slice(0, 600))}`);
check("2 the package carries the attested artifact table with id, kind and sha256",
  pkg.includes("`tests`") && pkg.includes("check-output") && pkg.includes("sha256"),
  JSON.stringify(pkg.match(/## Attested artifacts[\s\S]{0,400}/)));
check("2 the package lists the policy's checks when a policy file exists",
  pkg.includes("npm test") && pkg.includes("`review`"), JSON.stringify(pkg.match(/## What the policy requires[\s\S]{0,400}/)));
check("2 the package contains no text from the task report or .superpowers/",
  !pkg.includes(NARRATIVE) && !pkg.includes("REVIEW-SUITE-NARRATIVE-MARKER") &&
  !pkg.includes("task-report.md") && !pkg.includes(".superpowers"),
  `package leaked the narrative (or .superpowers path): "${pkg.slice(0, 200)}"`);

const scopePath = join(sand.sandbox, ".factory", bead, "review-scope.json");
const scope = JSON.parse(readFileSync(scopePath, "utf8"));
check("3 review-scope.json names the bead and the frozen head",
  scope.bead === bead && scope.head === headAtStart && Array.isArray(scope.status),
  JSON.stringify({ bead: scope.bead, head: scope.head }));
const startTrail = trailOf(sand, bead).filter((e) => e.event === "review_started");
check("3 the trail appends one review_started with the package sha256 and head",
  startTrail.length === 1 && startTrail[0].package_sha256 === sha256File(packagePath) &&
  startTrail[0].head === headAtStart,
  JSON.stringify(startTrail));

console.log("\nrecord: the refusals, in the plan's order");
r = review(sand, ["record", bead, "--file", `out/log.txt`, "--verdict", "pass"]);
check("4 record with no FACTORY_ROLE is refused, naming FACTORY_ROLE=reviewer",
  r.status === 1 && r.stderr.includes("FACTORY_ROLE=reviewer"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
r = review(sand, ["record", bead, "--file", `out/log.txt`, "--verdict", "pass"],
  { FACTORY_ROLE: "builder", FACTORY_SESSION: "review-S1" });
check("4 record as FACTORY_ROLE=builder is refused the same way",
  r.status === 1 && r.stderr.includes("FACTORY_ROLE=reviewer"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

r = review(sand, ["record", bead, "--file", `out/log.txt`, "--verdict", "pass"], { FACTORY_ROLE: "reviewer" });
check("5 a reviewer with no FACTORY_SESSION is refused",
  r.status === 1 && r.stderr.includes("a reviewer must be named"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

r = review(sand, ["record", bead, "--file", `out/log.txt`, "--verdict", "pass"],
  { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "build-A" });
check("6 a reviewer whose session is the frozen builder is refused",
  r.status === 1 && r.stderr.includes("the reviewer session is the builder session"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

r = review(sand, ["record", beadNoStart, "--file", `.factory/${beadNoStart}/review.md`, "--verdict", "pass"],
  { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "review-S2" });
check("7 record with no review start is refused, naming the bead and the fix",
  r.status === 1 && r.stderr.includes(`no review package for ${beadNoStart}`) &&
  r.stderr.includes("run review start first"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

r = review(sand, ["record", bead, "--file", "out/log.txt", "--verdict", "pass"],
  { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "review-S1" });
check("8 --file outside .factory/<bead>/ is refused: the reviewer writes only its verdict file",
  r.status === 1 && r.stderr.includes("a reviewer writes only its own verdict file") &&
  r.stderr.includes("out/log.txt"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

// Now --file points at the verdict file, which says `Verdict: changes`, while
// the flag says pass: the file is the record, so they must disagree loudly.
writeFileSync(join(sand.sandbox, ".factory", bead, "review.md"), "Verdict: changes\n\nA finding.\n");
r = review(sand, ["record", bead, "--file", `.factory/${bead}/review.md`, "--verdict", "pass"],
  { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "review-S1" });
check("9 --verdict pass against a file saying changes is refused",
  r.status === 1 && r.stderr.includes("the verdict flag does not match the file"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

// A product file modified after start: the scope snapshot was empty, so the
// ` M` line is a change outside the verdict.
writeFileSync(join(sand.sandbox, "out", "log.txt"), "npm test -> 7 passed\nTAMPERED AFTER START\n");
r = review(sand, ["record", bead, "--file", `.factory/${bead}/review.md`, "--verdict", "changes"],
  { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "review-S1" });
check("10 a product file modified after start is refused, naming the path",
  r.status === 1 && r.stderr.includes("the reviewer changed files outside its verdict") &&
  r.stderr.includes("out/log.txt"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
writeFileSync(join(sand.sandbox, "out", "log.txt"), "npm test -> 7 passed\n");
const tampered = trailOf(sand, bead);
check("10 the refused record wrote no review event and no artifact",
  tampered.filter((e) => e.event === "review").length === 0 &&
  manifestOf(sand, bead).artifacts.every((a) => a.id !== "review"),
  JSON.stringify(manifestOf(sand, bead).artifacts.map((a) => a.id)));

// A commit after start makes the package stale - the verdict would describe
// a tree nobody shipped.
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "a later commit"],
  { cwd: sand.sandbox, env: sand.env, stdio: "ignore" });
const newHead = git(["rev-parse", "HEAD"], sand.sandbox, sand.env);
r = review(sand, ["record", bead, "--file", `.factory/${bead}/review.md`, "--verdict", "changes"],
  { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "review-S1" });
check("11 a new commit after start leaves the package stale",
  r.status === 1 && r.stderr.includes("the package is stale") && r.stderr.includes("run review start again"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

// Back to a current package: a fresh start, now deliberately without --base
// (the plan's signature leaves it optional), then a clean record.
writeFileSync(join(sand.sandbox, ".factory", bead, "review.md"), "Verdict: pass\n\nChecked the package; the diff matches the artifacts.\n");
r = review(sand, ["start", bead, "--phase", "7"]);
check("12 start without --base falls back to the root commit and exits 0",
  r.status === 0 && JSON.parse(readFileSync(scopePath, "utf8")).base === rootSha,
  `status=${r.status} stderr=${JSON.stringify(r.stderr)} base=${JSON.stringify(JSON.parse(readFileSync(scopePath, "utf8")).base)} root=${rootSha}`);
r = review(sand, ["record", bead, "--file", `.factory/${bead}/review.md`, "--verdict", "pass"],
  { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "review-S1" });
check("12 a clean record exits 0",
  r.status === 0 && r.stdout.includes("recorded review"),
  `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
let artifactsNow = manifestOf(sand, bead).artifacts;
const reviewArt = artifactsNow.find((a) => a.id === "review") ?? null;
const verdictSha = sha256File(join(sand.sandbox, ".factory", bead, "review.md"));
check("12 the artifact is id review, kind prr, verdict pass, reviewer session recorded",
  reviewArt !== null && reviewArt.kind === "prr" && reviewArt.verdict === "pass" &&
  reviewArt.reviewer_session === "review-S1" && artifactsNow.length === 2 &&
  manifestOf(sand, bead).artifacts.filter((a) => a.id === "review").length === 1,
  JSON.stringify(artifactsNow));
check("12 the artifact carries the verdict file's hash and the head it was recorded at",
  reviewArt !== null && reviewArt.sha256 === verdictSha && reviewArt.commit === newHead,
  `sha ${reviewArt && reviewArt.sha256} vs ${verdictSha} commit ${reviewArt && reviewArt.commit} vs ${newHead}`);
let revTrail = trailOf(sand, bead).filter((e) => e.event === "review");
check("12 the trail appends one review event with verdict, reviewer, builder and commit",
  revTrail.length === 1 && revTrail[0].verdict === "pass" && revTrail[0].reviewer_session === "review-S1" &&
  revTrail[0].builder_session === "build-A" && revTrail[0].commit === newHead,
  JSON.stringify(revTrail));

// A second record replaces the artifact rather than stacking a second one.
writeFileSync(join(sand.sandbox, ".factory", bead, "review.md"),
  "Verdict: pass\n\nChecked the package; the diff matches the artifacts.\nRe-read after a stale-package scare.\n");
r = review(sand, ["record", bead, "--file", `.factory/${bead}/review.md`, "--verdict", "pass"],
  { FACTORY_ROLE: "reviewer", FACTORY_SESSION: "review-S1" });
const rereadSha = sha256File(join(sand.sandbox, ".factory", bead, "review.md"));
artifactsNow = manifestOf(sand, bead).artifacts;
check("12 a second record replaces the review artifact in place",
  r.status === 0 && artifactsNow.filter((a) => a.id === "review").length === 1 &&
  artifactsNow.length === 2 && artifactsNow.find((a) => a.id === "review").sha256 === rereadSha,
  `status=${r.status} ids=${JSON.stringify(artifactsNow.map((a) => a.id))} ` +
  `sha=${JSON.stringify(artifactsNow.find((a) => a.id === "review") && artifactsNow.find((a) => a.id === "review").sha256)} vs ${rereadSha}`);
revTrail = trailOf(sand, bead).filter((e) => e.event === "review");
check("12 the second record appends its own review event",
  revTrail.length === 2 && revTrail[1].sha256 === rereadSha, JSON.stringify(revTrail.map((e) => e.sha256)));

console.log("\nshow");
r = review(sand, ["show", bead, "--json"]);
let shown = null;
try { shown = JSON.parse(r.stdout); } catch { /* asserted below */ }
check("13 show --json exits 0 and is parseable",
  r.status === 0 && shown !== null && typeof shown === "object", `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
check("13 show --json reports the verdict, the reviewer session and the builder session",
  shown !== null && shown.verdict === "pass" && shown.reviewer_session === "review-S1" &&
  shown.builder_session === "build-A", JSON.stringify(shown));
check("13 show --json reports the three checks ok while nothing has moved",
  shown !== null && shown.independence === true && shown.hash_ok === true && shown.at_head === true,
  JSON.stringify(shown));

writeFileSync(join(sand.sandbox, ".factory", bead, "review.md"), "Verdict: pass\n\nhand-edited after the record\n");
r = review(sand, ["show", bead]);
check("13 after the verdict file is hand-edited, the hash check reports FAIL and show still exits 0",
  r.status === 0 && /^FAIL\s+hash:/m.test(r.stdout),
  `status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
r = review(sand, ["show", bead, "--json"]);
try { shown = JSON.parse(r.stdout); } catch { /* asserted below */ }
check("13 --json reports the same tamper as hash_ok false, with independence intact",
  r.status === 0 && shown !== null && shown.hash_ok === false && shown.independence === true,
  JSON.stringify(shown));

console.log("\nunknown roles");
r = review(sand, ["record", bead, "--file", `.factory/${bead}/review.md`, "--verdict", "pass"],
  { FACTORY_ROLE: "admin", FACTORY_SESSION: "review-S1" });
check("14 an unknown FACTORY_ROLE is a refusal naming builder, reviewer, human - not a silent default",
  r.status === 1 && r.stderr.includes('unknown FACTORY_ROLE "admin"') &&
  r.stderr.includes("builder, reviewer or human"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

rmSandbox(sand.sandbox);
console.log(`\n${pass}/${pass + fail} review tests passed.`);
process.exit(fail ? 1 : 0);
