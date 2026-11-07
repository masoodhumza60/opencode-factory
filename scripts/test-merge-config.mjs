#!/usr/bin/env node
// Proves merge-config survives the file OpenCode actually ships: JSONC, with
// comments and trailing commas. A strict JSON.parse here destroys a user's
// global config at install time.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "merge-config.mjs");
const dir = mkdtempSync(join(tmpdir(), "merge-config-test-"));
let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} — ${d}`); } };

const user = join(dir, "opencode.json");
const snippet = join(dir, "snippet.json");
const original = `{
  // the user's own server, which must survive
  "mcp": { "servers": { "mine": { "command": ["mine"] } } },
  "theme": "dark",
}
`;
writeFileSync(user, original);
writeFileSync(snippet, JSON.stringify({ plugins: ["/bundle/plugin.ts"], mcp: { servers: { "bundle": { command: ["bundle"] } } } }));

const r = (() => { try { return { code: 0, out: execFileSync(process.execPath, [SCRIPT, "--snippet", snippet, "--user", user, "--out", user], { encoding: "utf8" }) }; } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; } })();
check("a JSONC config with a trailing comma merges", r.code === 0, r.out);

const merged = JSON.parse(readFileSync(user, "utf8"));
check("the user's server survives", !!merged.mcp.servers.mine);
check("the bundle server is added", !!merged.mcp.servers.bundle);
check("unrelated user keys survive", merged.theme === "dark");
const backups = readdirSync(dir).filter((f) => f.includes(".bak-"));
check("a backup of the original was written", backups.length === 1, readdirSync(dir).join(","));
if (backups.length === 1) {
  check("the backup is byte-identical to the original", readFileSync(join(dir, backups[0]), "utf8") === original, backups[0]);
}

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n${pass}/${pass + fail} merge-config tests passed.`);
process.exit(fail ? 1 : 0);
