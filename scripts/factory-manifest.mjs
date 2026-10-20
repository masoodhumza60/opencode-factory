// factory-manifest.mjs - the shared primitives for mechanical attestation.
//
// Together these replace "a sentence exists" with "a hashed artifact exists,
// at a commit, produced by a session": where a bead's artifacts live, how a
// file is hashed, how the per-bead manifest reads and writes, and the
// append-only event trail beside it.
//
// Nothing here decides policy. This module never looks at what an artifact
// means or when one is required - it only stores and refuses malformed ones.
// Policy lives in tasks 3-5, which import these names.

import { execFileSync } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

// ---- project root -----------------------------------------------------------
//
// Every caller wants the same anchor: the directory holding `.beads`. Walking
// up from wherever we were launched (often a subdirectory, or a temp sandbox)
// keeps `bead` subcommands working from anywhere inside the project without
// every script re-deriving the root by hand.

export function projectRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    const marker = join(dir, ".beads");
    if (existsSync(marker) && statSync(marker).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `no .beads directory found above ${start}; ` +
        `run from the project root or set BEADS_DIR`,
      );
    }
    dir = parent;
  }
}

// ---- git --------------------------------------------------------------------

// The commit an artifact was produced at. Run in `root` so a repo nested
// inside another one answers with its own HEAD, not the outer repo's.
export function gitHead(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

// ---- hashing ----------------------------------------------------------------

export function sha256File(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`artifact file does not exist: ${path}`);
  }
  if (!st.isFile()) {
    throw new Error(`artifact path is not a regular file: ${path}`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---- the per-bead manifest --------------------------------------------------

export function manifestPath(root, bead) {
  return join(root, ".factory", bead, "manifest.json");
}

// Absent file reads as the empty manifest, so the first attestation does not
// need a scaffolding step. Present files are validated on read rather than
// trusted: a hand-edited or truncated manifest must be loud, because every
// later task treats what it loads as evidence.
export function loadManifest(root, bead) {
  const path = manifestPath(root, bead);
  if (!existsSync(path)) return { version: 1, bead, artifacts: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`manifest at ${path} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`manifest at ${path} is not a JSON object`);
  }
  if (parsed.version !== 1) {
    throw new Error(`manifest field "version" at ${path} is ${JSON.stringify(parsed.version)}; only version 1 is known`);
  }
  if (!Array.isArray(parsed.artifacts)) {
    throw new Error(`manifest field "artifacts" at ${path} is not an array (got ${typeof parsed.artifacts})`);
  }
  for (const [i, artifact] of parsed.artifacts.entries()) {
    if (!artifact || typeof artifact !== "object") {
      throw new Error(`manifest field "artifacts[${i}]" at ${path} is not a JSON object`);
    }
    for (const field of ["id", "path", "sha256"]) {
      if (artifact[field] === undefined) {
        throw new Error(`manifest field "artifacts[${i}].${field}" at ${path} is missing`);
      }
    }
  }
  return parsed;
}

// Atomic write: temp file, then rename over the real path. A crash mid-write
// leaves a .tmp behind, never a half-written manifest. Stringify the object we
// were GIVEN - fields the caller added that this module does not know about
// must survive the round trip.
export function saveManifest(root, bead, manifest) {
  const path = manifestPath(root, bead);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, path);
}

// Replace by id in place so keepers of the ordering (a diff of two runs is
// much easier to read unmoved) keep it; append otherwise. Returns the
// manifest so callers can chain.
export function upsertArtifact(manifest, artifact) {
  const i = manifest.artifacts.findIndex((a) => a.id === artifact.id);
  if (i >= 0) manifest.artifacts[i] = artifact;
  else manifest.artifacts.push(artifact);
  return manifest;
}

// ---- the append-only trail --------------------------------------------------

function trailPath(root, bead) {
  return join(root, ".factory", bead, "trail.jsonl");
}

// Exactly one JSON line per event: append, never read-modify-write, so a
// crash between two appends cannot lose the first one. The timestamp and bead
// are added here so callers cannot record an event without either.
export function appendTrail(root, bead, event) {
  const path = trailPath(root, bead);
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), bead, ...event });
  appendFileSync(path, line + "\n");
}

// Parse the trail back. Every line must be a JSON object on its own line; an
// empty or malformed line is an error naming its line number, because an
// append-only file with one is evidence of a broken writer - skipping it
// would silently shorten the history.
export function readTrail(root, bead) {
  const path = trailPath(root, bead);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  // A trailing newline is how every writer in this module leaves the file;
  // only that last empty piece is expected, anything else is a real gap.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body === "") return [];
  return body.split("\n").map((line, i) => {
    const at = i + 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`trail ${path} line ${at} is not valid JSON: ${e.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`trail ${path} line ${at} is not a JSON object`);
    }
    return parsed;
  });
}
