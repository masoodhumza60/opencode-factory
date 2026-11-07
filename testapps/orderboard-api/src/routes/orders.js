import { sendJson } from "../http.js";
import { can } from "../auth.js";

const SELECT =
  "SELECT o.id, c.name AS customer, o.placed_at AS placedAt, o.status," +
  " o.amount_cents AS amountCents, o.currency" +
  " FROM orders o JOIN customers c ON c.id = o.customer_id";

export function listOrders(db, req, res, session) {
  if (!can(session, "orders.read")) return sendJson(res, 401, { error: "sign in required" });
  const orders = db.prepare(SELECT + " ORDER BY o.placed_at, o.id").all();
  return sendJson(res, 200, { orders });
}

export function getOrder(db, req, res, session, id) {
  if (!can(session, "orders.read")) return sendJson(res, 401, { error: "sign in required" });
  const order = db.prepare(SELECT + " WHERE o.id = ?").get(id);
  if (!order) return sendJson(res, 404, { error: "no such order" });
  return sendJson(res, 200, { order });
}
