// ORDER-BOARD STATUS FILTER — hidden acceptance test.
// Do not read this file if you are implementing the feature; the factory's
// point is that the acceptance bar is held out of band.
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrdersPage } from "../src/orders/OrdersPage";
import { createMemoryStore } from "../src/orders/store";
import type { Order } from "../src/types";

const ORDERS: Order[] = [
  { id: "ord_p1", customer: "Ada Pending", placedAt: "2026-05-01T10:00:00.000Z", status: "pending", amountCents: 1000, currency: "USD" },
  { id: "ord_p2", customer: "Bob Paid", placedAt: "2026-05-02T10:00:00.000Z", status: "paid", amountCents: 2000, currency: "USD" },
  { id: "ord_p3", customer: "Carol Shipped", placedAt: "2026-05-03T10:00:00.000Z", status: "shipped", amountCents: 3000, currency: "USD" },
  { id: "ord_p4", customer: "Dan Cancelled", placedAt: "2026-05-04T10:00:00.000Z", status: "cancelled", amountCents: 4000, currency: "USD" },
];

const filter = () => screen.getByLabelText(/filter by status/i);

describe("orders list status filter", () => {
  it("defaults to all orders and exposes the four status choices plus all", async () => {
    render(<OrdersPage store={createMemoryStore(ORDERS)} />);
    expect(await screen.findByText("Ada Pending")).toBeTruthy();
    expect(await screen.findByText("Dan Cancelled")).toBeTruthy();
    const select = filter() as HTMLSelectElement;
    expect(select.value).toBe("all");
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["all", "pending", "paid", "shipped", "cancelled"]);
  });

  it("narrows the rows to the chosen status and restores all", async () => {
    render(<OrdersPage store={createMemoryStore(ORDERS)} />);
    await screen.findByText("Ada Pending");
    fireEvent.change(filter(), { target: { value: "paid" } });
    expect(screen.queryByText("Ada Pending")).toBeNull();
    expect(screen.getByText("Bob Paid")).toBeTruthy();
    expect(screen.queryByText("Carol Shipped")).toBeNull();
    expect(screen.queryByText("Dan Cancelled")).toBeNull();
    fireEvent.change(filter(), { target: { value: "all" } });
    expect(screen.getByText("Ada Pending")).toBeTruthy();
    expect(screen.getByText("Dan Cancelled")).toBeTruthy();
  });
});
