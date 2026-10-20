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
import { verifyChecks } from "./factory-attest.mjs";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const script = resolve(dirname(fileURLToPath(import.meta.url)), "factory-attest.mjs");

// The sixteen kinds are pinned here from docs/factory-domain-profiles.md so
// the CLI cannot satisfy this refusal by truncating the list.
const KINDS = [
  "screenshot", "transcript", "contract", "api-diff", "plan", "eval",
  "hil-log", "prr", "exit-code-matrix", "golden-file", "help-snapshot",
  "tty-transcript", "completion-script", "install-log", "device-capture",
  "check-output",
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
check("8 a bad kind is refused naming every one of the sixteen",
  r.status === 1 && r.stderr.includes("telepathy") && KINDS.every((k) => r.stderr.includes(k)),
  `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
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

let vr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("v0 attest tests exits 0", vr.status === 0, `status=${vr.status} stderr=${JSON.stringify(vr.stderr)}`);
vr = attest2(vs, [vbead, "out/review.txt", "--id", "review", "--kind", "prr"]);
check("v0 attest review exits 0", vr.status === 0, `status=${vr.status} stderr=${JSON.stringify(vr.stderr)}`);

console.log("\nverify 1: all current, no session");
vr = verify(vs, [vbead]);
check("1 exits 0 with both checks current and no FACTORY_SESSION",
  vr.status === 0, `status=${vr.status} stdout=${JSON.stringify(vr.stdout)} stderr=${JSON.stringify(vr.stderr)}`);
check("1 review is NOT-APPLICABLE and tests is ok",
  /^  ok\s+tests\s/m.test(vr.stdout) && /^  NOT-APPLICABLE\s+review\s+.*FACTORY_SESSION is not set$/m.test(vr.stdout),
  vr.stdout);
check("1 the summary counts 2 checks, 1 ok, 0 failed",
  vr.stdout.includes("2 checks, 1 ok, 0 failed"), vr.stdout);
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
  v1Result.checks[1].result === "not-applicable" &&
  ["id", "result", "path", "sha256", "commit", "head", "kind", "fix"].every((k) => k in v1Result.checks[0]),
  JSON.stringify(v1Result.checks));
const vTrail = readTrail(vs.sandbox, vbead).filter((e) => e.event === "verify");
check("1 the trail's last line is a verify event with ok: true",
  vTrail.length === 1 && vTrail[0].ok === true && vTrail[0].total === 2 &&
  vTrail[0].passed === 1 && vTrail[0].failed === 0 && vTrail[0].phase === "7",
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

console.log("\nverify 8: independence");
vr = attest2(vs, [vbead, "out/review.txt", "--id", "review", "--kind", "prr"], { FACTORY_SESSION: "ses_same" });
check("8 re-attesting review as ses_same exits 0", vr.status === 0, `status=${vr.status}`);
vr = attest2(vs, [vbead, "out/tests.txt", "--id", "tests", "--kind", "check-output"]);
check("8 tests is current for the session cases", vr.status === 0, `status=${vr.status}`);
vr = verify(vs, [vbead], { FACTORY_SESSION: "ses_same" });
check("8 the same session verifying its own verdict is INDEPENDENCE, exit 1",
  vr.status === 1 && /^  INDEPENDENCE\s+review\s+.*same session that is verifying it \(ses_same\)/m.test(vr.stdout),
  `status=${vr.status} ${vr.stdout}`);

console.log("\nverify 9: different sessions");
vr = attest2(vs, [vbead, "out/review.txt", "--id", "review", "--kind", "prr"], { FACTORY_SESSION: "ses_a" });
check("9 re-attesting review as ses_a exits 0", vr.status === 0, `status=${vr.status}`);
vr = verify(vs, [vbead], { FACTORY_SESSION: "ses_b" });
check("9 a different session verifying is ok, exit 0",
  vr.status === 0 && /^  ok\s+review\s/m.test(vr.stdout), `status=${vr.status} ${vr.stdout}`);

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

rmSandbox(sandbox);
rmSandbox(pb.sandbox);
rmSandbox(ngEn);
rmSandbox(vs.sandbox);
rmSandbox(np.sandbox);
console.log(`\n${pass}/${pass + fail} attest tests passed.`);
process.exit(fail ? 1 : 0);