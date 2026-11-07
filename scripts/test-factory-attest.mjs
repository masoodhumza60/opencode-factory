// Tests for `factory-attest attest`: the CLI that records one artifact on a
// bead. The suite drives the real command as a child process in a throwaway
// sandbox - git repo, its own beads workspace (BEADS_DIR pointed at it), one
// bead, one artifact file - and reads the manifest and trail it leaves
// behind. Refusal cases sweep the same way, checking exit code 1 and the
// message that names the fix.

import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { sha256File, loadManifest, readTrail } from "./factory-manifest.mjs";
import { loadPolicy } from "./factory-policy.mjs";
import { verifyChecks, KINDS as ATTEST_KINDS } from "./factory-attest.mjs";
import { DECLARABLE_KINDS } from "./factory-policy.mjs";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const script = resolve(dirname(fileURLToPath(import.meta.url)), "factory-attest.mjs");

// The closed vocabulary is pinned here from docs/factory-domain-profiles.md so
// the CLI cannot satisfy this refusal by truncating the list. It is the policy's
// declarable kinds (which attest derives) plus the one only an orchestrator
// writes.
const KINDS = [
  "screenshot", "transcript", "contract", "api-diff", "plan", "eval",
  "hil-log", "prr", "exit-code-matrix", "golden-file", "help-snapshot",
  "tty-transcript", "completion-script", "install-log", "device-capture",
  "check-output",
  "visual", "authz", "load", "golden", "tty", "consumer-build",
  "plan-diff", "policy-check", "device", "signing", "update",
  "watchdog", "recovery", "frame", "input", "data-quality",
  "directions", "axe",
  "threat-model", "sbom", "traceability", "runbook", "slo",
  "hidden-tests",
];

// A sandbox is a git repo with its own beads workspace. Every child runs with
// BEADS_DIR pointed at the sandbox, so bd never touches the repo's workspace.
// Cleanup is not assertion, but must not crash a green suite: bd holds its
// embedded dolt database for a moment after the last child exits, so the
// first removal attempt can fail with EPERM. One waiting retry, then the
// failed removal is a warning - the sandbox is throwaway temp, not evidence.
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

function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), "factory-attest-"));
  const env = { ...process.env, BEADS_DIR: join(sandbox, ".beads") };
  delete env.FACTORY_SESSION;
  execFileSync("git", ["-c", "core.autocrlf=false", "init"], { cwd: sandbox, env, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
    { cwd: sandbox, env, stdio: "ignore" });
  execFileSync("bd", ["init"], { cwd: sandbox, env, stdio: "ignore" });
  return { sandbox, env };
}

// The plain `bd create` output puts the status ("open") last, so read the id
// out of its --json output instead.
function makeBead({ sandbox, env }, title) {
  const out = execFileSync("bd", ["create", title, "--json"], { cwd: sandbox, env, encoding: "utf8" });
  return JSON.parse(out).id;
}

// Run the CLI as a child process and normalise both outcomes to
// { status, stdout, stderr } so refusals read as data, not exceptions.
function run({ sandbox, env }, argv, extraEnv = {}) {
  const childEnv = { ...env, ...extraEnv };
  try {
    const stdout = execFileSync("node", [script, "attest", ...argv], { cwd: sandbox, env: childEnv, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      status: e.status == null ? -1 : e.status,
      stdout: String(e.stdout || ""),
      stderr: String(e.stderr || ""),
    };
  }
}

const manifestOf = (sb, bead) => loadManifest(sb.sandbox, bead);
const artifactsOf = (sb, bead) => manifestOf(sb, bead).artifacts;

const { sandbox, env } = makeSandbox();
const head_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sandbox, encoding: "utf8" }).trim();
const bead = makeBead({ sandbox, env }, "attest target");

console.log("\nhappy path");
mkdirSync(join(sandbox, "out"));
const logPath = join(sandbox, "out", "log.txt");
writeFileSync(logPath, "npm run dev -> 200 OK\n");
const logSha = sha256File(logPath);
const logBytes = statSync(logPath).size;
let r = run({ sandbox, env }, [bead, "out/log.txt", "--id", "run", "--kind", "check-output"]);
check("1 exits 0 and prints the attested line",
  r.status === 0 && /^attested run -> out\/log\.txt \(sha256 [0-9a-f]{12}…, commit [0-9a-f]{7}…\)$/m.test(r.stdout),
  `status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
const runArt = artifactsOf({ sandbox }, bead);
const a = runArt.length === 1 ? runArt[0] : null;
check("1 manifest records id and kind", a !== null && a.id === "run" && a.kind === "check-output",
  JSON.stringify(runArt));
check("1 path is root-relative with forward slashes", a !== null && a.path === "out/log.txt", a && a.path);
check("1 sha256 is the file's", a !== null && a.sha256 === logSha, a && a.sha256);
check("1 bytes matches the file size", a !== null && a.bytes === logBytes, a && a.bytes);
check("1 commit is the sandbox HEAD", a !== null && a.commit === head_commit, a && a.commit);
check("1 produced_at is ISO", a !== null && !Number.isNaN(Date.parse(a.produced_at)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(a.produced_at), a && a.produced_at);
check("1 with no --command and no policy, command is null", a !== null && a.command === null, a && JSON.stringify(a.command));

console.log("\ntrail");
const entries = readTrail(sandbox, bead);
check("2 the trail has exactly one attest line with the same id and sha256",
  entries.length === 1 && entries[0].event === "attest" && entries[0].id === "run" && entries[0].sha256 === logSha,
  JSON.stringify(entries));

console.log("\nreplace and append");
const log2Path = join(sandbox, "out", "log2.txt");
writeFileSync(log2Path, "npm test -> 7 passed\n");
r = run({ sandbox, env }, [bead, log2Path, "--id", "run", "--kind", "check-output", "--command", "npm run smoke"]);
check("3 re-attest exits 0", r.status === 0, `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
const replaced = artifactsOf({ sandbox }, bead).length === 1 ? artifactsOf({ sandbox }, bead)[0] : null;
check("3 the entry is replaced in place, length unchanged",
  replaced !== null && replaced.id === "run" &&
  replaced.sha256 === sha256File(log2Path) && replaced.path === "out/log2.txt",
  JSON.stringify(artifactsOf({ sandbox }, bead)));
check("3 an explicit --command is recorded",
  replaced !== null && replaced.command === "npm run smoke", replaced && JSON.stringify(replaced.command));
const buildPath = join(sandbox, "out", "build.txt");
writeFileSync(buildPath, "webpack built ok\n");
r = run({ sandbox, env }, [bead, buildPath, "--id", "build", "--kind", "install-log", "--command", "npm run build"]);
check("4 a second id appends to length 2",
  r.status === 0 && artifactsOf({ sandbox }, bead).length === 2 && artifactsOf({ sandbox }, bead)[1].id === "build",
  `status=${r.status} ${JSON.stringify(artifactsOf({ sandbox }, bead).map((x) => x.id))}`);

console.log("\npath kind and parser refusals");
r = run({ sandbox, env }, [bead, join(sandbox, "out", "missing.txt"), "--id", "run", "--kind", "check-output"]);
check("5 a missing file is refused, naming the absolute path",
  r.status === 1 && r.stderr.includes("does not exist") && r.stderr.includes(join(sandbox, "out", "missing.txt")),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
r = run({ sandbox, env }, [bead, "out", "--id", "run", "--kind", "check-output"]);
check("6 a directory is refused",
  r.status === 1 && r.stderr.includes("is a directory"), `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
writeFileSync(join(sandbox, "out", "empty.txt"), "");
r = run({ sandbox, env }, [bead, "out/empty.txt", "--id", "run", "--kind", "check-output"]);
check("7 a 0-byte file is refused",
  r.status === 1 && r.stderr.includes("is empty"), `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
r = run({ sandbox, env }, [bead, "out/log.txt", "--id", "run", "--kind", "telepathy"]);
check("8 a bad kind is refused naming every kind in the vocabulary",
  r.status === 1 && r.stderr.includes("telepathy") && KINDS.every((k) => r.stderr.includes(k)),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
// The pinned list and the runtime list are the same list: attest derives what
// it accepts from the policy's vocabulary, so the only addition is the kind the
// builder must never write.
check("8 attest accepts the policy's kinds, in order, plus hidden-tests",
  ATTEST_KINDS.length === DECLARABLE_KINDS.length + 1 &&
  DECLARABLE_KINDS.every((k, i) => ATTEST_KINDS[i] === k) &&
  ATTEST_KINDS[ATTEST_KINDS.length - 1] === "hidden-tests",
  JSON.stringify(ATTEST_KINDS));
r = run({ sandbox, env }, [bead, "out/log.txt", "--id", "run", "--kind", "check-output", "--bogus", "x"]);
check("unknown flag is refused with the accepted list",
  r.status === 1 && r.stderr.includes("unknown flag") && r.stderr.includes("--policy"), `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
r = run({ sandbox, env }, [bead, "out/log.txt", "--id", "run"]);
check("a missing required flag is refused naming it",
  r.status === 1 && r.stderr.includes("--kind"), `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

console.log("\nno policy, no gate");
r = run({ sandbox, env }, [bead, buildPath, "--id", "arbitrary-doc", "--kind", "plan", "--command", "cat notes"]);
check("10 without a policy an arbitrary id is accepted",
  r.status === 0 && artifactsOf({ sandbox }, bead).some((x) => x.id === "arbitrary-doc") &&
  artifactsOf({ sandbox }, bead).find((x) => x.id === "arbitrary-doc").kind === "plan",
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

console.log("\npolicy");
const pb = makeSandbox();
const pbead = makeBead(pb, "policy target");
mkdirSync(join(pb.sandbox, "out"));
const pPath = join(pb.sandbox, "out", "log.txt");
writeFileSync(pPath, "npm test -> 7 passed\n");
mkdirSync(join(pb.sandbox, "config"));
writeFileSync(join(pb.sandbox, "config", "factory.policy.yaml"),
  "version: 1\ntier: prototype\nprofile: web\n" +
  "\ntiers:\n" +
  "  prototype:\n    checks: [tests]\n" +
  "  internal:\n    checks: []\n" +
  "  public:\n    checks: []\n" +
  "  regulated:\n    checks: []\n" +
  "\nprofiles:\n" +
  "  web:\n    checks: [tests]\n" +
  "\nchecks:\n" +
  "  tests:\n" +
  "    phase: 5\n" +
  "    kind: check-output\n" +
  "    command: npm test\n");
r = run(pb, [pbead, join(pb.sandbox, "out", "log.txt"), "--id", "ghost", "--kind", "check-output"]);
check("9 an undeclared id with a policy is refused listing the declared ids",
  r.status === 1 && r.stderr.includes("declared: tests"), `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
r = run(pb, [pbead, join(pb.sandbox, "out", "log.txt"), "--id", "tests", "--kind", "check-output"]);
const pEntry = artifactsOf(pb, pbead).length === 1 ? artifactsOf(pb, pbead)[0] : null;
check("9 a declared id is accepted and the policy command is used",
  r.status === 0 && pEntry !== null && pEntry.command === "npm test",
  `status=${r.status} command=${JSON.stringify(pEntry && pEntry.command)}`);

console.log("\nwithout git, without the bead");
const ngEn = mkdtempSync(join(tmpdir(), "factory-attest-"));
mkdirSync(join(ngEn, ".beads"));
const ngEnv = { ...process.env, BEADS_DIR: join(ngEn, ".beads") };
delete ngEnv.FACTORY_SESSION;
r = run({ sandbox: ngEn, env: ngEnv }, ["beads-nothing", join(ngEn, "whatever.txt"), "--id", "run", "--kind", "eval"]);
// Pinned to the CLI's own sentence, not git's: git prints "... not a git
// repository ..." itself, so asserting on "git repository" alone would stay
// green if the CLI's refusal were deleted and git's raw text leaked through.
check("11 a non-git directory is refused naming the git repository fix",
  r.status === 1 && r.stderr.includes("run this inside a git repository"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
r = run({ sandbox, env }, ["beads-does-not-exist", "out/log.txt", "--id", "run", "--kind", "check-output"]);
check("12 a bead that does not exist is refused",
  r.status === 1 && r.stderr.includes("was not found"), `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

console.log("\nproducer session");
const reviewPath = join(sandbox, "out", "review.txt");
writeFileSync(reviewPath, "reviewed\n");
r = run({ sandbox, env }, [bead, reviewPath, "--id", "review-check", "--kind", "prr"],
  { FACTORY_SESSION: "reviewer-1" });
const reviewEntry = manifestOf({ sandbox }, bead).artifacts.find(x => x.id === "review-check");
const reviewTrail = readTrail(sandbox, bead).filter(x => x.id === "review-check");
check("13 FACTORY_SESSION is recorded verbatim in the manifest and the trail",
  r.status === 0 && reviewEntry !== undefined && reviewEntry.producer_session === "reviewer-1" &&
  reviewTrail.length === 1 && reviewTrail[0].producer_session === "reviewer-1",
  `manifest=${JSON.stringify(reviewEntry && reviewEntry.producer_session)} trail=${JSON.stringify(reviewTrail)}`);
const noSessionPath = join(sandbox, "out", "nosession.txt");
writeFileSync(noSessionPath, "unowned\n");
r = run({ sandbox, env }, [bead, noSessionPath, "--id", "no-session-check", "--kind", "eval"]);
const noSessionEntry = manifestOf({ sandbox }, bead).artifacts.find(x => x.id === "no-session-check");
const noSessionTrail = readTrail(sandbox, bead).filter(x => x.id === "no-session-check");
check("14 without FACTORY_SESSION the session is factory:<uuid>",
  r.status === 0 && noSessionEntry !== undefined && noSessionTrail.length === 1 &&
  /^factory:[0-9a-f-]{36}$/.test(noSessionEntry.producer_session) &&
  noSessionEntry.producer_session === noSessionTrail[0].producer_session,
  JSON.stringify(noSessionEntry && noSessionEntry.producer_session));

// A verdict artifact is different: the anonymous fallback would hand the same
// builder a fresh identity on every run, so a builder could attest its own
// review and look independent of itself. attest refuses, and names the fix.
r = run({ sandbox, env }, [bead, reviewPath, "--id", "review-anon", "--kind", "prr"]);
check("14 attest --kind prr without FACTORY_SESSION is refused; a verdict must be named",
  r.status === 1 && r.stderr.includes("a verdict must be named") &&
  r.stderr.includes("set FACTORY_SESSION to a reviewer session distinct from the builder"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
check("14 the refused anonymous verdict wrote no artifact and no trail event",
  manifestOf({ sandbox }, bead).artifacts.every((a) => a.id !== "review-anon") &&
  readTrail(sandbox, bead).every((x) => x.id !== "review-anon"),
  JSON.stringify(manifestOf({ sandbox }, bead).artifacts.map((a) => a.id)));
// The same command with a non-verdict kind keeps the uuid fallback: only the
// prr is a claim about who reviewed.
r = run({ sandbox, env }, [bead, noSessionPath, "--id", "no-session-again", "--kind", "check-output"]);
const againEntry = manifestOf({ sandbox }, bead).artifacts.find(x => x.id === "no-session-again");
check("14 a non-verdict kind without FACTORY_SESSION still succeeds and still freezes a uuid",
  r.status === 0 && againEntry !== undefined &&
  /^factory:[0-9a-f-]{36}$/.test(againEntry.producer_session || ""),
  JSON.stringify(againEntry && againEntry.producer_session));

// ---- hidden acceptance tests -------------------------------------------------
//
// A hidden test is the check the builder cannot read, so it is the one artifact
// the builder must never be able to author. The role is a declaration, not a
// secret: these assertions pin the refusal text and the recording, and the
// phase suite pins that ship actually requires one from someone else.

console.log("\nhidden acceptance tests");
const hiddenDir = join(sandbox, ".factory", bead, "hidden");
mkdirSync(hiddenDir, { recursive: true });
const hiddenPath = join(hiddenDir, "probe.txt");
writeFileSync(hiddenPath, "acceptance: the export runs on a machine with no network\n");
const hiddenRel = `.factory/${bead}/hidden/probe.txt`;

r = run({ sandbox, env }, [bead, hiddenRel, "--id", "hidden", "--kind", "hidden-tests"],
  { FACTORY_SESSION: "build:1" });
check("hidden 1 the builder may not attest a hidden acceptance test",
  r.status === 1 && r.stderr.includes("hidden acceptance tests are written by the orchestrator, not the builder"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
check("hidden 1 the refused builder attestation wrote no artifact and no trail event",
  artifactsOf({ sandbox }, bead).every((a) => a.kind !== "hidden-tests") &&
  readTrail(sandbox, bead).every((x) => x.id !== "hidden"),
  JSON.stringify(artifactsOf({ sandbox }, bead).map((a) => a.kind)));

r = run({ sandbox, env }, [bead, hiddenRel, "--id", "hidden", "--kind", "hidden-tests"],
  { FACTORY_ROLE: "orchestrator" });
check("hidden 2 an orchestrator must still name itself; the uuid fallback is refused",
  r.status === 1 && r.stderr.includes("hidden acceptance tests must be named") &&
  r.stderr.includes("set FACTORY_SESSION to an orchestrator session"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
check("hidden 2 the refused anonymous attestation wrote no artifact",
  artifactsOf({ sandbox }, bead).every((a) => a.kind !== "hidden-tests"),
  JSON.stringify(artifactsOf({ sandbox }, bead).map((a) => a.kind)));

r = run({ sandbox, env }, [bead, hiddenRel, "--id", "hidden", "--kind", "hidden-tests"],
  { FACTORY_ROLE: "orchestratr", FACTORY_SESSION: "orch:1" });
check("hidden 3 an unknown FACTORY_ROLE is a refusal, not a silent builder",
  r.status === 1 && r.stderr.includes(`unknown FACTORY_ROLE "orchestratr"`) &&
  r.stderr.includes("expected builder, reviewer, orchestrator or human"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

r = run({ sandbox, env }, [bead, hiddenRel, "--id", "hidden", "--kind", "hidden-tests"],
  { FACTORY_ROLE: "orchestrator", FACTORY_SESSION: "orch:1" });
const hiddenEntry = artifactsOf({ sandbox }, bead).find((a) => a.kind === "hidden-tests");
const hiddenTrail = readTrail(sandbox, bead).filter((x) => x.id === "hidden");
check("hidden 4 an orchestrator with a session records the test and who produced it",
  r.status === 0 && hiddenEntry !== undefined && hiddenEntry.id === "hidden" &&
  hiddenEntry.path === hiddenRel && hiddenEntry.producer_session === "orch:1" &&
  hiddenTrail.length === 1 && hiddenTrail[0].producer_session === "orch:1",
  `status=${r.status} entry=${JSON.stringify(hiddenEntry)}`);

// The policy on disk declares only `tests`; a hidden test must still be
// attestable, because a declared hidden test would be printed in the review
// package the builder reads.
const pHiddenDir = join(pb.sandbox, ".factory", pbead, "hidden");
mkdirSync(pHiddenDir, { recursive: true });
writeFileSync(join(pHiddenDir, "probe.txt"), "acceptance: the cli exits 2 on a bad flag\n");
r = run(pb, [pbead, `.factory/${pbead}/hidden/probe.txt`, "--id", "hidden", "--kind", "hidden-tests"],
  { FACTORY_ROLE: "orchestrator", FACTORY_SESSION: "orch:1" });
check("hidden 5 a hidden test is exempt from the declared-id rule",
  r.status === 0 && artifactsOf(pb, pbead).some((a) => a.kind === "hidden-tests"),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);

// ---- verify -----------------------------------------------------------------
//
// A second sandbox, same shape as the first: git repo, own beads workspace, one
// bead. It carries a policy whose phase 7 requires exactly two checks - `tests`
// (check-output) and `review` (prr) - so the ladder, the fix strings and the
// independence rule all have something real to stand on.

const vs = makeSandbox();
const vbead = makeBead(vs, "verify target");
mkdirSync(join(vs.sandbox, "config"));
mkdirSync(join(vs.sandbox, "out"));
writeFileSync(join(vs.sandbox, "config", "factory.policy.yaml"),
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
  "    command: null\n");
// The bead records its own phase, so at least one case exercises the default
// phase path rather than only --phase.
execFileSync("bd", ["set-state", vbead, "phase=7"], { cwd: vs.sandbox, env: vs.env, stdio: "ignore" });

const testsTxt = join(vs.sandbox, "out", "tests.txt");
const reviewTxt = join(vs.sandbox, "out", "review.txt");
writeFileSync(testsTxt, "npm test -> 7 passed\n");
writeFileSync(reviewTxt, "reviewed by a human\n");

// Artifacts are produced by the real command, never written by hand, so the
// verify suite proves the two halves agree with each other.
function run2(sb, argv, extraEnv = {}) {
  const childEnv = { ...sb.env, ...extraEnv };
  try {
    const stdout = execFileSync("node", [script, ...argv], { cwd: sb.sandbox, env: childEnv, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status == null ? -1 : e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
  }
}
const verify = (sb, argv, extraEnv) => run2(sb, ["verify", ...argv], extraEnv);
const attest2 = (sb, argv, extraEnv) => run2(sb, ["attest", ...argv], extraEnv);

const manifestPath = join(vs.sandbox, ".factory", vbead, "manifest.json");
const readManifestRaw = () => JSON.parse(readFileSync(manifestPath, "utf8"));
const writeManifestRaw = (m) => writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
// Remove ONE entry by id without touching the rest, so a hand-edit case is a
// single deliberate mutation.
const dropEntry = (id) => {
  const m = readManifestRaw();
  m.artifacts = m.artifacts.filter((a) => a.id !== id);
  writeManifestRaw(m);
};
const editEntry = (id, patch) => {
  const m = readManifestRaw();
  const e = m.artifacts.find((a) => a.id === id);
  Object.assign(e, patch);
  writeManifestRaw(m);
};
const commitAll = () => execFileSync("git",
  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "next"],
  { cwd: vs.sandbox, env: vs.env, stdio: "ignore" });

let vr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"],
  { FACTORY_SESSION: "build-A" });
check("v0 attest tests exits 0", vr.status === 0, `status=${vr.status} stderr=${JSON.stringify(vr.stderr)}`);
check("v0 the first attestation freezes the builder session",
  manifestOf(vs, vbead).builder_session === "build-A",
  `builder_session=${JSON.stringify(manifestOf(vs, vbead).builder_session)}`);
vr = attest2(vs, [vbead, "out/review.txt", "--id", "review", "--kind", "prr"], { FACTORY_SESSION: "review-R" });
check("v0 attest review exits 0", vr.status === 0, `status=${vr.status} stderr=${JSON.stringify(vr.stderr)}`);

console.log("\nverify 1: all current, no session needed any more");
vr = verify(vs, [vbead]);
check("1 exits 0 with both checks current and no FACTORY_SESSION",
  vr.status === 0, `status=${vr.status} stdout=${JSON.stringify(vr.stdout)} stderr=${JSON.stringify(vr.stderr)}`);
check("1 tests is ok and review is ok against the frozen builder, with no FACTORY_SESSION",
  /^  ok\s+tests\s/m.test(vr.stdout) && /^  ok\s+review\s/m.test(vr.stdout),
  vr.stdout);
check("1 the summary counts 2 checks, 2 ok, 0 failed",
  vr.stdout.includes("2 checks, 2 ok, 0 failed"), vr.stdout);
// verifyChecks reads bd through process.env, so point BEADS_DIR at the sandbox
// for the in-process call and put it back afterwards.
const withSandboxEnv = (sb, fn) => {
  const saved = process.env.BEADS_DIR;
  process.env.BEADS_DIR = sb.env.BEADS_DIR;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.BEADS_DIR;
    else process.env.BEADS_DIR = saved;
  }
};
const v1Result = withSandboxEnv(vs, () => verifyChecks(vs.sandbox, vbead, "7", loadPolicy(vs.sandbox)));
check("1 verifyChecks says ok and gives the frozen shape",
  v1Result.ok === true && v1Result.checks.length === 2 &&
  v1Result.checks[0].id === "tests" && v1Result.checks[0].result === "ok" &&
  v1Result.checks[1].result === "ok" &&
  v1Result.checks[1].reviewer_session === undefined && v1Result.checks[1].builder_session === undefined &&
  ["id", "result", "path", "sha256", "commit", "head", "kind", "fix"].every((k) => k in v1Result.checks[0]),
  JSON.stringify(v1Result.checks));
const vTrail = readTrail(vs.sandbox, vbead).filter((e) => e.event === "verify");
check("1 the trail's last line is a verify event with ok: true",
  vTrail.length === 1 && vTrail[0].ok === true && vTrail[0].total === 2 &&
  vTrail[0].passed === 2 && vTrail[0].failed === 0 && vTrail[0].phase === "7",
  JSON.stringify(vTrail));

console.log("\nverify 2: missing");
dropEntry("tests");
vr = verify(vs, [vbead]);
check("2 a deleted manifest entry is MISSING, exit 1",
  vr.status === 1 && /^  MISSING\s+tests\s/m.test(vr.stdout), `status=${vr.status} ${vr.stdout}`);
check("2 the printed fix names --id tests --kind check-output",
  vr.stdout.includes("--id tests --kind check-output"), vr.stdout);
// The failing run must be on the trail too: a verdict of false is the record
// the phase machine will read, not just the passing ones.
const missTrail = readTrail(vs.sandbox, vbead).filter((e) => e.event === "verify");
const missLast = missTrail[missTrail.length - 1];
check("2 the failing run appends exactly one verify event with ok: false and a phase",
  missTrail.length === 2 && missLast.ok === false &&
  missLast.phase === "7" && missLast.total === 2 && missLast.failed === 1,
  JSON.stringify(missTrail));

console.log("\nverify 3: absent");
vr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("3 re-attest restores the entry", vr.status === 0, `status=${vr.status}`);
rmSync(testsTxt, { force: true });
vr = verify(vs, [vbead]);
check("3 a deleted file is ABSENT, exit 1",
  vr.status === 1 && /^  ABSENT\s+tests\s/m.test(vr.stdout), `status=${vr.status} ${vr.stdout}`);

console.log("\nverify 4: not-a-file");
rmSync(testsTxt, { force: true });
mkdirSync(testsTxt);
vr = verify(vs, [vbead]);
check("4 a directory in the artifact's place is NOT-A-FILE, exit 1",
  vr.status === 1 && /^  NOT-A-FILE\s+tests\s/m.test(vr.stdout), `status=${vr.status} ${vr.stdout}`);
rmSync(testsTxt, { recursive: true, force: true });

console.log("\nverify 5: hash");
writeFileSync(testsTxt, "npm test -> 7 passed\n");
vr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("5 re-attest before the hash case exits 0", vr.status === 0, `status=${vr.status}`);
writeFileSync(testsTxt, "npm test -> 7 passed\nX");
vr = verify(vs, [vbead]);
const hashRow = (vr.stdout.split("\n").find((l) => /^  HASH\s+tests\s/.test(l))) || "";
const hashPair = hashRow.match(/recorded ([0-9a-f]{12})…, on disk ([0-9a-f]{12})…/);
check("5 an appended byte is HASH, exit 1",
  vr.status === 1 && hashPair !== null, `status=${vr.status} row=${JSON.stringify(hashRow)}`);
check("5 the row shows two different 12-char hashes",
  hashPair !== null && hashPair[1] !== hashPair[2], hashRow);

console.log("\nverify 14: re-attesting fixes it");
vr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("14 re-attest after the hash case exits 0", vr.status === 0, `status=${vr.status}`);
vr = verify(vs, [vbead]);
check("14 verify exits 0 again", vr.status === 0, `status=${vr.status} ${vr.stdout}`);

console.log("\nverify 6: stale");
commitAll();
vr = verify(vs, [vbead]);
const staleRow = (vr.stdout.split("\n").find((l) => /^  STALE\s+tests\s/.test(l))) || "";
check("6 a commit after attestation is STALE, exit 1",
  vr.status === 1 && staleRow !== "", `status=${vr.status} ${vr.stdout}`);
check("6 the row names the recorded commit and HEAD",
  /recorded at commit [0-9a-f]{7}, HEAD is [0-9a-f]{7}/.test(staleRow), staleRow);

console.log("\nverify 7: producer");
vr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("7 re-attest before the producer case exits 0", vr.status === 0, `status=${vr.status}`);
editEntry("tests", { producer_session: "" });
vr = verify(vs, [vbead]);
check("7 an empty producer_session is PRODUCER, exit 1",
  vr.status === 1 && /^  PRODUCER\s+tests\s+.*no producer session recorded/m.test(vr.stdout),
  `status=${vr.status} ${vr.stdout}`);

console.log("\nverify 8: the frozen builder cannot review its own bead");
// The prr is re-attested BY the frozen builder session, and verify runs with a
// fresh, unrelated FACTORY_SESSION - re-labelling the environment does not
// launder the review, because the builder is read from the manifest.
vr = attest2(vs, [vbead, "out/review.txt", "--id", "review", "--kind", "prr"], { FACTORY_SESSION: "build-A" });
check("8 re-attesting the prr as the frozen builder build-A exits 0", vr.status === 0, `status=${vr.status}`);
vr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("8 tests is current for the session cases", vr.status === 0, `status=${vr.status}`);
vr = verify(vs, [vbead], { FACTORY_SESSION: "build-B" });
check("8 a builder-produced prr is INDEPENDENCE with FACTORY_SESSION=build-B, exit 1",
  vr.status === 1 &&
  /^  INDEPENDENCE\s+review\s+.*the reviewer session "build-A" is the builder session "build-A"/m.test(vr.stdout),
  `status=${vr.status} ${vr.stdout}`);
// The same hold with the environment validating nothing extra (M1a's
// "not-applicable" trigger): the frozen builder stands either way.
vr = verify(vs, [vbead]);
check("8 the same self-review fails with no FACTORY_SESSION too, exit 1",
  vr.status === 1 && /^  INDEPENDENCE\s+review\s/m.test(vr.stdout), `status=${vr.status} ${vr.stdout}`);
let v8Json = null;
const freshJson = verify(vs, [vbead, "--json"], { FACTORY_SESSION: "verify-X" });
try { v8Json = JSON.parse(freshJson.stdout); } catch { /* asserted below */ }
check("8 --json names both colliding sessions on the row",
  freshJson.status === 1 && v8Json !== null &&
  (() => { const row = v8Json.checks.find((c) => c.id === "review");
           return row.result === "independence" && row.reviewer_session === "build-A" && row.builder_session === "build-A"; })(),
  JSON.stringify(freshJson.stdout));

console.log("\nverify 9: a genuinely different prr producer is ok");
vr = attest2(vs, [vbead, "out/review.txt", "--id", "review", "--kind", "prr"], { FACTORY_SESSION: "review-R" });
check("9 re-attesting the prr by session review-R exits 0", vr.status === 0, `status=${vr.status}`);
vr = verify(vs, [vbead], { FACTORY_SESSION: "build-B" });
check("9 a prr whose producer is review-R is ok against the frozen builder, exit 0",
  vr.status === 0 && /^  ok\s+review\s/m.test(vr.stdout), `status=${vr.status} ${vr.stdout}`);

console.log("\nverify 16: a manifest that predates the frozen builder");
// A manifest written before M1b has no builder_session. With no
// FACTORY_SESSION there is no second party: not-applicable, as in M1a - and
// its message must say exactly what is missing. With a session set, the
// environment remains the comparison point, also as in M1a: independence is
// asked of the prr's producer against it.
const legacyRaw = readManifestRaw();
delete legacyRaw.builder_session;
writeManifestRaw(legacyRaw);
vr = verify(vs, [vbead]);
check("16 no builder session and no FACTORY_SESSION is NOT-APPLICABLE, naming both absences",
  vr.status === 0 &&
  /^  NOT-APPLICABLE\s+review\s+.*no builder session recorded and FACTORY_SESSION is not set$/m.test(vr.stdout),
  `status=${vr.status} ${vr.stdout}`);
check("16 the not-applicable rung is not a failure",
  vr.stdout.includes("2 checks, 1 ok, 0 failed"), vr.stdout);
vr = verify(vs, [vbead], { FACTORY_SESSION: "review-Z" });
check("16 with FACTORY_SESSION set, a pre-frost manifest still gets checked against it",
  vr.status === 0 && /^  ok\s+review\s/m.test(vr.stdout), `status=${vr.status} ${vr.stdout}`);
vr = verify(vs, [vbead], { FACTORY_SESSION: "review-R" });
const legacyRow = vr.stdout.split("\n").find((l) => /^  INDEPENDENCE\s+review\s/.test(l)) || "";
check("16 a pre-frost prr whose producer is the env session is still INDEPENDENCE",
  vr.status === 1 &&
  /the reviewer session "review-R" is the builder session "review-R"/.test(legacyRow),
  `status=${vr.status} row=${JSON.stringify(legacyRow)}`);
// Put the frozen builder back: with build-A on record the review (produced by
// review-R) is genuinely independent again.
legacyRaw.builder_session = "build-A";
writeManifestRaw(legacyRaw);
vr = verify(vs, [vbead]);
check("16 restoring the builder session puts the review back at ok",
  vr.status === 0 && /^  ok\s+review\s/m.test(vr.stdout), `status=${vr.status} ${vr.stdout}`);
// Reading is validated, not trusted: the same empty builder_session a
// hand-edit could leave behind must be a loud failure, never a silent default.
const legacyEmpty = JSON.parse(JSON.stringify(legacyRaw));
legacyEmpty.builder_session = "";
writeManifestRaw(legacyEmpty);
let legacyBad = null;
try { manifestOf(vs, vbead); } catch (e) { legacyBad = e.message; }
check("16 an empty builder_session hand-written into the manifest is a loud read",
  legacyBad !== null && /builder_session/.test(legacyBad), `error=${JSON.stringify(legacyBad)}`);
writeManifestRaw(legacyRaw);

console.log("\nverify 10: --json");
vr = verify(vs, [vbead, "--json"]);
let vJson = null;
try { vJson = JSON.parse(vr.stdout); } catch { /* left null, asserted below */ }
check("10 stdout is one parseable JSON object",
  vJson !== null && typeof vJson === "object" && !Array.isArray(vJson), JSON.stringify(vr.stdout));
check("10 the object has exactly the expected top-level keys",
  vJson !== null &&
  ["bead", "phase", "tier", "profile", "ok", "counts", "checks"].every((k) => k in vJson) &&
  Object.keys(vJson).length === 7, vJson && Object.keys(vJson).join(","));
check("10 checks are in the policy's required order",
  vJson !== null && vJson.checks.map((c) => c.id).join(",") === "tests,review",
  vJson && vJson.checks.map((c) => c.id).join(","));
check("10 there is no prose on stdout",
  vr.stdout.trim().startsWith("{") && vr.stdout.trim().endsWith("}") && !vr.stdout.includes("verify "),
  JSON.stringify(vr.stdout));

console.log("\nverify 11: --phase against a bead with none recorded");
const noPhase = makeBead(vs, "no phase stored");
vr = verify(vs, [noPhase, "--phase", "7"]);
check("11 --phase 7 verifies a bead that records no phase",
  vr.status === 1 && vr.stdout.includes("phase 7") && /^  MISSING\s+tests\s/m.test(vr.stdout),
  `status=${vr.status} ${vr.stdout}`);
vr = verify(vs, [noPhase]);
check("11 without --phase the same bead refuses naming the recorded phase",
  vr.status === 1 && vr.stderr.includes("has no recorded phase") && vr.stderr.includes("--phase <n>"),
  `status=${vr.status} stderr=${JSON.stringify(vr.stderr)}`);
// --phase must beat a phase the bead DID record, not only fill in a missing
// one: the flag is an override, so a bead sitting at 3 still verifies as 7.
execFileSync("bd", ["set-state", noPhase, "phase=3"], { cwd: vs.sandbox, env: vs.env, stdio: "ignore" });
vr = verify(vs, [noPhase]);
check("11 the bead's own phase 3 is used when --phase is absent",
  vr.status === 0 && vr.stdout.includes("phase 3") && vr.stdout.includes("0 checks, 0 ok, 0 failed"),
  `status=${vr.status} ${vr.stdout}`);
vr = verify(vs, [noPhase, "--phase", "7"]);
check("11 --phase 7 overrides a recorded phase 3",
  vr.status === 1 && vr.stdout.includes("phase 7") && /^  MISSING\s+tests\s/m.test(vr.stdout),
  `status=${vr.status} ${vr.stdout}`);

console.log("\nverify 12: no policy, no verification");
const np = makeSandbox();
const npbead = makeBead(np, "no policy target");
vr = verify(np, [npbead]);
check("12 with no policy file verify refuses, exit 1",
  vr.status === 1 && vr.stderr.includes("there is no policy to verify against"),
  `status=${vr.status} stderr=${JSON.stringify(vr.stderr)}`);
check("12 the refusal leaves the trail untouched",
  readTrail(np.sandbox, npbead).length === 0, JSON.stringify(readTrail(np.sandbox, npbead)));

console.log("\nverify 13: a phase that requires nothing");
const beforePhase0 = readTrail(vs.sandbox, vbead).length;
vr = verify(vs, [vbead, "--phase", "0"]);
check("13 a phase with no checks exits 0",
  vr.status === 0 && vr.stdout.includes("0 checks, 0 ok, 0 failed"),
  `status=${vr.status} ${vr.stdout}`);
check("13 a phase with no checks still appends one verify line",
  readTrail(vs.sandbox, vbead).length === beforePhase0 + 1,
  `${beforePhase0} -> ${readTrail(vs.sandbox, vbead).length}`);

console.log("\nverify 15: a malformed manifest entry is data, not a crash");
// A hand-edited manifest can drop a field the manifest module never validates.
// The walker reaches `stale`/`hash` by inequality, so the report must render
// `<unknown>` for the missing side rather than dereferencing undefined.
let mr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("15 setup: tests is attested and current", mr.status === 0, `status=${mr.status}`);

// (a) drop `commit`: the entry cannot equal HEAD, so the row is stale.
const noCommitManifest = readManifestRaw();
delete noCommitManifest.artifacts.find((x) => x.id === "tests").commit;
writeManifestRaw(noCommitManifest);
vr = verify(vs, [vbead]);
check("15a an entry with no commit prints STALE and <unknown>, exit 1",
  vr.status === 1 && /^  STALE\s+tests\s/m.test(vr.stdout) && vr.stdout.includes("<unknown>"),
  `status=${vr.status} ${vr.stdout}`);
check("15a the human report does not crash: no stack trace on stderr",
  !/TypeError/.test(vr.stderr) && vr.stderr.trim() === "",
  `stderr=${JSON.stringify(vr.stderr)}`);
const noCommitJson = verify(vs, [vbead, "--json"]);
let ncParsed = null;
try { ncParsed = JSON.parse(noCommitJson.stdout); } catch { /* asserted below */ }
check("15a --json stays parseable and reports the same stale result",
  noCommitJson.status === 1 && ncParsed !== null &&
  ncParsed.checks.find((c) => c.id === "tests").result === "stale" &&
  ncParsed.checks.find((c) => c.id === "tests").recorded_commit === null,
  JSON.stringify(noCommitJson.stdout));

// (b) a non-string sha256: the recomputed hash cannot equal it, so the row is
// hash - and the row dereferences that same field to print the recorded side.
mr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("15 setup: tests is re-attested cleanly", mr.status === 0, `status=${mr.status}`);
editEntry("tests", { sha256: 12345 });
vr = verify(vs, [vbead]);
check("15b a non-string sha256 prints a HASH row and <unknown>, exit 1",
  vr.status === 1 && /^  HASH\s+tests\s/m.test(vr.stdout) && vr.stdout.includes("<unknown>"),
  `status=${vr.status} ${vr.stdout}`);
check("15b the human report does not crash: no stack trace on stderr",
  !/TypeError/.test(vr.stderr) && vr.stderr.trim() === "",
  `stderr=${JSON.stringify(vr.stderr)}`);
const badShaJson = verify(vs, [vbead, "--json"]);
let bsParsed = null;
try { bsParsed = JSON.parse(badShaJson.stdout); } catch { /* asserted below */ }
check("15b --json stays parseable and reports the same hash result",
  badShaJson.status === 1 && bsParsed !== null &&
  bsParsed.checks.find((c) => c.id === "tests").result === "hash",
  JSON.stringify(badShaJson.stdout));

// Leave the sandbox consistent for anything that follows.
mr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("15 cleanup: tests is re-attested and verifies", mr.status === 0 && verify(vs, [vbead]).status === 0,
  `status=${mr.status}`);

// ---- trail at the call sites ------------------------------------------------
//
// `complete` used to write ONE `complete` event whether it passed or failed, so
// the log could not tell "we shipped" from "we tried and were refused". This
// block pins the split: a refusal appends a `refusal` event and no `complete`,
// the accepted run appends the `complete` and leaves the refusal's bytes alone.
//
// The gate choreography is copied from test-factory-phase.mjs rather than
// imported - a test suite is not a library, and importing the phase suite would
// run its 143 assertions twice inside this sandbox. Only the phase CLI and bd
// are imported, but as code: the four helpers below are adapted to this file's
// own `sandbox`/`env` shape.

const HERE = dirname(fileURLToPath(import.meta.url));
// The absolute path matters: run()/execFileSync pin cwd to a temp sandbox, so a
// relative `scripts/factory-phase.mjs` resolves INSIDE the sandbox and dies with
// MODULE_NOT_FOUND.
const PHASE_SCRIPT = join(HERE, "factory-phase.mjs");

// A phase-CLI runner alongside this suite's `run` (which always prepends
// "attest"). Same { status, stdout, stderr } normalisation so refusals read as
// data.
function phaseRun(sb, argv) {
  try {
    const stdout = execFileSync("node", [PHASE_SCRIPT, ...argv], { cwd: sb.sandbox, env: sb.env, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status == null ? -1 : e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
  }
}
const phaseCmd = (sb, argv) => phaseRun(sb, argv);

// The claim phase 5's own --ran gate demands. Copied verbatim from the phase
// suite so the two suites assert the same contract.
const RAN_CLAIM = "npm run dev -> 200 OK on GET /health at 2026-10-20T10:00:00Z";
// G1 is raised by enter 1 and is required by complete 1 when a policy exists;
// G2a is raised by enter 2 and must be approved before complete 2; G2b likewise
// for 3. Approved through the machine, never a raw resolve.
const GATE_LETTER = { "2": "A", "3": "B" };
const approveGate = (sb, bead, letter) =>
  phaseCmd(sb, ["gate", bead, letter, "--evidence", `the ${letter} gate evidence is on disk and the checklist passed`, "--quiet"]);

// Walk a fresh bead to `target`, resolving exactly the gates that stand in the
// way. Mirrors walkTo in the phase suite; throws rather than silently leaving a
// half-built bead, so a setup problem reads as a setup problem.
function walkToAttest(sb, title, target) {
  const bead = makeBead(sb, title);
  if (!bead) throw new Error(`walkToAttest: could not create bead for "${title}"`);
  for (const p of ["0", "1", "2", "3", "4", "5", "6"]) {
    if (Number(p) >= Number(target)) break;
    const entered = phaseCmd(sb, ["enter", bead, p, "--reason", `walk to phase ${p}`, "--quiet"]);
    if (entered.status !== 0) throw new Error(`walkToAttest: enter ${p} failed: ${entered.stdout}${entered.stderr}`);
    if (p === "1") {
      const g = approveGate(sb, bead, "G1");
      if (g.status !== 0) throw new Error(`walkToAttest: gate G1 failed: ${g.stdout}${g.stderr}`);
    }
    if (p === "2") {
      const g = approveGate(sb, bead, GATE_LETTER[p]);
      if (g.status !== 0) throw new Error(`walkToAttest: gate A failed: ${g.stdout}${g.stderr}`);
    }
    if (p === "3") {
      const g = approveGate(sb, bead, GATE_LETTER[p]);
      if (g.status !== 0) throw new Error(`walkToAttest: gate B failed: ${g.stdout}${g.stderr}`);
    }
    const done = phaseCmd(sb, ["complete", bead, p, "--evidence", `phase ${p} ran its checks and they passed`, "--quiet"]);
    if (done.status !== 0) throw new Error(`walkToAttest: complete ${p} failed: ${done.stdout}${done.stderr}`);
  }
  const landed = phaseCmd(sb, ["enter", bead, String(target), "--reason", `walk to phase ${target}`, "--quiet"]);
  if (landed.status !== 0) throw new Error(`walkToAttest: enter ${target} failed: ${landed.stdout}${landed.stderr}`);
  return bead;
}

console.log("\ntrail at the call sites");
// A sandbox whose phase 5 requires an artifact named `run` produced by npm test.
const ts = makeSandbox();
// enter 2 requires a brainstorm from phase 1 to exist, so plant one before the
// walk - copied from the phase suite's ensureBrainstorm, which hits the same
// precondition.
mkdirSync(join(ts.sandbox, "docs", "superpowers", "brainstorms"), { recursive: true });
writeFileSync(join(ts.sandbox, "docs", "superpowers", "brainstorms", "0000-00-00-trail-brainstorm.md"), "# trail brainstorm\n");
mkdirSync(join(ts.sandbox, "config"));
mkdirSync(join(ts.sandbox, "out"));
writeFileSync(join(ts.sandbox, "config", "factory.policy.yaml"),
  "version: 1\ntier: prototype\nprofile: web\n" +
  "\ntiers:\n" +
  "  prototype:\n    checks: [run]\n" +
  "  internal:\n    checks: []\n" +
  "  public:\n    checks: []\n" +
  "  regulated:\n    checks: []\n" +
  "\nprofiles:\n" +
  "  web:\n    checks: []\n" +
  "\nchecks:\n" +
  "  run:\n" +
  "    phase: 5\n" +
  "    kind: check-output\n" +
  "    command: npm test\n");
// makeSandbox's git init + empty commit gives HEAD, which attest records.
const tbead = walkToAttest({ sandbox: ts.sandbox, env: ts.env }, "trail target", "5");
const trailFile = join(ts.sandbox, ".factory", tbead, "trail.jsonl");
const readTrailRaw = () => readFileSync(trailFile, "utf8");
// The artifact phase 5's own --ran gate demands; the policy check `run` is a
// DIFFERENT file this suite attests later, so the two barriers stay distinct.
const bootLog = join(ts.sandbox, "out", "boot.log");
writeFileSync(bootLog, "200 OK\n");

// The refused completion, before anything is attested.
const completesBeforeRefusal = readTrail(ts.sandbox, tbead).filter((e) => e.event === "complete").length;
const trailLenBeforeRefusal = readTrail(ts.sandbox, tbead).length;
let tr = phaseCmd({ sandbox: ts.sandbox, env: ts.env },
  ["complete", tbead, "5", "--evidence", "the artifact is supposedly verified and on disk",
   "--ran", RAN_CLAIM, "--artifact", bootLog, "--quiet"]);
const refusedTrail = readTrail(ts.sandbox, tbead);
const lastRefused = refusedTrail[refusedTrail.length - 1];
check("T1 the refused completion appends a refusal event naming the failed run check",
  tr.status === 1 && lastRefused !== undefined &&
  lastRefused.event === "refusal" && lastRefused.command === "complete" && lastRefused.phase === "5" &&
  Array.isArray(lastRefused.problems) && lastRefused.problems.some((p) => typeof p === "string" && p.startsWith("run: ")),
  `status=${tr.status} last=${JSON.stringify(lastRefused)}`);
// The refusal adds exactly one line and it is NOT a completion: the walk's own
// complete 0..4 events are expected, but this refused `complete 5` must not add
// a sixth. (Worded against the delta, not "no complete anywhere" - the trail is
// append-only and legitimately already holds the walk's completions.)
check("T2 the refused completion appends no complete event",
  refusedTrail.length === trailLenBeforeRefusal + 1 &&
  refusedTrail.filter((e) => e.event === "complete").length === completesBeforeRefusal,
  `${trailLenBeforeRefusal} -> ${refusedTrail.length}; completes ${completesBeforeRefusal} -> ${refusedTrail.filter((e) => e.event === "complete").length}`);

// The trail records the attempt from the very first refusal - it is not a log of
// successes only. Asserting the presence of the refusal, not just a non-empty
// file, because the walk's earlier completions would make "non-empty" true even
// if the refusal write were deleted.
const firstTrailBytes = readTrailRaw();
check("T3 the trail file exists and is non-empty after the first refusal",
  statSync(trailFile).size > 0 && firstTrailBytes.trim() !== "" &&
  firstTrailBytes.split("\n").some((l) => l.includes('"refusal"')),
  `${statSync(trailFile).size} bytes`);

// The accepted completion. The policy's `run` check needs an attested `run`
// artifact; attest it, then complete 5 again.
const policyRunTxt = join(ts.sandbox, "out", "run.txt");
writeFileSync(policyRunTxt, "npm test -> 7 passed\n");
const trAttest = run2({ sandbox: ts.sandbox, env: ts.env }, ["attest", tbead, "out/run.txt", "--id", "run", "--kind", "check-output"]);
const beforeSuccess = readTrailRaw();
tr = phaseCmd({ sandbox: ts.sandbox, env: ts.env },
  ["complete", tbead, "5", "--evidence", "the run transcript is attested and its hash matches HEAD",
   "--ran", RAN_CLAIM, "--artifact", bootLog, "--quiet"]);
const afterSuccess = readTrailRaw();
const afterEntries = readTrail(ts.sandbox, tbead);
const lastSuccess = afterEntries[afterEntries.length - 1];
check("T4 the success appends complete and the earlier refusal line is byte-identical",
  trAttest.status === 0 && tr.status === 0 &&
  lastSuccess !== undefined && lastSuccess.event === "complete" && lastSuccess.command === "complete" &&
  lastSuccess.phase === "5" && lastSuccess.ok === true &&
  afterSuccess.startsWith(beforeSuccess) &&
  afterSuccess.slice(beforeSuccess.length).split("\n").filter((l) => l !== "").length === 1,
  `status=${tr.status} last=${JSON.stringify(lastSuccess)} added=${JSON.stringify(afterSuccess.slice(beforeSuccess.length))} attest=${trAttest.status}`);

// verify appends exactly one event per run - not two on the first.
const verifyCountBefore = readTrail(ts.sandbox, tbead).filter((e) => e.event === "verify").length;
const vFirst = verify({ sandbox: ts.sandbox, env: ts.env }, [tbead]);
const verifyCountAfterOne = readTrail(ts.sandbox, tbead).filter((e) => e.event === "verify").length;
const vSecond = verify({ sandbox: ts.sandbox, env: ts.env }, [tbead]);
const verifyCountAfterTwo = readTrail(ts.sandbox, tbead).filter((e) => e.event === "verify").length;
check("T5 two verify runs append exactly one verify event each",
  verifyCountAfterOne === verifyCountBefore + 1 && verifyCountAfterTwo === verifyCountBefore + 2,
  `${verifyCountBefore} -> ${verifyCountAfterOne} -> ${verifyCountAfterTwo} (status ${vFirst.status}, ${vSecond.status})`);

// Every line is a well-formed event: JSON object with at (ISO), a known event
// name, and the bead it belongs to.
const EVENT_NAMES = ["attest", "verify", "refusal", "complete"];
const allEntries = readTrail(ts.sandbox, tbead);
check("T6 every trail line is a well-formed event with at, event and bead",
  allEntries.length > 0 && allEntries.every((e) =>
    typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(e.at) &&
    EVENT_NAMES.includes(e.event) && e.bead === tbead),
  JSON.stringify(allEntries));

rmSandbox(ts.sandbox);

// ---- tier arithmetic at verify time -----------------------------------------
//
// The exit criterion, enforced against the real CLI: the policy file's tier
// arithmetic (prototype 3, regulated 20) is what `verify` demands of a bead.
// The brief says the two policies live in separate temp directories, so each
// case gets its own sandbox: the regulated sandbox carries all twenty ids at
// phase 5, the prototype sandbox the same three ids at phase 5. Every check
// is check-output so one phase can be verified end to end on both tiers.
console.log("\ntier arithmetic: twenty missing, three attested");
const TIER20 = [
  "tests", "run", "review", "lint", "types", "contract", "a11y", "perf",
  "security", "migration", "rollback", "observability", "privacy", "audit",
  "retention", "incident", "dr", "segregation", "training", "attestation",
];
const checksAt5 = (ids) => ids.map((id) =>
  `  ${id}:\n    phase: 5\n    kind: check-output\n    command: npm test\n`).join("");
const regulatedPolicyText =
  "version: 1\ntier: prototype\nprofile: web\n" +
  "\ntiers:\n" +
  "  prototype:\n    checks: [tests, run, review]\n" +
  "  internal:\n    checks: []\n" +
  "  public:\n    checks: []\n" +
  `  regulated:\n    checks: [${TIER20.join(", ")}]\n` +
  "\nprofiles:\n" +
  "  web:\n    checks: []\n" +
  "\nchecks:\n" +
  checksAt5(TIER20);
const prototypePolicyText =
  "version: 1\ntier: prototype\nprofile: web\n" +
  "\ntiers:\n" +
  "  prototype:\n    checks: [tests, run, review]\n" +
  "  internal:\n    checks: []\n" +
  "  public:\n    checks: []\n" +
  "  regulated:\n    checks: []\n" +
  "\nprofiles:\n" +
  "  web:\n    checks: []\n" +
  "\nchecks:\n" +
  checksAt5(["tests", "run", "review"]);

const tierSb = makeSandbox();
const tierVerify = (() => {
  mkdirSync(join(tierSb.sandbox, "config"));
  writeFileSync(join(tierSb.sandbox, "config", "factory.policy.yaml"), regulatedPolicyText);
  const regBead = makeBead(tierSb, "regulated target");
  // bd 1.3.0: `bd update <id> --metadata <json>` sets custom metadata, which
  // loadBeadMeta reads back as the bead's tier override.
  execFileSync("bd", ["update", regBead, "--metadata", JSON.stringify({ tier: "regulated" })],
    { cwd: tierSb.sandbox, env: tierSb.env, stdio: "ignore" });
  const vr = verify(tierSb, [regBead, "--phase", "5", "--json"]);
  let parsed = null;
  try { parsed = JSON.parse(vr.stdout); } catch { /* asserted below */ }
  return { vr, parsed };
})();
check("tier 1 a regulated bead is refused until all twenty are attested",
  tierVerify.vr.status === 1 && tierVerify.parsed !== null &&
  tierVerify.parsed.counts.total === 20 && tierVerify.parsed.counts.failed === 20 &&
  tierVerify.parsed.checks.every((c) => c.result === "missing"),
  `status=${tierVerify.vr.status} counts=${JSON.stringify(tierVerify.parsed && tierVerify.parsed.counts)}`);

const protoSb = makeSandbox();
const protoVerify = (() => {
  mkdirSync(join(protoSb.sandbox, "config"));
  mkdirSync(join(protoSb.sandbox, "out"));
  writeFileSync(join(protoSb.sandbox, "config", "factory.policy.yaml"), prototypePolicyText);
  const bead = makeBead(protoSb, "prototype target");
  // No metadata is set: the bead inherits tier prototype from the policy's
  // own default, which is the second of the brief's two admitted shapes.
  for (const id of ["tests", "run", "review"]) {
    writeFileSync(join(protoSb.sandbox, "out", `${id}.txt`), `${id} -> produced\n`);
    const ar = attest2(protoSb, [bead, `out/${id}.txt`, "--id", id, "--kind", "check-output"]);
    if (ar.status !== 0) throw new Error(`attest ${id} failed: ${ar.stdout}${ar.stderr}`);
  }
  const vr = verify(protoSb, [bead, "--phase", "5", "--json"]);
  let parsed = null;
  try { parsed = JSON.parse(vr.stdout); } catch { /* asserted below */ }
  return { vr, parsed };
})();
check("tier 2 a prototype bead completes after three",
  protoVerify.vr.status === 0 && protoVerify.parsed !== null &&
  protoVerify.parsed.ok === true && protoVerify.parsed.counts.total === 3 &&
  protoVerify.parsed.counts.ok === 3,
  `status=${protoVerify.vr.status} counts=${JSON.stringify(protoVerify.parsed && protoVerify.parsed.counts)}`);

// ---- the builder session is frozen at first write ---------------------------

const bs = makeSandbox();
const bsBead = makeBead(bs, "frozen builder session");
mkdirSync(join(bs.sandbox, "out"), { recursive: true });
writeFileSync(join(bs.sandbox, "out", "a.txt"), "a -> produced\n");
const firstAttest = attest2(bs, [bsBead, "out/a.txt", "--id", "a", "--kind", "check-output"],
  { FACTORY_SESSION: "build-A" });
check("the first attestation records the builder session",
  firstAttest.status === 0 && manifestOf(bs, bsBead).builder_session === "build-A",
  `status=${firstAttest.status} builder_session=${JSON.stringify(manifestOf(bs, bsBead).builder_session)}`);

writeFileSync(join(bs.sandbox, "out", "b.txt"), "b -> produced\n");
const secondAttest = attest2(bs, [bsBead, "out/b.txt", "--id", "b", "--kind", "check-output"],
  { FACTORY_SESSION: "build-B" });
check("a later session cannot rewrite the builder session",
  secondAttest.status === 0 && manifestOf(bs, bsBead).builder_session === "build-A",
  `status=${secondAttest.status} builder_session=${JSON.stringify(manifestOf(bs, bsBead).builder_session)}`);
check("the artifact still records which session produced it",
  secondAttest.status === 0 &&
  manifestOf(bs, bsBead).artifacts.find((a) => a.id === "b").producer_session === "build-B",
  `producer_session=${JSON.stringify((manifestOf(bs, bsBead).artifacts.find((a) => a.id === "b") || {}).producer_session)}`);

// An unset FACTORY_SESSION must still freeze something real: the fallback uuid
// is what the artifact and the manifest share, so "anonymous" is one identity,
// not a hole.
const anon = makeSandbox();
const anonBead = makeBead(anon, "anonymous builder");
mkdirSync(join(anon.sandbox, "out"), { recursive: true });
writeFileSync(join(anon.sandbox, "out", "c.txt"), "c -> produced\n");
const anonAttest = attest2(anon, [anonBead, "out/c.txt", "--id", "c", "--kind", "check-output"]);
const anonSession = manifestOf(anon, anonBead).builder_session;
check("an unset FACTORY_SESSION still freezes one real id",
  anonAttest.status === 0 && /^factory:[0-9a-f-]{36}$/.test(anonSession || "") &&
  manifestOf(anon, anonBead).artifacts.find((a) => a.id === "c").producer_session === anonSession,
  `status=${anonAttest.status} builder_session=${JSON.stringify(anonSession)}`);

// Reading is validated, not trusted: an empty builder_session would compare
// unequal to every reviewer and make self-review look independent.
const badManifestPath = join(anon.sandbox, ".factory", anonBead, "manifest.json");
const goodManifest = readFileSync(badManifestPath, "utf8");
writeFileSync(badManifestPath, JSON.stringify({ version: 1, bead: anonBead, artifacts: [], builder_session: "" }));
let builderRefusal = null;
try { manifestOf(anon, anonBead); } catch (e) { builderRefusal = e.message; }
check("an empty builder_session is a loud read, not a silent default",
  builderRefusal !== null && /builder_session/.test(builderRefusal),
  `error=${JSON.stringify(builderRefusal)}`);
writeFileSync(badManifestPath, goodManifest);

// ---- the declared kind is the only kind that answers a check ----------------
//
// A check declares what evidence answers it. A transcript proves a command ran;
// it says nothing about what a screen showed, so it cannot answer a screenshot
// check. Without this rung the profile matrix is a wish and "evidence" is
// merely a file that hashed. The refusal lives at verify - the gate - rather
// than at attest, so an artifact recorded before its check was written can
// still be reported against rather than silently orphaned.
console.log("\nthe declared kind is the only kind that answers a check");

const ms = makeSandbox();
const mbead = makeBead(ms, "kind mismatch");
mkdirSync(join(ms.sandbox, "config"));
mkdirSync(join(ms.sandbox, "out"));
writeFileSync(join(ms.sandbox, "config", "factory.policy.yaml"),
  "version: 1\ntier: prototype\nprofile: web\n" +
  "\ntiers:\n" +
  "  prototype:\n    checks: [shot]\n" +
  "  internal:\n    checks: []\n" +
  "  public:\n    checks: []\n" +
  "  regulated:\n    checks: []\n" +
  "\nprofiles:\n" +
  "  web:\n    checks: []\n" +
  "\nchecks:\n" +
  "  shot:\n" +
  "    phase: 3\n" +
  "    kind: screenshot\n" +
  "    command: null\n");
writeFileSync(join(ms.sandbox, "out", "shot.txt"), "screenshot of the checkout page\n");
// The bead records its own phase, so verify resolves the policy's phase-3
// checks the way the machine does rather than by a flag the test supplies.
execFileSync("bd", ["set-state", mbead, "phase=3"], { cwd: ms.sandbox, env: ms.env, stdio: "ignore" });

let kc = attest2(ms, [mbead, "out/shot.txt", "--id", "shot", "--kind", "transcript"],
  { FACTORY_SESSION: "build-M" });
check("kind 1 the wrong kind is still attesting (the policy is read at verify, not here)",
  kc.status === 0, `status=${kc.status} stderr=${JSON.stringify(kc.stderr)}`);
kc = verify(ms, [mbead]);
check("kind 2 a transcript cannot stand in for a screenshot: MISMATCH, exit 1",
  kc.status === 1 && /^  MISMATCH\s+shot\s/m.test(kc.stdout),
  `status=${kc.status} stdout=${JSON.stringify(kc.stdout)}`);
check("kind 3 the report names the declared kind, the actual kind and the fix",
  kc.stdout.includes("needs a screenshot artifact; the manifest has transcript") &&
  kc.stdout.includes("--id shot --kind screenshot"),
  kc.stdout);
const mResult = withSandboxEnv(ms, () => verifyChecks(ms.sandbox, mbead, "3", loadPolicy(ms.sandbox)));
check("kind 4 the row carries mismatch, both kinds, and the exact sentence",
  mResult.ok === false && mResult.checks[0].result === "mismatch" &&
  mResult.checks[0].kind === "screenshot" && mResult.checks[0].actual_kind === "transcript" &&
  mResult.checks[0].detail ===
    `check "shot" needs a screenshot artifact; the manifest has transcript (out/shot.txt)`,
  JSON.stringify(mResult.checks));
kc = attest2(ms, [mbead, "out/shot.txt", "--id", "shot", "--kind", "screenshot"]);
check("kind 5 re-attesting with the declared kind verifies",
  kc.status === 0 && verify(ms, [mbead]).status === 0,
  `status=${kc.status} stderr=${JSON.stringify(kc.stderr)}`);

rmSandbox(ms.sandbox);

rmSandbox(bs.sandbox);
rmSandbox(anon.sandbox);

rmSandbox(tierSb.sandbox);
rmSandbox(protoSb.sandbox);

rmSandbox(sandbox);
rmSandbox(pb.sandbox);
rmSandbox(ngEn);
rmSandbox(vs.sandbox);
rmSandbox(np.sandbox);
console.log(`\n${pass}/${pass + fail} attest tests passed.`);
process.exit(fail ? 1 : 0);