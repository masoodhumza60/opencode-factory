import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../src/config.js";
import { openDb, migrate } from "../src/db.js";
import { CUSTOMERS, ORDERS } from "../src/seed-data.js";

mkdirSync(dirname(config.database), { recursive: true });
const db = openDb(config.database);
migrate(db);

const insC = db.prepare("INSERT OR REPLACE INTO customers (id, name) VALUES (?, ?)");
const insO = db.prepare(
  "INSERT OR REPLACE INTO orders (id, customer_id, placed_at, status, amount_cents, currency)" +
  " VALUES (?, ?, ?, ?, ?, ?)"
);

db.exec("BEGIN");
for (const c of CUSTOMERS) insC.run(c.id, c.name);
for (const o of ORDERS) insO.run(o.id, o.customerId, o.placedAt, o.status, o.amountCents, o.currency);
db.exec("COMMIT");
db.close();

console.log("seeded " + CUSTOMERS.length + " customers and " + ORDERS.length + " orders into " + config.database);
