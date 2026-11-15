// ORDERBOARD-API PATCH — hidden acceptance test.
// Do not read this file if you are implementing the feature; the factory's
// point is that the acceptance bar is held out of band.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../src/db.js";
import { createApp } from "../src/server.js";
import { makeSessions } from "../src/auth.js";

let server, base, db, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "obapi-hidden-"));
  db = openDb(join(dir, "t.db"));
  migrate(db);
  // Seeded straight into the database, never through src/seed-data.js: the
  // seed data carries statuses outside the pending|paid|shipped|cancelled
  // vocabulary the state machine is built on.
  db.prepare("INSERT INTO customers (id, name) VALUES (?, ?)").run("cust_h", "Hidden Holder");
  const ins = db.prepare(
    "INSERT INTO orders (id, customer_id, placed_at, status, amount_cents, currency)" +
    " VALUES (?, ?, ?, ?, ?, ?)"
  );
  ins.run("ord_h_pend", "cust_h", "2026-05-01T10:00:00.000Z", "pending", 4200, "USD");
  ins.run("ord_h_ship", "cust_h", "2026-05-02T10:00:00.000Z", "shipped", 5100, "USD");
  server = createApp({ db, auth: makeSessions() });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = (token) => ({ authorization: "Bearer " + token, "content-type": "application/json" });
const patch = (id, body, token = "tok_admin") =>
  fetch(base + "/api/orders/" + id, { method: "PATCH", headers: as(token), body: JSON.stringify(body) });

test("a pending order can be moved to paid", async () => {
  const res = await patch("ord_h_pend", { status: "paid" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.status, "paid");
});

test("a paid order cannot go back to pending", async () => {
  const res = await patch("ord_h_pend", { status: "pending" });
  assert.equal(res.status, 409);
});

test("a shipped order cannot go back to paid", async () => {
  const res = await patch("ord_h_ship", { status: "paid" });
  assert.equal(res.status, 409);
});

test("an unknown order id 404s", async () => {
  const res = await patch("ord_h_nope", { status: "paid" });
  assert.equal(res.status, 404);
});

test("a missing status is a 400", async () => {
  const res = await patch("ord_h_pend", {});
  assert.equal(res.status, 400);
});

test("an unknown status is a 400", async () => {
  const res = await patch("ord_h_pend", { status: "weird" });
  assert.equal(res.status, 400);
});
