#!/usr/bin/env node
// opencode-factory config merge. Call after the installer has resolved the
// graft command so the snippet carries it in.
// usage: node merge-config.mjs --snippet <path> --user <path> --out <path>
import { readFileSync, writeFileSync } from "node:fs";

const get = (argv, key) => { const i = argv.indexOf(key); return i === -1 ? undefined : argv[i + 1]; };
const snippetPath = get(process.argv, "--snippet");
const userPath = get(process.argv, "--user");
const outPath = get(process.argv, "--out");
if (!snippetPath || !userPath || !outPath) {
  console.error("usage: merge-config.mjs --snippet <p> --user <p> --out <p>");
  process.exit(1);
}
const snippet = JSON.parse(readFileSync(snippetPath, "utf8"));
const user = JSON.parse(readFileSync(userPath, "utf8"));

const merged = { ...user };
// plugins: union, dedupe, bundle plugin list wins on duplicates
const bundlePlugins = snippet.plugins ?? [];
merged.plugins = [...new Set([...(user.plugins ?? []), ...bundlePlugins])];
// mcp.servers: purely additive — the bundle adds `graft` (machine-resolved in
// the snippet) and every user server, enabled or disabled, is preserved
// exactly as configured; nothing is ever removed.
const servers = { ...(user.mcp?.servers ?? {}) };
for (const [name, s] of Object.entries(snippet.mcp?.servers ?? {})) servers[name] = s;
merged.mcp = { ...(user.mcp ?? {}), servers };
writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
console.log("merged config -> " + outPath);
