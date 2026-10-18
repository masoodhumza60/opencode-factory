// Integration smoke test: the ONE thing the other 487 tests cannot check.
//
// Every existing suite tests a script in the repo, against a fixture. None runs
// the installer, none talks to a real `bd`, and none executes the INSTALLED copy
// of anything. The suites validate $bundle/scripts; the thing an operator
// actually runs lives in $HOME/.agents/skills/factory/scripts. Nothing in this
// repo checks that the second thing exists, runs, and agrees with the first.
//
// So this test walks that boundary once, with nothing mocked:
//   1. copy the BUNDLE (not just install.sh - it resolves siblings from
//      BASH_SOURCE, so a lone copy dies at line 60 with exit 127)
//   2. point $HOME at a throwaway directory and run the real installer
//   3. bd init a throwaway repo and create a real bead
//   4. run the INSTALLED factory-phase.mjs and make a real phase transition
//   5. assert status agrees
//
// FALSIFIER, and the reason this is not another hollow test: remove one file from
// install.sh's `runtime` array and this test MUST go red. If it does not, it
// proves nothing and belongs in the bin with the others. That costs a second
// install, so this file is slow on purpose - roughly half an hour, run by hand.
// A test that crosses the real boundary cannot also be a fast one.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const SKIP = ["node_modules", ".git", "testapps", "docs/superpowers"];

let pass = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { failures.push(name + (detail ? " -- " + detail : "")); console.log("  FAIL " + name + (detail ? " -- " + detail : "")); }
};
const sh = (cmd, timeout = 1800000) => spawnSync(BASH, ["-lc", cmd], { encoding: "utf8", timeout });

function copyBundle(dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(REPO, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP.includes(e.name)) continue;
      cpSync(join(REPO, e.name), join(dest, e.name), { recursive: true });
    } else {
      cpSync(join(REPO, e.name), join(dest, e.name));
    }
  }
  return join(dest, "install.sh");
}

// The runtime array is the falsifier's target. If install.sh ever renames this,
// the mutation throws rather than silently becoming a no-op that "passes".
function dropPhaseFromRuntime(installerPath) {
  const before = readFileSync(installerPath, "utf8");
  const after = before.replace("local runtime=(factory-phase.mjs ", "local runtime=(");
  if (after === before) throw new Error("MUTATION ANCHOR NOT FOUND - install.sh's runtime array changed shape, so this falsifier is no longer testing anything");
  writeFileSync(installerPath, after, "utf8");
}

// Everything throwaway this test makes lives under one folder rather than loose
// in the system temp root. That root is shared with every other tool on the
// machine and already holds thousands of unrelated entries, so five prefixes
// scattered across it are not somewhere a human can usefully look - and if this
// test ever dies before its finally block, "where did those go" is a question
// nobody can answer cheaply. One directory answers it.
const SCRATCH = join(tmpdir(), "opencode", "smoke");
mkdirSync(SCRATCH, { recursive: true });
const scratch = (what) => mkdtempSync(join(SCRATCH, what + "-"));
const t0 = Date.now();
console.log("scratch root: " + SCRATCH);
const roots = [];
try {
  const bdv = spawnSync("bd", ["--version"], { encoding: "utf8" });
  const bdRuns = bdv.status === 0;
  console.log("real `bd` available: " + bdRuns + (bdRuns ? "  (" + (bdv.stdout || "").trim() + ")" : ""));
  if (!bdRuns) {
    // Refusing is the whole point. This file exists because 487 tests all mock;
    // skipping it silently would be the same failure wearing a different hat.
    console.log("\nSKIP (exit 2): without a real `bd` this would degenerate into exactly the kind of test it replaces.");
    process.exit(2);
  }

  // ---------------- clean run ------------------------------------------------
  const home = scratch("home");
  const bundle = scratch("bundle");
  roots.push(home, bundle);
  const installer = copyBundle(bundle);

  console.log("\n=== install: HOME=" + home + " bundle=" + bundle + " ===");
  const inst = sh(`HOME="${home}" bash "${installer}" --skip-bd 2>&1`);
  const instOut = (inst.stdout || "") + (inst.stderr || "");
  console.log(instOut.trim().split(/\r?\n/).slice(-12).map((l) => "  " + l).join("\n"));
  console.log("  installer exit: " + inst.status + "  (" + Math.round((Date.now() - t0) / 1000) + "s)");
  check("install.sh exited 0", inst.status === 0, instOut.slice(-400));

  const skill = join(home, ".agents", "skills", "factory");
  const phaseScript = join(skill, "scripts", "factory-phase.mjs");
  check("the installed phase script exists at the path SKILL.md tells the agent to use", existsSync(phaseScript), phaseScript);
  check("SKILL.md was installed", existsSync(join(skill, "SKILL.md")));
  check("all 8 runtime scripts were installed", existsSync(join(skill, "scripts")) && readdirSync(join(skill, "scripts")).length >= 8,
    existsSync(join(skill, "scripts")) ? String(readdirSync(join(skill, "scripts")).length) : "no scripts dir");
  check("the config landed under the throwaway home", existsSync(join(home, ".config", "opencode")));
  console.log("  installed: " + (existsSync(join(skill, "scripts")) ? readdirSync(join(skill, "scripts")).join(", ") : "(none)"));

  // ---------------- real bead, real transition ------------------------------
  const work = scratch("work");
  roots.push(work);
  const proj = join(work, "proj");
  mkdirSync(proj, { recursive: true });
  sh(`cd "${proj}" && git init -q && git config user.email t@t && git config user.name t`);
  sh(`cd "${proj}" && bd init smoke >/dev/null 2>&1`);

  // bd names the bead from the repo, not from `bd init`'s argument. Ask bd
  // instead of parsing its output - another place I guessed wrong already.
  const mk = sh(`cd "${proj}" && bd create --title="smoke bead" --type=task 2>&1`);
  const listed = sh(`cd "${proj}" && bd ready --json 2>/dev/null || bd list --json 2>&1`);
  let bead = "";
  try {
    const j = JSON.parse((listed.stdout || "").trim());
    const arr = Array.isArray(j) ? j : j.issues || j.results || [];
    bead = (arr[0] && (arr[0].id || arr[0].key)) || "";
  } catch { bead = ((mk.stdout || "").match(/[\w-]*-\w+\s*│?/g) || [])[0]?.trim().split(/\s/)[0] || ""; }
  console.log("  bead: " + (bead || "(could not determine)"));
  check("bd gave us a real bead id", !!bead, (mk.stdout || "").slice(0, 200));

  if (bead) {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const enter = spawnSync(process.execPath, [phaseScript, "enter", bead, "1", "--reason", "smoke test"], {
      cwd: proj, encoding: "utf8", env, timeout: 120000 });
    console.log("  enter exit=" + enter.status + "  " + JSON.stringify(((enter.stdout || "") + (enter.stderr || "")).slice(0, 240)));
    check("the INSTALLED phase script accepts a real transition", enter.status === 0, "exit " + enter.status);

    const st = spawnSync(process.execPath, [phaseScript, "status", bead], { cwd: proj, encoding: "utf8", env, timeout: 120000 });
    const text = ((st.stdout || "") + (st.stderr || "")).trim();
    console.log("  status: " + text.replace(/\r?\n/g, " | ").slice(0, 320));
    check("status agrees with the transition we just made", /1/.test(text), text.slice(0, 240));
  }

  // ---------------- THE FALSIFIER --------------------------------------------
  console.log("\n=== FALSIFIER: drop factory-phase.mjs from the runtime array ===");
  const home2 = scratch("mut-home");
  const bundle2 = scratch("mut-bundle");
  roots.push(home2, bundle2);
  const installer2 = copyBundle(bundle2);
  dropPhaseFromRuntime(installer2);
  const mut = sh(`HOME="${home2}" bash "${installer2}" --skip-bd 2>&1`);
  const mutOut = (mut.stdout || "") + (mut.stderr || "");
  const phase2 = join(home2, ".agents", "skills", "factory", "scripts", "factory-phase.mjs");
  console.log("  mutated installer exit: " + mut.status);
  check("MUTATION detected: the mutated install did not ship the phase script", !existsSync(phase2), "still present");
  check("MUTATION detected: the mutated install named the file it skipped", /factory-phase\.mjs/.test(mutOut), mutOut.slice(-300));
} finally {
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
}

console.log("\n" + pass + " passed, " + failures.length + " failed  (" + Math.round((Date.now() - t0) / 60000) + "m)");
if (failures.length) { console.log("failures:"); for (const f of failures) console.log("  - " + f); process.exitCode = 1; }