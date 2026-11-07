// mcp-defmatch.mjs - one predicate, no side effects, no imports.
//
// It lives in its own file for a reason that cost a day once: it was first
// exported from factory-mcp.mjs, and importing THAT module runs its CLI
// dispatch, so the test process exited on the usage banner before a single
// assertion ran. A function cannot be unit-tested from a file that does
// things on load. Keep this file importable and keep it boring.
//
// What it is for: after writing a server definition, prove the file on disk
// says what we meant. A write that silently disagrees produces a config
// opencode ignores - the entry looks installed and the server never
// appears - which is worse than not writing it at all.

export function defMatches(got, def) {
  // Both sides are checked. `got` is whatever came back off disk and `def` is what
  // we meant to write; either can be missing, and a comparator that throws on a
  // missing side turns a clear mismatch into a stack trace.
  if (!got || typeof got !== "object") return false;
  if (!def || typeof def !== "object") return false;
  if (got.type !== def.type) return false;
  // V2: opencode stops a server with `disabled`, so the key we write is
  // `disabled: false` and an explicit false is required. Absent also connects,
  // but requiring the key catches a partial write that opencode would read as
  // a server inheriting global rather than one this tool just installed.
  if (got.disabled !== false) return false;
  if (def.type === "remote") return typeof got.url === "string" && got.url === def.url;
  if (!Array.isArray(got.command)) return false;
  return JSON.stringify(got.command) === JSON.stringify(def.command);
}
