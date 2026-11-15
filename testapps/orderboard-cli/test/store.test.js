import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrders, saveOrder } from "../src/store.js";

// The store directory is passed explicitly everywhere (ORDERBOARD_CLI_DATA in
// the CLI, the argument here), so the real seed's data/ is never touched by tests.
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ob-cli-store-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a missing store file loads as an empty list, not an error", () => {
  assert.deepEqual(loadOrders(join(dir, "roundtrip1")), []);
});

test("save then load round-trips, with stable ids and status", () => {
  const dataDir = join(dir, "roundtrip2");
  const a = saveOrder(dataDir, { customer: "Ada Lovelace", amountCents: 12900, currency: "USD" });
  const b = saveOrder(dataDir, { customer: "Grace Hopper", amountCents: 0, currency: "EUR" });
  const orders = loadOrders(dataDir);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map((o) => o.id), [a.id, b.id]);
  assert.equal(orders[0].placedAt, a.placedAt);
  assert.equal(orders[0].status, "pending");
  assert.equal(orders[1].status, "pending");
  assert.equal(orders[0].amountCents, 12900);
  assert.equal(orders[1].amountCents, 0);
});

test("the store file is valid JSON at <dataDir>/orders.json", () => {
  const dataDir = join(dir, "roundtrip3");
  const a = saveOrder(dataDir, { customer: "Ada Lovelace", amountCents: 100, currency: "USD" });
  const p = join(dataDir, "orders.json");
  assert.equal(existsSync(p), true);
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, a.id);
});

test("a corrupt store file is refused, not silently reported as empty", () => {
  const dataDir = join(dir, "roundtrip4");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "orders.json"), "{ not json", "utf8");
  assert.throws(() => loadOrders(dataDir), /corrupt|invalid|parse/i);
});
