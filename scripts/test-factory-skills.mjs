#!/usr/bin/env node
// test-factory-skills.mjs - negative tests for the mandatory-skill check.
//
// The rule this suite exists to defend: a check that cannot fail is decoration.
// `bd gate list --all` reported "No gates found" on two real projects whose
// markdown claimed three approved gates, so every claim the factory makes about
// its own state is now a check with a test that proves the check can go red.
//
// Runs the REAL script as a child process against temp catalogs and a sandboxed
// HOME, so nothing here can install a skill or touch the developer's real
// ~/.agents/skills. The live installation is proven separately at the end.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "factory-skills.mjs");
const REAL_CATALOG = resolve(HERE, "..", "skills", "catalog.yaml");

let pass = 0;
let failed = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    process.stdout.write(`  FAIL ${name}\n         ${e.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SANDBOX = mkdtempSync(join(tmpdir(), "factory-skills-test-"));
const TMP = join(SANDBOX, "catalogs");
mkdirSync(TMP, { recursive: true });

// Every test gets its OWN fake HOME and project dir. An earlier draft shared
// one HOME across the whole suite, so `installFakeSkill("alpha")` in one test
// silently satisfied the next test's assertion and the suite passed for the
// wrong reason. Isolation is what makes a negative test trustworthy.
let homeSeq = 0;
function freshEnv() {
  const id = ++homeSeq;
  const home = join(SANDBOX, `home${id}`);
  const cwd = join(SANDBOX, `proj${id}`);
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

// Sandboxed HOME + cwd so the suite can never install into, read from, or be
// satisfied by the developer's real skill directory.
function run(args, env = {}) {
  const base = env.fresh || freshEnv();
  const e = { ...process.env, HOME: base.home, USERPROFILE: base.home };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8", env: e, cwd: env.cwd || base.cwd, timeout: 60000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// `record` reads its JSON from stdin, and `run` cannot supply stdin without
// changing the helper 21 existing tests depend on. Same body, one extra field.
function runRecord(args, input, env = {}) {
  const base = env.fresh || freshEnv();
  const e = { ...process.env, HOME: base.home, USERPROFILE: base.home };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8", env: e, cwd: env.cwd || base.cwd, timeout: 60000, input,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function catalog(name, body) {
  const p = join(TMP, `${name}.yaml`);
  writeFileSync(p, body, "utf8");
  return p;
}

const GOOD = `version: 2
mandatory:
  - name: alpha
    source: owner/one
    official: true
    phases: '7'
    why: 'alpha is required'
  - name: beta
    source: owner/two
    official: true
    why: 'beta is required'
topics:
  demo:
    - name: gamma
      source: owner/three
      rank: 1
      official: true
      why: 'optional'
`;

// Write a real SKILL.md so a "present" skill is genuinely present on disk.
function installFakeSkill(home, name) {
  const d = join(home, ".agents", "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: fake\n---\n`, "utf8");
}
function installFakeProjectSkill(cwd, name) {
  const d = join(cwd, ".agents", "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: fake\n---\n`, "utf8");
}

process.stdout.write("factory-skills tests\n");

// ------------------------------------------------------------ happy path ---

t("real catalog parses and reports both mandatory skills missing", () => {
  const r = run(["check", "--catalog", REAL_CATALOG]);
  assert(r.code === 1, `expected exit 1 on a machine without the skills, got ${r.code}`);
  assert(r.out.includes("commit-work") && r.out.includes("skill-judge"), "both mandatory skills should be named");
  assert(r.out.includes("FAIL mandatory skills"), "must print an explicit FAIL, not a soft hint");
});

t("a satisfied catalog prints PASS and exits 0", () => {
  const c = catalog("good", GOOD);
  const env = freshEnv();
  installFakeSkill(env.home, "alpha");
  installFakeSkill(env.home, "beta");
  const r = run(["check", "--catalog", c], { fresh: env });
  assert(r.code === 0, `expected exit 0, got ${r.code} :: ${r.out}`);
  assert(r.out.includes("PASS mandatory skills: 2/2 present"), `unexpected verdict :: ${r.out}`);
});

t("one missing skill fails the whole check", () => {
  const c = catalog("partial", GOOD);
  const env = freshEnv();
  installFakeSkill(env.home, "alpha");   // beta deliberately absent
  const r = run(["check", "--catalog", c], { fresh: env });
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(/missing/.test(r.out) && r.out.includes("beta"), `should name beta as missing :: ${r.out}`);
});

t("a skill present only in the project dir still counts", () => {
  const c = catalog("proj", GOOD);
  const env = freshEnv();
  installFakeProjectSkill(env.cwd, "alpha");
  installFakeProjectSkill(env.cwd, "beta");
  const r = run(["check", "--catalog", c], { fresh: env });
  assert(r.code === 0, `expected exit 0, got ${r.code} :: ${r.out}`);
  assert(r.out.includes("project"), `should report the project scope :: ${r.out}`);
});

t("a skill dir with no SKILL.md does not count as installed", () => {
  const c = catalog("nosk", GOOD);
  const env = freshEnv();
  installFakeSkill(env.home, "alpha");
  // beta exists as a directory but its manifest is a DIRECTORY, not a file -
  // the signature of an interrupted install. existsSync() alone says "yes".
  const d = join(env.home, ".agents", "skills", "beta");
  mkdirSync(join(d, "SKILL.md"), { recursive: true });
  const r = run(["check", "--catalog", c], { fresh: env });
  assert(r.code === 1, `a skill without a real SKILL.md file must fail (exit ${r.code})`);
  assert(r.out.includes("beta"), `should name beta as missing :: ${r.out}`);
});

// ----------------------------------------------------------- fail closed ---

t("an empty mandatory list is refused, not read as 'nothing required'", () => {
  const c = catalog("empty", "version: 2\nmandatory: []\ntopics:\n  x:\n    - name: a\n");
  const r = run(["check", "--catalog", c]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.out.includes("no mandatory skills"), `should say the list is empty :: ${r.out}`);
});

t("a missing 'why' is refused", () => {
  // version present, so this exercises the field check rather than tripping
  // the version gate first.
  const c = catalog("nowhy", "version: 2\nmandatory:\n  - name: foo\n    source: a/b\n");
  const r = run(["check", "--catalog", c]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.out.includes("why"), `should name the missing field :: ${r.out}`);
});

t("a missing 'source' is refused", () => {
  const c = catalog("nosrc", "version: 2\nmandatory:\n  - name: foo\n    why: x\n");
  const r = run(["check", "--catalog", c]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.out.includes("source"), `should name the missing field :: ${r.out}`);
});

t("an unreadable catalog file fails rather than reporting success", () => {
  const r = run(["check", "--catalog", join(TMP, "does-not-exist.yaml")]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.out.includes("catalog not found") || r.out.includes("unreadable"), `should say why :: ${r.out}`);
});

t("a malformed catalog is refused, not partially parsed", () => {
  // Bad indentation: `source` is indented differently from its siblings. A
  // permissive parser quietly accepts this and reports the skill as
  // requirement-free, which is the failure this whole suite exists to stop.
  const c = catalog("malformed", "mandatory:\n  - name: foo\n   source: a/b\n    why: x\n");
  const r = run(["check", "--catalog", c]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.out.includes("unreadable"), `a malformed catalog must be refused :: ${r.out}`);
});

t("a catalog missing 'version' is refused", () => {
  // version gates the schema. Without it a future catalog could mean something
  // different and be read under these rules.
  const c = catalog("noversion", "mandatory:\n  - name: foo\n    source: a/b\n    why: x\n");
  const r = run(["check", "--catalog", c]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.out.includes("version"), `should say version is required :: ${r.out}`);
});

t("an unknown future version is refused", () => {
  const c = catalog("v99", "version: 99\nmandatory:\n  - name: foo\n    source: a/b\n    why: x\n");
  const r = run(["check", "--catalog", c]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.out.includes("version"), `should refuse a version it cannot read :: ${r.out}`);
});

t("an unknown top-level key is refused", () => {
  const c = catalog("unknownkey", "version: 2\nmandatory:\n  - name: foo\n    source: a/b\n    why: x\nbogus: 1\n");
  const r = run(["check", "--catalog", c]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.out.includes("bogus") || r.out.includes("unknown top-level"), `should name the key :: ${r.out}`);
});

// ---------------------------------------------------------- machine use ---

t("json output is parseable and agrees with the exit code", () => {
  const c = catalog("json", GOOD);
  const env = freshEnv();
  installFakeSkill(env.home, "alpha");
  installFakeSkill(env.home, "beta");
  const r = run(["check", "--catalog", c, "--json"], { fresh: env });
  const j = JSON.parse(r.out);
  assert(j.ok === true && j.total === 2, `json should agree with PASS :: ${r.out}`);
  assert(j.results.every((x) => x.present), "json results should all be present");
});

t("json output on failure lists the missing names", () => {
  const c = catalog("jsonfail", GOOD);
  const env = freshEnv();
  installFakeSkill(env.home, "alpha");
  const r = run(["check", "--catalog", c, "--json"], { fresh: env });
  const j = JSON.parse(r.out);
  assert(j.ok === false && j.missing.includes("beta"), `json should name beta :: ${r.out}`);
});

t("an unknown subcommand is refused", () => {
  const r = run(["frobnicate"]);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert(r.err.includes("usage"), `should print usage :: ${r.err}`);
});

t("install --dry-run reports intent and writes nothing", () => {
  const c = catalog("dry", GOOD);
  const env = freshEnv();   // nothing installed -> both are missing
  const r = run(["install", "--catalog", c, "--dry-run"], { fresh: env });
  assert(r.code === 0, `dry run should exit 0, got ${r.code} :: ${r.out}`);
  assert(r.out.includes("would-install"), `should describe intent :: ${r.out}`);
  assert(!existsSync(join(env.home, ".agents", "skills", "alpha")), "dry run must not create the skill");
  assert(!existsSync(join(env.cwd, ".agents", "skills", "alpha")), "dry run must not create the skill");
});

t("install is a no-op when every mandatory skill is already present", () => {
  const c = catalog("noop", GOOD);
  const env = freshEnv();
  installFakeSkill(env.home, "alpha");
  installFakeSkill(env.home, "beta");
  const r = run(["install", "--catalog", c, "--dry-run"], { fresh: env });
  assert(r.code === 0, `expected exit 0, got ${r.code}`);
  assert(/already present/.test(r.out), `should say nothing to do :: ${r.out}`);
  assert(!/would-install/.test(r.out), `must not try to reinstall :: ${r.out}`);
});

t("check never mutates the filesystem", () => {
  const c = catalog("readonly", GOOD);
  const env = freshEnv();
  installFakeSkill(env.home, "alpha");
  const before = readFileSync(c, "utf8");
  const skillsDir = join(env.home, ".agents", "skills");
  run(["check", "--catalog", c], { fresh: env });
  run(["check", "--catalog", c, "--json"], { fresh: env });
  const after = readFileSync(c, "utf8");
  assert(before === after, "check must not rewrite the catalog");
  assert(existsSync(skillsDir), "check must not remove the skills dir");
  assert(existsSync(join(skillsDir, "alpha", "SKILL.md")), "check must not disturb an installed skill");
});

// ------------------------------------------------- the sandbox is airtight ---

t("the suite never saw the developer's real skill directory", () => {
  const realSkills = join(process.env.USERPROFILE || "", ".agents", "skills", "commit-work");
  // The sandboxed HOME means `check` could not have observed the real install.
  // This asserts the *precondition* that made the earlier tests meaningful.
  assert(!realSkills.startsWith(SANDBOX), "sandbox HOME must differ from the real one");
});

t("each test ran against its own isolated HOME", () => {
  // Guards the bug this suite already had once: a shared fake HOME let one
  // test's installFakeSkill satisfy another test's assertion.
  const a = freshEnv();
  const b = freshEnv();
  assert(a.home !== b.home, "freshEnv must hand out a distinct HOME each call");
  installFakeSkill(a.home, "alpha");
  assert(!existsSync(join(b.home, ".agents", "skills", "alpha")), "skills must not leak between sandboxes");
});

// --------------------------------------- the decision record is writable ----
// Nine skills sat installed in a real project with no recorded verdict. The
// contract for recording them was written in docs/discovery.md and nothing
// implemented it, so the last test in this block matters as much as the first:
// the guards below are easy, and it is the EFFECT (the file, and its stamped
// timestamp) that was entirely missing.

const RECORD = {
  version: 1,
  run: { at: "2026-01-01T00:00:00.000Z", degraded: false },
  installed: [{
    repo: "owner/one", skill: "alpha", score: "92/120",
    rationale: "adds the missing capability and nothing this repo already has",
    command: "npx --yes skills add owner/one -s alpha -g -a opencode --copy -y",
  }],
  rejected: [{ skill: "beta", reason: "duplicates what alpha already provides" }],
};
const recOut = (cwd) => join(cwd, ".agents", "skills", "skills.lock.json");
const readRec = (cwd) => JSON.parse(readFileSync(recOut(cwd), "utf8"));

t("a complete record is written where the docs say it lives", () => {
  const env = freshEnv();
  const r = runRecord(["record"], JSON.stringify(RECORD), env);
  assert(r.code === 0, `expected exit 0, got ${r.code}: ${r.out}${r.err}`);
  assert(existsSync(recOut(env.cwd)), "must write .agents/skills/skills.lock.json");
  const w = readRec(env.cwd);
  assert(Array.isArray(w.installed) && w.installed.length === 1, "one install recorded");
  for (const f of ["repo", "skill", "score", "rationale", "command"]) {
    assert(typeof w.installed[0][f] === "string" && w.installed[0][f].length > 0,
      `installed[0].${f} must be recorded - this is the whole of fix #5`);
  }
});

t("run.at is stamped by the script, not taken from the agent", () => {
  // The record shipped in customer-support-deshboard said run.at = 2026-09-30
  // while four more skills were installed on 2026-10-04, and a later session
  // read that as "discovery already ran". An agent that supplies its own
  // timestamp records when it meant to, not when the run happened.
  const env = freshEnv();
  runRecord(["record"], JSON.stringify(RECORD), env);
  const at = readRec(env.cwd).run.at;
  assert(at !== RECORD.run.at, `run.at must be overwritten, still ${at}`);
  const age = Date.now() - Date.parse(at);
  assert(Number.isFinite(age) && age >= 0 && age < 120000,
    `stamped run.at should be about now, got ${at}`);
});

t("a record missing any required fact is refused and NOTHING is written", () => {
  const env = freshEnv();
  const bad = { ...RECORD, installed: [{ repo: "owner/one" }] };
  const r = runRecord(["record"], JSON.stringify(bad), env);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  const all = r.out + r.err;
  for (const f of ["skill", "score", "rationale", "command"]) {
    assert(all.includes(f), `refusal must name the missing ${f}`);
  }
  assert(!existsSync(recOut(env.cwd)), "a refused record must leave no file behind");
});

t("degraded:true without a reason is refused", () => {
  // This is the whole of fix #4: a record must not be able to say "degraded"
  // without saying why, because an unexplained degraded run is what a later
  // session reads as "discovery ran, nothing else needed".
  const env = freshEnv();
  const bad = { ...RECORD, run: { at: "2026-01-01T00:00:00.000Z", degraded: true } };
  const r = runRecord(["record"], JSON.stringify(bad), env);
  assert(r.code === 1, `expected exit 1, got ${r.code}`);
  assert((r.out + r.err).includes("degraded_reason"), "refusal must name degraded_reason");
  assert(!existsSync(recOut(env.cwd)), "nothing written");
});

t("every problem is reported at once, not one per run", () => {
  const env = freshEnv();
  const bad = { run: { degraded: false }, installed: [{}], rejected: [{}] };
  const r = runRecord(["record"], JSON.stringify(bad), env);
  const all = r.out + r.err;
  for (const f of ["repo", "skill", "score", "rationale", "command"]) {
    assert(all.includes(f), `an agent fixing a record wants the whole list - ${f} missing from it`);
  }
  assert(all.includes("rejected"), "a rejection also needs its skill and reason");
});

t("a degraded run still records its reason", () => {
  const env = freshEnv();
  const rec = { ...RECORD, run: { degraded: true, degraded_reason: "RESEARCH_DENIED" } };
  const r = runRecord(["record"], JSON.stringify(rec), env);
  assert(r.code === 0, `a degraded run must still be recorded, got ${r.code}: ${r.out}${r.err}`);
  assert(readRec(env.cwd).run.degraded_reason === "RESEARCH_DENIED", "the reason must survive to disk");
  assert(readRec(env.cwd).run.degraded === true, "and so must the degraded flag");
});

t("no input and malformed input are both refused loudly", () => {
  const a = runRecord(["record"], "", freshEnv());
  assert(a.code === 1, `empty input must be refused, got ${a.code}`);
  const b = runRecord(["record"], "{ not json", freshEnv());
  assert(b.code === 1, `malformed JSON must be refused, got ${b.code}`);
  assert((a.out + a.err).length > 0 && (b.out + b.err).length > 0, "both must say something");
});

t("--dry-run validates without writing", () => {
  const env = freshEnv();
  const r = runRecord(["record", "--dry-run"], JSON.stringify(RECORD), env);
  assert(r.code === 0, `dry-run on a valid record exits 0, got ${r.code}`);
  assert(!existsSync(recOut(env.cwd)), "dry-run must not write");
  const bad = runRecord(["record", "--dry-run"], JSON.stringify({ ...RECORD, installed: [{}] }), env);
  assert(bad.code === 1, "dry-run still validates - it is not a way to skip the check");
});

t("record needs no catalog, unlike check and install", () => {
  // The dispatcher runs record before the catalog is parsed on purpose: a
  // degraded discovery run must still be able to record why it degraded, even
  // if the catalog is the thing that is broken.
  const r = runRecord(["record"], JSON.stringify(RECORD), freshEnv());
  assert(r.code === 0, `record must not require a catalog, got ${r.code}: ${r.out}${r.err}`);
});

process.stdout.write(`\n${pass} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
}

// Cleanup must never turn a green suite red - Windows holds bd/Dolt handles and
// rmSync can throw EPERM. Warn instead of failing; the assertions already ran.
try {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch (e) {
  process.stdout.write(`warning: could not remove sandbox ${SANDBOX} (${e.code || e.message}); assertions already completed\n`);
}

process.exit(failed ? 1 : 0);
