-- Second migration on purpose: a single-file schema proves the runner ran
-- once, not that it can tell what it has already done.
CREATE INDEX orders_status_idx ON orders(status);
