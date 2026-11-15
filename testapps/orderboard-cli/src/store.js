// The orders store. Local JSON file at <dataDir>/orders.json; the tests always
// pass an explicit temp dataDir, so the seed's own data/ is never touched.
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const FILE = "orders.json";
export const STATUSES = ["pending", "paid", "shipped", "cancelled"];

export function loadOrders(dataDir) {
  const file = join(dataDir, FILE);
  if (!existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`corrupt orders.json in ${dataDir}: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`corrupt orders.json in ${dataDir}: expected an array of orders`);
  }
  return parsed;
}

// Read-modify-write via a temp file + rename, so a crash mid-write cannot leave
// a half-written store behind. Mints the id and placedAt here.
export function saveOrder(dataDir, order) {
  mkdirSync(dataDir, { recursive: true });
  const orders = loadOrders(dataDir);
  const saved = {
    id: `ord_${randomUUID()}`,
    customer: order.customer,
    amountCents: order.amountCents,
    currency: order.currency,
    status: STATUSES[0],
    placedAt: new Date().toISOString(),
  };
  orders.push(saved);
  const tmp = join(dataDir, `${FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(orders, null, 2), "utf8");
  renameSync(tmp, join(dataDir, FILE));
  return saved;
}
