#!/usr/bin/env node
// The drill must be proven on a sandbox, never on the real machine. This suite
// creates a fake $HOME, runs every step against it, forces failures, and checks
// that the fake home is byte-identical afterwards.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  drill, backupRoots, verifyInstall, restoreBackup, verifyRollback, checkBackupPlacement,
} from "./factory-delivery.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};

const SANDBOX = mkdtempSync(join(tmpdir(), "factory-delivery-test-"));

function fakeHome({ opencode = { "opencode.json": '{"plugins":[]}\n' }, skills = {} }) {
  const home = join(SANDBOX, "home");
  rmSync(home, { recursive: true, force: true });
  const oc = join(home, ".config", "opencode");
  const sk = join(home, ".agents", "skills");
  mkdirSync(oc, { recursive: true });
  mkdirSync(sk, { recursive: true });
  for (const [rel, body] of Object.entries(opencode)) {
    const full = join(oc, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  for (const [rel, body] of Object.entries(skills)) {
    const full = join(sk, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return home;
}
const fakeBackupDir = () => mkdtempSync(join(SANDBOX, "backup-"));

// -- backup ------------------------------------------------------------------
console.log("backup and manifest");
{
  const home = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  const backup = fakeBackupDir();
  const head = "deadbeef";
  const m = backupRoots(home, backup, head);
  check("manifest records head, created_at and home",
    m.head === head && typeof m.created_at === "string" && m.home === home);
  const keys = Object.keys(m.files).sort();
  check("manifest has one entry per file across both roots",
    keys.length === 2
      && keys.includes("opencode/opencode.json")
      && keys.includes("agents-skills/factory/SKILL.md"),
    keys.join(","));
  for (const [k, e] of Object.entries(m.files)) {
    check(`entry ${k} carries sha256 and size`,
      typeof e.sha256 === "string" && e.sha256.length === 64 && Number.isInteger(e.size) && e.size >= 0);
  }
  const stored = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  check("manifest.json is written and parses", stored.head === head && Object.keys(stored.files).length === 2);
}

// a missing source root refuses BEFORE any backup is written
{
  const home = join(SANDBOX, "empty-home");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const backup = fakeBackupDir();
  let threw = false;
  try { backupRoots(home, backup, "head"); } catch (e) { threw = /\.config[\/\\]opencode|missing/i.test(String(e.message)); }
  check("a missing .config/opencode root refuses by name", threw);
  check("the refusal wrote no manifest", !existsSync(join(backup, "manifest.json")));
}

// -- pre-existing empty directories are recorded, never pruned --------------
console.log("\npre-existing empty directories");
{
  const home = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  mkdirSync(join(home, ".agents", "skills", "preexisting-empty", "nested"), { recursive: true });
  mkdirSync(join(home, ".config", "opencode", "plugins-empty"), { recursive: true });
  const m = backupRoots(home, fakeBackupDir(), "head");
  check("the backup manifest records pre-existing empty dirs, resolved absolute",
    Array.isArray(m.dirs)
      && m.dirs.includes(resolve(join(home, ".agents", "skills", "preexisting-empty", "nested")))
      && m.dirs.includes(resolve(join(home, ".config", "opencode", "plugins-empty"))),
    JSON.stringify(m.dirs));
  check("a non-empty pre-existing dir is NOT recorded as an empty one",
    Array.isArray(m.dirs) && !m.dirs.includes(resolve(join(home, ".agents", "skills", "preexisting-empty"))),
    JSON.stringify(m.dirs));
  check("non-empty directories are not recorded as pre-existing empties",
    Array.isArray(m.dirs) && !m.dirs.includes(resolve(join(home, ".agents", "skills"))));

  // a full drill: the install creates an empty dir; rollback must prune it and keep ours
  const home2 = fakeHome({
    opencode: { "opencode.json": "{}" },
    skills: {
      "factory/SKILL.md": "skill",
      "factory/install-manifest.json": JSON.stringify({ bundle_commit: "abc1234", files: {} }),
    },
  });
  mkdirSync(join(home2, ".agents", "skills", "preexisting-empty", "nested"), { recursive: true });
  const installCreatesEmptyDir = () => { mkdirSync(join(home2, ".agents", "skills", "install-created-empty"), { recursive: true }); };
  const r = drill({ home: home2, backup: fakeBackupDir(), selfcheck: () => 0, install: installCreatesEmptyDir, head: "abc1234" });
  check("the drill passes with pre-existing empty dirs in the home", r.ok && r.code === 0, JSON.stringify(r));
  check("pre-existing empty dir survives rollback", existsSync(join(home2, ".agents", "skills", "preexisting-empty")));
  check("pre-existing nested empty dir survives rollback", existsSync(join(home2, ".agents", "skills", "preexisting-empty", "nested")));
  check("install-created empty dir is pruned by rollback", !existsSync(join(home2, ".agents", "skills", "install-created-empty")));
}

// -- rollback restore --------------------------------------------------------
console.log("\nrestore");
{
  const home = fakeHome({
    opencode: { "opencode.json": "{}", "plugins/keep.ts": "keep" },
    skills: { "factory/SKILL.md": "skill" },
  });
  const backup = fakeBackupDir();
  backupRoots(home, backup, "head");
  // simulate install: modify one file, add two new files, delete one old file
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), '{"plugins":["x"]}');
  writeFileSync(join(home, ".agents", "skills", "factory", "NEW.md"), "install artifact");
  rmSync(join(home, ".agents", "skills", "factory", "SKILL.md"));
  const r = restoreBackup(home, backup);
  check("restore reports restored, removed and pruned counts",
    r.restored === 3 && r.removed === 1, JSON.stringify(r));
  check("the modified file came back byte-exact",
    readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8") === "{}");
  check("the deleted backup file is restored",
    existsSync(join(home, ".agents", "skills", "factory", "SKILL.md")));
  check("the install-artifact file is removed",
    !existsSync(join(home, ".agents", "skills", "factory", "NEW.md")));
  check("the user's keep.ts is untouched",
    readFileSync(join(home, ".config", "opencode", "plugins", "keep.ts"), "utf8") === "keep");
}

console.log("\nverify rollback byte-compare");
{
  const home = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  const backup = fakeBackupDir();
  backupRoots(home, backup, "head");
  const v = verifyRollback(home, backup);
  check("an untouched home verifies", v.ok && v.problems.length === 0, v.problems.join(" | "));
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), '{"changed":true}');
  const v2 = verifyRollback(home, backup);
  check("an edited file is caught by byte-compare", !v2.ok && v2.problems.some(p => p.includes("opencode.json")));
  writeFileSync(join(home, ".config", "opencode", "new.ts"), "added");
  const v3 = verifyRollback(home, backup);
  check("an added file is caught by byte-compare", !v3.ok && v3.problems.some(p => p.includes("new.ts")));
}

// -- install verification ----------------------------------------------------
console.log("\ninstall verification");
{
  const home = fakeHome({
    opencode: { "opencode.json": "{}" },
    skills: {
      "factory/SKILL.md": "skill",
      "factory/install-manifest.json": JSON.stringify({
        installed_at: "2026-11-08T00:00:00Z",
        bundle_commit: "abc1234",
        files: {},
      }),
    },
  });
  const backup = fakeBackupDir();
  const m = backupRoots(home, backup, "abc1234"); // HEAD == bundle_commit
  const v1 = verifyInstall(home, m, { selfcheck: () => 0 });
  check("selfcheck 0 + matching bundle_commit verifies", v1.ok, v1.problems.join(" | "));
  const v2 = verifyInstall(home, m, { selfcheck: () => 1 });
  check("selfcheck non-zero refuses", !v2.ok && v2.problems.some(p => /selfcheck/i.test(p)));
  const mWrong = { ...m, head: "0000000" };
  const v3 = verifyInstall(home, mWrong, { selfcheck: () => 0 });
  check("bundle_commit mismatch refuses", !v3.ok && v3.problems.some(p => /bundle_commit|HEAD/i.test(p)));
  // the installer evidence (install-manifest.json) names a file whose live bytes
  // don't match the recorded hash: install verification must refuse
  writeFileSync(join(home, ".agents", "skills", "factory", "install-manifest.json"),
    JSON.stringify({
      bundle_commit: "abc1234", bundle_path: "/fake/bundle", installed_at: new Date().toISOString(),
      files: { "factory/SKILL.md": { hash: "0".repeat(64), src: "factory/SKILL.md" } },
    }));
  const m2 = backupRoots(home, fakeBackupDir(), "abc1234");
  const v4 = verifyInstall(home, m2, { selfcheck: () => 0 });
  check("a manifest hash mismatch refuses", !v4.ok && v4.problems.some(p => /SKILL\.md/i.test(p)));
}

// -- default selfcheck (runs the installed copy, not the repo's) --------------
console.log("\ndefault selfcheck");
{
  const home = fakeHome({
    opencode: { "opencode.json": "{}" },
    skills: {
      "factory/SKILL.md": "skill",
      "factory/scripts/factory-selfcheck.mjs": "process.exit(1);",
      "factory/install-manifest.json": JSON.stringify({ bundle_commit: "abc1234", files: {} }),
    },
  });
  const m = backupRoots(home, fakeBackupDir(), "abc1234");
  const v = verifyInstall(home, m); // no selfcheck param — must run the installed copy
  check("the default selfcheck runs the installed copy and refuses on non-zero",
    !v.ok && v.problems.some(p => /selfcheck|exited 1/i.test(p)),
    v.problems.join(" | "));
  // fresh home for the exit-0 state
  const home2 = fakeHome({
    opencode: { "opencode.json": "{}" },
    skills: {
      "factory/SKILL.md": "skill",
      "factory/scripts/factory-selfcheck.mjs": "process.exit(0);",
      "factory/install-manifest.json": JSON.stringify({ bundle_commit: "abc1234", files: {} }),
    },
  });
  const m2 = backupRoots(home2, fakeBackupDir(), "abc1234");
  const v2 = verifyInstall(home2, m2);
  check("the default selfcheck passes on exit 0",
    v2.ok && !v2.problems.some(p => /factory-selfcheck|failed to run/i.test(p)),
    v2.problems.join(" | "));
}

// -- the drill end to end (sandboxed) ---------------------------------------
console.log("\ndrill end to end");
{
  const home = fakeHome({
    opencode: { "opencode.json": "{}" },
    skills: {
      "factory/SKILL.md": "skill",
      "factory/install-manifest.json": JSON.stringify({
        bundle_commit: "abc1234",
        files: { "factory/SKILL.md": { hash: "", src: "skills/factory/SKILL.md" } },
      }),
    },
  });
  const backup = fakeBackupDir();
  // a fake "install" that mutates one file and adds one file
  const fakeInstall = () => {
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), '{"plugins":["x"]}\n');
    writeFileSync(join(home, ".agents", "skills", "factory", "install-manifest.json"),
      JSON.stringify({ bundle_commit: "abc1234", files: {} }));
  };
  const r = drill({ home, backup, selfcheck: () => 0, install: fakeInstall, head: "abc1234" });
  check("a passing drill exits ok", r.ok && r.code === 0, JSON.stringify(r));
  check("the drill wrote a transcript", existsSync(r.transcript));
  const m = verifyRollback(home, backup);
  check("after the drill the fake home is restored byte-identically", m.ok, m.problems.join(" | "));

  // a mid-drill failure triggers auto-rollback
  const home2 = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  const backup2 = fakeBackupDir();
  const badInstall = () => { writeFileSync(join(home2, ".config", "opencode", "opencode.json"), '{"broken":true}\n'); throw new Error("install exploded"); };
  const r2 = drill({ home: home2, backup: backup2, selfcheck: () => 0, install: badInstall, head: "abc1234" });
  check("a mid-drill failure exits non-zero", !r2.ok && r2.code === 1);
  const m2 = verifyRollback(home2, backup2);
  check("auto-rollback restored the fake home", m2.ok, m2.problems.join(" | "));
  check("the failure transcript names the install error",
    readFileSync(r2.transcript, "utf8").includes("install exploded"));

  // --no-auto-rollback leaves the broken state and prints instructions
  const home3 = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  const backup3 = fakeBackupDir();
  const r3 = drill({ home: home3, backup: backup3, noAutoRollback: true, selfcheck: () => 0, install: badInstall, head: "abc1234" });
  check("--no-auto-rollback exits non-zero", !r3.ok && r3.code === 1);
  check("--no-auto-rollback does NOT restore",
    readFileSync(join(home3, ".config", "opencode", "opencode.json"), "utf8") === '{"broken":true}\n');

  // auto-rollback failure: the backup is unreadable at restore time -
  // the drill must still exit non-zero and the transcript must name the restore failure
  const home5 = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  const backup5 = fakeBackupDir();
  const destroyBackup = () => {
    writeFileSync(join(home5, ".config", "opencode", "opencode.json"), '{"broken":true}\n');
    rmSync(backup5, { recursive: true, force: true });
    throw new Error("install exploded");
  };
  const r5 = drill({ home: home5, backup: backup5, selfcheck: () => 0, install: destroyBackup, head: "abc1234" });
  check("an auto-rollback failure exits non-zero", !r5.ok && r5.code === 1);
  check("the transcript names the restore failure",
    readFileSync(r5.transcript, "utf8").includes("AUTO-ROLLBACK FAILED"));
}

// -- backup placement refusals -----------------------------------------------
console.log("\nbackup placement refusals");
{
  // fresh empty backup OK to proceed
  const home = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  const emptyBackup = fakeBackupDir(); // exists, empty
  let installRan = false;
  const okDrill = drill({
    home,
    backup: emptyBackup,
    selfcheck: () => 0,
    install: () => { installRan = true;
      writeFileSync(join(home, ".agents", "skills", "factory", "install-manifest.json"), JSON.stringify({ bundle_commit: "abc1234", files: {} })); },
    head: "abc1234",
  });
  check("a fresh empty backup directory proceeds", okDrill.ok && okDrill.code === 0 && installRan, JSON.stringify(okDrill));
  check("the empty-backup run wrote a manifest into the backup", existsSync(join(emptyBackup, "manifest.json")));

  // a string-prefix sibling of the home is NOT nested and must be allowed
  const p = checkBackupPlacement(home, join(SANDBOX, "home-evil-sibling"));
  check("a backup whose name merely shares a prefix with home is not refused", p.ok, p.problems.join(" | "));

  // nested under .config/opencode (empty, non-existent) — refused, not created
  const nestedBackup = join(home, ".config", "opencode", "drill-backup");
  installRan = false;
  const r1 = drill({ home, backup: nestedBackup, selfcheck: () => 0, install: () => { installRan = true; }, head: "abc1234" });
  check("a backup nested under .config/opencode is refused (exit 1)", !r1.ok && r1.code === 1, JSON.stringify({ ok: r1.ok, code: r1.code }));
  check("the nested refusal names the root it collides with", (r1.problems ?? []).some(x => /inside or equal/.test(x) && x.includes(".config")), JSON.stringify(r1.problems));
  check("the nested refusal created nothing and ran no install", !existsSync(nestedBackup) && !installRan);

  // nested deep under .agents/skills, path does not exist yet — still refused
  const deepNested = join(home, ".agents", "skills", "a", "b");
  const r2 = drill({ home, backup: deepNested, selfcheck: () => 0, install: () => {}, head: "abc1234" });
  check("a deep non-existent backup nested under .agents/skills is refused", r2.code === 1 && (r2.problems ?? []).some(x => /inside or equal/.test(x)), JSON.stringify(r2.problems));
  check("the deep nested refusal created nothing", !existsSync(deepNested));

  // backup equal to a root — refused
  const r3 = drill({ home, backup: join(home, ".agents", "skills"), selfcheck: () => 0, install: () => {}, head: "abc1234" });
  check("a backup equal to an install root is refused", r3.code === 1 && (r3.problems ?? []).some(x => /inside or equal/.test(x)), JSON.stringify(r3.problems));

  // backup under home but outside the two roots — refused (backup inside the tree it snapshots)
  const underHome = join(home, "my-backup");
  const r4 = drill({ home, backup: underHome, selfcheck: () => 0, install: () => {}, head: "abc1234" });
  check("a backup inside the home being drilled is refused", r4.code === 1 && (r4.problems ?? []).some(x => /inside the home/.test(x)), JSON.stringify(r4.problems));
  check("the under-home refusal created nothing", !existsSync(underHome));

  // the home inside the backup dir — refused
  const bigBackup = join(SANDBOX, "big-backup");
  const nestedHome = join(bigBackup, "home");
  mkdirSync(join(nestedHome, ".config", "opencode"), { recursive: true });
  mkdirSync(join(nestedHome, ".agents", "skills"), { recursive: true });
  writeFileSync(join(nestedHome, ".config", "opencode", "opencode.json"), "{}");
  const r5 = drill({ home: nestedHome, backup: bigBackup, selfcheck: () => 0, install: () => {}, head: "abc1234" });
  check("a home nested inside the backup dir is refused", r5.code === 1 && (r5.problems ?? []).some(x => /inside the backup directory/.test(x)), JSON.stringify(r5.problems));
  check("the home-inside-backup refusal created no backup", !existsSync(join(bigBackup, "manifest.json")) && readdirSync(bigBackup).length === 1);

  // non-empty reuse refused, listing what was found — stale files must not be re-manifested
  const reused = fakeBackupDir();
  writeFileSync(join(reused, "stale.txt"), "stale");
  const home3 = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  installRan = false;
  const r6 = drill({ home: home3, backup: reused, selfcheck: () => 0, install: () => { installRan = true; }, head: "abc1234" });
  check("a non-empty existing backup directory is refused (exit 1)", !r6.ok && r6.code === 1, JSON.stringify({ ok: r6.ok, code: r6.code }));
  check("the non-empty refusal lists what was found", (r6.problems ?? []).some(x => /not empty/.test(x) && x.includes("stale.txt")), JSON.stringify(r6.problems));
  check("the non-empty refusal touched neither home nor backup", !installRan && existsSync(join(reused, "stale.txt")) && readFileSync(join(home3, ".config", "opencode", "opencode.json"), "utf8") === "{}");
  let threw = null;
  try { backupRoots(home3, reused, "abc1234"); } catch (e) { threw = String(e.message); }
  check("backupRoots also refuses the reused backup directory directly", !!threw && /not empty/.test(threw), String(threw));

  // backup path exists as a file — refused
  const fileBackup = join(SANDBOX, "backup-as-file");
  writeFileSync(fileBackup, "x");
  const r7 = drill({ home: home3, backup: fileBackup, selfcheck: () => 0, install: () => {}, head: "abc1234" });
  check("a backup path that is a file is refused", r7.code === 1 && (r7.problems ?? []).some(x => /not a directory/.test(x)), JSON.stringify(r7.problems));

  // CLI: nested backup exits 1 and says why on stderr
  const home4b = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
  const nestedCli = join(home4b, ".config", "opencode", "cli-backup");
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "factory-delivery.mjs");
  const cli = spawnSync(process.execPath, [CLI, "drill", "--home", home4b, "--backup", nestedCli], { encoding: "utf8" });
  check("CLI refuses a nested backup with exit 1 and a clear message",
    cli.status === 1 && /refusing to run/.test(cli.stderr) && /inside or equal/.test(cli.stderr),
    `status=${cli.status} stderr=${cli.stderr}`);
  check("the CLI refusal created nothing", !existsSync(nestedCli));
}

// -- install exits 0 but fails verification: drill must roll back -----------
console.log("\ninstall exits 0 but verification fails");
{
  const home = fakeHome({
    opencode: { "opencode.json": "{}" },
    skills: { "factory/SKILL.md": "skill" },
  });
  const backup = fakeBackupDir();
  // a fake "successful" install: exits 0, but records a WRONG bundle_commit
  const fakeInstall = () => {
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), '{"plugins":["x"]}\n');
    writeFileSync(join(home, ".agents", "skills", "factory", "install-manifest.json"),
      JSON.stringify({ bundle_commit: "0000000", files: {} }));
  };
  const r = drill({ home, backup, selfcheck: () => 0, install: fakeInstall, head: "abc1234" });
  check("install exits 0 but records the wrong bundle_commit -> drill fails", !r.ok && r.code === 1, JSON.stringify(r));
  check("the transcript names the bundle_commit mismatch",
    typeof r.transcript === "string" && readFileSync(r.transcript, "utf8").includes("bundle_commit"));
  const m = verifyRollback(home, backup);
  check("auto-rollback restored the fake home", m.ok, m.problems.join(" | "));
  check("the fake home is byte-identical after the failed drill",
    readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8") === "{}");
}

// -- CLI ---------------------------------------------------------------------
console.log("\nCLI");
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-delivery.mjs");
const home4 = fakeHome({ opencode: { "opencode.json": "{}" }, skills: { "factory/SKILL.md": "skill" } });
const backup4 = fakeBackupDir();
const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
check("--help explains the invocation and never attests",
  help.status === 0 && help.stdout.includes("drill --backup") && /never attests/i.test(help.stdout));
const noBackup = spawnSync(process.execPath, [SCRIPT, "drill", "--home", home4], { encoding: "utf8" });
check("no --backup is a usage error", noBackup.status === 1 && /--backup/.test(noBackup.stderr));

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} delivery tests passed.`);
process.exit(fail ? 1 : 0);
