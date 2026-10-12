import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../src/db.js";
import { CUSTOMERS, ORDERS } from "../src/seed-data.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "obdb-"));
  return { dir, file: join(dir, "t.db") };
}

function seedInto(db) {
  const insC = db.prepare("INSERT OR REPLACE INTO customers (id, name) VALUES (?, ?)");
  const insO = db.prepare(
    "INSERT OR REPLACE INTO orders (id, customer_id, placed_at, status, amount_cents, currency)" +
    " VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const c of CUSTOMERS) insC.run(c.id, c.name);
  for (const o of ORDERS) insO.run(o.id, o.customerId, o.placedAt, o.status, o.amountCents, o.currency);
}

test("migrations apply in order, once each", () => {
  const { dir, file } = fresh();
  const db = openDb(file);
  const first = migrate(db);
  assert.deepEqual(first, ["001_init.sql", "002_orders_status_index.sql"]);
  assert.deepEqual(migrate(db), [], "a second migrate must apply nothing");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the second migration really is a second migration", () => {
  const { dir, file } = fresh();
  const db = openDb(file);
  migrate(db);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='orders_status_idx'").all();
  assert.equal(idx.length, 1, "the index from 002 should exist");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("seed data round-trips through the real schema", () => {
  const { dir, file } = fresh();
  const db = openDb(file);
  migrate(db);
  seedInto(db);
  const n = db.prepare("SELECT count(*) AS n FROM orders").get().n;
  assert.equal(n, ORDERS.length);
  const zero = db.prepare("SELECT amount_cents FROM orders WHERE id = ?").get("ord_1003");
  assert.equal(zero.amount_cents, 0, "a zero-amount order must survive the round trip");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
