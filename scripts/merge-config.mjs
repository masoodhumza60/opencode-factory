#!/usr/bin/env node
// opencode-factory config merge. Call after the installer has resolved any
// machine-specific snippet contents so the snippet carries them in.
// usage: node merge-config.mjs --snippet <path> --user <path> --out <path>
import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const get = (argv, key) => { const i = argv.indexOf(key); return i === -1 ? undefined : argv[i + 1]; };
const snippetPath = get(process.argv, "--snippet");
const userPath = get(process.argv, "--user");
const outPath = get(process.argv, "--out");
if (!snippetPath || !userPath || !outPath) {
  console.error("usage: merge-config.mjs --snippet <p> --user <p> --out <p>");
  process.exit(1);
}
// OpenCode's config is officially JSONC. Strict JSON.parse here is how an
// install destroyed a real user's config: comments were legal input and the
// installer refused the file after having already written the plugin.
function stripJsonc(src) {
  let out = "", inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === "\\") { out += src[++i]; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}
function parseJsonc(text, what) {
  try {
    // Trailing commas are legal JSONC. Only strip them outside strings.
    const cleaned = stripJsonc(text);
    let result = "", inString = false;
    for (let i = 0; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inString) {
        result += c;
        if (c === "\\") { result += cleaned[++i]; }
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; result += c; continue; }
      if (c === ",") {
        let j = i + 1;
        while (j < cleaned.length && /\s/.test(cleaned[j])) j++;
        if (cleaned[j] === "}" || cleaned[j] === "]") continue;
      }
      result += c;
    }
    return JSON.parse(result);
  } catch (e) {
    console.error(`${what} is not valid JSON or JSONC (${e.message}); fix it by hand rather than losing it.`);
    process.exit(1);
  }
}

const snippet = parseJsonc(readFileSync(snippetPath, "utf8"), snippetPath);
const user = parseJsonc(readFileSync(userPath, "utf8"), userPath);

const merged = { ...user };
// plugins: union, dedupe, bundle plugin list wins on duplicates
const bundlePlugins = snippet.plugins ?? [];
merged.plugins = [...new Set([...(user.plugins ?? []), ...bundlePlugins])];
// mcp.servers: purely additive — any server the snippet declares (resolved on
// the machine at install time) is added, and every user server, enabled or
// disabled, is preserved exactly as configured; nothing is ever removed.
const servers = { ...(user.mcp?.servers ?? {}) };
for (const [name, s] of Object.entries(snippet.mcp?.servers ?? {})) servers[name] = s;
merged.mcp = { ...(user.mcp ?? {}), servers };
// The merge re-serialises the file, so any comments in the user's JSONC are
// lost. Keep the last five originals beside it: one file is a cheap price for
// being able to recover what the installer rewrote.
function backupUser(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14);
  const backup = `${path}.bak-${stamp}`;
  let candidate = backup;
  let n = 1;
  while (existsSync(candidate)) candidate = `${backup}-${n++}`;
  copyFileSync(path, candidate);
  const dir = dirname(path);
  const prefix = path.split(/[\\/]/).pop() + ".bak-";
  const old = readdirSync(dir || ".")
    .filter((f) => f.startsWith(prefix))
    .sort()
    .reverse()
    .slice(5);
  for (const f of old) {
    try { unlinkSync(join(dir, f)); } catch {}
  }
  return candidate;
}

const written = resolve(outPath) === resolve(userPath) ? backupUser(userPath) : null;
if (written) console.log("backed up " + userPath + " -> " + written);
writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
console.log("merged config -> " + outPath);
