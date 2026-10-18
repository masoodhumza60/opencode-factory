#!/usr/bin/env node
// opencode-factory selfcheck. Exits 0 when the factory environment is intact.
// --tokens additionally prints the token-cost estimate of injected context.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";

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
const { platform } = await import("./platform.mjs");
const plat = platform();
const log = plat.state.log();
const MAX_TAIL = 2 * 1024 * 1024;   // start: read the last 2 MB
const MAX_GROW = 64 * 1024 * 1024;  // hard bound on expansion for huge logs
if (existsSync(log)) {
  let fd;
  try {
    fd = openSync(log, "r");
    const size = fstatSync(fd).size;
    // Which plugins SHOULD load is a property of this machine, not of the bundle.
  // The installer decides that: it writes each shim it can actually load, and
  // skips - with a warning - any whose module it could not import. So the
  // expectation is derived from what is on disk plus what the config declares,
  // never from names typed into this file. Typing them in made this check a
  // claim about one machine, and it went red the moment the installer did the
  // right thing.
  const expectedPlugins = () => {
    const names = [];
    const dir = join(homedir(), ".config", "opencode", "plugins");
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".ts") || f.endsWith(".js")) names.push(basename(f).replace(/\.[jt]s$/, ""));
      }
    } catch { /* no plugins dir yet - the count below will say so */ }
    const cfgPath = join(homedir(), ".config", "opencode", "opencode.json");
    if (existsSync(cfgPath)) {
      try {
        const declared = JSON.parse(readFileSync(cfgPath, "utf8")).plugins;
        if (Array.isArray(declared)) names.push(...declared.map((d) => String(d).split("@").slice(0, -1).join("@") || String(d)));
      } catch { /* unreadable config - the count below will say so */ }
    }
    return names;
  };

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
    const expected = expectedPlugins();
    const allDeclared = expected.length > 0 && expected.every((n) => ids.includes(n));
    const missing = expected.filter((n) => !ids.includes(n));
    const targetFailures = haveRun ? failures.filter((l) => runOf(l) === targetRun) : [];
    const basis = haveRun
      ? `from latest opencode run ${targetRun}`
      : loading.length
        ? "plugin-load lines carry no run token (cannot prove same-run)"
        : "no loading-plugin lines in the log tail";
    ok("plugins: all 3 loading", haveRun && allDeclared,
      haveRun ? `expected ${expected.length} declared on this machine: ${expected.join(", ") || "(none)"}` +
        (missing.length ? `; not loaded: ${missing.join(", ")}` : "") : basis);
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
]) {
  const r = process.platform === "win32" ? spawnSync(cmd + " " + args.join(" "), { shell: true, timeout: 15000 }) : spawnSync(cmd, args, { timeout: 15000 });
  ok(name + " present", r.status === 0, r.stdout?.toString().trim().slice(0, 80) ?? "no output");
}
// 3. Conductor skill deployed - and its docs. Checking SKILL.md alone is how a
//    machine ends up passing this check with every reference the conductor
//    makes dangling: the doc is what tells the agent where conductor.md,
//    plan-format.md and discovery.md live, so their absence is a real fault,
//    not a packaging detail.
const factorySkillDir = join(homedir(), ".agents", "skills", "factory");
const factorySkill = join(factorySkillDir, "SKILL.md");
const requiredDocs = ["conductor.md", "how-factory-works.md", "plan-format.md", "discovery.md", "mcp-judging.md"];
const missingDocs = requiredDocs.filter((d) => !existsSync(join(factorySkillDir, "docs", d)));
ok(
  "factory skill deployed",
  existsSync(factorySkill) && missingDocs.length === 0,
  missingDocs.length === 0
    ? factorySkill
    : `${factorySkill} - missing docs: ${missingDocs.join(", ")} (re-run install.ps1/install.sh)`,
);
// 3a. The scripts those docs tell an agent to run. This check exists because a
//     real run proved the absence is invisible otherwise: on 2026-10-10 a phase-5
//     agent read the installed conductor.md, was told to run factory-phase.mjs,
//     and found nothing there - the docs shipped without the machinery every one
//     of them names. The check above was green the whole time. Presence is the
//     floor, not the goal: this also runs the installed phase machine so a file
//     that landed but cannot execute does not read as a healthy install either.
const requiredScripts = [
  "factory-phase.mjs", "factory-mcp.mjs", "factory-plan.mjs",
  "factory-skills.mjs", "factory-selfcheck.mjs", "platform.mjs",
];
const missingScripts = requiredScripts.filter((s) => !existsSync(join(factorySkillDir, "scripts", s)));
ok(
  "factory runtime scripts deployed",
  missingScripts.length === 0,
  missingScripts.length === 0
    ? join(factorySkillDir, "scripts")
    : `missing from the install: ${missingScripts.join(", ")} - the installed docs reference them (re-run install.ps1/install.sh)`,
);
// Drift between what was installed and what is on disk NOW.
//
// This is a warn, not a fail, and the distinction is deliberate. A stale install
// is a normal state: every bundle commit moves the source ahead of the install,
// so a check that went red on it would be red almost always and would be learned
// to ignore. But run 2 of the factory was executed against a stale install - the
// factory-mcp.mjs on disk was a version behind, still speaking V1 while the bundle
// spoke V2 - and every other check passed, because every one of them asked whether
// a file existed rather than whether it was current. A whole six-phase run was
// about to measure the wrong thing and the system could not say so. The install
// now writes a manifest of what it put there; this reports when that is, and
// names any file whose hash has moved since.
// The manifest lives BESIDE the files it describes, in the skill directory. An
// earlier version looked one level up, in the shared skills root, while the
// installer wrote into the skill directory - so the two paths never met and this
// check spent a run reporting on a test fixture. The whole check is worth nothing
// unless this path and the installer's are the same path, which is why the test
// suite asserts that rather than trusting both halves to agree.
const manifestPath = join(factorySkillDir, "install-manifest.json");
if (!existsSync(manifestPath)) {
  warn(
    "install manifest",
    `no manifest at ${manifestPath} - the install predates it, so nothing can say whether these scripts are current. Re-run the installer.`
  );
} else {
  let mf = null;
  // Strip a BOM before parsing rather than treating one as corruption. PowerShell 5.1
  // `Set-Content -Encoding utf8` writes one, and a manifest saved by a human in an
  // editor can carry one too. Neither is a corrupted manifest - calling them one would
  // send the operator to re-run an installer that already worked.
  try {
    mf = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  } catch { /* reported below */ }
  if (!mf || !mf.files) {
    warn("install manifest", `${manifestPath} is unreadable or has no file list - re-run the installer.`);
  } else {
    const drifted = [];
    const missing = [];
    // The bundle has moved ahead of what is installed. This is the direction that
    // matters: nothing on disk changed, so every other check passes and the run
    // measures code the bundle no longer ships. An install four commits behind is
    // silent unless somebody compares against the bundle.
    const behind = [];
    // The manifest predates the bundle_path field, or the recorded source did not
    // resolve. Either way this file cannot be compared, and cannot be called current.
    const uncomp = [];
    // A manifest written by install.sh under Git bash on Windows records the
    // MSYS spelling /c/Users/... . node's existsSync() cannot resolve that, so
    // every file landed in `uncomp` and the check warned forever - blind in the
    // one direction it exists to see. Prefer the recorded path as written, and
    // fall back to the Windows spelling. install.sh now records the Windows
    // spelling; this keeps every already-installed manifest honest in the
    // meantime rather than waiting for the next install run.
    const msysToWindows = (p) => {
      if (!p || existsSync(p)) return p;
      const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
      return m ? `${m[1].toUpperCase()}:${m[2] || "/"}` : p;
    };
    const bundleRoot = msysToWindows(mf.bundle_path);
    const bundleGone = bundleRoot ? !existsSync(bundleRoot) : true;
    for (const [name, entry] of Object.entries(mf.files)) {
      // Keys are paths relative to the skills root, because basename collides:
      // SKILL.md exists under both factory/ and verify-app/.
      const here = join(factorySkillDir, "..", name);
      if (!existsSync(here)) { missing.push(name); continue; }
      // A pre-bundle_path manifest stores a bare hash; a current one stores an
      // object. Reading both is what lets an old install be diagnosed rather than
      // silently reported as fine.
      const want = String(typeof entry === "object" && entry ? entry.hash : entry).toUpperCase();
      const src = typeof entry === "object" && entry ? entry.src : null;
      if (createHash("sha256").update(readFileSync(here)).digest("hex").toUpperCase() !== want) {
        drifted.push(name);
      }
      if (bundleGone || !src) { uncomp.push(name); continue; }
      const there = join(bundleRoot, src);
      if (!existsSync(there)) { uncomp.push(name); continue; }
      if (createHash("sha256").update(readFileSync(there)).digest("hex").toUpperCase() !== want) {
        behind.push(name);
      }
    }
    const age = mf.installed_at
      ? Math.round((Date.now() - Date.parse(mf.installed_at)) / 86400000)
      : null;
    const when = age === null ? mf.installed_at : `${age} day(s) ago`;
    if (drifted.length || missing.length || behind.length) {
      warn(
        behind.length ? "the bundle has moved ahead of the install" : "installed scripts have changed since install",
        `installed ${when} (bundle ${mf.bundle_commit || "unknown"})` +
          (behind.length ? `; ${behind.length} file(s) newer in the bundle: ${behind.join(", ")}` : "") +
          `; ${drifted.length} file(s) edited since: ${drifted.join(", ") || "none"}` +
          (missing.length ? `; ${missing.length} file(s) no longer present: ${missing.join(", ")}` : "") +
          `${behind.length || drifted.length || missing.length ? " - this run is measuring code that is not the current bundle. Re-run the installer before starting a feature." : ""}`
        // The missing files are named, not just counted. A message that says "17
        // files are missing" and then lists nothing is the same failure as a check
        // that passes: it tells you something happened without telling you what.
      );
    } else if (uncomp.length) {
      // Not a pass. A check that cannot compare must not say "current" - that is
      // the exact shape of the bug this replaces: a green line over files nothing
      // had actually looked at.
      warn(
        "install currency not established",
        `installed ${when} (bundle ${mf.bundle_commit || "unknown"}); ${uncomp.length} file(s) could not be compared against the bundle` +
          (bundleGone
            ? ` - the bundle it was installed from is not at ${bundleRoot || "(not recorded, so this manifest predates it)"}, so nothing here can say whether it is current. Re-run the installer from the bundle you intend to use.`
            : ` - the manifest records no bundle source path for: ${uncomp.join(", ")}. Re-run the installer.`) +
          " Reporting this as current would be the one thing this check exists to prevent."
      );
    } else {
      console.log(`     install current as of ${when} (bundle ${mf.bundle_commit || "unknown"}), compared against the bundle at ${bundleRoot}`);
    }
  }
}

// Every hand-kept list of runtime scripts is a list that can go stale. On
// 2026-10-11 mcp-defmatch.mjs was extracted out of factory-mcp.mjs so its
// comparison could be unit-tested; both installers kept their old lists, shipped
// a factory-mcp.mjs that threw ERR_MODULE_NOT_FOUND on its first run, and the
// "factory runtime scripts deployed" check passed the whole time - every file it
// named was present, and the thing that was missing was one none of them named.
// So the check is derived from the files themselves rather than from a list.
const installedScriptsDir = join(factorySkillDir, "scripts");
const unresolvedImports = [];
if (existsSync(installedScriptsDir)) {
  for (const f of readdirSync(installedScriptsDir)) {
    if (!f.endsWith(".mjs")) continue;
    const body = readFileSync(join(installedScriptsDir, f), "utf8");
    for (const m of body.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
      if (!existsSync(join(installedScriptsDir, m[1]))) {
        unresolvedImports.push(`${f} -> ${m[1]}`);
      }
    }
  }
}
ok(
  "every installed script's own imports resolve",
  unresolvedImports.length === 0,
  unresolvedImports.length === 0
    ? installedScriptsDir
    : `these imports do not resolve inside the install: ${unresolvedImports.join(", ")} - the script will throw on load (re-run install.ps1/install.sh)`,
);

// Every hand-kept list can go stale, so the list is not the source of truth -
// the installed docs are. A doc that names scripts/<name>.mjs is telling an
// agent to run something; if the install does not carry it, that agent finds
// nothing, which is how orderboard-a2o phase 5 reported "factory-phase.mjs
// does not exist on this machine". Strict on purpose: repository-only tooling
// is named in prose as living in the repository, because the alternative is
// an exception list nobody reads and a check that has learned to be quiet.
const docsDir = join(factorySkillDir, "docs");
const namedScripts = new Map();
// Paths, not names: SKILL.md sits beside docs/, not inside it. A list of
// names here re-read every entry from docs/ and threw ENOENT on the first run.
const mdFiles = [];
try {
  for (const f of readdirSync(docsDir)) if (f.endsWith(".md")) mdFiles.push(join(docsDir, f));
} catch (e) { /* the catalog check below already speaks to a missing docs dir */ }
if (existsSync(join(factorySkillDir, "SKILL.md"))) mdFiles.push(join(factorySkillDir, "SKILL.md"));
for (const p of mdFiles) {
  const f = basename(p);
  const body = readFileSync(p, "utf8");
  for (const m of body.matchAll(/scripts\/([\w.-]+\.mjs)/g)) {
    if (!namedScripts.has(m[1])) namedScripts.set(m[1], new Set());
    namedScripts.get(m[1]).add(f);
  }
}
const unshipped = [...namedScripts]
  .filter(([name]) => !existsSync(join(installedScriptsDir, name)))
  .map(([name, where]) => name + " (named in " + [...where].join(", ") + ")");
ok(
  "every script the installed docs name is shipped",
  unshipped.length === 0,
  unshipped.length === 0
    ? mdFiles.length + " installed doc(s) name " + namedScripts.size + " script(s), all present"
    : "the installed docs tell an agent to run these and the install does not carry them: " + unshipped.join("; ") + " - ship the script, or say in the doc that it lives in the factory repository (re-run install.ps1/install.sh)",
);

// The catalog is data factory-skills.mjs needs; it resolves it as
// ../skills/catalog.yaml relative to itself, so it has to sit beside the
// scripts rather than inside them.
ok(
  "skills catalog deployed",
  existsSync(join(factorySkillDir, "skills", "catalog.yaml")),
  join(factorySkillDir, "skills", "catalog.yaml"),
);
// The servers this factory depends on are data too: factory-mcp.mjs resolves
// ../config/mcp-requirements.json relative to itself. Absent, it silently keeps
// nothing and calls every server on the machine the user's own - which looks
// like correct output and is not. Checked for content as well as presence,
// because a truncated file parses as nothing rather than as an error.
const reqsPath = join(factorySkillDir, "config", "mcp-requirements.json");
let reqsOk = false, reqsWhy = reqsPath;
if (existsSync(reqsPath)) {
  try {
    const parsed = JSON.parse(readFileSync(reqsPath, "utf8"));
    reqsOk = Array.isArray(parsed.required) && parsed.required.every((x) => typeof x === "string");
    reqsWhy = reqsOk ? `${reqsPath} (${parsed.required.length} declared)` : `${reqsPath} has no string "required" array`;
  } catch (e) {
    reqsWhy = `${reqsPath} is not valid JSON (${e.message})`;
  }
}
ok("mcp requirements deployed", reqsOk, reqsWhy);
// And the effect: the INSTALLED script, with no --requirements flag, must
// actually read that file. A copy that landed in the wrong place passes every
// existsSync above and gets found here.
const declaredForProbe = reqsOk ? JSON.parse(readFileSync(reqsPath, "utf8")).required : [];
if (declaredForProbe.length > 0 && missingScripts.indexOf("factory-mcp.mjs") === -1) {
  const probe = mkdtempSync(join(tmpdir(), "factory-reqs-"));
  // One server named after the declaration, one that is not, so the check can
  // tell "read the file" apart from "always says bundle".
  const named = declaredForProbe[0];
  const other = declaredForProbe.indexOf("probe") === -1 ? "probe" : "probe2";
  const cfgPath = join(probe, "opencode.json");
  writeFileSync(cfgPath, JSON.stringify({
    mcp: { servers: { [named]: { type: "local", command: ["node", "-e", ""] }, [other]: { type: "local", command: ["node", "-e", ""] } } },
  }, null, 2));
  const installedMcp = join(factorySkillDir, "scripts", "factory-mcp.mjs");
  const rr = process.platform === "win32"
    ? spawnSync(`node "${installedMcp}" audit --config "${cfgPath}" --json`, { shell: true, timeout: 30000, encoding: "utf8" })
    : spawnSync("node", [installedMcp, "audit", "--config", cfgPath, "--json"], { timeout: 30000, encoding: "utf8" });
  let bundleLabeled = false, readBack = "";
  try { readBack = `${rr.stdout || ""}${rr.stderr || ""}`; bundleLabeled = /"owner"\s*:\s*"bundle"/.test(readBack); } catch { }
  ok(
    "installed mcp script reads its own declaration",
    bundleLabeled,
    bundleLabeled
      ? `${installedMcp} labelled the declared server bundle-owned without being told`
      : `the installed script did not read ${reqsPath}: ${readBack.trim().split("\n")[0] || "(no output)"}`,
  );
}
// Presence is not the effect. This runs the INSTALLED phase machine and checks
// it fails for the right reason - a usage error naming the commands, not a
// crash. A copy that landed truncated, or one whose sibling imports are missing,
// would pass every existsSync above and fail here, which is the whole point.
if (missingScripts.length === 0) {
  const installedPhase = join(factorySkillDir, "scripts", "factory-phase.mjs");
  const runArgs = [installedPhase];
  const r = process.platform === "win32"
    ? spawnSync("node " + runArgs.join(" "), { shell: true, timeout: 30000, encoding: "utf8" })
    : spawnSync("node", runArgs, { timeout: 30000, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  // Exit 1 with a usage line is the healthy answer here: the script parsed, ran,
  // and refused to guess. A syntax error or a missing import does not look
  // like that, so the check reads the output rather than only the exit code.
  const usable = r.status !== 0 && /usage/i.test(out) && !/SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(out);
  ok(
    "installed phase machine runs",
    usable,
    usable
      ? `${installedPhase} (executed from the install, not the bundle)`
      : `${installedPhase} is present but did not run: exit ${r.status} ${usable ? "" : out.trim().split("\n")[0] || "(no output)"}`,
  );
}
// 3b. The verify-app generator. Phase 5 refuses to complete without a --booted
//     claim, and this skill is what turns that one sentence into a committed,
//     re-runnable artifact. Shipping the guard without the thing that makes the
//     claim checkable would be the guard-without-effect shape again.
const verifyAppSkill = join(homedir(), ".agents", "skills", "verify-app", "SKILL.md");
ok(
  "verify-app skill deployed",
  existsSync(verifyAppSkill),
  existsSync(verifyAppSkill) ? verifyAppSkill : `${verifyAppSkill} (re-run install.ps1/install.sh)`,
);
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
const dcpDir = plat.state.pluginData("dcp");
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
const dcpOverride = join(plat.configDir(), "dcp-prompts", "overrides", "turn-nudge");
if (existsSync(dcpOverride)) ok("dcp: turn-nudge override installed", true, dcpOverride);
else warn("dcp: turn-nudge override installed", `missing — re-run the installer to write ${dcpOverride}`);
// 7. Mandatory third-party skills present. A FAIL, not a WARN, and the reasoning
//    is the whole point of P4: a mandatory skill that is merely warned about is a
//    gate people learn to ignore, and a machine that reaches phase 7 with no
//    commit-work to run has failed at install time, not at ship time.
//
//    This delegates to factory-skills.mjs rather than re-reading the catalog.
//    Two parsers of one file drift, and the second one to be written is the one
//    that quietly disagrees — the defect this project has already shipped twice
//    (docs/superpowers as a second source of truth; gates described in prose
//    while bd reported none). One reader, one answer, machine-checkable.
//
//    `--catalog <path>` exists so scripts/test-selfcheck.mjs can drive the
//    failure path with a catalog whose skills are not installed, rather than
//    mutating the real machine's skills directory.
const skillsScript = join(dirname(fileURLToPath(import.meta.url)), "factory-skills.mjs");
if (!existsSync(skillsScript)) {
  ok("mandatory skills: present", false, `factory-skills.mjs missing from the bundle (${skillsScript})`);
} else {
  const catalogArg = flagValue("--catalog");
  const skillsArgs = [skillsScript, "check", "--json"];
  if (catalogArg) skillsArgs.push("--catalog", catalogArg);
  const sr = process.platform === "win32"
    ? spawnSync("node " + skillsArgs.join(" "), { shell: true, timeout: 30000, encoding: "utf8" })
    : spawnSync("node", skillsArgs, { timeout: 30000, encoding: "utf8" });
  let report = null;
  try { report = JSON.parse((sr.stdout ?? "").trim().split("\n").pop()); } catch { /* handled below */ }
  // `ok: false` is ambiguous and reading it as one meaning is how this check
  // shipped a TypeError instead of a verdict. factory-skills.mjs uses the same
  // flag for two different failures: skills are missing (and it reports
  // `missing` + `total`), or the catalog itself could not be read (and it
  // reports `error`). Trusting the flag without checking the shape reached for
  // `report.missing.length` on undefined and crashed the whole selfcheck — so
  // the verdict must be derived from the shape, never from the flag alone.
  const wellFormed = report && typeof report.ok === "boolean" && Array.isArray(report.missing) && typeof report.total === "number";
  if (!wellFormed) {
    const why = report?.error
      ? `catalog unreadable - ${String(report.error).slice(0, 60)}`
      : `check produced no usable report (exit ${sr.status}) — ${(sr.stderr || sr.stdout || "no output").trim().slice(0, 60)}`;
    ok("mandatory skills: present", false, why);
  } else if (report.ok) {
    ok("mandatory skills: present", true, `${report.total}/${report.total} — ${(report.results ?? []).map((r) => r.name).join(", ")}`);
  } else {
    ok("mandatory skills: present", false,
      `${report.missing.length} of ${report.total} missing: ${report.missing.join(", ")} — fix: node scripts/factory-skills.mjs install`);
  }
}
// 9. Repo-scoped warnings (informational — these never affect the exit code,
//    so installers stay green on healthy machines).
try {
  if (existsSync(join(process.cwd(), ".agents", "skills")) &&
      !existsSync(join(process.cwd(), ".agents", "skills", "skills.lock.json")))
    warn("skills.lock.json missing", "run `factory discover` to record the (possibly empty) outcome");
} catch { /* subdirs unreadable — skip */ }
// 10. Token footprint (--tokens only)
// These are REPORTING lines, not checks. They are deliberately not ok()/warn():
// a health check that cannot fail is a check in a costume, and the one thing
// worth surfacing here -- your own spend -- is not a health signal at all. It
// is a number the human reads when deciding whether to keep going or hand off.
if (process.argv.includes("--tokens")) {
  const beadsCtx = (readFileSync(join(plat.configDir(), "plugins", "opencode-beads.ts"), "utf8").length);
  ok("context footprint rough est.", true, `beads plugin approx ${(beadsCtx / 4000).toFixed(1)}k chars → ~${Math.round(beadsCtx / 4)} tokens`);

  // The orchestrator's own spend in this project. The 7b run measured the
  // orchestrator at ~92% of input-equivalent and the subagents at ~8%, so the
  // number that decides whether to hand off is this one, not the total.
  // parent_id IS NULL picks the orchestrator: a subagent is a session WITH a
  // parent, so without that filter the fresh, cheap sessions get averaged in
  // and the expensive one disappears into the mean.
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(plat.state.db(), { readOnly: true });
    const cwdNorm = process.cwd().replace(/\\/g, "/").toLowerCase();
    const s = db
      .prepare(
        `select tokens_input, tokens_cache_read from session_v2
          where parent_id is null
            and lower(replace(directory,'\\','/')) = ?
          order by time_updated desc limit 1`,
      )
      .get(cwdNorm);
    if (s) {
      const input = Number(s.tokens_input || 0);
      const cache = Number(s.tokens_cache_read || 0);
      console.log(
        `\nthis orchestrator session: ${input.toLocaleString("en-US")} input` +
          (cache ? `, ${cache.toLocaleString("en-US")} cache-read` : "") +
          `\n  (cache reads are ~0.1x, so input is what to compare against a per-task baseline)` +
          `\n  full report: node scripts/measure.mjs   ·   ~300-400k input/task was the pre-phase-machine figure`,
      );
    } else {
      console.log("\norchestrator spend: no session recorded for this directory yet (paths in the DB use forward slashes).");
    }
    db.close();
  } catch (e) {
    console.log(`\norchestrator spend: unavailable (${e.message.split("\n")[0]}) — node scripts/measure.mjs for the full report.`);
  }
}
const failed = checks.filter((c) => !c.pass);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed. Re-run install.ps1/install.sh.`);
  process.exit(1);
}
console.log("\nAll selfchecks passed — factory is ready.");
