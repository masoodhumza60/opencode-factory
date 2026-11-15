// ORDERBOARD-CLI machine output — hidden acceptance test.
// Do not read this file if you are implementing the feature; the factory's
// point is that the acceptance bar is held out of band.
//
// NOTE: the CLI seed shipped with its Phase B feature (--json everywhere,
// validation, non-zero exit) already implemented, so this file passes on the
// bare tree. The eval harness prints NOT APPLICABLE for the CLI seed rather
// than counting it as a pass.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const dirs = [];
after(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), "obcli-hidden-"));
  dirs.push(d);
  return d;
};

const run = (args, dataDir) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ORDERBOARD_CLI_DATA: dataDir },
  });

test("list --json emits a parseable JSON array of orders", () => {
  const dataDir = freshDir();
  const r = run(["list", "--json"], dataDir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test("create --json validates and round-trips through list --json", () => {
  const dataDir = freshDir();
  const mk = run(["create", "--json", JSON.stringify({ customer: "Ada", amountCents: 1299, currency: "USD" })], dataDir);
  assert.equal(mk.status, 0, mk.stderr);
  const created = JSON.parse(mk.stdout);
  assert.equal(created.status, "pending");
  const ls = run(["list", "--json", "--status", "pending"], dataDir);
  assert.equal(ls.status, 0, ls.stderr);
  assert.equal(JSON.parse(ls.stdout).length, 1);
});
