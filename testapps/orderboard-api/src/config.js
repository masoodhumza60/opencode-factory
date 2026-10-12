// Every value the app reads at runtime comes from here, so a test can point
// the whole thing at a throwaway file without touching the environment.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3001),
  database: process.env.DATABASE_PATH || join(ROOT, "data", "orders.db"),
};
