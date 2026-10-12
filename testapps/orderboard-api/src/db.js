import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "migrations");

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// Migrations are tracked in the database itself, not on disk, because the disk
// copy is what gets deleted and rebuilt. Each one is its own transaction: a
// migration that fails halfway must not leave a half-applied schema behind,
// which is the failure that is hardest to notice and worst to debug.
export function migrate(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
    "name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );

  const done = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const ran = [];

  for (const file of files) {
    if (done.has(file)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
      db.exec("COMMIT");
      ran.push(file);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error("migration " + file + " failed and was rolled back: " + e.message);
    }
  }
  return ran;
}

export function orderById(db, id) {
  return db.prepare(
    "SELECT o.id, o.customer_id AS customerId, c.name AS customer, o.placed_at AS placedAt," +
    " o.status, o.amount_cents AS amountCents, o.currency" +
    " FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?"
  ).get(id);
}
