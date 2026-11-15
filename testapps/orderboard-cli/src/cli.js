#!/usr/bin/env node
// orders - create and list orders against a local JSON store.
//   orders create --json '<payload>'   create an order, print it as JSON
//   orders list [--status s] [--json]  list orders, optionally filtered
// Exit codes: 0 ok, 2 usage/validation error (one line on stderr).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrders, saveOrder, STATUSES } from "./store.js";
import { parseFlags } from "./args.js";

const seedRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.ORDERBOARD_CLI_DATA ?? join(seedRoot, "data");
const usage = "usage: orders <create|list> [--json <payload>] [--status pending|paid|shipped|cancelled] [--json]";

const fail = (msg) => { console.error(msg); process.exit(2); };

function create(argv) {
  const { flags } = parseFlags(argv);
  const payload = flags.get("json");
  if (!payload || payload === true) fail(`orders create requires --json '<payload>'\n${usage}`);
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    fail(`invalid JSON payload: could not parse the argument passed to --json`);
  }
  const customer = data?.customer;
  if (typeof customer !== "string" || customer.trim() === "") {
    fail("customer must be a non-empty string");
  }
  const amountCents = data?.amountCents;
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents)) {
    fail("amountCents must be an integer (cents)");
  }
  if (amountCents < 0) fail("amountCents must not be negative");
  const currency = data?.currency;
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    fail("currency must be a 3-letter code (e.g. USD)");
  }
  const saved = saveOrder(dataDir, {
    customer: customer.trim(),
    amountCents,
    currency: currency.toUpperCase(),
  });
  process.stdout.write(JSON.stringify(saved) + "\n");
}

function list(argv) {
  const { flags } = parseFlags(argv);
  const status = flags.get("status");
  if (status !== undefined && status !== true && !STATUSES.includes(status)) {
    fail(`unknown status "${status}" - expected one of: ${STATUSES.join(", ")}`);
  }
  let orders = loadOrders(dataDir);
  if (typeof status === "string") orders = orders.filter((o) => o.status === status);
  if (flags.has("json")) {
    process.stdout.write(JSON.stringify(orders) + "\n");
    return;
  }
  // Human table; the header is deliberately stable - the empty-store case
  // still prints it so a scripted reader sees the columns.
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  process.stdout.write(`${pad("ID", 24)} ${pad("CUSTOMER", 18)} ${pad("AMOUNT", 13)} ${pad("STATUS", 10)} PLACED\n`);
  for (const o of orders) {
    const amount = `${(o.amountCents / 100).toFixed(2)} ${o.currency}`;
    process.stdout.write(`${pad(o.id, 24)} ${pad(o.customer, 18)} ${pad(amount, 13)} ${pad(o.status, 10)} ${o.placedAt}\n`);
  }
}

const [sub, ...rest] = process.argv.slice(2);
switch (sub) {
  case "create": create(rest); break;
  case "list": list(rest); break;
  default:
    fail(sub === undefined ? usage : `unknown subcommand "${sub}" - ${usage}`);
}
