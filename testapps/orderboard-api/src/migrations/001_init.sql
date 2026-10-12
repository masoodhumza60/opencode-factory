-- Orders and the two reference tables the admin page needs.
CREATE TABLE customers (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL
);

CREATE TABLE orders (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  placed_at    TEXT NOT NULL,
  status       TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL
);
