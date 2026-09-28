#!/usr/bin/env node
// Pair the factory with DCP (dynamic context pruning) so pruning gets a target.
//
// Why this file exists: the factory's own rules cap a session at ~100 turns and
// require a handoff, and DCP is the thing that keeps each session's context from
// bloating in the meantime. But DCP's automatic strategies (dedup, purge-errors)
// need no cooperation, while its compress tool is model-invoked — which means
// "dcp is installed" tells you nothing about whether the model ever compresses.
// Pairing means giving the nudge somewhere to point: the handoff rule.
//
// Two things happen here, both additive and both idempotent:
//   1. flip experimental.customPrompts in dcp.jsonc so overrides are honoured
//   2. write the turn-nudge override itself
//
// The config edit is TRANSACTIONAL. Inserting a key by regex is only "additive"
// as far as we can tell, and a config that contains "experimental" inside a
// string or a nested object could take a syntactically valid but semantically
// misplaced key. So we keep the original bytes, write, re-parse, confirm the key
// landed where intended, and restore the original if anything is off. The one
// thing this script must never do is leave a user's config worse than it found
// it while reporting success.
//
// We author the override text ourselves. DCP is AGPL-3.0-or-later; installing it
// is fine, vendoring or copying its prompt text into this bundle is not.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const configDir = flag("--config-dir", join(homedir(), ".config", "opencode"));
const dcpConfig = join(configDir, "dcp.jsonc");
const overridePath = join(configDir, "dcp-prompts", "overrides", "turn-nudge");

const SCHEMA_URL =
  "https://raw.githubusercontent.com/Tarquinen/opencode-dynamic-context-pruning/master/dcp.schema.json";

// The nudge fires repeatedly, so every token here is paid for many times over.
// Keep it short, concrete, and pointed at the handoff: the nudge cannot enforce
// anything, but it can name the one action that actually bounds a session.
const TURN_NUDGE = `Context check (opencode-factory). Every turn re-sends everything before it, so a
session's cost grows with its turn count, not just its size.

If earlier work in this conversation is now closed, run the compress tool on it now.

Also watch the turn count: this factory's budget is about 100 turns per session.
If you are near it, or a phase just ended, hand off instead of continuing —
record where you are with \`bd set-state <id> <dim>=<val> --reason "..."\`, leave
the next action with \`bd update <id> --append-notes "next: <action>"\`, tell the
human one line (done / next / blocked), then stop. The next session resumes from
beads, not from your scrollback.
`;

// Strip comments and trailing commas so we can inspect the config. Parsing and
// inspection only — we never write this back, so comments and formatting in the
// user's file survive untouched.
const withoutComments = (src) =>
  src
    .replace(/\\"|"(?:\\.|[^"\\])*"|(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm, (m, a, b) => (a || b ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");

// Read one probe of a DCP state file. The same shape the selfcheck uses.
const readProbe = (file) => {
  const s = JSON.parse(readFileSync(file, "utf8"));
  return {
    id: s.sessionId ?? file.replace(/^.*[\\/]/, "").replace(/\.json$/, ""),
    manual: s.manualMode === true,
    pruned: s.stats?.totalPruneTokens ?? s.stats?.pruneTokenCounter ?? 0,
  };
};

// Enable customPrompts without reformatting the file: insert the one key we
// need. Path A adds the whole `experimental` object; Path B adds the key to an
// `experimental` that already exists. Both are pure insertions, so a second run
// finds customPrompts already present and does nothing.
function enableCustomPrompts() {
  if (!existsSync(dcpConfig)) {
    const seeded = `{\n  "$schema": "${SCHEMA_URL}",\n  "experimental": {\n    "customPrompts": true\n  }\n}\n`;
    if (!dryRun) {
      // On a fresh machine the config dir may not exist yet, and an unguarded
      // write here throws ENOENT. The installers create it first, but this
      // script is also runnable on its own, so it must stand up its own path.
      try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(dcpConfig, seeded, "utf8");
      } catch (e) {
        return { action: "skipped", detail: `could not create dcp.jsonc (${e.message.slice(0, 60)})` };
      }
    }
    return { action: "created", detail: "dcp.jsonc seeded with experimental.customPrompts" };
  }
  const raw = readFileSync(dcpConfig, "utf8");
  const bare = withoutComments(raw);
  if (/"customPrompts"\s*:/.test(bare)) return { action: "unchanged", detail: "customPrompts already set" };

  let updated;
  if (/"experimental"\s*:\s*\{/.test(bare)) {
    const m = bare.match(/"experimental"\s*:\s*\{/);
    const at = raw.indexOf("{", raw.indexOf(m[0]) + m[0].length - 1) + 1;
    updated = raw.slice(0, at) + '\n    "customPrompts": true,' + raw.slice(at);
  } else {
    const lastBrace = raw.lastIndexOf("}");
    if (lastBrace === -1) return { action: "skipped", detail: "no closing brace found; left dcp.jsonc alone" };
    const head = raw.slice(0, lastBrace).replace(/\s*$/, "");
    updated = head + ',\n  "experimental": {\n    "customPrompts": true\n  }\n' + raw.slice(lastBrace);
  }
  if (dryRun) return { action: "updated", detail: "inserted experimental.customPrompts (comments preserved)" };

  // Transactional: write, then prove the result is what we intended. If the
  // re-parse fails or the key did not land as a real boolean, put the user's
  // original file back and report that we did.
  try {
    writeFileSync(dcpConfig, updated, "utf8");
  } catch (e) {
    return { action: "skipped", detail: `write failed (${e.message.slice(0, 60)}); left dcp.jsonc alone` };
  }
  let verified;
  try {
    const check = JSON.parse(withoutComments(readFileSync(dcpConfig, "utf8")));
    verified = check?.experimental?.customPrompts === true;
  } catch (e) {
    verified = false;
    var why = `result does not parse (${e.message.slice(0, 60)})`;
  }
  if (!verified) {
    try {
      writeFileSync(dcpConfig, raw, "utf8");
    } catch { /* nothing more we can do; report loudly below */ }
    return { action: "skipped", detail: `insertion unverified${typeof why === "string" ? ` — ${why}` : " (customPrompts not true)"}; original restored` };
  }
  return { action: "updated", detail: "inserted experimental.customPrompts (comments preserved, re-parsed)" };
}

const cfg = enableCustomPrompts();

if (dryRun) {
  console.log(`[dry-run] dcp.jsonc (${cfg.action}): ${cfg.detail}`);
  console.log(`[dry-run] write turn-nudge override -> ${overridePath}`);
  process.exit(0);
}

mkdirSync(dirname(overridePath), { recursive: true });
writeFileSync(overridePath, TURN_NUDGE, "utf8");

console.log(`dcp prompts: dcp.jsonc ${cfg.action} (${cfg.detail})`);
console.log(`dcp prompts: turn-nudge override -> ${overridePath}`);
// Say so when the override is inert. An override file on disk reads as
// "configured" to anyone who glances at it, but dcp ignores it entirely until
// experimental.customPrompts is true — and a silent no-op is the exact failure
// this whole step exists to prevent, so we do not create one here.
if (cfg.action === "skipped")
  console.warn(
    "dcp prompts: WARNING the override is INERT — fix dcp.jsonc by hand (set experimental.customPrompts to true) or the nudge will never fire."
  );
else console.log("dcp prompts: restart OpenCode for this to take effect (dcp reads config at startup).");
