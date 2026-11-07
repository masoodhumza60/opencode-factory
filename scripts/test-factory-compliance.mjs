#!/usr/bin/env node
// Shape, not judgment: these tests pin what each compliance artifact must
// contain. A passing check means a reviewer can judge the artifact, not that
// the system is secure, tested or operable.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkThreatModel, checkRunbook } from "./factory-compliance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-compliance.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "factory-compliance-test-"));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}

const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: SANDBOX, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const THREAT = `# Threat model - testapp

## Assets

- The task list and the user's session.

## Entry points

- The static page at / and the state query parameter.

## Threats

- An attacker injects script through the state parameter and reads the list.

## Mitigations

- The fixture reads a fixed allowlist of state names and renders text nodes.
`;

const RUNBOOK = `# Runbook - testapp

## Purpose

Serve the static task list.

## Ownership

The factory team.

## Detection

A failed capture run or a 5xx from the static host.

## Response

Re-run the capture and check the fixture files.

## Escalation

Page the on-call engineer if the host is down.
`;

console.log("factory-compliance: markdown");

const threat = checkThreatModel(THREAT);
check("the golden threat model passes", threat.ok, JSON.stringify(threat.problems));

const noAssets = checkThreatModel(THREAT.replace(/## Assets[\s\S]*?(?=## Entry points)/, ""));
check("a threat model with no Assets section is refused by name",
  !noAssets.ok && noAssets.problems.some((p) => p.includes("Assets")),
  JSON.stringify(noAssets.problems));

const emptyThreats = checkThreatModel(THREAT.replace(
  /## Threats\n\n- An attacker[^\n]*\n/,
  "## Threats\n\n",
));
check("an empty Threats section is refused by name",
  !emptyThreats.ok && emptyThreats.problems.some((p) => p.includes("empty section: Threats")),
  JSON.stringify(emptyThreats.problems));

const proseThreats = checkThreatModel(THREAT.replace(
  /## Threats\n\n- An attacker[^\n]*\n/,
  "## Threats\n\nAn attacker could do something bad.\n",
));
check("Threats with prose but no list item is refused",
  !proseThreats.ok && proseThreats.problems.some((p) => p.includes("Threats must list")),
  JSON.stringify(proseThreats.problems));

const proseMitigations = checkThreatModel(THREAT.replace(
  /## Mitigations\n\n- The fixture[^\n]*\n/,
  "## Mitigations\n\nWe will be careful.\n",
));
check("Mitigations with no list item is refused",
  !proseMitigations.ok && proseMitigations.problems.some((p) => p.includes("Mitigations must list")),
  JSON.stringify(proseMitigations.problems));

const entryPointsVariant = checkThreatModel(THREAT.replace("## Entry points", "## Entry Points"));
check("Entry Points is accepted as the heading", entryPointsVariant.ok,
  JSON.stringify(entryPointsVariant.problems));

const risksVariant = checkThreatModel(THREAT.replace("## Threats", "## Risks"));
check("Risks is accepted as the Threats heading", risksVariant.ok,
  JSON.stringify(risksVariant.problems));

const runbook = checkRunbook(RUNBOOK);
check("the golden runbook passes", runbook.ok, JSON.stringify(runbook.problems));

const alternates = `# Runbook - testapp

## Service

Serve the static task list.

## Owner

The factory team.

## Symptoms

A failed capture run.

## Procedure

Re-run the capture and check the fixture files.

## Rollback

Redeploy the previous static build.
`;
const alternateRunbook = checkRunbook(alternates);
check("alternate runbook headings are accepted", alternateRunbook.ok,
  JSON.stringify(alternateRunbook.problems));

const noDetection = checkRunbook(RUNBOOK.replace(/## Detection[\s\S]*?(?=## Response)/, ""));
check("a runbook with no Detection or Symptoms is refused",
  !noDetection.ok && noDetection.problems.some((p) => p.includes("Detection")),
  JSON.stringify(noDetection.problems));

const emptyResponse = checkRunbook(RUNBOOK.replace(
  /## Response\n\nRe-run[^\n]*\n/,
  "## Response\n\n",
));
check("an empty Response section is refused by name",
  !emptyResponse.ok && emptyResponse.problems.some((p) => p.includes("empty section: Response")),
  JSON.stringify(emptyResponse.problems));

const usage = run(["check"]);
check("the CLI with no arguments prints usage",
  usage.code === 1 && usage.out.includes("factory-compliance.mjs check"), usage.out);

const unknown = run(["check", "nonsense", "b1", "x.md"]);
check("the CLI refuses an unknown type by name and lists the known types",
  unknown.code === 1 && unknown.out.includes("nonsense") && unknown.out.includes("threat-model"),
  unknown.out);

const missing = run(["check", "threat-model", "b1", join(SANDBOX, "missing.md")]);
check("the CLI names a missing file rather than crashing",
  missing.code === 1 && missing.out.includes("missing.md") && missing.out.includes("does not exist"),
  missing.out);

const goldenPath = join(SANDBOX, "threat-model.md");
writeFileSync(goldenPath, THREAT, "utf8");
const goldenRun = run(["check", "threat-model", "b1", goldenPath]);
check("the CLI accepts the golden threat model and names the path",
  goldenRun.code === 0 && goldenRun.out.includes("compliance ok ->"), goldenRun.out);

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} compliance tests passed.`);
process.exit(fail ? 1 : 0);
