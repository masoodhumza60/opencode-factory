#!/usr/bin/env node
// opencode-factory: graft extract.js Windows patch (idempotent).
// Pristine graft@0.18.0 statically imports tree-sitter-kotlin, whose native
// binding has no Windows prebuilt — startup crashes. Replace with a dynamic
// import so kotlin files are parsed like any other language when a build/prebuild
// exists, and simply skipped when it can't load.
//
// Usage: node graft-patch-extract.mjs --dir "<graft package dir>"

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const idx = process.argv.indexOf("--dir");
if (idx === -1) {
  console.error("usage: node graft-patch-extract.mjs --dir <graft package dir>");
  process.exit(1);
}
const pkgDir = process.argv[idx + 1];
const file = join(pkgDir, "dist", "graph", "extract.js");
const original = readFileSync(file, "utf8");

const STATIC_IMPORT = 'import Kotlin from "tree-sitter-kotlin";';
const LET_KOTLIN = `let Kotlin;
try {
  // opencode-factory patch: tree-sitter-kotlin ships no Windows prebuilt
  // binding (source-only) and no native toolchain is assumed here, so a static
  // import would crash startup. Load it dynamically; when a build/prebuild
  // exists this resolves normally and kotlin files are parsed like any other
  // language. On failure, kotlin files are simply skipped by the per-file
  // try/catch in build.js/check.js.
  Kotlin = (await import("tree-sitter-kotlin")).default;
} catch {
  Kotlin = undefined;
}`;

if (!original.includes(STATIC_IMPORT)) {
  if (original.includes("Kotlin = (await import(\"tree-sitter-kotlin\"))")) {
    console.log("already patched: " + file);
    process.exit(0);
  }
  console.error("unexpected extract.js shape (static import missing); refusing to patch");
  process.exit(2);
}

writeFileSync(file, original.replace(STATIC_IMPORT, LET_KOTLIN), "utf8");
console.log("patched: " + file);
