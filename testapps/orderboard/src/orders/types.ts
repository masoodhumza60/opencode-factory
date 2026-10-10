export type OrderStatus = "pending" | "paid" | "shipped" | "cancelled";

export interface Order {
  id: string;
  /** Customer's display name. May contain commas, quotes and newlines. */
  customer: string;
  /** ISO 8601 date-time, always UTC. */
  placedAt: string;
  status: OrderStatus;
  /** Integer minor units (cents). Never a float. */
  amountCents: number;
  currency: string;
}

/** Parse a `YYYY-MM-DD` input value into an inclusive UTC day boundary. */
export function dayStartUtc(isoDate: string): Date {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`not a date: ${isoDate}`);
  return d;
}
