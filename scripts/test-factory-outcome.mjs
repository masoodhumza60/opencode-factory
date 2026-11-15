#!/usr/bin/env node
// The outcomes ledger's behavior suite. Every case runs against its own
// throwaway root with a seeded docs/outcomes.jsonl — nothing here reads the
// developer's real docs/, and the negative-results.md canary is byte-compared.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-outcome.mjs");
const ROWS = [
  { at: "2026-01-01T00:00:00Z", bead: "b1", head: "aaaaaa1", verdict: "did-not-work", what_changed: "the migration broke production", measured: "before", learned: [{ name: "hidden tests", line: "they discriminate, run them" }] },
  { at: "2026-01-02T00:00:00Z", bead: "b2", head: "bbbbbb2", verdict: "did-not-work", what_changed: "the filter shipped wrong", measured: "none", learned: [{ name: "hidden tests", line: "they discriminate" }, { name: "staging", line: "dry-run the migration first" }] },
  { at: "2026-01-03T00:00:00Z", bead: "b3", head: "cccccc3", verdict: "worked", what_changed: "the cli seed shipped", measured: "before", learned: [{ name: "hidden tests", line: "they discriminate" }, { name: "staging", line: "dry-run first" }] },
  { at: "2026-01-04T00:00:00Z", bead: "b4", head: "dddddd4", verdict: "worked-with-changes", what_changed: "the api transition shipped", measured: "before", learned: [] },
];

const SANDBOX = mkdtempSync(join(tmpdir(), "factory-outcome-test-"));
const newRoot = (rows = ROWS) => {
  const root = join(SANDBOX, `root-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "outcomes.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return root;
};
const run = (root, args) =>
  spawnSync(process.execPath, [SCRIPT, ...args, "--root", root], { encoding: "utf8" });

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};
const has = (s, sub) => String(s).includes(sub);

console.log("factory-outcome");

const r1 = newRoot();
const rep = run(r1, ["report"]);
check("report tallies by verdict", rep.status === 0 && has(rep.stdout, "did-not-work: 2") && has(rep.stdout, "total: 4"), rep.stdout);

const lst = run(r1, ["list"]);
let parsed = [];
try { parsed = lst.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { parsed = null; }
check("list prints rows as JSON, one per line", lst.status === 0 && parsed !== null && parsed.length === ROWS.length && parsed.every((r) => typeof r.bead === "string"), lst.stdout);

const look = run(r1, ["lookup", "HIDDEN TESTS"]);
check("lookup matches case-insensitively and names the beads",
  look.status === 0 && has(look.stdout, "b1") && has(look.stdout, "b2") && has(look.stdout, "b3"), look.stdout);

const empty = run(r1, ["lookup", "no-such-tool-name"]);
check("lookup on an unused name exits 0 with a clear empty message",
  empty.status === 0 && /no outcomes mention/.test(empty.stdout), empty.stdout);

const d1 = run(r1, ["draft"]);
const draftPath = join(r1, "docs", "negative-results.draft.md");
const first = readFileSync(draftPath, "utf8");
const d2 = run(r1, ["draft"]);
const second = readFileSync(draftPath, "utf8");
check("draft regenerates the draft file byte-identically on rerun", d1.status === 0 && first === second, draftPath);
check("draft includes did-not-work rows and repeated learnings only",
  has(first, "the migration broke production") && has(first, "the filter shipped wrong")
    && has(first, "hidden tests") && has(first, "staging")
    && !has(first, "the api transition shipped") && !has(first, "worked-with-changes"),
  first);

writeFileSync(join(r1, "docs", "negative-results.md"), "# curated\n\nhand-written\n", "utf8");
const before = readFileSync(join(r1, "docs", "negative-results.md"), "utf8");
run(r1, ["draft"]);
check("draft never touches negative-results.md (canary unchanged)",
  readFileSync(join(r1, "docs", "negative-results.md"), "utf8") === before);

const corrupt = newRoot([ROWS[0], { at: "2026-01-02T00:00:00Z", bead: "b2", /* valid */ }]);
writeFileSync(join(corrupt, "docs", "outcomes.jsonl"),
  JSON.stringify(ROWS[0]) + "\n" + "not json at all\n", "utf8");
const c = run(corrupt, ["report"]);
check("a corrupt line in the ledger is refused by name, line number named",
  c.status === 1 && has(c.stderr, "line 2") && has(c.stderr, "outcomes.jsonl"), `${c.status} ${c.stderr}`);

const missing = run(join(SANDBOX, "empty-root"), ["report"]);
check("a missing ledger reads as zero rows and exits 0",
  missing.status === 0 && has(missing.stdout, "total: 0"), `${missing.status} ${missing.stdout}`);

console.log(`\n${pass}/${pass + fail} outcome tests passed.`);
process.exit(fail ? 1 : 0);
