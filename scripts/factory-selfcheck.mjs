#!/usr/bin/env node
// opencode-factory selfcheck. Exits 0 when the factory environment is intact.
// --tokens additionally prints the token-cost estimate of injected context.
import { readFileSync, existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const checks = [];
const ok = (name, pass, extra = "") => {
  checks.push({ name, pass, extra });
  console.log(`${pass ? "PASS" : "FAIL  "} ${name}${extra ? " — " + extra : ""}`);
};
// Informational only: never enters `checks`, so it cannot change the exit code.
// A fresh session that has not needed pruning yet is a fact about the machine's
// current state, not a broken install — installers must stay green there.
const warn = (name, msg) => console.log(`WARN ${name} — ${msg}`);

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
// 5. DCP is actually pruning, not merely loaded. Check 1 proves dcp *started*;
//    it says nothing about whether pruning is doing anything. A loaded-but-idle
//    dcp passes every other check here and silently does nothing, which is the
//    failure this catches. DCP is a nudge channel rather than a budget — it
//    asked a runaway session to compress five times and was ignored five times
//    — so this does not try to promote it into a budget. It only proves it is
//    doing the job it is actually capable of doing.
//
//    Sampling several recent sessions, not just the newest one. Keying off a
//    single newest-by-mtime file made this check cry wolf: a fresh session has
//    pruned nothing, so running selfcheck in one reported WARN on a perfectly
//    healthy machine, and a large historical state file could lose an mtime
//    race to an idle new one. A health check that fires on healthy machines is
//    one people learn to ignore. So: inspect the most recent DCP_RECENT
//    sessions, and pass if any of them shows pruning. Every session inspected
//    is named, so the answer is auditable rather than mysterious.
//
//    `--dcp-state <file>` inspects exactly one state file, and
//    `--dcp-session <id>` targets one session by name. Both exist so the
//    negative tests in scripts/test-selfcheck.mjs can drive the failure paths.
const DCP_RECENT = 5;
const dcpDir = join(homedir(), ".local", "share", "opencode", "storage", "plugin", "dcp");
const dcpRead = (file) => {
  const s = JSON.parse(readFileSync(file, "utf8"));
  // The config has manualMode as an object ({enabled, automaticStrategies});
  // the per-session state file holds the resolved boolean. Read the state.
  return {
    id: s.sessionId ?? basename(file, ".json"),
    manual: s.manualMode === true,
    pruned: s.stats?.totalPruneTokens ?? s.stats?.pruneTokenCounter ?? 0,
  };
};
const flagValue = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};
let dcpFiles = [];
const dcpStateArg = flagValue("--dcp-state");
const dcpSessionArg = flagValue("--dcp-session");
if (dcpStateArg) {
  dcpFiles = [dcpStateArg];
} else {
  try {
    dcpFiles = readdirSync(dcpDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => {
        const p = join(dcpDir, n);
        return { p, at: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, dcpSessionArg ? dcpFiles.length : DCP_RECENT)   // a named session may be any age
      .map((e) => e.p);
  } catch { /* no dcp state yet */ }
}
if (dcpSessionArg && !dcpStateArg) {
  const want = dcpSessionArg.endsWith(".json") ? dcpSessionArg : dcpSessionArg + ".json";
  try {
    const all = readdirSync(dcpDir);
    const hit = all.find((n) => n === want || n.replace(/\.json$/, "") === dcpSessionArg);
    dcpFiles = hit ? [join(dcpDir, hit)] : [];
  } catch { /* no dcp state yet */ }
  if (!dcpFiles.length) ok("dcp: pruning active", false, `no state file for session ${dcpSessionArg}`);
}
if ((!dcpStateArg && !dcpSessionArg && dcpFiles.length === 0) || dcpFiles.some((f) => !existsSync(f))) {
  ok("dcp: pruning active", false, "no dcp session state found — plugin loaded but never ran");
} else {
  const seen = [];
  let prunedAny = false;
  let manualAny = false;
  let bad = null;
  for (const f of dcpFiles) {
    try {
      const r = dcpRead(f);
      seen.push(r);
      if (r.manual) manualAny = true;
      if (r.pruned > 0) prunedAny = true;
    } catch (e) {
      bad = `${basename(f)}: ${e.message.slice(0, 50)}`;
    }
  }
  const list = seen.length
    ? seen.map((r) => `${r.id.slice(0, 8)}:${r.pruned.toLocaleString("en-US")}${r.manual ? "!" : ""}`).join(" ")
    : "none readable";
  if (manualAny)
    ok("dcp: pruning active", false, `manualMode is true in at least one session (auto-pruning OFF) — [${list}]`);
  else if (bad)
    ok("dcp: pruning active", false, `state unreadable — ${bad}`);
  else if (prunedAny)
    ok("dcp: pruning active", true, `${seen.filter((r) => r.pruned > 0).length}/${seen.length} recent sessions pruning — [${list}]`);
  else
    warn("dcp: pruning active", `no recent session has pruned yet (${list}); expected in a fresh session, re-check once real work has happened`);
}
// 6. The turn-nudge override. A WARN, not a FAIL: it is deliberately deletable
//    by a user who prefers dcp's stock wording, and it only activates after an
//    OpenCode restart, so a missing file right after install is not an error.
const dcpOverride = join(homedir(), ".config", "opencode", "dcp-prompts", "overrides", "turn-nudge");
if (existsSync(dcpOverride)) ok("dcp: turn-nudge override installed", true, dcpOverride);
else warn("dcp: turn-nudge override installed", `missing — re-run the installer to write ${dcpOverride}`);
// 7. Repo-scoped warnings (informational — these never affect the exit code,
//    so installers stay green on healthy machines).
try {
  const wiring = join(process.cwd(), "graft", ".graph", "wiring.json");
  if (existsSync(wiring)) {
    const w = JSON.parse(readFileSync(wiring, "utf8"));
    if ((w.nodeCount ?? 0) === 0)
      warn("graft graph has 0 nodes", "run `graft build`; the conductor rebuilds at implement/debug entry");
  }
} catch { /* not a graft repo or unreadable graph — skip */ }
try {
  if (existsSync(join(process.cwd(), ".agents", "skills")) &&
      !existsSync(join(process.cwd(), ".agents", "skills", "skills.lock.json")))
    warn("skills.lock.json missing", "run `factory discover` to record the (possibly empty) outcome");
} catch { /* subdirs unreadable — skip */ }
// 8. Token footprint (--tokens only)
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
