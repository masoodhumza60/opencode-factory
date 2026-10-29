// factory-attest.mjs - the `attest` and `verify` commands.
//
// `attest` records one artifact on a bead: the artifact lands in the bead's
// manifest (hash, size, path, commit, session) and an `attest` event lands in
// its append-only trail.
//
// `verify` is the other half: it decides whether the artifacts a phase
// requires are actually there, current, and produced by someone else. It
// reads disk, git and `bd`, and renders a report - it never writes an
// artifact, only a `verify` event on the trail when it got as far as a
// decision.
//
// Refusals are part of the interface. Every one exits 1 and its message
// names the thing that fixes it - the flag, the file, the declared ids, the
// missing policy.

import { execFileSync } from "node:child_process";
import { statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, sep, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  projectRoot, gitHead, sha256File, loadManifest, saveManifest,
  upsertArtifact, appendTrail, ensureBuilderSession,
} from "./factory-manifest.mjs";
import { loadPolicy, effectiveChecks, requiredForPhase } from "./factory-policy.mjs";

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

  // 5b. A verdict artifact must name who said so. The factory:<uuid> fallback
  //     would hand every anonymous run a fresh identity, so a builder could
  //     attest its own review and look independent of itself. Other kinds keep
  //     the fallback: check-output has no second party to name.
  if (args.kind === "prr" && (process.env.FACTORY_SESSION ?? "").trim() === "") {
    throw new AttestError(
      "a verdict must be named; set FACTORY_SESSION to a reviewer session distinct from the builder");
  }

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
  const session = process.env.FACTORY_SESSION || `factory:${randomUUID()}`;
  const artifact = {
    id: args.id,
    kind: args.kind,
    path: relative(root, abs).split(sep).join("/"),
    sha256: sha256File(abs),
    bytes: stat.size,
    command,
    producer_session: session,
    produced_at: new Date().toISOString(),
    commit,
  };

  // 8. Upsert by id, so re-attesting replaces in place rather than stacking.
  //    The builder session is recorded here, once: the same `session` value
  //    feeds the artifact, so the fallback uuid cannot differ between the two
  //    and make one run look like two agents.
  const manifest = loadManifest(root, args.bead);
  ensureBuilderSession(manifest, session);
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

// ---- verify: reading what the bead says about itself ------------------------

const PHASE_RE = /^[0-8]$/;
const NO_STATE_RE = /^\(no .* state set\)$/;

// The phase the bead claims it is at, read from its own state labels through
// bd. `null` is a real answer - the bead has no phase recorded yet - and is
// kept distinct from "unreadable", which is a refusal. The environment is
// passed through untouched, exactly as in requireBead, so BEADS_DIR works.
export function readBeadPhase(bead) {
  let out;
  try {
    out = execFileSync("bd", ["state", bead, "phase"], { encoding: "utf8" });
  } catch (e) {
    const detail = firstLine(e && e.stderr ? e.stderr : e.message);
    throw new AttestError(`bead ${bead} was not found: bd state failed (${detail || "no stderr"})`);
  }
  const raw = String(out ?? "").trim();
  if (raw === "" || NO_STATE_RE.test(raw)) return null;
  const bare = raw.replace(/^phase:\s*/, "");
  if (PHASE_RE.test(bare)) return bare;
  throw new AttestError(`unrecognized phase state for ${bead}: ${raw}`);
}

// The bead's tier/profile overrides. Absent, empty or unreadable metadata all
// mean "no override": the policy file's own default applies. A missing bead is
// a refusal, using the same shape as requireBead so the message is stable.
export function loadBeadMeta(bead) {
  let out;
  try {
    out = execFileSync("bd", ["show", bead, "--json"], { encoding: "utf8" });
  } catch (e) {
    const detail = firstLine(e && e.stderr ? e.stderr : e.message);
    throw new AttestError(`bead ${bead} was not found: bd show failed (${detail || "no stderr"})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new AttestError(`bead ${bead} was not found: bd show did not return JSON (${firstLine(e.message)})`);
  }
  // bd show --json answers with an array; a filtered or wrapped shape may
  // answer with one object under `issue`. Either way the first record is the
  // bead we asked for.
  const record = Array.isArray(parsed) ? parsed[0] : (parsed.issue || parsed);
  const declared = record && typeof record === "object" ? record.metadata : null;
  const meta = {};
  if (declared && typeof declared === "object") {
    if (typeof declared.tier === "string" && declared.tier !== "") meta.tier = declared.tier;
    if (typeof declared.profile === "string" && declared.profile !== "") meta.profile = declared.profile;
  }
  return meta;
}

// ---- verify: the decision ---------------------------------------------------

// The exact command that would replace one artifact, so a failing report tells
// the reader what to run rather than only what is wrong.
function fixCommand(bead, id, check) {
  let cmd = `factory-attest attest ${bead} ${check.path} --id ${id} --kind ${check.kind}`;
  if (typeof check.command === "string" && check.command !== "") {
    cmd += ` --command "${check.command}"`;
  }
  return cmd;
}

// One check's ladder: existence, type, hash, freshness, producer, then -
// for a prr only - independence against the frozen builder session. The first
// rung that fails is the result - a re-hash says nothing when the file is gone.
function decide(entry, abs, expectedSha, head) {
  if (!entry) return "missing";
  let stat;
  try {
    stat = statSync(abs);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return "absent";
    throw e;
  }
  if (stat.isDirectory()) return "not-a-file";
  if (sha256File(abs) !== expectedSha) return "hash";
  if (entry.commit !== head) return "stale";
  if (typeof entry.producer_session !== "string" || entry.producer_session === "") return "producer";
  return "ok";
}

// The whole decision, pure apart from reading disk, git and bd. It never
// prints and never throws for a broken artifact: a broken artifact is data
// about the run, not a crash. Task 6 calls this directly before set-state.
export function verifyChecks(root, bead, phase, policy) {
  const meta = loadBeadMeta(bead);
  const { tier, profile } = effectiveChecks(policy, meta);
  const ids = requiredForPhase(policy, meta, phase);
  const head = gitHead(root);
  const manifest = loadManifest(root, bead);
  // The builder is the session frozen at the manifest's first write, not
  // whoever carries FACTORY_SESSION at verify time: a builder that re-runs
  // verify with a fresh session id must not thereby become independent of
  // itself. Only when the manifest predates the field and the caller has no
  // FACTORY_SESSION is there no second party, which is the M1a
  // not-applicable rung, not a licence.
  const builder = manifest.builder_session || process.env.FACTORY_SESSION;

  const checks = ids.map((id) => {
    const entry = manifest.artifacts.find((a) => a.id === id) || null;
    const def = policy.checks[id] || {};
    const result = decide(
      entry,
      entry ? join(root, entry.path) : null,
      entry ? entry.sha256 : null,
      head,
    );
    const row = {
      id,
      result,
      path: entry ? entry.path : null,
      sha256: entry ? entry.sha256 : null,
      commit: entry ? entry.commit : null,
      kind: def.kind,
      fix: fixCommand(bead, id, {
        path: entry && typeof entry.path === "string" ? entry.path : "<path>",
        kind: def.kind,
        command: def.command,
      }),
    };
    // Two fields the shape wants always, filled once the result is known: the
    // commit being checked against, and - only for a stale artifact - the
    // commit the artifact was actually recorded at. A hand-edited manifest can
    // leave that field missing or non-string; the walker found `stale` by
    // inequality, so the honest report is "we do not know", never a crash.
    row.head = head;
    if (result === "stale") {
      row.recorded_commit = typeof entry.commit === "string" ? entry.commit : null;
    }

    // Independence is only ever asked of a verdict artifact: a prr whose
    // reviewer is the session that built the bead proves nothing about that
    // bead. The builder is frozen in the manifest, so the comparison holds
    // whatever the caller's environment says now - re-labelling the session
    // after the fact does not launder a self-review. When no builder session
    // is on record anywhere (manifest predates the field, env unset), there
    // is no second party: the rung stays not-applicable, exactly as in M1a.
    if (result === "ok" && def.kind === "prr") {
      if (typeof builder !== "string" || builder === "") {
        row.result = "not-applicable";
      } else {
        const reviewer = entry.reviewer_session ?? entry.producer_session;
        if (reviewer === builder) {
          row.result = "independence";
          // Both names travel on the row so the report and --json can say who
          // reviewed and who built, not merely that the two collide.
          row.reviewer_session = reviewer;
          row.builder_session = builder;
        }
      }
    }
    return row;
  });

  const total = checks.length;
  const ok = checks.filter((c) => c.result === "ok").length;
  const failed = checks.filter((c) => c.result !== "ok" && c.result !== "not-applicable").length;

  return {
    bead,
    phase: String(phase),
    tier,
    profile,
    ok: failed === 0,
    checks,
    counts: { total, ok, failed },
  };
}

// ---- verify: rendering ------------------------------------------------------

// `ok` is the only lowercase label; every other result is loud on purpose, so
// a report scanned quickly cannot mistake a failure for a pass. Every value a
// hand-edited manifest can leave malformed is rendered as `<unknown>` rather
// than dereferenced: the report must survive the input it is reporting on.
const UNKNOWN = "<unknown>";
const short = (v, n) => (typeof v === "string" ? v.slice(0, n) : UNKNOWN);

function rowLine(row, details) {
  const label = row.result === "ok" ? "ok" : row.result.toUpperCase();
  const left = `  ${label.padEnd(5)} ${row.id.padEnd(9)} ${row.path ?? "<no path recorded>"}`;
  switch (row.result) {
    case "ok":
      return `${left}  sha256 ${short(row.sha256, 12)}…  commit ${short(row.commit, 7)}…`;
    case "not-applicable":
      return `${left}  no verdict independence to check: no builder session recorded and FACTORY_SESSION is not set`;
    case "missing":
      return `${left}  no artifact recorded; attest it with: ${row.fix}`;
    case "absent":
      return `${left}  the file is gone; attest it again with: ${row.fix}`;
    case "not-a-file":
      return `${left}  the path is not a regular file; attest the file it produced`;
    case "hash":
      return `${left}  sha256 changed: recorded ${short(row.sha256, 12)}…, on disk ${short(details.onDisk?.[row.id], 12)}…`;
    case "stale":
      return `${left}  recorded at commit ${short(row.recorded_commit, 7)}, HEAD is ${short(row.head, 7)}`;
    case "producer":
      return `${left}  no producer session recorded`;
    case "independence":
      return `${left}  the reviewer session "${short(row.reviewer_session, 40)}" ` +
        `is the builder session "${short(row.builder_session, 40)}"; the builder cannot review its own bead`;
    default:
      return left;
  }
}

export function renderVerify(result, details = { onDisk: {} }) {
  const where = `verify ${result.bead} phase ${result.phase} (tier ${result.tier}, profile ${result.profile})`;
  const rows = result.checks.map((row) => rowLine(row, details));
  const summary = `${result.counts.total} checks, ${result.counts.ok} ok, ${result.counts.failed} failed`;
  return [where, ...rows, summary].join("\n");
}

// ---- verify: the command ----------------------------------------------------

const VERIFY_FLAGS = {
  phase: "the phase to verify (0-8); defaults to the phase recorded on the bead",
  policy: "the policy file to read checks from instead of config/factory.policy.yaml (optional)",
  json: "print one JSON object instead of the human report",
};

function parseVerifyArgs(argv) {
  const values = { phase: null, policy: null, json: false };
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
    if (!Object.hasOwn(VERIFY_FLAGS, name)) {
      throw new AttestError(
        `unknown flag "${arg}"; accepted flags are --phase <n>, --policy <path>, --json`,
      );
    }
    if (name === "json") {
      if (inline !== null) throw new AttestError(`flag --json takes no value`);
      values.json = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      value = argv[++i];
      if (value === undefined) {
        throw new AttestError(`flag --${name} is missing its value: write --${name} <value>; --${name} is ${VERIFY_FLAGS[name]}`);
      }
    }
    values[name] = value;
  }

  const [bead] = positional;
  if (bead === undefined) {
    throw new AttestError("missing required argument <bead>: the bead whose phase artifacts to verify");
  }
  if (values.phase !== null && !PHASE_RE.test(values.phase)) {
    throw new AttestError(
      `--phase "${values.phase}" is not a phase; the accepted range is 0-8, one digit`,
    );
  }
  return { bead, ...values };
}

// `runVerify` resolves everything the decision needs, runs it, records the
// event and renders. It prints nothing itself: the caller owns stdout, which
// keeps `--json` to exactly one line. It returns the rendered text together
// with the verdict, because the exit code has to come from the decision, not
// from whether rendering succeeded.
export function runVerify(argv) {
  const args = parseVerifyArgs(argv);

  let root;
  try {
    root = projectRoot(process.cwd());
  } catch (e) {
    throw new AttestError(e.message);
  }

  // The bead must exist before anything else: a report about a ghost is noise.
  requireBead(args.bead);

  // Verification is the one command that cannot run policy-free: with no
  // policy there is no set of required checks to be missing.
  const policy = loadChecksPolicy(root, args.policy);
  if (policy === null) {
    throw new AttestError(
      "there is no policy to verify against: create config/factory.policy.yaml or pass --policy <path>",
    );
  }

  // The phase is the caller's when given, otherwise what the bead recorded.
  // No phase and none recorded is a refusal, not a guess.
  let phase = args.phase;
  if (phase === null) {
    phase = readBeadPhase(args.bead);
    if (phase === null) {
      throw new AttestError(
        `bead ${args.bead} has no recorded phase; pass --phase <n> to verify a phase explicitly`,
      );
    }
  }

  // Anchor the commit before the decision, so a non-git directory refuses
  // instead of reporting every artifact stale against a HEAD that does not
  // exist.
  try {
    gitHead(root);
  } catch (e) {
    const detail = firstLine(e && e.stderr ? e.stderr : e.message);
    throw new AttestError(
      `${detail}: run this inside a git repository: ` +
      `verification compares each artifact's commit with HEAD`,
    );
  }

  const result = verifyChecks(root, args.bead, phase, policy);

  // The renderer needs the hash currently on disk, to show both sides of a
  // mismatch. Derive it here, once, rather than widening what Task 6
  // receives.
  const details = { onDisk: {} };
  for (const row of result.checks) {
    if (row.result === "hash") details.onDisk[row.id] = sha256File(join(root, row.path));
  }

  appendTrail(root, args.bead, {
    event: "verify",
    phase: result.phase,
    tier: result.tier,
    profile: result.profile,
    ok: result.ok,
    total: result.counts.total,
    passed: result.counts.ok,
    failed: result.counts.failed,
  });

  if (args.json) {
    return {
      ok: result.ok,
      text: JSON.stringify({
        bead: result.bead,
        phase: result.phase,
        tier: result.tier,
        profile: result.profile,
        ok: result.ok,
        counts: result.counts,
        checks: result.checks.map((c) => ({
          id: c.id,
          result: c.result,
          path: c.path,
          sha256: c.sha256,
          commit: c.commit,
          ...(c.recorded_commit === undefined ? {} : { recorded_commit: c.recorded_commit }),
          ...(c.reviewer_session === undefined ? {} : { reviewer_session: c.reviewer_session }),
          ...(c.builder_session === undefined ? {} : { builder_session: c.builder_session }),
          head: c.head,
          kind: c.kind,
          fix: c.fix,
        })),
      }),
    };
  }
  return { ok: result.ok, text: renderVerify(result, details) };
}

// The frozen signature Task 6 imports: the human report, or a refusal. The
// verdict that decides the exit code is `runVerify`'s, since a string cannot
// carry it.
export function verify(argv) {
  return runVerify(argv).text;
}

// ---- protected files --------------------------------------------------------
// The grading machinery is the set of scripts that decide what counts as
// evidence. Pinning their hashes answers one question at ship time: are the
// rules that graded this bead the rules a human baselined? A hash cannot stop
// an edit; it makes one impossible to hide behind a green report.
export const PROTECTED_FILES = [
  "scripts/factory-attest.mjs",
  "scripts/factory-policy.mjs",
  "scripts/factory-manifest.mjs",
  "scripts/factory-phase.mjs",
  "scripts/factory-review.mjs",
];
export const PROTECTED_SET = "config/factory.protected.json";

// The factory install, not the user's project: the scripts live here, and this
// is the copy whose hashes are pinned. `fileURLToPath` because a URL pathname
// on Windows is `/C:/...` and join() would keep the leading slash.
export function factoryHome() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function sameProtectedSet(a, b) {
  if (!a || !b || a.version !== b.version) return false;
  const ka = Object.keys(a.files || {}).sort();
  const kb = Object.keys(b.files || {}).sort();
  if (ka.join("\n") !== kb.join("\n")) return false;
  return ka.every((k) => a.files[k] === b.files[k]);
}

// Every reason the pinned rules cannot be trusted, each naming the fix.
export function protectedProblems(home = factoryHome()) {
  const path = join(home, PROTECTED_SET);
  if (!existsSync(path)) {
    return [`no protected set at ${PROTECTED_SET}; run factory-attest protect --write as a human`];
  }
  let set = null;
  try {
    set = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [`${PROTECTED_SET} is not valid JSON: ${e.message}`];
  }
  if (!set || typeof set !== "object" || set.version !== 1 ||
      !set.files || typeof set.files !== "object") {
    return [`${PROTECTED_SET} is not a version 1 protected set`];
  }
  const problems = [];
  for (const file of PROTECTED_FILES) {
    const recorded = set.files[file];
    if (typeof recorded !== "string" || recorded === "") {
      problems.push(`${PROTECTED_SET} records no hash for ${file}`);
      continue;
    }
    const abs = join(home, file);
    if (!existsSync(abs)) {
      problems.push(`the grading machinery is missing ${file}`);
      continue;
    }
    if (sha256File(abs) !== recorded) problems.push(`the grading machinery changed: ${file}`);
  }
  // A baseline nobody committed is a baseline only its author can see. Compare
  // parsed JSON, not bytes: git stores LF and a Windows checkout may be CRLF,
  // which would make every run look uncommitted.
  let head = null;
  try {
    head = JSON.parse(execFileSync("git", ["-C", home, "show", `HEAD:${PROTECTED_SET}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    head = null;
  }
  if (!head || !sameProtectedSet(set, head)) {
    problems.push(`the protected set is not committed; commit ${PROTECTED_SET} before shipping`);
  }
  // A committed baseline is still unsigned by default. When the install carries
  // an allowed-signers file, the commit that last changed the set must verify
  // against it - the same sentence the acceptance tag is judged by. Without the
  // file a factory cannot check signatures at all, so the rule stays silent:
  // the docs state that ceiling rather than this check inventing a problem.
  const signers = join(home, "config", "factory.allowed_signers");
  if (existsSync(signers)) {
    let verdict = null;
    let shortSha = "";
    try {
      verdict = execFileSync("git",
        ["-C", home, "-c", `gpg.ssh.allowedSignersFile=${signers}`, "log", "-1",
          "--format=%G?", "--", PROTECTED_SET],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      shortSha = execFileSync("git",
        ["-C", home, "log", "-1", "--format=%h", "--", PROTECTED_SET],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      problems.push(
        "config/factory.allowed_signers exists but git cannot verify signatures; " +
        "check gpg.format=ssh and the allowed signers file");
      return problems;
    }
    if (verdict !== "G") {
      problems.push(
        `the protected set was last changed in ${shortSha}, which is not signed by an allowed signer`);
    }
  }
  return problems;
}

// The writer. Never edits a script; records what the scripts are now. Only a
// human may move the baseline, so an agent cannot bless its own edit.
export function protect(argv, home = factoryHome()) {
  const write = argv.includes("--write");
  if (write && process.env.FACTORY_ROLE !== "human") {
    throw new AttestError(
      "only a human may re-baseline the grading machinery; set FACTORY_ROLE=human");
  }
  const path = join(home, PROTECTED_SET);
  let previous = {};
  if (existsSync(path)) {
    try { previous = JSON.parse(readFileSync(path, "utf8")).files || {}; } catch { previous = {}; }
  }
  const files = {};
  const rows = [];
  for (const file of PROTECTED_FILES) {
    const hash = sha256File(join(home, file));
    files[file] = hash;
    const before = previous[file];
    rows.push(`${before === undefined ? "new    " : before === hash ? "ok     " : "changed"} ${file}`);
  }
  for (const file of Object.keys(previous)) {
    if (!PROTECTED_FILES.includes(file)) rows.push(`removed ${file}`);
  }
  if (write) writeFileSync(path, JSON.stringify({ version: 1, files }, null, 2) + "\n");
  return [
    `${write ? "wrote" : "would write"} ${PROTECTED_SET}`,
    ...rows,
    "",
    write
      ? "commit it: the pinned set must be in HEAD before ship can pass"
      : "re-run with --write and FACTORY_ROLE=human to record this baseline",
  ].join("\n");
}

// ---- entry ------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    // The subcommand word is part of the command line, not the arguments:
    // `attest` is the default verb, `verify` the other.
    const argv = process.argv.slice(2);
    const command = ["verify", "protect"].includes(argv[0]) ? argv[0] : "attest";
    if (["attest", "verify", "protect"].includes(argv[0])) argv.shift();
    if (command === "protect") {
      console.log(protect(argv));
      process.exit(0);
    }
    const run = command === "verify" ? runVerify(argv) : null;
    console.log(run ? run.text : attest(argv));
    // verify's exit code is its verdict; attest's is always success once it
    // recorded.
    process.exit(run && !run.ok ? 1 : 0);
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
