import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../src/db.js";
import { createApp } from "../src/server.js";
import { makeSessions } from "../src/auth.js";
import { CUSTOMERS, ORDERS } from "../src/seed-data.js";

let server, base, db, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "obapi-"));
  db = openDb(join(dir, "t.db"));
  migrate(db);
  const insC = db.prepare("INSERT OR REPLACE INTO customers (id, name) VALUES (?, ?)");
  const insO = db.prepare(
    "INSERT OR REPLACE INTO orders (id, customer_id, placed_at, status, amount_cents, currency)" +
    " VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const c of CUSTOMERS) insC.run(c.id, c.name);
  for (const o of ORDERS) insO.run(o.id, o.customerId, o.placedAt, o.status, o.amountCents, o.currency);
  server = createApp({ db, auth: makeSessions() });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  // fetch() keeps connections alive by default, so close() alone waits for a
  // connection that is never going to end. That is a hang, not a slow test.
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = (token) => ({ authorization: "Bearer " + token });

test("orders are not readable without a session", async () => {
  const res = await fetch(base + "/api/orders");
  assert.equal(res.status, 401);
});

test("a viewer can read orders", async () => {
  const res = await fetch(base + "/api/orders", { headers: as("tok_viewer") });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.orders.length, ORDERS.length);
});

test("an admin can read orders", async () => {
  const res = await fetch(base + "/api/orders", { headers: as("tok_admin") });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).orders.length, ORDERS.length);
});

test("the session endpoint states what the role may do", async () => {
  const admin = await (await fetch(base + "/api/session", { headers: as("tok_admin") })).json();
  const viewer = await (await fetch(base + "/api/session", { headers: as("tok_viewer") })).json();
  assert.equal(admin.can.export, true);
  assert.equal(viewer.can.export, false);
});

test("one order by id, and 404 for one that is not there", async () => {
  const hit = await fetch(base + "/api/orders/ord_1001", { headers: as("tok_admin") });
  assert.equal(hit.status, 200);
  assert.equal((await hit.json()).order.id, "ord_1001");
  const miss = await fetch(base + "/api/orders/ord_9999", { headers: as("tok_admin") });
  assert.equal(miss.status, 404);
});

test("sign-in maps a known name to a token and refuses an unknown one", async () => {
  const ok = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "admin" }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).token, "tok_admin");
  const bad = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "nobody" }),
  });
  assert.equal(bad.status, 401);
});

test("the admin page is served and the app script comes with it", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Orderboard/);
  const script = await fetch(base + "/app.js");
  assert.equal(script.status, 200);
});

test("an unknown API path is a 404, not a crash", async () => {
  const res = await fetch(base + "/api/nope", { headers: as("tok_admin") });
  assert.equal(res.status, 404);
});
