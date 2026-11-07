// Sample data. The rows are chosen to make export bugs visible rather than to
// look tidy:
//   - a name with a comma and a double quote, and one with a newline, because
//     a hand-rolled CSV writer gets those wrong and a naive test never sees it
//   - two orders on the same day at 00:00:00Z and 22:30:00Z, so whether a date
//     range is inclusive of its end day is observable rather than arguable
//   - an order with amountCents 0, which a truthiness check drops
//   - one order placed on a month boundary
export const CUSTOMERS = [
  { id: "cus_1001", name: "Ada Lovelace" },
  { id: "cus_1002", name: "Alan, \"Al\" Turing" },
  { id: "cus_1003", name: "Katherine\nJohnson" },
  { id: "cus_1004", name: "Grace Hopper" },
  { id: "cus_1005", name: "Radia Perlman" },
];

export const ORDERS = [
  { id: "ord_1001", customerId: "cus_1001", placedAt: "2026-03-01T00:00:00.000Z", status: "fulfilled", amountCents: 12900, currency: "USD" },
  { id: "ord_1002", customerId: "cus_1002", placedAt: "2026-03-02T22:30:00.000Z", status: "pending", amountCents: 4500, currency: "USD" },
  { id: "ord_1003", customerId: "cus_1003", placedAt: "2026-03-03T11:05:00.000Z", status: "pending", amountCents: 0, currency: "USD" },
  { id: "ord_1004", customerId: "cus_1004", placedAt: "2026-04-01T09:15:00.000Z", status: "cancelled", amountCents: 8900, currency: "EUR" },
  { id: "ord_1005", customerId: "cus_1005", placedAt: "2026-04-02T18:40:00.000Z", status: "fulfilled", amountCents: 23150, currency: "EUR" },
];
