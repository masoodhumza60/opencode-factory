#!/usr/bin/env node
// seed-testapp.mjs - produce the canonical test app, identically, every time.
//
// Why this exists: the 7b test app lived only in a temp directory, and temp
// cleanup deleted it. Every artifact that run had produced - the spec, the
// plan, 103 passing tests - was gone, recoverable only because git objects
// happened to survive underneath. That is not a safe place to keep the thing
// every measurement is compared against.
//
// So the template lives in THIS repo (testapps/orderboard, committed) and this
// script copies it out. The contract is narrow on purpose:
//
//   - the same app every time, from the committed template, never edited in place
//   - total reset, not partial: no node_modules, .beads, graft graph or docs carry over
//   - one git repo per seeded run, so a run is a branch and diff away from the next
//   - the feature the factory is meant to build is ABSENT, verified by this script
//
// The last one is the point of the whole exercise. A seed that already contains
// the finished feature cannot measure whether the factory can build it, so this
// script fails loudly if the template ever grows one.
//
//   node scripts/seed-testapp.mjs <target-dir> [--dry-run] [--no-install]
//
// Exit 0 seeded, 1 refused or failed. Never overwrites a non-empty directory.

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, "..");
const TEMPLATE = join(BUNDLE, "testapps", "orderboard");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noInstall = args.includes("--no-install");
const json = args.includes("--json");
const target = resolve(args.find((a) => !a.startsWith("--")) || "");

// Files the feature under test would create. If the template grows one of these
// the seed is no longer a blank slate and every measurement against it is
// measuring nothing, so this is a hard failure rather than a warning.
const FEATURE_FILES = ["src/orders/csv.ts", "src/orders/csv.test.ts", "src/orders/range.ts", "src/orders/range.test.ts"];

const say = (...a) => { if (!json) console.log(...a); };
const emit = (o) => { if (json) console.log(JSON.stringify(o)); };

function die(msg, stage) {
  if (json) console.log(JSON.stringify({ ok: false, stage, error: msg }));
  else console.error(`seed-testapp: ${msg}`);
  process.exit(1);
}

if (!target) die("a target directory is required: seed-testapp.mjs <target-dir>", "usage");

if (!existsSync(TEMPLATE)) die(`template missing at ${TEMPLATE} - the bundle is incomplete`, "template-missing");

const present = FEATURE_FILES.filter((f) => existsSync(join(TEMPLATE, f)));
if (present.length)
  die(`the template already contains the feature (${present.join(", ")}). A seed that ships the finished work cannot measure building it.`, "template-not-blank");

// Total reset means refusing anything that is not an empty or absent directory.
if (existsSync(target)) {
  const entries = readdirSync(target);
  if (entries.length && !entries.every((e) => e === ".git" || e === ".DS_Store"))
    die(`${target} is not empty (${entries.slice(0, 5).join(", ")}). Seed into a fresh directory so a run cannot inherit the last one's state - that inheritance is what made an earlier run uninterpretable.`, "target-not-empty");
}

function walk(dir, base = "") {
  const out = [];
  for (const e of readdirSync(join(dir, base))) {
    const rel = base ? `${base}/${e}` : e;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(TEMPLATE);
if (dryRun) {
  say(`seed-testapp: would copy ${files.length} file(s) from testapps/orderboard to ${target}${noInstall ? " (no install)" : ""}`);
  emit({ ok: true, dryRun: true, files: files.length, target });
  process.exit(0);
}

mkdirSync(target, { recursive: true });
for (const rel of files) {
  const to = join(target, rel);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, readFileSync(join(TEMPLATE, rel))); // bytes, so no encoding is invented here
}
say(`seed-testapp: copied ${files.length} file(s) -> ${target}`);

// A run is a repo. Not committing the seed means the first agent edit is the
// first commit and there is nothing to diff the run against.
const git = (a) => execFileSync("git", a, { cwd: target, stdio: ["ignore", "pipe", "pipe"] });
try {
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["-c", "user.name=factory", "-c", "user.email=factory@localhost", "commit", "-q", "-m", "seed: orderboard (canonical test app, feature unimplemented)"]);
  say("seed-testapp: git repository initialised with one seed commit");
} catch (e) {
  die(`could not initialise a git repository in ${target}: ${(e.stderr || e.message).toString().trim()}`, "git-failed");
}

if (!noInstall) {
  say("seed-testapp: npm ci (this is what makes tsc and vitest genuinely runnable)");
  try {
    // On Windows the npm entry point is npm.cmd, and a spawned process cannot
    // resolve the bare name "npm" (ENOENT). Naming npm.cmd is not enough either:
// Node refuses to spawn a .cmd without a shell (EINVAL) since the fix for
// CVE-2024-27980, and passing args through shell:true earns a deprecation
// warning about unescaped arguments. So go through cmd.exe with FIXED literals
// and pass the directory as cwd rather than interpolating it into a command
// string - which would be the actual injection surface. All three facts were
// found by running this, not by reading it.
    const npmArgs = ["ci", "--no-audit", "--no-fund"];
    if (process.platform === "win32") execFileSync("cmd.exe", ["/d", "/s", "/c", "npm ci --no-audit --no-fund"], { cwd: target, stdio: ["ignore", "pipe", "pipe"] });
    else execFileSync("npm", npmArgs, { cwd: target, stdio: ["ignore", "pipe", "pipe"] });
    say("seed-testapp: dependencies installed");
  } catch (e) {
    die(`npm ci failed: ${(e.stderr || e.message).toString().trim()}`, "install-failed");
  }
}

say("");
say("next: open a session in that directory and run the factory against a feature.");
say(`seed-testapp: ${files.length} file(s), feature absent, git ready.`);
emit({ ok: true, target, files: files.length, installed: !noInstall });