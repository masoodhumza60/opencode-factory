#!/usr/bin/env node
// M3's whole point: "set up my factory from <repo>" must be a verifiable local
// act, not a promise. This script backs up the live install, re-installs from
// this repo, proves the install, and rolls the machine back either way. It is
// unpinned on purpose: it orchestrates, it does not grade. It never attests.
import { existsSync, statSync, mkdirSync, cpSync, readdirSync, readFileSync, createReadStream, writeFileSync, rmSync, truncateSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOTS = [".config/opencode", ".agents/skills"];
const ROOT_PREFIX = { ".config/opencode": "opencode", ".agents/skills": "agents-skills" };
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USAGE =
  "usage: node scripts/factory-delivery.mjs drill --backup <dir> [--no-auto-rollback] [--home <dir>]\n" +
  "\nBacks up ~/.config/opencode and ~/.agents/skills, re-installs from this repo, verifies the install, and restores the pre-drill state. Never attests. --help prints this.";

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const isoNow = () => new Date().toISOString().replace(/[:.]/g, "-");

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

export function backupRoots(home, backup, head = gitHead()) {
  // Refuse before touching anything if a root is missing — an empty backup is not a backup.
  for (const root of ROOTS) {
    const src = join(home, root);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      throw new Error(`${src} does not exist or is not a directory: back up the real install root first`);
    }
  }
  mkdirSync(backup, { recursive: true });
  const files = {};
  for (const root of ROOTS) {
    const src = join(home, root);
    const dst = join(backup, ROOT_PREFIX[root]);
    cpSync(src, dst, { recursive: true });
    for (const f of walkFiles(dst)) {
      const rel = relative(backup, f).replace(/\\/g, "/");
      files[rel] = { sha256: sha256File(f), size: statSync(f).size };
    }
  }
  const manifest = { head, created_at: new Date().toISOString(), home, roots: ROOTS, files };
  writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function gitHead() {
  try { return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { throw new Error("could not resolve repo HEAD with git rev-parse --short HEAD"); }
}

export function readManifest(backup) {
  const p = join(backup, "manifest.json");
  if (!existsSync(p)) throw new Error(`${p} does not exist: run backup first`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export function verifyInstall(home, manifest, { selfcheck } = {}) {
  const problems = [];
  const run = selfcheck ?? (() => runSelfcheck(home));
  try {
    const code = run();
    if (code !== 0) problems.push(`factory-selfcheck.mjs exited ${code}: the install is not healthy`);
  } catch (e) {
    problems.push(`factory-selfcheck.mjs failed to run: ${e.message}`);
  }
  const mPath = join(home, ".agents", "skills", "factory", "install-manifest.json");
  if (!existsSync(mPath)) {
    problems.push(`${mPath} does not exist: the installer did not write an install manifest`);
    return { ok: false, problems };
  }
  let im;
  try { im = JSON.parse(readFileSync(mPath, "utf8")); }
  catch (e) { problems.push(`${mPath} does not parse: ${e.message}`); return { ok: false, problems }; }
  if (im.bundle_commit !== manifest.head) {
    problems.push(`install-manifest bundle_commit is "${im.bundle_commit}", this repo's HEAD is "${manifest.head}": the install does not match this bundle`);
  }
  const base = join(home, ".agents", "skills");
  for (const [rel0, meta] of Object.entries(im.files ?? {})) {
    // The real installer has been seen writing keys prefixed with "skills/";
    // tolerate that prefix so the drill verifies the installed tree, not the spelling.
    const rel = rel0.startsWith("skills/") ? rel0.slice("skills/".length) : rel0;
    const live = join(base, rel);
    if (!existsSync(live)) { problems.push(`install-manifest file missing on disk: ${rel}`); continue; }
    // The installer writes Get-FileHash (UPPERCASE); Node digests are lowercase.
    // Compare case-insensitively, or a byte-perfect install reads as mismatch.
    const h = sha256File(live).toLowerCase();
    if (h !== String(meta.hash ?? "").toLowerCase()) problems.push(`install-manifest hash mismatch: ${rel}`);
  }
  return { ok: problems.length === 0, problems };
}

function runSelfcheck(home) {
  const p = join(home, ".agents", "skills", "factory", "scripts", "factory-selfcheck.mjs");
  if (!existsSync(p)) throw new Error(`${p} does not exist: the installed bundle is missing scripts/factory-selfcheck.mjs`);
  const r = spawnSync(process.execPath, [p, "--home", home],
    { cwd: home, encoding: "utf8", timeout: 20 * 60 * 1000 });
  return r.status ?? 1;
}

export function restoreBackup(home, backup) {
  const manifest = readManifest(backup);
  let restored = 0, removed = 0, pruned = 0;
  // 1) every backed-up file goes back, overwriting whatever is there now
  for (const rel of Object.keys(manifest.files)) {
    const src = join(backup, rel);
    const dst = join(home, rel.startsWith("opencode/") ? join(".config", "opencode", rel.slice("opencode/".length)) : join(".agents", "skills", rel.slice("agents-skills/".length)));
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
    restored += 1;
  }
  // 2) delete only files that are NOT in the manifest — install artifacts
  for (const root of ROOTS) {
    const liveRoot = join(home, root);
    for (const f of walkFiles(liveRoot)) {
      const rel = root === ".config/opencode"
        ? `opencode/${relative(liveRoot, f).replace(/\\/g, "/")}`
        : `agents-skills/${relative(liveRoot, f).replace(/\\/g, "/")}`;
      if (!manifest.files[rel]) { rmSync(f, { force: true }); removed += 1; }
    }
    pruned += pruneEmptyDirs(liveRoot);
  }
  return { restored, removed, pruned };
}

function pruneEmptyDirs(root) {
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = join(dir, entry.name);
        walk(full);
        if (readdirSync(full).length === 0) { rmSync(full, { recursive: true, force: true }); count += 1; }
      }
    }
  };
  walk(root);
  return count;
}

export function verifyRollback(home, backup) {
  const manifest = readManifest(backup);
  const problems = [];
  const seen = new Set();
  for (const [rel, meta] of Object.entries(manifest.files)) {
    const live = join(home, rel.startsWith("opencode/") ? join(".config", "opencode", rel.slice("opencode/".length)) : join(".agents", "skills", rel.slice("agents-skills/".length)));
    seen.add(live);
    if (!existsSync(live)) { problems.push(`missing after rollback: ${rel}`); continue; }
    if (sha256File(live) !== meta.sha256) problems.push(`modified after rollback: ${rel}`);
    if (statSync(live).size !== meta.size) problems.push(`size changed after rollback: ${rel}`);
  }
  for (const root of ROOTS) {
    for (const f of walkFiles(join(home, root))) {
      if (!seen.has(f)) problems.push(`not in the backup manifest: ${f}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export function drill({ home = homedir(), backup, noAutoRollback = false, selfcheck, install, head } = {}) {
  const transcriptName = `${isoNow()}-drill.md`;
  const transcriptPath = join(REPO_ROOT, "out", "delivery", transcriptName);
  const lines = [];
  const log = (line) => { lines.push(line); console.log(line); };
  mkdirSync(dirname(transcriptPath), { recursive: true });
  const finish = (ok, code, extra = []) => {
    lines.push("", ...extra);
    writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");
    return { ok, code, transcript: transcriptPath };
  };
  const restoreAndReport = (reason) => {
    if (noAutoRollback) {
      return finish(false, 1, [`FAILURE: ${reason}`, "auto-rollback disabled (--no-auto-rollback); restore manually from the backup."]);
    }
    try {
      const r = restoreBackup(home, backup);
      const v = verifyRollback(home, backup);
      return finish(false, 1, [`FAILURE: ${reason}`, `auto-rollback ran: restored ${r.restored} files, removed ${r.removed}, pruned ${r.pruned} empty directories`, v.ok ? "rollback verified byte-identical" : `rollback verification problems: ${v.problems.join(" | ")}`]);
    } catch (e) {
      return finish(false, 1, [`FAILURE: ${reason}`, `AUTO-ROLLBACK FAILED: ${e.message}`, "the machine may be in a half-restored state; restore from the backup by hand"]);
    }
  };
  if (!backup) return finish(false, 1, ["usage: no --backup directory given"]);
  try {
    const resolvedHead = head ?? gitHead();
    log(`# factory delivery drill — ${new Date().toISOString()}`);
    log(`HEAD: ${resolvedHead}`);
    log(`home: ${home}`);
    log("step 2: backup …");
    const manifest = backupRoots(home, backup, resolvedHead);
    log(`backup written: ${Object.keys(manifest.files).length} files -> ${backup}`);
    log("step 3: install …");
    let installOut = "";
    if (install) { install(); installOut = "injected install"; }
    else {
      const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(REPO_ROOT, "install.ps1")], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60 * 60 * 1000 });
      installOut = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      log(installOut.trim());
      if (r.status !== 0) return restoreAndReport(`install.ps1 exited ${r.status}`);
    }
    log("step 4: verify install …");
    const v = verifyInstall(home, manifest, selfcheck ? { selfcheck } : {});
    if (!v.ok) return restoreAndReport(`install verification failed: ${v.problems.join(" | ")}`);
    log("install verification: OK");
    log("step 5: rollback …");
    const r = restoreBackup(home, backup);
    log(`rollback: restored ${r.restored} files, removed ${r.removed}, pruned ${r.pruned}`);
    log("step 6: verify rollback …");
    const vb = verifyRollback(home, backup);
    if (!vb.ok) return finish(false, 1, [`rollback verification failed: ${vb.problems.join(" | ")}`]);
    log("rollback verified byte-identical");
    return finish(true, 0, ["delivery ok — the bundle installs here and the machine is back to its pre-drill state"]);
  } catch (e) {
    return restoreAndReport(e.message);
  }
}

function main(argv) {
  if (argv.includes("--help")) { console.log(USAGE); return 0; }
  const i = argv.indexOf("--backup");
  const backup = i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  if (argv[0] !== "drill" || !backup) { console.error(USAGE); return 1; }
  const home = argv.includes("--home") ? argv[argv.indexOf("--home") + 1] : homedir();
  const result = drill({ home, backup, noAutoRollback: argv.includes("--no-auto-rollback") });
  return result.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
