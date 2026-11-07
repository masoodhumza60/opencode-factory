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
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  statSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

// ---- project root -----------------------------------------------------------
//
// Every caller wants the same anchor: the directory holding `.beads`. Walking
// up from wherever we were launched (often a subdirectory, or a temp sandbox)
// keeps `bead` subcommands working from anywhere inside the project without
// every script re-deriving the root by hand.
//
// `BEADS_DIR` wins when it is set, because that is the workspace `bd` itself
// will talk to. Without this, `attest` (which resolves from the cwd) and
// `complete` (which asks `bd` where its workspace is) can anchor on different
// directories, and every artifact written by one is `MISSING` to the other.

// A `.beads` directory is a workspace only if it contains a database. Probed
// against bd 1.3.0 on this host: `bd init` (both with and without
// BEADS_NO_DOLT) stores the database in `.beads/embeddeddolt`, and
// `bd where` reports that path as the database. But bd ALSO writes telemetry
// into `~/.beads` (eventsData/ + machine-id) with no database in it - a
// directory this code must NOT count as a workspace, because the bd that then
// runs underneath rejects it with "no beads database found".
// "Non-empty" is therefore not the test; presence of the database is.
// Unknown shapes (an older or different bd backend) are refused here too -
// fail closed - and the message says to set BEADS_DIR, where an explicit
// pointer is trusted exactly as the user gave it.
//
// This lives here, not in factory-phase, because `attest` and `complete` must
// agree on the project root. When each module had its own predicate, a `.beads`
// directory with no database (an aborted `bd init`) made `attest` write its
// manifest in one place while `complete` looked in another, and every artifact
// was reported MISSING.
export function isWorkspaceBeads(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  if (!entries.length) return false;
  return entries.some(
    (e) =>
      e === "embeddeddolt" || e === "issues.jsonl" ||
      e.endsWith(".db") || e.endsWith(".sqlite")
  );
}

export function projectRoot(start = process.cwd()) {
  const declared = (process.env.BEADS_DIR || "").trim();
  if (declared) {
    const beads = resolve(declared);
    if (!existsSync(beads) || !statSync(beads).isDirectory()) {
      throw new Error(
        `BEADS_DIR points at ${beads}, which is not a directory; ` +
        `point it at the .beads directory or unset it`,
      );
    }
    return dirname(beads);
  }
  let dir = resolve(start);
  for (;;) {
    const marker = join(dir, ".beads");
    if (existsSync(marker) && isWorkspaceBeads(marker)) return dir;
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
  // The one field that is not an artifact: the session that first touched the
  // bead. Validated like everything else, because a manifest that says
  // `builder_session: {}` would compare unequal to every reviewer session and
  // silently make self-review look independent.
  if (parsed.builder_session !== undefined &&
      (typeof parsed.builder_session !== "string" || parsed.builder_session.trim() === "")) {
    throw new Error(
      `manifest field "builder_session" at ${path} is ${JSON.stringify(parsed.builder_session)}; expected a non-empty string`);
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

// The session that first touched this bead, recorded once and never replaced.
// Independence is the whole point: a builder that re-runs with a fresh
// FACTORY_SESSION must not thereby become a different agent from the one that
// produced the artifacts. Attest and review record are the only artifact
// writers, and both require this field, so every bead that can be graded has
// it; verify compares against it, never against whatever the caller's
// environment says now.
export function ensureBuilderSession(manifest, session) {
  if (!manifest.builder_session) manifest.builder_session = session;
  return manifest.builder_session;
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
