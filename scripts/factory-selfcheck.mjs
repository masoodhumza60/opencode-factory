#!/usr/bin/env node
// opencode-factory selfcheck. Exits 0 when the factory environment is intact.
// --tokens additionally prints the token-cost estimate of injected context.
import { readFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const checks = [];
const ok = (name, pass, extra = "") => {
  checks.push({ name, pass, extra });
  console.log(`${pass ? "PASS" : "FAIL  "} ${name}${extra ? " — " + extra : ""}`);
};

// 1. Plugins load cleanly (same-run evidence from the opencode log).
//    The machine-wide log's most recent lines are mostly session noise
//    (`message="spawning process" args="..."` echo the flag values back, so a
//    bare phrase match false-FAILs on a healthy machine). Only the STRUCTURED
//    plugin lines count: a quoted msg/message field whose value is exactly
//    "loading plugin" / "failed to load plugin". We read from the end
//    (bounded, cheap even on huge logs) and group by the `run=<id>` token: all
//    three factory plugin ids must have loaded in the newest run that loaded
//    any plugins, and that same run must show zero load failures.
const log = join(homedir(), ".local", "share", "opencode", "log", "opencode.log");
const MAX_TAIL = 2 * 1024 * 1024;   // start: read the last 2 MB
const MAX_GROW = 64 * 1024 * 1024;  // hard bound on expansion for huge logs
if (existsSync(log)) {
  let fd;
  try {
    fd = openSync(log, "r");
    const size = fstatSync(fd).size;
    const msgOf = (line) => (line.match(/(?:^|\s)(?:msg|message)="([^"]*)"/) ?? [])[1];
    const runOf = (line) => (line.match(/\srun=([0-9a-f]+)/) ?? [])[1];
    const idOf = (line) => {
      const m = line.match(/\sid=(?:"([^"]*)"|([^\s]+))/);
      return m ? m[1] ?? m[2] : "";
    };

    // Read the tail, growing it until it reaches back past the start of the
    // newest plugin-loading run (so that run's startup failures are in view),
    // bounded so a huge log stays cheap.
    let window = Math.min(size, MAX_TAIL);
    let lines = [];
    let loading = [];
    let failures = [];
    let targetRun;
    for (;;) {
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, size - window);
      const parts = buf.toString("utf8").split("\n");
      lines = window >= size ? parts : parts.slice(1); // a cut window may start mid-line
      loading = [];
      failures = [];
      for (const line of lines) {
        const m = msgOf(line);
        if (m === "loading plugin") loading.push(line);
        else if (m === "failed to load plugin") failures.push(line);
      }
      targetRun = runOf(loading[loading.length - 1] ?? "");
      const firstRun = runOf(lines[0] ?? "");
      if (window >= size || window >= MAX_GROW) break;
      if (loading.length > 0 && firstRun !== targetRun) break;
      window = Math.min(size, window * 2);
    }

    const haveRun = typeof targetRun === "string" && targetRun.length > 0;
    const targetLoading = haveRun ? loading.filter((l) => runOf(l) === targetRun) : [];
    const ids = targetLoading.map(idOf).join(" ");
    const allThree =
      ids.includes("opencode-beads") && ids.includes("opencode-pty") && ids.includes("@tarquinen/opencode-dcp");
    const targetFailures = haveRun ? failures.filter((l) => runOf(l) === targetRun) : [];
    const basis = haveRun
      ? `from latest opencode run ${targetRun}`
      : loading.length
        ? "plugin-load lines carry no run token (cannot prove same-run)"
        : "no loading-plugin lines in the log tail";
    ok("plugins: all 3 loading", haveRun && allThree, basis);
    ok("plugins: zero load failures", haveRun && targetFailures.length === 0, haveRun ? `in run ${targetRun}` : basis);
  } catch (e) {
    ok("plugins: all 3 loading", false, `log unreadable: ${e.message.slice(0, 80)}`);
    ok("plugins: zero load failures", false, "log unreadable");
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
} else {
  ok("plugins: log available", false, "no log file found");
}
// 2. CLI binaries
for (const [name, cmd, args] of [
  ["bd", "bd", ["version"]],
  ["graft", "graft", ["--version"]],
]) {
  const r = process.platform === "win32" ? spawnSync(cmd + " " + args.join(" "), { shell: true, timeout: 15000 }) : spawnSync(cmd, args, { timeout: 15000 });
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
