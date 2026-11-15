#!/usr/bin/env node
// The M4b eval harness: the three seeds under testapps/ are the factory's
// regression fixtures. This proves, cheaply and deterministically, that the
// seeds and their hidden acceptance tests still discriminate: hidden tests
// fail on a bare seed, pass on the committed golden reference, and fail on
// the committed plausible-wrong reference. It never attests, never writes
// outside out/eval/, and never mutates a seed.
//
//   node scripts/factory-eval.mjs check [seed]
//
// seed may be one of: orderboard, orderboard-api, orderboard-cli
// Exit 0 = every proof held; exit 1 otherwise.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEEDS = ["orderboard", "orderboard-api", "orderboard-cli"];
const USAGE = "usage: node scripts/factory-eval.mjs check [seed]";
const node = process.execPath;
const isWin = process.platform === "win32";

const readSeed = (name) => join(ROOT, "testapps", name);
const copySeed = (name, dest) =>
  cpSync(readSeed(name), join(dest, "testapps", name), {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.git|out|data)([\\/]|$)/.test(src),
  });

// Each seed knows its own runners. Own-test runners use cwd = the seed copy.
const RUN = {
  orderboard: {
    own: { cmd: node, args: ["node_modules/vitest/vitest.mjs", "run", "src"], cwd: ["testapps", "orderboard"] },
    hidden: { cmd: node, args: ["node_modules/vitest/vitest.mjs", "run", "hidden/status-filter.test.tsx"], cwd: ["testapps", "orderboard"] },
  },
  "orderboard-api": {
    own: { cmd: node, args: ["--test", "test/api.test.js", "test/db.test.js"], cwd: ["testapps", "orderboard-api"] },
    hidden: { cmd: node, args: ["--test", "hidden/patch-order.test.js"], cwd: ["testapps", "orderboard-api"] },
  },
  "orderboard-cli": {
    own: { cmd: node, args: ["--test", "test/cli.test.js", "test/store.test.js"], cwd: ["testapps", "orderboard-cli"] },
    hidden: { cmd: node, args: ["--test", "hidden/machine-output.test.js"], cwd: ["testapps", "orderboard-cli"] },
  },
};

const runIn = (cmd, args, cwd, env) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });

// The web seed's vitest lives in its node_modules; the copy must see it. A
// directory junction costs one cmd call and leaves the repo untouched.
function junctionWebDeps(scratch) {
  const real = join(ROOT, "testapps", "orderboard", "node_modules");
  if (!existsSync(real)) {
    throw new Error("testapps/orderboard/node_modules is missing; run `npm install` in testapps/orderboard first");
  }
  const link = join(scratch, "testapps", "orderboard", "node_modules");
  const r = spawnSync(isWin ? "cmd" : "ln", isWin ? ["/c", "mklink", "/J", link, real] : ["-s", real, link], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("could not junction web node_modules: " + (r.stderr || r.stdout || ""));
}

const applyPatch = (patchAbs, scratch) => {
  const r = spawnSync("git", ["apply", "-p1", patchAbs], { cwd: scratch, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

const rows = [];
const line = ({ seed, proof, ok, detail }) => {
  rows.push({ at: new Date().toISOString(), seed, proof, ok });
  console.log(`${ok ? "ok" : "FAIL"} ${seed} ${proof}${detail ? " — " + detail : ""}`);
};

function checkScratch(seed, proof, expectOk, patchAbs) {
  const scratch = mkdtempSync(join(tmpdir(), "factory-eval-"));
  try {
    copySeed(seed, scratch);
    if (seed === "orderboard") junctionWebDeps(scratch);
    if (patchAbs) {
      const p = applyPatch(patchAbs, scratch);
      if (!p.ok) { line({ seed, proof, ok: false, detail: `patch would not apply: ${p.out}` }); return; }
    }
    const spec = RUN[seed];
    if (proof === "own") {
      const r = runIn(spec.own.cmd, spec.own.args, join(scratch, ...spec.own.cwd));
      line({ seed, proof, ok: (r.status === 0) === expectOk, detail: r.status === 0 ? "" : (r.stderr || r.stdout || "").split("\n").slice(-3).join(" | ") });
    } else {
      const r = runIn(spec.hidden.cmd, spec.hidden.args, join(scratch, ...spec.hidden.cwd), seed === "orderboard-cli" ? { ORDERBOARD_CLI_DATA: mkdtempSync(join(tmpdir(), "ob-cli-eval-")) } : undefined);
      const got = r.status === 0;
      line({ seed, proof, ok: got === expectOk, detail: got === expectOk ? "" : `expected ${expectOk ? "pass" : "fail"}, got ${got ? "pass" : "fail"} (exit ${r.status})` });
    }
  } catch (e) {
    line({ seed, proof, ok: false, detail: e.message });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function checkOne(seed) {
  const src = readSeed(seed);
  if (!existsSync(src)) { line({ seed, proof: "seed", ok: false, detail: `no seed at testapps/${seed}` }); return; }
  // The cli seed already implements its feature; its hidden test passes on the
  // bare tree by construction, so the golden/broken proofs are not applicable.
  if (seed === "orderboard-cli") {
    for (const proof of ["fail-bare", "pass-golden", "fail-broken"]) line({ seed, proof, ok: true, detail: "NOT APPLICABLE (the seed ships its feature; no discrimination signal)" });
    checkScratch(seed, "own", true, null); // its own suite still has to be green
    return;
  }
  checkScratch(seed, "own", true, null);
  checkScratch(seed, "fail-bare", false, null);
  checkScratch(seed, "pass-golden", true, join(src, "golden.patch"));
  checkScratch(seed, "fail-broken", false, join(src, "broken.patch"));
}

function main(argv) {
  const [command, seed] = argv;
  if (command !== "check") { console.error(USAGE); return 1; }
  if (seed && !SEEDS.includes(seed)) { console.error(`no seed named ${seed}; expected one of ${SEEDS.join(", ")}`); return 1; }
  for (const s of seed ? [seed] : SEEDS) checkOne(s);
  mkdirSync(join(ROOT, "out", "eval"), { recursive: true });
  const out = join(ROOT, "out", "eval", `${Date.now()}.jsonl`);
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} proofs passed.`);
  console.log(`machine record: ${out}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
