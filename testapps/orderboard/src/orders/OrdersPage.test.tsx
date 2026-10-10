import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrdersPage } from "./OrdersPage";
import { createMemoryStore } from "./store";
import type { Order } from "./types";

const one = (over: Partial<Order> = {}): Order => ({
  id: "ord_1",
  customer: "Ada Lovelace",
  placedAt: "2026-03-02T09:15:00.000Z",
  status: "paid",
  amountCents: 12900,
  currency: "USD",
  ...over,
});

describe("OrdersPage", () => {
  it("shows a loading state while the store is still pending", () => {
    // A store that never settles, so the assertion is about the pending state
    // rather than racing it. A store that resolves immediately tests nothing:
    // the state it renders is whichever one the microtask queue reached first.
    const pending = { list: () => new Promise<Order[]>(() => {}) };
    render(<OrdersPage store={pending} />);
    expect(screen.getByText(/loading orders/i)).toBeTruthy();
  });

  it("renders one row per order", async () => {
    render(<OrdersPage store={createMemoryStore([one(), one({ id: "ord_2", customer: "Grace Hopper" }) ])} />);
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
  });

  it("renders an empty state rather than a blank table", async () => {
    render(<OrdersPage store={createMemoryStore([])} />);
    expect(await screen.findByText(/no orders yet/i)).toBeTruthy();
  });

  it("surfaces a store failure as an alert instead of spinning forever", async () => {
    const broken = { list: async () => { throw new Error("network down"); } };
    render(<OrdersPage store={broken} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/network down/i)).toBeTruthy();
  });
});
