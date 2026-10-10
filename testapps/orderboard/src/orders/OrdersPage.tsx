import { useEffect, useState } from "react";
import type { Order } from "./types";
import type { OrderStore } from "./store";
import { formatMoney } from "./store";

export function OrdersPage({ store }: { store: OrderStore }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    store
      .list()
      .then((rows) => {
        if (live) setOrders(rows);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "failed to load orders");
      });
    return () => {
      live = false;
    };
  }, [store]);

  if (error) {
    return (
      <div className="card">
        <p className="error" role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (orders === null) {
    return (
      <div className="card">
        <p className="status">Loading orders...</p>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="card">
        <p className="empty">No orders yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Customer</th>
            <th scope="col">Placed</th>
            <th scope="col">Status</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>{o.id}</td>
              <td>{o.customer}</td>
              <td>{o.placedAt.slice(0, 10)}</td>
              <td>{o.status}</td>
              <td>{formatMoney(o.amountCents, o.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
