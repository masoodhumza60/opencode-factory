// Strict YAML-subset policy parser and validator for the factory.
//
// The factory policy is deliberately parsed by a hand-written parser, not a
// YAML library: the policy grammar is the subset below, and anything outside
// it is a named PolicyError rather than a guess. See
// docs/how-factory-works.md; the tiers/profiles/checks shape is the contract
// between this file and the phase machine.
//
// Grammar accepted:
//   - two-space indentation, never tabs
//   - `key:` opens a nested block; `key: value` sets a scalar
//   - `- item` lines build the list opened by the nearest `key:` with no value
//   - scalars are `true`/`false`, integers, `null`, `[a, b, c]`, or a string
//   - `#` starts a comment at line start or after a space
//   - `{`, `}`, `|`, `>`, `&`, `*`, `'` and `"` are refused

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyError";
  }
}

const POLICIES_DIR = "config";
const POLICY_FILE = "factory.policy.yaml";

const REFUSED = ["{", "}", "|", ">", "&", "*", "'", '"'];

// The closed evidence vocabulary: the one list both sides read. A policy may
// declare any of these, and factory-attest accepts any of them plus the kinds
// only the orchestrator writes (see factory-attest's KINDS). Keeping the list
// here - in the file that judges declarations - means attest cannot drift from
// the policy, and a kind a profile names is always a kind an artifact can carry.
// Thirty-four kinds. docs/factory-domain-profiles.md lists the same set for readers.
export const DECLARABLE_KINDS = [
  "screenshot", "transcript", "contract", "api-diff", "plan", "eval",
  "hil-log", "prr", "exit-code-matrix", "golden-file", "help-snapshot",
  "tty-transcript", "completion-script", "install-log", "device-capture",
  "check-output",
  "visual", "authz", "load", "golden", "tty", "consumer-build",
  "plan-diff", "policy-check", "device", "signing", "update",
  "watchdog", "recovery", "frame", "input", "data-quality",
  // M2b: design judgment and accessibility are evidence kinds now, not prose.
  "directions", "axe",
];

const KINDS = new Set(DECLARABLE_KINDS);

const KEY_RE = /^([A-Za-z0-9_.-]+):\s*(.*)$/;

function fail(file, line, reason) {
  throw new PolicyError(`${file}:${line}: ${reason}`);
}

// `Object.keys` preserves declaration order, so the listed legal values come
// from the policy itself rather than a hard-coded string.
function declaredNames(map) {
  const names = Object.keys(map);
  return names.length ? `declared: ${names.join(", ")}` : "declared: nothing";
}

function refuseChars(raw, file, line) {
  for (const ch of REFUSED) {
    if (raw.includes(ch)) {
      fail(file, line, `"${ch}" is outside the policy subset; write a plain scalar or a nested block`);
    }
  }
}

function stripComment(raw) {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "#" && (i === 0 || raw[i - 1] === " ")) return raw.slice(0, i);
  }
  return raw;
}

function scalar(text) {
  const v = text.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => scalar(s));
  }
  return v;
}

export function parseYamlSubset(text, file) {
  const root = {};
  const stack = [{ indent: -2, map: root }];
  // The most recent `key:` that opened a nested block. A `key:` with no value
  // makes an empty map that a following `- item` may replace with the list it
  // opened; `pending.keyIndent` is the indent of that `key:` line.
  let pending = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const raw = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];

    // Rule 1: tabs anywhere, even inside a value.
    if (raw.includes("\t")) {
      fail(file, line, "tabs are not allowed; use spaces, two per level");
    }

    const noComment = stripComment(raw);
    if (noComment.trim() === "") continue;

    // Rule 5: refused characters in a line.
    refuseChars(noComment, file, line);

    const indent = noComment.length - noComment.trimStart().length;

    // Rule 2: indentation is a multiple of two spaces.
    if (indent % 2 !== 0) {
      fail(file, line, "indentation must be a multiple of two spaces");
    }

    // A block opened by `key:` at indent N owns lines at indent N+2, so
    // anything at indent <= N ends that block. Closing it also drops `pending`
    // when the block being closed is the one `pending` describes.
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (pending && pending.keyIndent >= indent) pending = null;
    const parent = stack[stack.length - 1];
    const expected = parent.indent + 2;

    const content = noComment.trim();

    if (content.startsWith("-")) {
      // Rule 10: `- item` appends to the list opened by the nearest preceding
      // `key:` whose value was empty, at exactly one level deeper.
      if (pending && indent === pending.keyIndent + 2) {
        pending.value.push(scalar(content.slice(1)));
        pending.map[pending.key] = pending.value;
        continue;
      }
      // A `- item` under a key that already has a scalar is named, not guessed.
      const ownerKey = pending ? pending.key : parent.lastKey;
      const ownerMap = pending ? pending.map : parent.map;
      if (ownerKey && ownerMap && Object.prototype.hasOwnProperty.call(ownerMap, ownerKey) &&
          !Array.isArray(ownerMap[ownerKey]) && !(ownerMap[ownerKey] && typeof ownerMap[ownerKey] === "object")) {
        fail(file, line, `"${ownerKey}" is already a scalar, so it cannot take a list`);
      }
      fail(file, line, 'expected "key: value"');
    }

    // Rule 3: a child may open at most one level deeper than its parent key.
    if (indent > expected) {
      fail(file, line, `indentation jumps from ${parent.indent} to ${indent}; use one level of two spaces`);
    }

    // Rule 8: a key is `^[A-Za-z0-9_.-]+:\s*(.*)$`.
    const m = KEY_RE.exec(content);
    if (!m) {
      fail(file, line, 'expected "key: value"');
    }
    const key = m[1];
    const rest = m[2];

    // Rule 9: duplicate key in the same map.
    if (Object.prototype.hasOwnProperty.call(parent.map, key)) {
      fail(file, line, `duplicate key "${key}"`);
    }

    if (rest.trim() === "") {
      // Rule 10: `key:` with no value opens a map; a deeper `- item` may turn
      // it into the list it opened.
      const empty = {};
      parent.map[key] = empty;
      parent.lastKey = key;
      stack.push({ indent, map: empty });
      pending = { map: parent.map, key, value: [], keyIndent: indent };
    } else {
      // Rule 4 / 12: a scalar value.
      parent.map[key] = scalar(rest);
      parent.lastKey = key;
      pending = null;
    }
  }

  return root;
}

export function validatePolicy(policy, file) {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new PolicyError(`${file}: policy must be a mapping`);
  }
  if (policy.version !== 1) {
    throw new PolicyError(`${file}: version must be 1`);
  }

  const tiers = policy.tiers && typeof policy.tiers === "object" ? policy.tiers : {};
  const profiles = policy.profiles && typeof policy.profiles === "object" ? policy.profiles : {};
  const checks = policy.checks && typeof policy.checks === "object" ? policy.checks : {};

  if (policy.tier !== undefined && !Object.prototype.hasOwnProperty.call(tiers, policy.tier)) {
    throw new PolicyError(`${file}: tier "${policy.tier}" is not declared under tiers; ${declaredNames(tiers)}`);
  }
  if (policy.profile !== undefined && !Object.prototype.hasOwnProperty.call(profiles, policy.profile)) {
    throw new PolicyError(`${file}: profile "${policy.profile}" is not declared under profiles; ${declaredNames(profiles)}`);
  }

  for (const [tier, def] of Object.entries(tiers)) {
    const ids = def && Array.isArray(def.checks) ? def.checks : [];
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(checks, id)) {
        throw new PolicyError(`${file}: check "${id}" is referenced by tiers.${tier}.checks but not declared under checks`);
      }
    }
  }
  for (const [profile, def] of Object.entries(profiles)) {
    const ids = def && Array.isArray(def.checks) ? def.checks : [];
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(checks, id)) {
        throw new PolicyError(`${file}: check "${id}" is referenced by profiles.${profile}.checks but not declared under checks`);
      }
    }
  }

  for (const [id, def] of Object.entries(checks)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      throw new PolicyError(`${file}: check "${id}" must be a mapping`);
    }
    const phase = def.phase;
    if (phase === undefined || phase === null) {
      throw new PolicyError(`${file}: check "${id}" has no phase; every check gates a phase (0-8, or 4p)`);
    }
    // Anchored to the phase table in factory-phase.mjs: ids 0-8 plus the 4p
    // debug detour. Numeric ids stay integers in the policy; "4p" is the one
    // string form the machine knows.
    if (!(phase === "4p" || (Number.isInteger(phase) && phase >= 0 && phase <= 8))) {
      throw new PolicyError(`${file}: check "${id}" has phase ${JSON.stringify(phase)}, which is not a phase; allowed phase ids are 0, 1, 2, 3, 4, 4p, 5, 6, 7, 8`);
    }
    if (!KINDS.has(def.kind)) {
      throw new PolicyError(`${file}: check "${id}" has kind "${def.kind}", which is not one of the known kinds`);
    }
  }

  return policy;
}

export function loadPolicy(root, override) {
  let file = override;
  if (!override) {
    const candidate = join(root, POLICIES_DIR, POLICY_FILE);
    if (!existsSync(candidate)) return null;
    file = candidate;
  } else {
    if (!existsSync(override)) {
      throw new PolicyError(`${override}: policy file does not exist`);
    }
    file = override;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    // No override and no file: the M0 behaviour applies, signalled by null.
    if (!override && e && e.code === "ENOENT") return null;
    throw new PolicyError(`${file}: cannot read the policy file (${(e && e.code) || "unknown error"})`);
  }
  return validatePolicy(parseYamlSubset(text, file), file);
}

export function effectiveChecks(policy, meta) {
  const tier = (meta && meta.tier) || policy.tier;
  const profile = (meta && meta.profile) || policy.profile;

  const tiers = (policy && policy.tiers) || {};
  const profiles = (policy && policy.profiles) || {};

  if (!Object.prototype.hasOwnProperty.call(tiers, tier)) {
    throw new PolicyError(`<bead metadata>: tier "${tier}" is not declared under tiers; ${declaredNames(tiers)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(profiles, profile)) {
    throw new PolicyError(`<bead metadata>: profile "${profile}" is not declared under profiles; ${declaredNames(profiles)}`);
  }

  const list = [];
  const seen = new Set();
  for (const id of tiers[tier].checks || []) {
    if (!seen.has(id)) { seen.add(id); list.push(id); }
  }
  for (const id of profiles[profile].checks || []) {
    if (!seen.has(id)) { seen.add(id); list.push(id); }
  }

  return { tier, profile, checks: list };
}

export function requiredForPhase(policy, meta, phase) {
  const { checks } = effectiveChecks(policy, meta);
  const want = Number(phase);
  return checks.filter((id) => policy.checks[id] && policy.checks[id].phase === want);
}
