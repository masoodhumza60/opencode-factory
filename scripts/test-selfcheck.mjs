#!/usr/bin/env node
// Negative tests for factory-selfcheck.mjs — the suite that proves our checks
// can actually fail.
//
// Why this exists: the bundle once shipped a check that could only ever pass,
// and a check that cannot fail is decoration. Proving a check fails is easy to
// do once in a throwaway shell command and easy to forget, so the proof has to
// live in the repo or it does not exist. The dcp check's grading is also a
// judgement call that is easy to get backwards, so it is pinned here: a fresh
// session that has pruned nothing must WARN, never FAIL, or the check cries wolf
// on healthy machines and people learn to ignore it.
//
// Run:  node scripts/test-selfcheck.mjs
// Exits 0 when every expectation holds, 1 otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const SELFCHECK = join(here, "factory-selfcheck.mjs");
let failures = 0;
let ran = 0;

const report = (name, pass, detail = "") => {
  ran += 1;
  if (pass) console.log(`  ok   ${name}${detail ? " — " + detail : ""}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// Run the real selfcheck script, optionally pointed at a specific dcp state
// file, and return {code, out} so we can assert both the exit code and the
// verdict line for the check under test.
const runSelfcheck = (args = []) => {
  const r = spawnSync(process.execPath, [SELFCHECK, ...args], { encoding: "utf8", timeout: 120000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return { code: r.status, out, line: (re) => (out.split(/\r?\n/).find((l) => re.test(l)) ?? "").trim() };
};

const tmp = mkdtempSync(join(tmpdir(), "factory-selfcheck-test-"));
const state = (name, body) => {
  const p = join(tmp, name + ".json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return p;
};

try {
  console.log("dcp: pruning active — grading of every branch");
  // 1. Pruned session must PASS. This is the healthy case.
  {
    const r = runSelfcheck(["--dcp-state", state("pruned", { manualMode: false, stats: { totalPruneTokens: 784530 } })]);
    report("pruned session PASSes", r.line(/^PASS\s+dcp: pruning active/) !== "", r.line(/dcp: pruning active/));
  }
  // 2. manualMode true must FAIL — auto-pruning is genuinely off.
  {
    const r = runSelfcheck(["--dcp-state", state("manual", { manualMode: true, stats: { totalPruneTokens: 0 } })]);
    report("manualMode:true FAILs (auto-pruning off)", r.line(/^FAIL\s+dcp: pruning active/) !== "", r.line(/dcp: pruning active/));
  }
  // 3. Corrupt state must FAIL, not be silently treated as healthy.
  {
    const r = runSelfcheck(["--dcp-state", state("corrupt", "{ not json at all")]);
    report("corrupt state FAILs", r.line(/^FAIL\s+dcp: pruning active/) !== "", r.line(/dcp: pruning active/));
  }
  // 4. A fresh session that has pruned nothing must WARN, never FAIL. This is
  //    the regression guard: an earlier draft of the plan called for FAIL here,
  //    which would fail a healthy fresh install and train people to ignore it.
  {
    const r = runSelfcheck(["--dcp-state", state("fresh", { manualMode: false, stats: { totalPruneTokens: 0 } })]);
    const warned = r.line(/^WARN\s+dcp: pruning active/) !== "";
    const passed = r.line(/^PASS\s+dcp: pruning active/) !== "";
    report("fresh session WARNs, does not FAIL", warned && !passed, r.line(/dcp: pruning active/));
  }
  // 5. A missing state file must FAIL (plugin loaded but never ran).
  {
    const r = runSelfcheck(["--dcp-state", join(tmp, "does-not-exist.json")]);
    report("missing state FAILs", r.line(/^FAIL\s+dcp: pruning active/) !== "", r.line(/dcp: pruning active/));
  }

  console.log("dcp: pruning active — multi-session sampling");
  // 6. If ANY recent session has pruned, the check must PASS. This is the fix
  //    for the newest-by-mtime cry-wolf: a fresh session newest in the dir must
  //    not drag down a machine where pruning demonstrably works.
  {
    const p = state("s_pruned", { manualMode: false, stats: { totalPruneTokens: 500000 } });
    const f = state("s_fresh", { manualMode: false, stats: { totalPruneTokens: 0 } });
    // Point --dcp-state at the fresh one and rely on the sibling being newer? No —
    // --dcp-state inspects exactly one file. The multi-session path runs against
    //    the real storage dir, exercised by the live-machine check below.
    const r = runSelfcheck(["--dcp-state", p]);
    report("single pruned file PASSes", r.line(/^PASS\s+dcp: pruning active/) !== "", r.line(/dcp: pruning active/));
    // And the fresh one on its own is the WARN case (already asserted above).
    const r2 = runSelfcheck(["--dcp-state", f]);
    report("single fresh file WARNs", r2.line(/^WARN\s+dcp: pruning active/) !== "", r2.line(/dcp: pruning active/));
  }
  // 7. The verdict line must name the sessions it inspected (auditable). IDs are
  //    truncated to 8 chars in the verdict for readability, so match that.
  {
    const r = runSelfcheck(["--dcp-state", state("audit", { sessionId: "sess_audit_1", manualMode: false, stats: { totalPruneTokens: 12345 } })]);
    report("verdict names the session inspected", /sess_aud/.test(r.line(/dcp: pruning active/) || ""), r.line(/dcp: pruning active/));
  }
  // 8. --dcp-session for an unknown id must FAIL loudly, not fall back to a
  //    random other session and quietly pass.
  {
    const r = runSelfcheck(["--dcp-session", "definitely-not-a-session"]);
    report("unknown --dcp-session FAILs", r.line(/^FAIL\s+dcp: pruning active/) !== "", r.line(/dcp: pruning active/));
  }

  console.log("every check can fail");
  // 9. The meta-property, asserted on the dcp verdict line rather than the
  //    process exit code. The exit code is global: on a fresh machine `bd
  //    present` or `beads store present` can fail for reasons that have nothing
  //    to do with dcp, and a test that asserts exit 0 would then fail on a
  //    healthy fresh install and break the installer. What we are proving is
  //    that the dcp check can reach BOTH verdicts, so assert the verdicts.
  {
    const passing = runSelfcheck(["--dcp-state", state("ok", { manualMode: false, stats: { totalPruneTokens: 1 } })]);
    const failing = runSelfcheck(["--dcp-state", state("bad", { manualMode: true })]);
    report("the dcp check can reach PASS", passing.line(/^PASS\s+dcp: pruning active/) !== "");
    report("the dcp check can reach FAIL", failing.line(/^FAIL\s+dcp: pruning active/) !== "");
  }

  console.log("live machine sanity");
  // 10. Against the real storage dir with no --dcp-state, the check must produce
  //     a dcp verdict and not crash on the real dcp.jsonc / state layout.
  {
    const r = runSelfcheck([]);
    const hasVerdict = /dcp: pruning active/.test(r.out);
    const crashed = /Error:|throw|Cannot read/.test(r.out);
    report("live run emits a dcp verdict", hasVerdict && !crashed, r.line(/dcp: pruning active/) || "(no dcp dir yet)");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${ran - failures}/${ran} selfcheck tests passed.`);
if (failures) {
  console.error(`${failures} test(s) failed.`);
  process.exit(1);
}
console.log("selfcheck tests: OK");
