# orderboard-cli

The third M4 seed: orders, from the terminal, against a local JSON store.

    orders create --json '{"customer":"Ada Lovelace","amountCents":12900,"currency":"USD"}'
    orders list                       # table of all orders
    orders list --status pending      # filtered
    orders list --json                # machine output (JSON array)

Zero runtime dependencies; Node >= 22.5. The store is a plain JSON array at
`<seed>/data/orders.json` (gitignored, created on first write). Set
`ORDERBOARD_CLI_DATA` to point elsewhere.

`hidden/` contains acceptance tests for factory-internal evals. Do not read
them when building.
