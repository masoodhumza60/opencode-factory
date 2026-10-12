import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../src/config.js";
import { openDb, migrate } from "../src/db.js";
import { start } from "../src/server.js";

if (process.argv.includes("--migrate-only")) {
  mkdirSync(dirname(config.database), { recursive: true });
  const db = openDb(config.database);
  const ran = migrate(db);
  db.close();
  console.log(ran.length ? "applied: " + ran.join(", ") : "schema already current");
} else {
  start();
}
