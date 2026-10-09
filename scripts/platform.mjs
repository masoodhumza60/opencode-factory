// platform.mjs - the ONE place that knows which agent harness we are running under.
//
// Everything else in this bundle answers "where does that file live" and "what
// does that harness call it". Those are the only questions that change when the
// factory runs somewhere else, and they were previously scattered as literals
// through four scripts. A second harness therefore meant hunting for `.config/
// opencode` and `restart OpenCode` - and any site somebody missed would point
// at the wrong file on a machine that never had OpenCode installed. Silent,
// and worse than an outright failure: a toggle that edits a config nobody reads
// still exits 0.
//
// So: one module owns the paths and the display names. A new harness is one new
// profile here plus an honest claim in ALL_PROFILES about what is genuinely
// ported and what is not. Nothing else in the bundle should hardcode a path.

import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

// Each profile answers four questions and nothing else:
//   config      - where this harness keeps its user-level config file
//   configDir   - the directory that config lives in (for tools that write siblings)
//   reloadHint  - the honest, user-facing sentence for "this needs a restart"
//   label       - how to name the harness in a message
// A field that does not apply is `null`, and the code that needs it refuses,
// rather than guessing a path.
export const PROFILES = {
  opencode: {
    label: "OpenCode",
    config: () => join(homedir(), ".config", "opencode", "opencode.json"),
    configDir: () => join(homedir(), ".config", "opencode"),
    // OpenCode reads config once at startup; a config edit cannot reach the
    // running process. Every script that writes config says this out loud,
    // because a toggle that appears to work and silently does not is the worst
    // outcome available.
    reloadHint: (p) => `restart OpenCode for this to take effect (it reads ${p} at startup)`,
  },
};

// Which harnesses this bundle claims to support. The `verified` flag is the
// important part: a profile can exist and still be unproven, and a caller that
// needs certainty can refuse rather than proceed on a hopeful path.
export const ALL_PROFILES = {
  opencode: { verified: true, since: "the first commit" },
  claude_code: { verified: false, since: null },
  codex: { verified: false, since: null },
  cursor: { verified: false, since: null },
};

const flagValue = (name) => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? undefined : argv[i + 1];
};

const KNOWN = new Set(Object.keys(PROFILES));

/**
 * The active profile.
 *
 * Resolution order is deliberate: an explicit `--platform` wins (a script driven
 * by a test or by a user on a multi-agent machine must be able to say which),
 * then OPENCODE_FACTORY_PLATFORM from the environment (so an installer can
 * export it once), then detection from the config file, then opencode as the
 * only supported default. Anything else fails closed with the list of names,
 * because silently falling back to the wrong harness is the failure this module
 * exists to prevent.
 */
/**
 * The PROJECT config file, or null when there is not one.
 *
 * This is deliberately separate from configPath(): connect/disconnect belongs
 * here and nowhere else. A global toggle turns a server on or off for every
 * project on the machine, including ones somebody is working in right now, and
 * the person who asked for it was explicit about that. Project config has the
 * highest precedence of the standard files and merges rather than replaces, so
 * writing `mcp.<server>.enabled` here changes this project and nothing else.
 *
 * OpenCode resolves it by looking in the current directory and then traversing
 * up to the nearest git directory, so that is the search. We write rather than
 * read it, so create it when the repo has a root but no file yet.
 */
export function projectConfigPath(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return join(dir, "opencode.json");
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function platform() {
  const asked = (flagValue("platform") || process.env.OPENCODE_FACTORY_PLATFORM || "").trim().toLowerCase();
  if (asked) {
    if (!KNOWN.has(asked)) {
      throw new Error(
        `unknown platform "${asked}". Known: ${[...KNOWN].join(", ")}. ` +
        `Add it to PROFILES in scripts/platform.mjs rather than passing a guess - ` +
        `a wrong path here silently edits a config nobody reads.`
      );
    }
    return { name: asked, ...PROFILES[asked] };
  }
  return { name: "opencode", ...PROFILES.opencode };
}

/** Config path, honouring an explicit --config override. */
export function configPath() {
  const override = flagValue("config");
  if (override) return override;
  return platform().config();
}

/** True when the caller asked for a platform this bundle has NOT verified. */
export function isUnverified(name) {
  return !ALL_PROFILES[name]?.verified;
}