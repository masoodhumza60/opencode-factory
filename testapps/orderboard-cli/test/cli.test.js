import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const cleanups = [];

after(() => {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
});

// Each test gets its own store directory, so no test sees another's orders and
// the real seed's data/ is never touched.
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "ob-cli-test-"));
  cleanups.push(d);
  return d;
}

function run(args, dataDir) {
  const dir = dataDir ?? freshDir();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ORDERBOARD_CLI_DATA: dir },
    timeout: 15000,
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("create --json prints a parseable order with a stable id, exit 0", () => {
  const r = run(["create", "--json", '{"customer":"Ada Lovelace","amountCents":12900,"currency":"USD"}']);
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  assert.equal(o.customer, "Ada Lovelace");
  assert.equal(o.status, "pending");
  assert.ok(typeof o.id === "string" && o.id.length > 3, "an id was minted");
});

test("create with a float amountCents exits 2 and writes nothing", () => {
  const d = freshDir();
  const r = run(["create", "--json", '{"customer":"Ada","amountCents":12.5,"currency":"USD"}'], d);
  assert.equal(r.code, 2);
  assert.match(r.err, /amountCents/);
  const list = run(["list", "--json"], d);
  assert.deepEqual(JSON.parse(list.out), []);
});

test("create with a negative amountCents exits 2", () => {
  const r = run(["create", "--json", '{"customer":"Ada","amountCents":-1,"currency":"USD"}']);
  assert.equal(r.code, 2);
});

test("create with a missing customer exits 2", () => {
  const r = run(["create", "--json", '{"amountCents":100,"currency":"USD"}']);
  assert.equal(r.code, 2);
  assert.match(r.err, /customer/);
});

test("create with a non-3-letter currency exits 2", () => {
  const r = run(["create", "--json", '{"customer":"Ada","amountCents":100,"currency":"DOLLAR"}']);
  assert.equal(r.code, 2);
  assert.match(r.err, /currency/);
});

test("create with malformed JSON payload exits 2", () => {
  const r = run(["create", "--json", "{ not json"]);
  assert.equal(r.code, 2);
});

test("list on an empty store exits 0 and prints the empty table", () => {
  const r = run(["list"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /customer/i);
});

test("list --json on an empty store prints a JSON array", () => {
  const r = run(["list", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), []);
});

test("list shows created orders and --json round-trips them", () => {
  const d = freshDir();
  run(["create", "--json", '{"customer":"Katherine","amountCents":0,"currency":"USD"}'], d);
  run(["create", "--json", '{"customer":"Radia","amountCents":23150,"currency":"EUR"}'], d);
  const r = run(["list", "--json"], d);
  const all = JSON.parse(r.out);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((o) => o.customer).sort(), ["Katherine", "Radia"]);
});

test("list --status pending filters; unknown status exits 2", () => {
  const d = freshDir();
  run(["create", "--json", '{"customer":"Grace","amountCents":100,"currency":"USD"}'], d);
  const ok = run(["list", "--status", "pending", "--json"], d);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).length, 1);
  const bad = run(["list", "--status", "weird"], d);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /status/i);
});

test("an unknown subcommand exits 2 with a stderr help line", () => {
  const r = run(["teleport"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage|orders/i);
});

test("no arguments at all exits 2 with usage on stderr", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage/i);
});
