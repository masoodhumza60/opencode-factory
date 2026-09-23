#!/usr/bin/env node
// opencode-factory selfcheck. Exits 0 when the factory environment is intact.
// --tokens additionally prints the token-cost estimate of injected context.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const checks = [];
const ok = (name, pass, extra = "") => {
  checks.push({ name, pass, extra });
  console.log(`${pass ? "PASS" : "FAIL  "} ${name}${extra ? " — " + extra : ""}`);
};

// 1. Plugins load cleanly (same-run evidence: drain the last opencode log)
const log = join(homedir(), ".local", "share", "opencode", "log", "opencode.log");
if (existsSync(log)) {
  const last = readFileSync(log, "utf8").trim().split("\n").slice(-80).join("\n");
  ok("plugins: all 3 loading", /msg="loading plugin"[^\n]*opencode-beads/.test(last) && /msg="loading plugin"[^\n]*opencode-pty/.test(last) && /msg="loading plugin"[^\n]*@tarquinen\/opencode-dcp/.test(last), "from last 80 log lines");
  ok("plugins: zero load failures", !/failed to load plugin/.test(last), "same window");
} else {
  ok("plugins: log available", false, "no log file found");
}
// 2. CLI binaries
for (const [name, cmd, args] of [
  ["bd", "bd", ["version"]],
  ["graft", "graft", ["--version"]],
]) {
  const r = process.platform === "win32" ? spawnSync(cmd, args, { shell: true }) : spawnSync(cmd, args);
  ok(name + " present", r.status === 0, r.stdout?.toString().trim().slice(0, 80) ?? "no output");
}
// 3. Conductor skill deployed
const factorySkill = join(homedir(), ".agents", "skills", "factory", "SKILL.md");
ok("factory skill deployed", existsSync(factorySkill), factorySkill);
// 4. Beads state accessible (git repo has .beads store)
const beadsMarker = existsSync(join(homedir(), ".beads")) || existsSync(".beads") || existsSync(".agit");
ok("beads store present", beadsMarker, "in cwd tree");
// 5. Token footprint (--tokens only)
if (process.argv.includes("--tokens")) {
  const beadsCtx = (readFileSync(join(homedir(), ".config", "opencode", "plugins", "opencode-beads.ts"), "utf8").length);
  ok("context footprint rough est.", true, `beads plugin approx ${(beadsCtx / 4000).toFixed(1)}k chars → ~${Math.round(beadsCtx / 4)} tokens`);
}
const failed = checks.filter((c) => !c.pass);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed. Re-run install.ps1/install.sh.`);
  process.exit(1);
}
console.log("\nAll selfchecks passed — factory is ready.");
