#!/usr/bin/env node
// The reviewer's tool. M1a recorded who produced an artifact, but the producer
// was whoever the environment said it was, and nothing stopped that "who" from
// being the builder twice. This module makes the second voice a named, separate
// session with exactly one write: its verdict.
//
// Five commands:
//   start    - turn the evidence into a package a reviewer can read in one sitting
//   record   - take the verdict, after checking the reviewer is not the builder
//   show     - print what was recorded and whether it still holds
//   accept   - a human records that this bead's pass was accepted, and signs it
//   withdraw - the same human undoes it, naming why; the trail keeps both lines
//
// Nothing here judges the work. The reviewer does that in prose; the machine
// only checks that the prose came from a different session and still describes
// the bytes on disk. Accept judges even less: it makes an annotated tag named
// factory-accept/<bead> and signs it with git's SSH signing key, and only a key
// listed in config/factory.allowed_signers makes the signature mean anything.
// A file left beside the review is no longer an acceptance; the tag is.

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  projectRoot, gitHead, sha256File, loadManifest, saveManifest,
  upsertArtifact, appendTrail, manifestPath, readTrail,
} from "./factory-manifest.mjs";
import { loadPolicy, effectiveChecks, requiredForPhase } from "./factory-policy.mjs";
import { readBeadPhase, loadBeadMeta } from "./factory-attest.mjs";

export class ReviewError extends Error {}

const ROLES = ["builder", "reviewer", "orchestrator", "human"];

// The role is declared, like the session. An unknown value is a refusal rather
// than a silent fallback to builder: a typo must not quietly grant or deny a
// capability that the rest of the run is judged by.
function role() {
  const raw = (process.env.FACTORY_ROLE ?? "").trim();
  if (raw === "") return "builder";
  if (!ROLES.includes(raw)) {
    throw new ReviewError(
      `unknown FACTORY_ROLE "${raw}"; expected builder, reviewer, orchestrator or human`);
  }
  return raw;
}

// The reviewer must be named. Unlike attest, there is no fallback uuid here: an
// anonymous review cannot be compared to the builder, so it would be decoration.
function namedSession(what) {
  const raw = (process.env.FACTORY_SESSION ?? "").trim();
  if (raw === "") {
    throw new ReviewError(`${what} must be named; set FACTORY_SESSION to the session id`);
  }
  return raw;
}

function rootOrRefusal() {
  try {
    return projectRoot(process.cwd());
  } catch (e) {
    throw new ReviewError(e.message);
  }
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// The reviewer reads evidence, not the builder's story: task reports and the
// working scratchpad live under `.superpowers/`, so a diff that carried their
// text would hand the reviewer exactly the narrative the design says it must
// not see. Every range command below filters that path out.
const EVIDENCE_ONLY = ["--", ":(exclude).superpowers"];

// Resolve a revision once, up front: a base given as a branch name could move
// between the package being written and the verdict being recorded.
function resolveCommit(root, rev, flag) {
  try {
    return git(root, ["rev-parse", "--verify", `${rev}^{commit}`]).trim();
  } catch {
    throw new ReviewError(`${flag} "${rev}" is not a commit in this repository`);
  }
}

// The plan's signature leaves --base optional. Without it the range still has
// to be definite, so it starts at the repository's first commit - and only a
// repository with exactly one root commit can answer that unambiguously; a
// multi-root history must ask, not guess.
function firstCommit(root) {
  const out = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"],
    { cwd: root, encoding: "utf8" }).trim();
  if (out === "") {
    throw new ReviewError(
      "this repository has no commits; make one before review start");
  }
  const ids = out.split("\n");
  if (ids.length > 1) {
    throw new ReviewError(
      "review start needs --base <rev>: this repository has more than one root commit, " +
      "so the base of the reviewed range cannot be guessed");
  }
  return ids[0];
}

function porcelain(root) {
  // core.quotePath=false keeps non-ASCII bytes raw instead of C-quoted, so a
  // bead id or file path that carries them matches by eye and by carve-out:
  // the verdict-file comparison in record compares these very strings.
  return git(root, ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line.trim() !== "");
}

// `.factory/` is the ledger, not the product, and `.beads/` is bd's own
// workspace: this module appends to the one on every command and bd may write
// the other at any moment between the snapshot and the verdict, so neither of
// those looks like the reviewer's edits.
function isProductPath(path) {
  return (path !== ".factory" && !path.startsWith(".factory/") && !path.startsWith(".factory\\")) &&
    (path !== ".beads" && !path.startsWith(".beads/") && !path.startsWith(".beads\\"));
}

function productChanges(lines) {
  return lines.filter((line) => isProductPath(line.slice(3).trim()));
}

// A rename spells as "from -> to"; both ends are real files to fingerprint.
function porcelainPaths(lines) {
  const out = [];
  for (const line of lines) {
    const field = line.slice(3);
    for (const raw of field.includes(" -> ") ? field.split(" -> ") : [field]) {
      const path = raw.trim();
      if (path !== "" && isProductPath(path)) out.push(path);
    }
  }
  return out;
}

// The content half of the scope snapshot: a porcelain line that does not change
// does not mean the file did not change - a path already `M ` at start can be
// edited again and the line set is identical afterwards. So the fingerprint
// records every product file's sha256 at start, and `record` recomputes them.
function scopeFiles(root, lines) {
  const files = {};
  for (const path of porcelainPaths(lines)) {
    try {
      const abs = join(root, path);
      if (!statSync(abs).isFile()) continue;
      files[path] = sha256File(abs);
    } catch {
      // Gone between snapshot and hash: the line-set check owns existence.
    }
  }
  return files;
}

function reviewDir(root, bead) {
  return join(root, ".factory", bead);
}

function scopePath(root, bead) {
  return join(reviewDir(root, bead), "review-scope.json");
}

// ---- argument parsing -------------------------------------------------------

// Deliberately the same shape as attest's parser: flags are declared, unknown
// flags name what is accepted, and a missing value says which flag is short.
function parseFlags(argv, spec, usage) {
  const values = {};
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
    if (!Object.hasOwn(spec, name)) {
      throw new ReviewError(`unknown flag "${arg}"; ${usage}`);
    }
    if (spec[name] === null) {
      if (inline !== null) throw new ReviewError(`flag --${name} takes no value`);
      values[name] = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      value = argv[++i];
      if (value === undefined) {
        throw new ReviewError(`flag --${name} is missing its value; ${usage}`);
      }
    }
    values[name] = value;
  }
  return { values, positional };
}

function beadOf(positional) {
  const bead = positional[0];
  if (bead === undefined || bead.trim() === "") {
    throw new ReviewError("missing required argument <bead>");
  }
  if (positional.length > 1) {
    throw new ReviewError(`unexpected extra argument "${positional[1]}"`);
  }
  return bead;
}

// ---- start ------------------------------------------------------------------

const START_FLAGS = { phase: "", base: "", policy: "" };
const START_USAGE = "accepted flags are --base <rev>, --phase <n>, --policy <path>";

function policyFor(root, override) {
  try {
    return loadPolicy(root, override ?? undefined);
  } catch (e) {
    throw new ReviewError(e.message);
  }
}

// The package is the reviewer's whole world: the diff, the artifacts, the
// checks, and what the verdict file must look like. It deliberately contains no
// task reports, no commit messages beyond their subject line, and no narrative
// from the builder - a reviewer handed the story of the work reviews the story.
export function start(argv) {
  const { values, positional } = parseFlags(argv, START_FLAGS, START_USAGE);
  const bead = beadOf(positional);
  const root = rootOrRefusal();

  if (!existsSync(manifestPath(root, bead))) {
    throw new ReviewError(`no manifest for ${bead}; nothing has been attested, so there is nothing to review`);
  }
  const manifest = loadManifest(root, bead);
  if (!manifest.artifacts.length) {
    throw new ReviewError(`the manifest for ${bead} is empty; attest at least one artifact first`);
  }

  let base;
  if (values.base === undefined) {
    base = firstCommit(root);
  } else {
    base = resolveCommit(root, values.base, "--base");
  }
  const head = gitHead(root);

  const phase = values.phase ?? readBeadPhase(bead) ?? "unrecorded";
  if (phase !== "unrecorded" && !/^[0-8]$|^4p$/.test(phase)) {
    throw new ReviewError(`--phase "${phase}" is not a phase; the accepted range is 0-8, one digit (4p for the debug detour)`);
  }

  const policy = policyFor(root, values.policy);
  let tierProfile = "no policy file: the checks are whatever was attested";
  let required = [];
  if (policy) {
    const meta = loadBeadMeta(bead);
    const { tier, profile } = effectiveChecks(policy, meta);
    tierProfile = `tier ${tier}, profile ${profile}`;
    const at = phase === "unrecorded" ? "0" : phase;
    required = requiredForPhase(policy, meta, at).map((id) => {
      const def = policy.checks[id] || {};
      return { id, kind: def.kind ?? "?", command: def.command ?? "(no command declared)" };
    });
  }

  const log = git(root, ["log", "--oneline", "--no-decorate", `${base}..${head}`, ...EVIDENCE_ONLY]).trim();
  const stat = git(root, ["diff", "--stat", `${base}..${head}`, ...EVIDENCE_ONLY]).trim();
  const diff = git(root, ["diff", `${base}..${head}`, ...EVIDENCE_ONLY]).trim();

  const artifacts = manifest.artifacts.map((a) =>
    `- \`${a.id}\` (${a.kind ?? "?"}) ${a.path} — sha256 ${String(a.sha256).slice(0, 12)}…, ` +
    `commit ${String(a.commit).slice(0, 7)}…, producer ${a.producer_session ?? "(unrecorded)"}`);

  // The plan is an artifact like any other: when one has been attested, the
  // reviewer should know the work had a design to deviate from. Nothing is
  // invented when there is none.
  const plan = manifest.artifacts.find((a) => a.kind === "plan");
  const verdictFile = `.factory/${bead}/review.md`;
  const lines = [
    `# Review package — ${bead}`,
    "",
    `Bead: ${bead}`,
    ...(plan ? [`Plan: ${plan.path}`] : []),
    `Base: ${base}`,
    `Head: ${head}`,
    `Phase: ${phase}`,
    `Checks: ${tierProfile}`,
    "",
    "## The change under review",
    "",
    log === "" ? "(no commits in this range)" : log,
    "",
    stat === "" ? "(no file changes in this range)" : stat,
    "",
    "```diff",
    diff === "" ? "(no diff)" : diff,
    "```",
    "",
    "## Attested artifacts",
    "",
    artifacts.length ? artifacts.join("\n") : "(none)",
    "",
    "## What the policy requires for this phase",
    "",
    required.length
      ? required.map((c) => `- \`${c.id}\` (${c.kind}): \`${c.command}\``).join("\n")
      : "(nothing declared)",
    "",
    "## How to answer",
    "",
    `Write exactly one file, \`${verdictFile}\`, and begin it with a verdict line:`,
    "",
    "```",
    "Verdict: pass",
    "```",
    "",
    "or `Verdict: changes`. Then say what you found:",
    "",
    "```",
    "## Findings",
    "- <severity> <file:line> <what is wrong, and the smallest fix>",
    "",
    "## Could not verify",
    "- <what you could not check, and why>",
    "```",
    "",
    "Review only what is in this package. Do not edit the product; `record` refuses",
    "when you do. Record the verdict with a session id that is not the builder's:",
    "",
    "```",
    `FACTORY_ROLE=reviewer FACTORY_SESSION=review:<bead> \\`,
    `  node scripts/factory-review.mjs record ${bead} --file ${verdictFile} --verdict pass`,
    "```",
    "",
  ];
  const text = lines.join("\n");

  mkdirSync(reviewDir(root, bead), { recursive: true });
  const packagePath = join(reviewDir(root, bead), "review-package.md");
  writeFileSync(packagePath, text);

  // The snapshot is taken now, before the reviewer starts, so `record` can tell
  // the reviewer's one file from an edit to the product. Lines alone cannot:
  // an already-dirty path that is edited again leaves the very same line - so
  // every hashable product file is fingerprinted alongside the line set.
  const status = porcelain(root);
  writeFileSync(scopePath(root, bead), JSON.stringify({
    version: 1,
    bead,
    base,
    head,
    started_at: new Date().toISOString(),
    status,
    files: scopeFiles(root, status),
  }, null, 2) + "\n");

  appendTrail(root, bead, {
    event: "review_started",
    base,
    head,
    package_sha256: sha256File(packagePath),
  });

  return [
    `review package -> ${relative(root, packagePath).split(sep).join("/")}`,
    `range ${base.slice(0, 7)}..${head.slice(0, 7)}, phase ${phase}`,
    `give it to: FACTORY_ROLE=reviewer FACTORY_SESSION=review:${bead} ... ${verdictFile}`,
  ].join("\n");
}

// ---- record -----------------------------------------------------------------

const RECORD_FLAGS = { file: "", verdict: "" };
const RECORD_USAGE = "accepted flags are --file <path>, --verdict pass|changes";

// `g` because counting every verdict line needs matchAll (which refuses a
// non-global pattern); `m` anchors each line, as before.
const VERDICT_RE = /^Verdict:\s*(pass|changes)\s*$/gm;

export function record(argv) {
  const { values, positional } = parseFlags(argv, RECORD_FLAGS, RECORD_USAGE);
  const bead = beadOf(positional);

  if (role() !== "reviewer") {
    throw new ReviewError("review record needs FACTORY_ROLE=reviewer");
  }
  const session = namedSession("a reviewer");
  const root = rootOrRefusal();

  if (!existsSync(manifestPath(root, bead))) {
    throw new ReviewError(`no manifest for ${bead}; there is nothing to review`);
  }
  const manifest = loadManifest(root, bead);
  const builder = manifest.builder_session;
  if (typeof builder !== "string" || builder === "") {
    throw new ReviewError(
      `the manifest for ${bead} records no builder_session; re-attest after upgrading ` +
      "so the builder's identity is on record and independence can be checked");
  }
  if (session === builder) {
    throw new ReviewError(
      "the reviewer session is the builder session; a bead cannot be reviewed by the agent that built it");
  }

  if (values.file === undefined) {
    throw new ReviewError("missing --file <path>: the verdict file the reviewer wrote");
  }
  if (values.verdict === undefined) {
    throw new ReviewError("missing --verdict pass|changes");
  }
  if (values.verdict !== "pass" && values.verdict !== "changes") {
    throw new ReviewError(`--verdict "${values.verdict}" is not a verdict; expected pass or changes`);
  }

  if (!existsSync(scopePath(root, bead))) {
    throw new ReviewError(`no review package for ${bead}; run review start first`);
  }
  const scope = JSON.parse(readFileSync(scopePath(root, bead), "utf8"));

  const abs = resolve(root, values.file);
  const rel = relative(root, abs).split(sep).join("/");
  if (rel.startsWith(`.factory/${bead}/hidden/`)) {
    throw new ReviewError(
      "a review verdict may not be a hidden acceptance test; write it outside " +
      `.factory/${bead}/hidden/`);
  }
  const expected = `.factory/${bead}/`;
  if (!rel.startsWith(expected) || rel.slice(expected.length).includes("/")) {
    throw new ReviewError(
      `a reviewer writes only its own verdict file, ${expected}review*.md; "${rel}" is outside it`);
  }
  if (!/^review.*\.md$/.test(basename(abs))) {
    throw new ReviewError(
      `a reviewer writes only its own verdict file, ${expected}review*.md; "${basename(abs)}" is not one`);
  }
  // The package and the scope snapshot are the builder-authored evidence this
  // module wrote at start - and the package's how-to-answer template carries a
  // literal "Verdict: pass" line. A builder (or anyone) that records it as the
  // verdict is recording the template, not a reviewer's findings.
  if (rel === `.factory/${bead}/review-package.md` || rel === `.factory/${bead}/review-scope.json`) {
    throw new ReviewError(
      `the review package is evidence, not a verdict; write your findings to a separate review*.md file`);
  }
  if (!existsSync(abs)) {
    throw new ReviewError(`the verdict file does not exist: ${rel}`);
  }
  // The same evidence under another name is the same trick: copy
  // review-package.md to review-copy.md and the bytes still say "Verdict: pass"
  // because the template wrote them. The package's hash is on the trail, so a
  // renamed copy is recognised by content, not by filename.
  const started = readTrail(root, bead).filter((e) => e.event === "review_started");
  const packageSha = started.length ? started[started.length - 1].package_sha256 : null;
  if (typeof packageSha === "string" && packageSha !== "" && sha256File(abs) === packageSha) {
    throw new ReviewError(
      `the review package is evidence, not a verdict; write your findings to a separate review*.md file`);
  }

  const text = readFileSync(abs, "utf8");
  const verdicts = [...text.matchAll(VERDICT_RE)];
  if (verdicts.length === 0) {
    throw new ReviewError(`the verdict file has no "Verdict: pass" or "Verdict: changes" line: ${rel}`);
  }
  // A file that hedges - "pass" up top, "changes" buried in the findings -
  // would otherwise be read at the first line and get whichever verdict the
  // flag wanted. The file must state exactly one, and it must be the flag's.
  if (verdicts.length > 1) {
    throw new ReviewError(`the verdict file states more than one verdict: ${rel}`);
  }
  if (verdicts[0][1] !== values.verdict) {
    throw new ReviewError(
      `the verdict flag does not match the file; the file is the record ` +
      `(--verdict ${values.verdict}, the file says ${verdicts[0][1]})`);
  }

  // The scope refusal is numbered ahead of staleness in the plan, so it is
  // asked here, after the verdict is known to describe something and before
  // the package's freshness is questioned: a reviewer who both touched the
  // product and let the package go stale is refused for the touch first,
  // since that is the worse of the two.
  const before = new Set(productChanges(scope.status ?? []));
  const now = productChanges(porcelain(root));
  const outside = now.filter((line) => !before.has(line) && !line.endsWith(` ${rel}`));
  const vanished = [...before].filter((line) => !now.includes(line));
  // The line set cannot see an edit to a path that was already dirty at start:
  // the line was ` M` then and is ` M` now. The start snapshot fingerprinted the
  // bytes of every product file, so a content change - or a file gone missing -
  // is caught here by hash, the same sentence as the line-set half.
  const drifted = [];
  for (const [path, sha] of Object.entries(scope.files ?? {})) {
    let current = null;
    try {
      const absFile = join(root, path);
      if (statSync(absFile).isFile()) current = sha256File(absFile);
    } catch {
      current = null;
    }
    if (current !== sha) drifted.push(path);
  }
  if (outside.length || vanished.length || drifted.length) {
    throw new ReviewError(
      "the reviewer changed files outside its verdict: " +
      [
        ...outside,
        ...vanished,
        ...drifted.map((p) => `${p} (content changed since review start)`),
      ].join(" | "));
  }

  const head = gitHead(root);
  if (scope.head !== head) {
    throw new ReviewError(
      `the package is stale: it was written at ${String(scope.head).slice(0, 7)} and HEAD is ${head.slice(0, 7)}; ` +
      "run review start again so the verdict describes what is actually there");
  }

  const artifact = {
    id: "review",
    kind: "prr",
    path: rel,
    sha256: sha256File(abs),
    bytes: statSync(abs).size,
    command: null,
    producer_session: session,
    reviewer_session: session,
    verdict: values.verdict,
    produced_at: new Date().toISOString(),
    commit: head,
  };
  upsertArtifact(manifest, artifact);
  saveManifest(root, bead, manifest);
  appendTrail(root, bead, {
    event: "review",
    path: rel,
    sha256: artifact.sha256,
    verdict: values.verdict,
    reviewer_session: session,
    builder_session: builder,
    commit: head,
  });

  return `recorded review -> ${rel} (verdict ${values.verdict}, reviewer ${session})`;
}

// ---- accept / withdraw -------------------------------------------------------
//
// `phase_done` says a gate passed; it says nothing about whether anyone with
// skin in the game said "ship it". Accept and withdraw are where that human
// word lives, deliberately outside the phase machine: a gate is recomputed
// from evidence every time, while an acceptance is what one named human
// decided and then could take back, in the open, on the trail.
//
// Accept's checks are the plan's list, refused in that order: the role, the
// manifest's identity of the builder, the review's existence and verdict, that
// the reviewer is not the builder, that the reviewed bytes still are the bytes
// on disk, and only last that the actor signs the record. A refusal earlier in
// the list is honest about nothing further being checkable.

const ACCEPT_FLAGS = { note: "" };
const ACCEPT_USAGE = 'accepted flag is --note "<text>"';
const WITHDRAW_FLAGS = { note: "" };
const WITHDRAW_USAGE = 'accepted flag is --note "<why>"';

const TAG_PREFIX = "factory-accept/";

function tagName(bead) {
  return `${TAG_PREFIX}${bead}`;
}

function signersFile(root) {
  return join(root, "config", "factory.allowed_signers");
}

const NO_SIGNERS =
  "config/factory.allowed_signers is missing; a signature nobody can check is not an acceptance";
const BAD_SIGNER =
  "the acceptance tag is not signed by an allowed signer; add your public key to config/factory.allowed_signers";
const VERDICT_DRIFTED = "the verdict file changed after review; run factory-review record again";

function tagExists(root, tag) {
  try {
    git(root, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

// An annotated tag carries its message as the tag object's body, with the SSH
// signature armor appended by git; a lightweight tag points straight at a
// commit and carries none. Fields are parsed first-match from the body, and
// their counts come along so a duplicate line can be named at check time - a
// tag this module wrote has none, so a duplicate is somebody else's edit.
function readAcceptanceTag(root, bead, { verify = false } = {}) {
  const tag = tagName(bead);
  let ref;
  try {
    ref = git(root, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).trim();
  } catch {
    return null;
  }
  const commit = git(root, ["rev-parse", `${ref}^{commit}`]).trim();
  let body = "";
  try {
    const cat = git(root, ["cat-file", "tag", ref]);
    const split = cat.indexOf("\n\n");
    if (split >= 0) body = cat.slice(split + 2);
  } catch {
    // No tag object, no message: the bare-commit shape of a forged tag.
  }
  const armor = body.indexOf("-----BEGIN SSH SIGNATURE-----");
  if (armor >= 0) body = body.slice(0, armor);

  const fields = {};
  const counts = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^(bead|verdict_sha256|reviewer_session|accepted_by|note):(.*)$/);
    if (m) {
      if (counts[m[1]] === undefined) {
        counts[m[1]] = 1;
        fields[m[1]] = m[2].trim();
      } else {
        counts[m[1]] += 1;
      }
    }
  }

  let verify_ok = null;
  if (verify) {
    try {
      git(root, ["-c", `gpg.ssh.allowedSignersFile=${signersFile(root)}`, "verify-tag", tag]);
      verify_ok = true;
    } catch {
      verify_ok = false;
    }
  }
  return { tag, ref, commit, fields, counts, verify_ok };
}

// The checks `accept` applied at tag time, re-run at ship time. An acceptance
// is a signed claim about a review, and the claim decays if the signature, the
// commit or the verdict bytes moved since. `complete` calls this instead of
// trusting anything, so a hand-forged tag is only a wrong claim whose name is
// already taken.
export function acceptanceProblems(root, bead) {
  const problems = [];
  if (!existsSync(signersFile(root))) {
    problems.push(NO_SIGNERS);
  }

  // The review-artifact checks are unchanged: the tag must describe a real,
  // passing, independent review.
  const manifest = loadManifest(root, bead);
  const artifact = (manifest.artifacts || []).find((a) => a.id === "review");
  if (!artifact) {
    problems.push("the manifest records no review artifact");
    return problems;
  }
  if (artifact.kind !== "prr") problems.push(`the review artifact has kind ${JSON.stringify(artifact.kind)}; expected prr`);
  if (artifact.verdict !== "pass") problems.push(`the review artifact records verdict ${JSON.stringify(artifact.verdict)}; expected pass`);
  const reviewer = artifact.reviewer_session ?? artifact.producer_session;
  const builder = manifest.builder_session;
  if (typeof reviewer !== "string" || reviewer.trim() === "") {
    problems.push("the review artifact names no reviewer session");
  } else if (!builder) {
    problems.push("the manifest records no builder_session; the reviewer cannot be proven independent");
  } else if (reviewer === builder) {
    problems.push(`the reviewer session "${reviewer}" is the builder session`);
  }

  const acc = readAcceptanceTag(root, bead, { verify: true });
  if (!acc) {
    problems.push(`no acceptance tag for ${bead}; accept it with: git tag -s factory-accept/${bead} -F <msg> <commit>`);
    return problems;
  }
  if (acc.verify_ok === false) {
    problems.push(BAD_SIGNER);
    return problems;
  }

  if (acc.counts.bead === undefined) {
    problems.push("the acceptance tag message has no bead: line");
  } else if (acc.counts.bead > 1) {
    problems.push("the acceptance tag message states bead: more than once");
  } else if (acc.fields.bead !== bead) {
    problems.push(`the acceptance tag is for bead ${JSON.stringify(acc.fields.bead)}, not "${bead}"`);
  }
  if (acc.counts.verdict_sha256 === undefined) {
    problems.push("the acceptance tag message has no verdict_sha256: line");
  }
  if (acc.counts.reviewer_session === undefined) {
    problems.push("the acceptance tag message has no reviewer_session: line");
  }
  if (typeof acc.fields.accepted_by !== "string" || acc.fields.accepted_by.trim() === "") {
    problems.push("the acceptance tag message does not say who accepted it (accepted_by)");
  }

  const head = gitHead(root);
  if (acc.commit !== head) {
    problems.push(`the acceptance tag points at ${acc.commit}, not the current commit ${head}`);
  }
  if (typeof acc.fields.verdict_sha256 === "string" && acc.fields.verdict_sha256 !== artifact.sha256) {
    problems.push(`the acceptance tag names verdict ${acc.fields.verdict_sha256}, but the review artifact is ${artifact.sha256}`);
  }
  const file = artifact.path ? join(root, artifact.path) : null;
  if (!file || !existsSync(file) || sha256File(file) !== artifact.sha256) {
    problems.push(VERDICT_DRIFTED);
  }
  return problems;
}

export function accept(argv) {
  const { values, positional } = parseFlags(argv, ACCEPT_FLAGS, ACCEPT_USAGE);
  const bead = beadOf(positional);

  if (role() !== "human") {
    throw new ReviewError("only a human may accept; set FACTORY_ROLE=human");
  }
  const root = rootOrRefusal();

  if (!existsSync(manifestPath(root, bead))) {
    throw new ReviewError(`no manifest for ${bead}; nothing has been attested`);
  }
  const manifest = loadManifest(root, bead);
  if (typeof manifest.builder_session !== "string" || manifest.builder_session === "") {
    throw new ReviewError(
      "this manifest predates builder sessions; re-attest after upgrading " +
      "so the builder's identity is on record and acceptance can be checked");
  }

  const entry = manifest.artifacts.find((a) => a.id === "review" && a.kind === "prr");
  if (!entry) {
    throw new ReviewError("no passing review; nothing to accept");
  }
  if (entry.verdict !== "pass") {
    throw new ReviewError(`the review verdict is "${entry.verdict}"; nothing to accept`);
  }
  // The same independence sentence `record` applied: whatever session the
  // crediting artifact names must not be the one that built the bead.
  const reviewer = entry.reviewer_session ?? entry.producer_session ?? null;
  if (reviewer === manifest.builder_session) {
    throw new ReviewError("a bead cannot be accepted on the builder's own review");
  }

  const verdictAbs = join(root, entry.path);
  // The review described particular bytes. If the verdict file has moved since
  // `record` hashed it, what the human would be accepting now is prose nobody
  // reviewed; the fix is the one the message names, recording again.
  if (!existsSync(verdictAbs) || sha256File(verdictAbs) !== entry.sha256) {
    throw new ReviewError("the verdict file changed after review; run review record again");
  }

  const heldBy = (process.env.FACTORY_SESSION ?? "").trim();
  if (heldBy === "") {
    // No anonymous fallback here, for the reason `record` refuses anonymity: an
    // unsigned acceptance cannot be compared to anybody, so it is decoration.
    throw new ReviewError("an acceptance must be signed; set FACTORY_SESSION");
  }

  // A signature nobody can check is not an acceptance. There is no default
  // keyring and no fallback: without the signers file, accept stops here, with
  // no tag written and nothing half-done to clean up.
  if (!existsSync(signersFile(root))) {
    throw new ReviewError(NO_SIGNERS);
  }

  const tag = tagName(bead);
  if (tagExists(root, tag)) {
    throw new ReviewError(`an acceptance tag already exists for ${bead}; withdraw it first: git tag -d ${tag}`);
  }

  const note = typeof values.note === "string" && values.note.trim() !== "" ? values.note : null;
  const head = gitHead(root);
  // The message is exactly what git signs; every check downstream parses it
  // back out of the tag object and compares field by field.
  const message = [
    `bead: ${bead}`,
    `verdict_sha256: ${entry.sha256}`,
    `reviewer_session: ${reviewer}`,
    `accepted_by: ${heldBy}`,
    `note: ${note ?? ""}`,
    "",
  ].join("\n");

  const tmpDir = mkdtempSync(join(tmpdir(), "factory-accept-"));
  try {
    const msgFile = join(tmpDir, "tag-message");
    writeFileSync(msgFile, message);
    try {
      git(root, ["tag", "-s", tag, "-F", msgFile, head]);
    } catch (e) {
      const stderr = String(e.stderr ?? e.message ?? "").trim().split("\n")[0].trim();
      throw new ReviewError(
        `git could not sign the acceptance tag: ${stderr || "(no stderr)"}; ` +
        "configure an SSH signing key with: git config gpg.format ssh && git config user.signingkey <key>");
    }
    // Verify its own output: a tag git just made must pass git's own check
    // against the signers file, otherwise this is not an acceptance but an
    // ordinary tag wearing one's name, and it is destroyed on the way out.
    try {
      git(root, ["-c", `gpg.ssh.allowedSignersFile=${signersFile(root)}`, "verify-tag", tag]);
    } catch {
      try { git(root, ["tag", "-d", tag]); } catch { /* never there */ }
      throw new ReviewError(BAD_SIGNER);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  appendTrail(root, bead, {
    event: "accept",
    accepted_by: heldBy,
    verdict_sha256: entry.sha256,
    commit: head,
    note,
    tag,
  });

  return `accepted ${bead} on the review by ${reviewer}, tag ${tag} at ${head.slice(0, 7)}`;
}

export function withdraw(argv) {
  const { values, positional } = parseFlags(argv, WITHDRAW_FLAGS, WITHDRAW_USAGE);
  const bead = beadOf(positional);

  if (role() !== "human") {
    throw new ReviewError("only a human may withdraw an acceptance; set FACTORY_ROLE=human");
  }
  const note = typeof values.note === "string" ? values.note.trim() : "";
  if (note === "") {
    // The reason is the price of the door: a withdrawal with no stated why is
    // indistinguishable from an accident, and the trail would carry silence.
    throw new ReviewError('withdraw needs a reason: --note "<why>"');
  }
  const root = rootOrRefusal();

  const tag = tagName(bead);
  // Deleting the tag is the whole withdrawal: an absent tag is the exact state
  // accept began from, and the trail keeps why it stopped being there.
  if (!tagExists(root, tag)) {
    throw new ReviewError(`no acceptance recorded for ${bead}`);
  }
  git(root, ["tag", "-d", tag]);
  appendTrail(root, bead, { event: "withdraw", note, tag });

  return `withdrew the acceptance of ${bead}: ${note}`;
}

// ---- show -------------------------------------------------------------------

const SHOW_FLAGS = { json: null, policy: "" };
const SHOW_USAGE = "accepted flags are --json, --policy <path>";

// `show` never decides anything; it prints the three equalities a gate would
// ask about, so a refusal elsewhere can be read rather than guessed at.
export function show(argv) {
  const { values, positional } = parseFlags(argv, SHOW_FLAGS, SHOW_USAGE);
  const bead = beadOf(positional);
  const root = rootOrRefusal();
  const manifest = loadManifest(root, bead);
  const entry = manifest.artifacts.find((a) => a.id === "review") ?? null;

  const builder = manifest.builder_session ?? null;
  const reviewer = entry ? entry.reviewer_session ?? entry.producer_session ?? null : null;
  const head = gitHead(root);
  // The acceptance is a signed tag beside the review, so `show` reads it from
  // git - including one whose signature does not check out (reported, not
  // hidden) or one that names nobody (rendered as not accepted).
  const acc = readAcceptanceTag(root, bead, { verify: true });
  const acceptance = acc === null ? null : {
    tag: acc.tag,
    accepted_by: typeof acc.fields.accepted_by === "string" && acc.fields.accepted_by !== ""
      ? acc.fields.accepted_by : null,
    commit: acc.commit,
    verdict_sha256: typeof acc.fields.verdict_sha256 === "string" ? acc.fields.verdict_sha256 : null,
  };

  const result = {
    bead,
    recorded: entry !== null,
    verdict: entry ? entry.verdict ?? null : null,
    path: entry ? entry.path : null,
    builder_session: builder,
    reviewer_session: reviewer,
    independence: entry !== null && builder !== null && reviewer !== null && reviewer !== builder,
    hash_ok: entry !== null && existsSync(join(root, entry.path)) &&
      sha256File(join(root, entry.path)) === entry.sha256,
    at_head: entry !== null && entry.commit === head,
    head,
    commit: entry ? entry.commit ?? null : null,
    acceptance,
  };

  if (values.json) return JSON.stringify(result) + "\n";

  if (!entry) return `no review recorded for ${bead}`;
  const mark = (ok) => (ok ? "ok  " : "FAIL");
  const acceptedLine = acc === null
    ? "accepted: not accepted"
    : acc.verify_ok === false
      ? "accepted: tag present but NOT signed by an allowed signer"
      : acceptance.accepted_by
        ? `accepted: by ${acceptance.accepted_by} at tag ${acc.tag} (${String(acceptance.commit).slice(0, 7)}…)`
        : "accepted: not accepted";
  return [
    `review ${bead}: verdict ${result.verdict ?? "(none)"} at ${result.path}`,
    `${mark(result.independence)}  independence: reviewer ${reviewer ?? "(none)"} vs builder ${builder ?? "(none)"}`,
    `${mark(result.hash_ok)}  hash: the verdict file still hashes to what was recorded`,
    `${mark(result.at_head)}  head: recorded at ${String(result.commit).slice(0, 7)}…, HEAD is ${head.slice(0, 7)}…`,
    acceptedLine,
  ].join("\n");
}

// ---- the command ------------------------------------------------------------

const COMMANDS = { start, record, show, accept, withdraw };

function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];
  const run = COMMANDS[name];
  if (!run) {
    throw new ReviewError(`unknown command "${name ?? ""}"; use start, record, show, accept or withdraw`);
  }
  return run(argv.slice(1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(main());
    process.exit(0);
  } catch (e) {
    // A ReviewError is a refusal; anything else is a bug and keeps its stack.
    if (e instanceof ReviewError) {
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
