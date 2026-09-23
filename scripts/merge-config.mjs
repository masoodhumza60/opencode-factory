#!/usr/bin/env node
// opencode-factory config merge. Call after the installer has resolved the
// graft command so the snippet carries it in.
// usage: node merge-config.mjs --snippet <path> --user <path> --out <path>
import { readFileSync, writeFileSync } from "node:fs";

const get = (argv, key) => argv[argv.indexOf(key) + 1];
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
// mcp.servers: bundle owns `graft`; bundle disables these servers; else user keeps theirs
const owns = new Set(["graft"]);
const disabledDrops = new Set(["chrome-devtools", "github", "nuxt", "nuxt-ui", "nuxt-hub"]);
const servers = { ...(user.mcp?.servers ?? {}) };
for (const [name, s] of Object.entries(snippet.mcp?.servers ?? {})) servers[name] = s;
const finalServers = {};
for (const [name, cfg] of Object.entries(servers)) {
  if (owns.has(name) || !disabledDrops.has(name)) finalServers[name] = cfg;
}
merged.mcp = { ...(user.mcp ?? {}), servers: finalServers };
writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
console.log("merged config -> " + outPath);
