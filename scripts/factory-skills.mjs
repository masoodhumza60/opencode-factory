#!/usr/bin/env node
// factory-skills.mjs - the engine behind skills/catalog.yaml.
//
// The catalog is DATA. This script is the only thing that reads it and acts on
// it, so "which skills must every machine have" has exactly one answer that is
// machine-checkable. Right now that answer lives in prose across conductor.md,
// the two command files and the selfcheck, which is exactly the arrangement
// that let `bd gate list --all` report "No gates found" on two real projects
// whose markdown claimed three approved gates.
//
//   node scripts/factory-skills.mjs check [--json] [--catalog <path>]
//   node scripts/factory-skills.mjs install [--dry-run] [--catalog <path>]
//
// Exit codes:
//   0  every mandatory skill is present (or, for install, everything needed was installed)
//   1  a mandatory skill is missing, or the catalog could not be read
//
// Two design decisions worth stating, because both were learned the hard way:
//
// 1. FAIL, NEVER WARN. A mandatory skill that is merely warned about is a gate
//    people learn to ignore. The first version of the dcp check shipped as a
//    FAIL on "pruned nothing" and had to be walked back to WARN because it
//    cried wolf on healthy fresh machines. Mandatory skills have no such
//    excuse: a machine missing commit-work will reach phase 7 and have nothing
//    to run, so that is a hard failure with the install command in the message.
//
// 2. NEVER INSTALL SILENTLY INTO A PROJECT. Mandatory skills are machine-wide
//    (~/.agents/skills), installed once per device by the bundle installer.
//    Per-project skills belong to `factory discover`, which records its choices
//    in the project's decision file. Keeping those two apart is what makes
//    `check` mean the same thing on every machine.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = resolve(HERE, "..", "skills", "catalog.yaml");

// ---------------------------------------------------------------- catalog ---

// A deliberately small YAML reader. It understands exactly the shape
// skills/catalog.yaml uses - scalars, a list of maps, and a map of lists of
// maps - and throws on anything else. A permissive parser is how a typo in a
// config file becomes a silently-empty skill list, and an empty skill list
// means "nothing is mandatory", which is the most dangerous possible failure
// for a file whose whole job is to say what must be present.
function unquote(v) {
  const s = v.trim();
  if ((s.startsWith("'") && s.endsWith("'") && s.length > 1) ||
      (s.startsWith('"') && s.endsWith('"') && s.length > 1)) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  if (s !== "" && !Number.isNaN(n)) return n;
  return unquote(s);
}

const TOP_LEVEL_KEYS = new Set(["version", "mandatory", "topics"]);
// Only this schema version is understood. A future catalog that means
// something different must be refused here, not read under these rules -
// reading v3 with v2 assumptions is how a catalog silently stops saying what
// it appears to say.
const SUPPORTED_VERSIONS = new Set([2]);

function parseCatalog(text) {
  const lines = text.split(/\r?\n/);
  const out = { version: null, mandatory: [], topics: {} };
  let section = null;      // "mandatory" | "topics" | null
  let listKey = null;      // current list name inside a section
  let current = null;      // current map being accumulated
  let entryKeyCol = -1;    // column the current entry's first key started at

  const fail = (i, msg) => {
    const e = new Error(`catalog.yaml line ${i + 1}: ${msg}`);
    e.code = "CATALOG_INVALID";
    throw e;
  };

  // The column a key actually starts at. A list item's first key sits two
  // columns right of its dash, and every sibling key must start in that same
  // column. That is what catches the mis-indented entry: without it,
  //     - name: foo
  //      source: a/b
  //      why: x
  // parses as a complete entry and the skill reads as fully specified when
  // its source was never really aligned with it.
  const colOf = (rawText, key) => rawText.indexOf(key);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^\s/.test(raw) === false && line.trim() === "---") continue;

    const indent = raw.length - raw.trimStart().length;
    const text2 = line.trim();

    if (indent === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(text2);
      if (!m) fail(i, `cannot read top-level line: ${text2}`);
      const [, key, rest] = m;
      if (!TOP_LEVEL_KEYS.has(key)) fail(i, `unknown top-level key "${key}"`);
      if (rest.trim() !== "") {
        out[key] = parseScalar(rest);
        section = null;
        continue;
      }
      if (key === "mandatory" || key === "topics") {
        section = key;
        listKey = null;
        current = null;
        entryKeyCol = -1;
        continue;
      }
      fail(i, `key "${key}" needs a value`);
    }

    if (section === null) fail(i, `indented line outside any section: ${text2}`);

    if (section === "mandatory") {
      const item = /^-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(text2);
      if (item) {
        current = {};
        out.mandatory.push(current);
        current[item[1]] = parseScalar(item[2]);
        entryKeyCol = colOf(raw, item[1]);
        continue;
      }
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(text2);
      if (kv && current) {
        if (colOf(raw, kv[1]) !== entryKeyCol) {
          fail(i, `key "${kv[1]}" is mis-indented (column ${colOf(raw, kv[1])}, siblings at ${entryKeyCol})`);
        }
        current[kv[1]] = parseScalar(kv[2]);
        continue;
      }
      fail(i, `cannot read mandatory entry: ${text2}`);
    }

    if (section === "topics") {
      const head = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(text2);
      if (head) { listKey = head[1]; out.topics[listKey] = []; current = null; entryKeyCol = -1; continue; }
      const item = /^-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(text2);
      if (item) {
        if (!listKey) fail(i, "topic entry before any topic name");
        current = {};
        out.topics[listKey].push(current);
        current[item[1]] = parseScalar(item[2]);
        entryKeyCol = colOf(raw, item[1]);
        continue;
      }
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(text2);
      if (kv && current) {
        if (colOf(raw, kv[1]) !== entryKeyCol) {
          fail(i, `key "${kv[1]}" is mis-indented (column ${colOf(raw, kv[1])}, siblings at ${entryKeyCol})`);
        }
        current[kv[1]] = parseScalar(kv[2]);
        continue;
      }
      fail(i, `cannot read topic entry: ${text2}`);
    }
  }

  // A catalog that parsed but says nothing is not a catalog. Treat it as a
  // failure rather than reporting "0 mandatory skills, all present", which is
  // the exact sentence a typo would produce and the hardest one to notice.
  if (!Array.isArray(out.mandatory) || out.mandatory.length === 0) {
    const e = new Error("catalog.yaml lists no mandatory skills - refusing to treat that as 'nothing is required'");
    e.code = "CATALOG_EMPTY";
    throw e;
  }
  if (out.version === null) {
    const e = new Error("catalog.yaml has no 'version' - refusing to guess the schema");
    e.code = "CATALOG_INVALID";
    throw e;
  }
  if (!SUPPORTED_VERSIONS.has(out.version)) {
    const e = new Error(`catalog.yaml version ${out.version} is not one this script understands (${[...SUPPORTED_VERSIONS].join(", ")}) - upgrade the factory, do not reinterpret the file`);
    e.code = "CATALOG_INVALID";
    throw e;
  }
  for (const m of out.mandatory) {
    for (const k of ["name", "source", "why"]) {
      if (typeof m[k] !== "string" || m[k].trim() === "") {
        const e = new Error(`catalog.yaml: mandatory entry missing "${k}"`);
        e.code = "CATALOG_INVALID";
        throw e;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- resolution ---

function skillDirs() {
  const dirs = [];
  const push = (root, scope) => {
    if (!existsSync(root)) return;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const d = join(root, e.name);
      // must be a FILE. existsSync alone returns true for a directory called
      // SKILL.md, which would let a half-deleted or interrupted install count
      // as present - the machine reports healthy and the phase then finds no
      // skill to load.
      let manifest = join(d, "SKILL.md");
      let ok = false;
      try { ok = statSync(manifest).isFile(); } catch { ok = false; }
      if (ok) dirs.push({ name: e.name, dir: d, scope });
    }
  };
  push(join(homedir(), ".agents", "skills"), "global");
  push(join(process.cwd(), ".agents", "skills"), "project");
  return dirs;
}

function check(catalog) {
  const installed = skillDirs();
  const byName = new Map();
  for (const s of installed) if (!byName.has(s.name)) byName.set(s.name, s);
  const results = catalog.mandatory.map((m) => {
    const found = byName.get(m.name);
    return {
      name: m.name,
      source: m.source,
      official: m.official === true,
      phases: m.phases ?? null,
      present: Boolean(found),
      scope: found ? found.scope : null,
      dir: found ? found.dir : null,
      why: m.why,
    };
  });
  return { results, missing: results.filter((r) => !r.present) };
}

// ---------------------------------------------------------------- install ---

// `npx skills add <source> -s <name> -g -a opencode --copy -y`
//   -g          machine-wide, because these are mandatory on every device
//   -a opencode target the agent that will load them
//   --copy      copy files rather than symlinking (Windows symlinks need
//               elevation, and a machine-global install that fails on a fresh
//               Windows box is worse than a slightly larger install)
//   -y          no prompt; this runs unattended inside the installer
// Note: `npx skills find` is INTERACTIVE and is never used by any script.
function installOne(entry, { dryRun }) {
  const args = ["--yes", "skills", "add", entry.source, "-s", entry.name, "-g", "-a", "opencode", "--copy", "-y"];
  if (dryRun) return { name: entry.name, action: "would-install", cmd: `npx ${args.join(" ")}` };
  const env = { ...process.env, DISABLE_TELEMETRY: "1" };
  const r = process.platform === "win32"
    ? spawnSync("npx " + args.join(" "), { shell: true, env, timeout: 300000, encoding: "utf8" })
    : spawnSync("npx", args, { env, timeout: 300000, encoding: "utf8" });
  return {
    name: entry.name,
    action: r.status === 0 ? "installed" : "failed",
    detail: r.status === 0 ? "ok" : String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 160),
  };
}

// ------------------------------------------------------------------- main ---

function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const ci = args.indexOf("--catalog");
  const catalogPath = ci !== -1 && args[ci + 1] ? resolve(args[ci + 1]) : DEFAULT_CATALOG;

  if (cmd !== "check" && cmd !== "install") {
    process.stderr.write("usage: factory-skills.mjs check|install [--json] [--dry-run] [--catalog <path>]\n");
    return 1;
  }

  let catalog;
  try {
    catalog = parseCatalog(readFileSync(catalogPath, "utf8"));
  } catch (e) {
    const msg = e.code === "ENOENT"
      ? `catalog not found at ${catalogPath}`
      : e.message;
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
    } else {
      process.stdout.write(`FAIL mandatory skills: catalog unreadable - ${msg}\n`);
    }
    return 1;
  }

  if (cmd === "install") {
    const { missing } = check(catalog);
    const todo = missing.map((m) => catalog.mandatory.find((c) => c.name === m.name));
    if (todo.length === 0) {
      if (json) process.stdout.write(JSON.stringify({ ok: true, installed: [], note: "already present" }) + "\n");
      else process.stdout.write(`mandatory skills: all ${catalog.mandatory.length} already present, nothing to install\n`);
      return 0;
    }
    const results = todo.map((e) => installOne(e, { dryRun }));
    // Re-check from disk rather than trusting the CLI's exit code. The CLI
    // printing a success banner is not evidence; the SKILL.md being on disk is.
    const after = check(catalog);
    const stillMissing = after.missing.map((m) => m.name);
    // A dry run installs nothing, so "still missing" is the expected outcome
    // rather than a failure. Judging a preview by the same rule as a real
    // install would make `--dry-run` always exit 1, and a check that is red
    // on the happy path is a check people stop reading.
    const ok = dryRun || stillMissing.length === 0;
    if (json) {
      process.stdout.write(JSON.stringify({ ok, results, stillMissing }) + "\n");
    } else {
      for (const r of results) {
        process.stdout.write(`  ${r.action} ${r.name}${r.detail && r.detail !== "ok" ? ` - ${r.detail}` : ""}\n`);
      }
      process.stdout.write(ok
        ? `mandatory skills: ${dryRun ? `${todo.length} would be installed` : `${catalog.mandatory.length}/${catalog.mandatory.length} present`}${dryRun ? " (dry-run - nothing written)" : ""}\n`
        : `mandatory skills: still missing after install - ${stillMissing.join(", ")}\n`);
    }
    return ok ? 0 : 1;
  }

  // check
  const { results, missing } = check(catalog);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: missing.length === 0, total: results.length, results, missing: missing.map((m) => m.name) }) + "\n");
    return missing.length === 0 ? 0 : 1;
  }
  for (const r of results) {
    const where = r.present ? `${r.scope} (${r.dir})` : "MISSING";
    process.stdout.write(`  ${r.present ? "ok  " : "MISS"} ${r.name.padEnd(16)} ${r.source.padEnd(28)} ${where}\n`);
  }
  if (missing.length === 0) {
    process.stdout.write(`PASS mandatory skills: ${results.length}/${results.length} present\n`);
    return 0;
  }
  process.stdout.write(`FAIL mandatory skills: ${missing.length} missing - ${missing.map((m) => m.name).join(", ")}\n`);
  process.stdout.write(`     fix: npx skills add softaworks/agent-toolkit -s <name> -g -a opencode --copy -y\n`);
  return 1;
}

process.exit(main(process.argv));
