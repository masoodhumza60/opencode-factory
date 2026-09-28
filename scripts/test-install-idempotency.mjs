#!/usr/bin/env node
// Idempotency + non-destructiveness tests for the config-writing steps.
//
// "Safe to re-run" is a promise the README makes and the installers rely on.
// Run once by hand it is easy to observe; run twice by accident six months from
// now it is exactly the kind of thing that silently starts double-merging. This
// suite pins the promise as a test: write the same config twice, assert the
// result is byte-identical, and assert the user's comments survive.
//
// The config merge is the risky part because it rewrites a real file the user
// owns. The dcp-prompts writer is the other, because it inserts by regex.
//
// Run:  node scripts/test-install-idempotency.mjs
// Exits 0 when every expectation holds, 1 otherwise.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const MERGE = join(here, "merge-config.mjs");
const DCP = join(here, "dcp-prompts.mjs");
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
const run = (script, args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const read = (f) => readFileSync(f, "utf8");
// dcp.jsonc is JSONC — the fixtures below deliberately carry a comment, so the
// assertions have to strip comments exactly the way the writer does. Parsing a
// comment-bearing config with strict JSON.parse would fail on the comment and
// tell us nothing about the writer.
const parseJsonc = (src) =>
  JSON.parse(
    src
      .replace(/\\"|"(?:\\.|[^"\\])*"|(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm, (m, a, b) => (a || b ? "" : m))
      .replace(/,(\s*[}\]])/g, "$1")
  );

const tmp = mkdtempSync(join(tmpdir(), "factory-idem-test-"));
try {
  // --- merge-config.mjs: the union merge the installers depend on -----------
  console.log("merge-config.mjs — union merge is idempotent and non-destructive");
  {
    const user = join(tmp, "opencode.json");
    // A user config with their own MCP servers, a comment-free but unusual
    // shape, and an unrelated key. The merge must not remove any of it.
    writeFileSync(user, JSON.stringify({ theme: "tokyonight", mcp: { servers: { mine: { type: "local", command: ["x"] } } } }, null, 2), "utf8");
    const snippet = join(tmp, "snippet.json");
    writeFileSync(snippet, JSON.stringify({ mcp: { servers: { factory: { type: "local", command: ["y"] } } } }), "utf8");

    const first = run(MERGE, ["--snippet", snippet, "--user", user, "--out", user]);
    report("first merge exits 0", first.code === 0, first.out.split("\n")[0]);
    const afterFirst = read(user);

    const second = run(MERGE, ["--snippet", snippet, "--user", user, "--out", user]);
    report("second merge exits 0", second.code === 0);
    const afterSecond = read(user);
    report("re-running the merge is byte-identical", afterFirst === afterSecond);

    const parsed = JSON.parse(afterSecond);
    report("user's own key survives", parsed.theme === "tokyonight", `theme=${parsed.theme}`);
    report("user's own MCP server survives", !!parsed.mcp?.servers?.mine, "servers.mine present");
    report("bundle's server added alongside", !!parsed.mcp?.servers?.factory, "servers.factory present");
    report("no duplicate key introduced", !/"factory"\s*:\s*\{[^}]*"factory"/.test(afterSecond));
  }

  // --- dcp-prompts.mjs: regex insertion, must be safe + idempotent ---------
  console.log("dcp-prompts.mjs — insertion is idempotent and preserves comments");
  {
    const dir = join(tmp, "dcp-idem");
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "dcp.jsonc");
    writeFileSync(cfg, '{\n  // my own note, please keep me\n  "$schema": "http://x/schema.json",\n  "debug": false\n}\n', "utf8");
    const run1 = run(DCP, ["--config-dir", dir]);
    report("first dcp run exits 0", run1.code === 0, run1.out.split("\n")[0]);
    const a = read(cfg);
    const ov1 = read(join(dir, "dcp-prompts", "overrides", "turn-nudge"));

    const run2 = run(DCP, ["--config-dir", dir]);
    report("second dcp run exits 0", run2.code === 0);
    const b = read(cfg);
    report("re-running dcp-prompts is byte-identical", a === b);
    report("comment preserved through insertion", a.includes("my own note, please keep me"));
    report("override file stable across runs", ov1 === read(join(dir, "dcp-prompts", "overrides", "turn-nudge")));
    const ok = parseJsonc(a);
    report("customPrompts is true after run", ok.experimental?.customPrompts === true);
    report("$schema preserved", ok.$schema === "http://x/schema.json");
  }

  console.log("dcp-prompts.mjs — refuses to damage a config it cannot handle");
  {
    // A config with no closing brace: the writer must leave it untouched and
    // report INERT, not write into it and claim success.
    const dir = join(tmp, "dcp-broken");
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "dcp.jsonc");
    const original = '{ this is not closable';
    writeFileSync(cfg, original, "utf8");
    const r = run(DCP, ["--config-dir", dir]);
    report("broken config left byte-identical", read(cfg) === original, "original preserved");
    report("broken config reported INERT", /INERT/.test(r.out), r.out.split("\n").pop());
  }

  console.log("dcp-prompts.mjs — creates a config when none exists (fresh machine)");
  {
    const dir = join(tmp, "dcp-fresh");
    const r = run(DCP, ["--config-dir", dir]);
    report("fresh run exits 0", r.code === 0);
    report("dcp.jsonc created", existsSync(join(dir, "dcp.jsonc")));
    report("override written", existsSync(join(dir, "dcp-prompts", "overrides", "turn-nudge")));
    if (existsSync(join(dir, "dcp.jsonc"))) {
      const o = JSON.parse(read(join(dir, "dcp.jsonc")));
      report("fresh config has customPrompts true", o.experimental?.customPrompts === true);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${ran - failures}/${ran} idempotency tests passed.`);
if (failures) {
  console.error(`${failures} test(s) failed.`);
  process.exit(1);
}
console.log("idempotency tests: OK");
