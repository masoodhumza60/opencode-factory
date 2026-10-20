// Tests for `factory-attest attest`: the CLI that records one artifact on a
// bead. The suite drives the real command as a child process in a throwaway
// sandbox - git repo, its own beads workspace (BEADS_DIR pointed at it), one
// bead, one artifact file - and reads the manifest and trail it leaves
// behind. Refusal cases sweep the same way, checking exit code 1 and the
// message that names the fix.

import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
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
check("11 a non-git directory is refused naming the git repository fix",
  r.status === 1 && r.stderr.includes("git repository"), `status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
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

rmSandbox(sandbox);
rmSandbox(pb.sandbox);
rmSandbox(ngEn);
console.log(`\n${pass}/${pass + fail} attest tests passed.`);
process.exit(fail ? 1 : 0);
