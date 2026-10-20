import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  projectRoot, gitHead, sha256File, loadManifest, saveManifest,
  upsertArtifact, appendTrail, readTrail,
} from "./factory-manifest.mjs";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
function must(fn, pattern) {
  try { fn(); return false; } catch (e) { return pattern.test(e.message); }
}

const root = mkdtempSync(join(tmpdir(), "factory-manifest-"));
mkdirSync(join(root, ".beads"));
execFileSync("git", ["init", "-q"], { cwd: root });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: root });
const head = gitHead(root);

const file = join(root, "run.txt");
writeFileSync(file, "npm run dev -> 200 OK\n");

console.log("\nproject root");
check("walks up to the .beads directory", projectRoot(join(root)) === root, projectRoot(join(root)));
check("walks up also from a deeper subdirectory", projectRoot(join(root, "a", "b")) === root);

console.log("\ngit");
check("gitHead is 40 lowercase hex characters", /^[0-9a-f]{40}$/.test(head), head);

console.log("\nhashing");
const h = sha256File(file);
check("sha256 is 64 lowercase hex characters", /^[0-9a-f]{64}$/.test(h), h);
check("a directory is refused", must(() => sha256File(root), /not a regular file/));
check("a missing file is refused", must(() => sha256File(join(root, "nope")), /does not exist/));

console.log("\nmanifest");
check("an absent manifest reads as version 1 with no artifacts",
  JSON.stringify(loadManifest(root, "b1")) === JSON.stringify({ version: 1, bead: "b1", artifacts: [] }));
const art = { id: "run", kind: "transcript", path: "run.txt", sha256: h, bytes: 21, command: "npm run dev", producer_session: "s1", produced_at: "2026-10-21T00:00:00Z", commit: head };
let m = upsertArtifact(loadManifest(root, "b1"), art);
check("upsert appends a new artifact", m.artifacts.length === 1);
m = upsertArtifact(m, { ...art, sha256: "b".repeat(64) });
check("upsert replaces by id rather than duplicating", m.artifacts.length === 1 && m.artifacts[0].sha256 === "b".repeat(64));
saveManifest(root, "b1", m);
check("round-trips", loadManifest(root, "b1").artifacts[0].id === "run");

writeFileSync(join(root, ".factory", "b1", "manifest.json"), JSON.stringify({ version: 2, bead: "b1", artifacts: [] }));
check("a wrong version is refused", must(() => loadManifest(root, "b1"), /version/));

check("non-array artifacts are refused", must(() => {
  saveManifest(root, "b1", { version: 1, bead: "b1", artifacts: "nope" });
  loadManifest(root, "b1");
}, /"artifacts" at .* is not an array/));

check("a missing artifact field is refused and named", must(() => {
  const bad = { version: 1, bead: "b1", artifacts: [{ id: "x", path: "p" }] };
  saveManifest(root, "b1", bad);
  loadManifest(root, "b1");
}, /sha256/));
check("every artifact is validated, not only the first", must(() => {
  const bad = { version: 1, bead: "b1",
    artifacts: [{ id: "ok", path: "p", sha256: "a".repeat(64) }, { path: "p", sha256: "a".repeat(64) }] };
  saveManifest(root, "b1", bad);
  loadManifest(root, "b1");
}, /artifacts\[1\]\.id/));
check("fields the caller added survive a save", (() => {
  const extra = { version: 1, bead: "b1", note: "hand-written",
    artifacts: [{ id: "run", path: "run.txt", sha256: "a".repeat(64), command: "npm run dev" }] };
  saveManifest(root, "b1", extra);
  const back = loadManifest(root, "b1");
  return back.note === "hand-written" && back.artifacts[0].command === "npm run dev";
})());

console.log("\ntrail");
appendTrail(root, "b1", { event: "attest", id: "run" });
const first = readFileSync(join(root, ".factory", "b1", "trail.jsonl"), "utf8");
appendTrail(root, "b1", { event: "verify", ok: true });
const both = readFileSync(join(root, ".factory", "b1", "trail.jsonl"), "utf8");
check("the trail appends without rewriting", both.startsWith(first) && both.trim().split("\n").length === 2, both);
check("the trail parses back", readTrail(root, "b1").length === 2);

console.log("\ntrail shape and refusals");
check("an absent trail reads as empty", readTrail(root, "b2").length === 0);
check("the trail stamps at and bead on every event", (() => {
  appendTrail(root, "b2", { event: "attest", id: "run" });
  const e = readTrail(root, "b2")[0];
  return e.bead === "b2" && !Number.isNaN(Date.parse(e.at)) && e.event === "attest";
})());
check("a malformed line throws with the line number", must(() => {
  mkdirSync(join(root, ".factory", "b3"), { recursive: true });
  writeFileSync(join(root, ".factory", "b3", "trail.jsonl"),
    JSON.stringify({ event: "attest" }) + "\nnot json\n");
  readTrail(root, "b3");
}, /line 2/));
check("an empty line throws, it is not skipped", must(() => {
  mkdirSync(join(root, ".factory", "b4"), { recursive: true });
  writeFileSync(join(root, ".factory", "b4", "trail.jsonl"),
    JSON.stringify({ event: "attest" }) + "\n\n");
  readTrail(root, "b4");
}, /line 2/));
check("a JSON line that is not an object throws", must(() => {
  mkdirSync(join(root, ".factory", "b5"), { recursive: true });
  writeFileSync(join(root, ".factory", "b5", "trail.jsonl"),
    JSON.stringify({ event: "attest" }) + "\n[1, 2]\n");
  readTrail(root, "b5");
}, /line 2/));

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} manifest tests passed.`);
process.exit(fail ? 1 : 0);
