import type { Order, OrderStatus } from "./types";

/** In-memory store. A real deployment would swap this for an API client. */
export interface OrderStore {
  list(): Promise<Order[]>;
}

const SEED: Order[] = [
  { id: "ord_1001", customer: "Ada Lovelace", placedAt: "2026-03-02T09:15:00.000Z", status: "paid", amountCents: 12900, currency: "USD" },
  { id: "ord_1002", customer: "Grace Hopper", placedAt: "2026-03-02T18:40:00.000Z", status: "shipped", amountCents: 4500, currency: "USD" },
  { id: "ord_1003", customer: "Alan, \"Al\" Turing", placedAt: "2026-03-03T11:05:00.000Z", status: "pending", amountCents: 0, currency: "USD" },
  { id: "ord_1004", customer: "Katherine\nJohnson", placedAt: "2026-03-05T07:00:00.000Z", status: "cancelled", amountCents: 8900, currency: "USD" },
  { id: "ord_1005", customer: "Radia Perlman", placedAt: "2026-03-09T22:30:00.000Z", status: "paid", amountCents: 23150, currency: "USD" },
];

export function createMemoryStore(seed: Order[] = SEED): OrderStore {
  return {
    async list() {
      return seed.map((o) => ({ ...o }));
    },
  };
}

export const STATUSES: OrderStatus[] = ["pending", "paid", "shipped", "cancelled"];

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
