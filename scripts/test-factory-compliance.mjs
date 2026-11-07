#!/usr/bin/env node
// Shape, not judgment: these tests pin what each compliance artifact must
// contain. A passing check means a reviewer can judge the artifact, not that
// the system is secure, tested or operable.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkThreatModel, checkRunbook, checkSbom, checkTraceability, checkSlo } from "./factory-compliance.mjs";

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

console.log("\nfactory-compliance: json");

const SBOM = JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  components: [{ type: "library", name: "testapp", version: "1.0.0" }],
}, null, 2);

const SPDX = JSON.stringify({
  spdxVersion: "SPDX-2.3",
  documentNamespace: "https://example.test/spdx/testapp",
  packages: [{ name: "testapp", versionInfo: "1.0.0" }],
}, null, 2);

const TRACE = JSON.stringify({
  criteria: [
    {
      id: "AC-1",
      description: "The list renders three tasks in the default state.",
      evidence: [{ kind: "screenshot", ref: "out/capture/default-1440.png" }],
    },
    {
      id: "AC-2",
      description: "The error state is announced.",
      evidence: ["out/capture/error-1440.png"],
    },
  ],
}, null, 2);

const SLO = JSON.stringify({
  service: "testapp",
  objectives: [
    { name: "availability", target: 0.999, indicator: "successful page loads / all page loads" },
  ],
}, null, 2);

const sbom = checkSbom(SBOM);
check("the golden CycloneDX report passes", sbom.ok, JSON.stringify(sbom.problems));

const spdx = checkSbom(SPDX);
check("an SPDX report passes", spdx.ok, JSON.stringify(spdx.problems));

const emptyComponents = checkSbom(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", components: [] }));
check("an empty components array still passes: shape only", emptyComponents.ok,
  JSON.stringify(emptyComponents.problems));

const neither = checkSbom(JSON.stringify({ hello: "world" }));
check("valid JSON matching neither shape is refused and names both",
  !neither.ok && neither.problems.some((p) => p.includes("CycloneDX")) &&
    neither.problems.some((p) => p.includes("SPDX")),
  JSON.stringify(neither.problems));

const badJson = checkSbom("{not json");
check("malformed JSON is refused with the parse error",
  !badJson.ok && badJson.problems.some((p) => p.includes("not JSON")),
  JSON.stringify(badJson.problems));

const trace = checkTraceability(TRACE);
check("the golden traceability record passes", trace.ok, JSON.stringify(trace.problems));

const unmapped = checkTraceability(JSON.stringify({
  criteria: [{ id: "AC-3", description: "No evidence yet.", evidence: [] }],
}));
check("an unmapped criterion is refused by its id",
  !unmapped.ok && unmapped.problems.some((p) => p.includes("AC-3") && p.includes("evidence")),
  JSON.stringify(unmapped.problems));

const noDescription = checkTraceability(JSON.stringify({
  criteria: [{ id: "AC-4", evidence: ["out/capture/default-390.png"] }],
}));
check("a criterion with no description is refused",
  !noDescription.ok && noDescription.problems.some((p) => p.includes("AC-4") && p.includes("description")),
  JSON.stringify(noDescription.problems));

const noCriteria = checkTraceability(JSON.stringify({ criteria: [] }));
check("an empty criteria array is refused",
  !noCriteria.ok && noCriteria.problems.some((p) => p.includes("criteria")),
  JSON.stringify(noCriteria.problems));

const slo = checkSlo(SLO);
check("the golden SLO record passes", slo.ok, JSON.stringify(slo.problems));

const zeroTarget = checkSlo(JSON.stringify({
  service: "testapp",
  objectives: [{ name: "errors", target: 0, indicator: "error rate" }],
}));
check("a zero target is a number and passes", zeroTarget.ok, JSON.stringify(zeroTarget.problems));

const emptyTarget = checkSlo(JSON.stringify({
  service: "testapp",
  objectives: [{ name: "availability", target: "", indicator: "loads" }],
}));
check("an empty-string target is refused",
  !emptyTarget.ok && emptyTarget.problems.some((p) => p.includes("target")),
  JSON.stringify(emptyTarget.problems));

const noObjectives = checkSlo(JSON.stringify({ service: "testapp", objectives: [] }));
check("an empty objectives array is refused",
  !noObjectives.ok && noObjectives.problems.some((p) => p.includes("objectives")),
  JSON.stringify(noObjectives.problems));

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} compliance tests passed.`);
process.exit(fail ? 1 : 0);
