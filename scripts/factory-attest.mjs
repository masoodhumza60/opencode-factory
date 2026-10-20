// factory-attest.mjs - the `attest` command: record one artifact on a bead.
//
// One invocation writes two things, both through primitives that already
// exist and are already tested: the artifact lands in the bead's manifest
// (hash, size, path, commit, session) and an `attest` event lands in its
// append-only trail. Nothing here decides WHEN attestation is due or enough
// - that is the verify work that follows - it only records an artifact, and
// refuses loudly when the record would be meaningless: no repo, no bead, no
// file, an empty file, an unknown kind, an id the policy does not declare.
//
// Refusals are part of the interface. Every one exits 1 and its message
// names the thing that fixes it - the flag, the file, the declared ids.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  projectRoot, gitHead, sha256File, loadManifest, saveManifest,
  upsertArtifact, appendTrail,
} from "./factory-manifest.mjs";
import { loadPolicy } from "./factory-policy.mjs";

// The sixteen kinds are copy-anchored to factory-policy's KINDS and to
// docs/factory-domain-profiles.md; changing the set means changing all three.
export const KINDS = [
  "screenshot", "transcript", "contract", "api-diff", "plan", "eval",
  "hil-log", "prr", "exit-code-matrix", "golden-file", "help-snapshot",
  "tty-transcript", "completion-script", "install-log", "device-capture",
  "check-output",
];

export class AttestError extends Error {
  constructor(message) {
    super(message);
    this.name = "AttestError";
  }
}

const FIRST_LINE = /\r?\n/;

function firstLine(text) {
  return String(text ?? "").split(FIRST_LINE)[0].trim();
}

// ---- argument parsing -------------------------------------------------------

const FLAGS = {
  id: "the check id this artifact satisfies (a non-empty id is accepted even without a policy)",
  kind: "one of the sixteen artifact kinds (docs/factory-domain-profiles.md)",
  command: "the command whose run produced this artifact (optional)",
  policy: "the policy file to read checks from instead of config/factory.policy.yaml (optional)",
};

// Positionals are `bead` then `path`; every other input must be a known flag
// with a value. An unknown or malformed flag stops the command before any of
// the recording steps can run.
export function parseArgs(argv) {
  const values = { id: null, kind: null, command: null, policy: null };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let inline = null;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (!Object.hasOwn(FLAGS, name)) {
      throw new AttestError(
        `unknown flag "${arg}"; accepted flags are --id <check>, --kind <kind>, ` +
        `--command "<cmd>", --policy <path>`,
      );
    }
    let value = inline;
    if (value === null) {
      value = argv[++i];
      if (value === undefined) {
        throw new AttestError(`flag --${name} is missing its value: write --${name} <value>; --${name} is ${FLAGS[name]}`);
      }
    }
    values[name] = value;
  }

  const [bead, path] = positional;
  if (bead === undefined) {
    throw new AttestError("missing required argument <bead>: the bead id this artifact belongs to");
  }
  if (path === undefined) {
    throw new AttestError("missing required argument <path>: the file the bead produced");
  }
  if (values.id === null || values.id === "") {
    throw new AttestError(`missing required flag --id: ${FLAGS.id}`);
  }
  if (values.kind === null || values.kind === "") {
    throw new AttestError(`missing required flag --kind: ${FLAGS.kind}`);
  }
  return { bead, path, ...values };
}

// ---- refusing what would be meaningless to record ---------------------------

function requireGitHead(root) {
  try {
    return gitHead(root);
  } catch (e) {
    const detail = firstLine(e && e.stderr ? e.stderr : e.message);
    throw new AttestError(
      `${detail}: run this inside a git repository: ` +
      `the manifest records the commit the artifact was produced at`,
    );
  }
}

function requireBead(bead) {
  try {
    // The environment is passed through untouched: bd resolves its own
    // workspace (BEADS_DIR included) and hiding it would hide the data.
    execFileSync("bd", ["show", bead, "--json"], { encoding: "utf8" });
  } catch (e) {
    const detail = firstLine(e && e.stderr ? e.stderr : e.message);
    throw new AttestError(`bead ${bead} was not found: bd show failed (${detail || "no stderr"})`);
  }
}

function refuseArtifactPath(rawPath) {
  const abs = resolve(process.cwd(), rawPath);
  let stat;
  try {
    stat = statSync(abs);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
      throw new AttestError(`${abs} does not exist: there is nothing to attest`);
    }
    throw e;
  }
  if (stat.isDirectory()) {
    throw new AttestError(`${abs} is a directory: attest the file it produced`);
  }
  if (stat.size === 0) {
    throw new AttestError(`${abs} is empty: a 0-byte artifact proves nothing`);
  }
  return { abs, stat };
}

function requireKind(kind) {
  if (!KINDS.includes(kind)) {
    throw new AttestError(
      `kind "${kind}" is not one of the sixteen kinds; the kinds are: ${KINDS.join(", ")}`,
    );
  }
}

function requireDeclaredId(policy, id) {
  const checks = policy.checks && typeof policy.checks === "object" && !Array.isArray(policy.checks)
    ? policy.checks
    : {};
  const names = Object.keys(checks);
  throw new AttestError(
    `check id "${id}" is not declared under checks; declared: ${names.length ? names.join(", ") : "nothing"}`,
  );
}

function loadChecksPolicy(root, override) {
  try {
    return loadPolicy(root, override);
  } catch (e) {
    // Policy problems (parse errors, an unreadable file) are refusals like
    // the rest: their message already names the file and the fix.
    throw new AttestError(e.message);
  }
}

// ---- attest -----------------------------------------------------------------

export function attest(argv) {
  // The argument parse is step zero: an unusable command line must be
  // refused before any of the recording steps below run.
  const args = parseArgs(argv);

  // 1. Anchor the project so manifest and trail are written beside its .beads.
  let root;
  try {
    root = projectRoot(process.cwd());
  } catch (e) {
    throw new AttestError(e.message);
  }

  // 2. The commit the artifact was produced at.
  const commit = requireGitHead(root);

  // 3. The bead must exist; a manifest for a ghost bead is a lie.
  requireBead(args.bead);

  // 4. The artifact must be a non-empty file.
  const { abs, stat } = refuseArtifactPath(args.path);

  // 5. The kind must be one of the sixteen.
  requireKind(args.kind);

  // 6. With a policy on disk, the id must be one it declares. Without one,
  //    any non-empty id is accepted: no policy, no gate yet.
  const policy = loadChecksPolicy(root, args.policy);
  if (policy && !Object.hasOwn(policy.checks ?? {}, args.id)) {
    requireDeclaredId(policy, args.id);
  }

  // 7. The artifact: the command is the caller's when given, otherwise the
  //    policy check's own command, otherwise null (nothing ran that we could
  //    name).
  const command = args.command
    ?? (policy ? policy.checks[args.id]?.command ?? null : null);
  const artifact = {
    id: args.id,
    kind: args.kind,
    path: relative(root, abs).split(sep).join("/"),
    sha256: sha256File(abs),
    bytes: stat.size,
    command,
    producer_session: process.env.FACTORY_SESSION || `factory:${randomUUID()}`,
    produced_at: new Date().toISOString(),
    commit,
  };

  // 8. Upsert by id, so re-attesting replaces in place rather than stacking.
  const manifest = loadManifest(root, args.bead);
  upsertArtifact(manifest, artifact);
  saveManifest(root, args.bead, manifest);

  // 9. The trail appends; it is the history, the manifest the current state.
  appendTrail(root, args.bead, {
    event: "attest",
    id: artifact.id,
    path: artifact.path,
    sha256: artifact.sha256,
    commit: artifact.commit,
    producer_session: artifact.producer_session,
  });

  // 10. Confirmation with the short hash and commit only - enough to spot
  //     which run this was, not enough to pretend the manifest is not
  //     already on disk in full.
  return `attested ${artifact.id} -> ${artifact.path} ` +
    `(sha256 ${artifact.sha256.slice(0, 12)}…, commit ${artifact.commit.slice(0, 7)}…)`;
}

// ---- entry ------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    // The subcommand word is part of the command line, not the arguments:
    // `attest` is this file's only verb.
    const argv = process.argv.slice(2);
    if (argv[0] === "attest") argv.shift();
    console.log(attest(argv));
    process.exit(0);
  } catch (e) {
    // AttestError is a refusal: print and leave. Anything else is a bug and
    // rethrows with its stack - a crash must never dress up as a refusal.
    if (e instanceof AttestError) {
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
