#!/usr/bin/env node
// The directions artifact is judged on shape only: is there a user, a journey,
// two or more named directions each with a critique and a fit verdict, one
// chosen, one rejected with a reason that is more than an adjective. Taste is
// the human's at G1; this suite only pins the shape and the refusals.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDirections } from "./factory-design.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "factory-design.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "factory-design-test-"));

// execFileSync's catch keeps only stdout unless stderr is captured, so every
// refusal path in this suite reads stderr through spawnSync rather than a pipe.
const runCli = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: SANDBOX, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
}

const GOLDEN = `# Directions - testapp task list

## User

Someone with a dozen small tasks and no patience for filing systems. They open
the page between meetings, on a phone, and want to see what is left without
reading a dashboard.

## Journey

1. Open the page; a skeleton appears while the list loads.
2. The tasks appear in the order they were added.
3. With nothing left, an empty state explains what to do next.
4. If the fetch fails, a role="alert" region says so and keeps the page still.
5. "Add a task" is disabled while a previous add is in flight.

## Directions

### Quiet ledger

One column, hairlines between rows, no cards. The list reads like a notebook.

- Critique: handle three tasks well and it becomes a wall of lines; the rhythm
  only survives because the type is large enough to carry it.
- Fit: fits

### Card grid

Each task is a card on a two-column grid.

- Critique: cards invite comparison and drag; this list has neither, so the
  grid spends space on structure that carries no meaning.
- Fit: strains

### Command palette first

The list is a blank page until the user types.

- Critique: hides the one thing the user came to see behind an interaction.
- Fit: rejects

## Chosen

Quiet ledger. The journey is a glance, and the ledger is the only direction
where the glance has no chrome to read through.

## Rejected (with reasons)

- Card grid: it borrows the visual language of a task manager that reorders and
  drags, and this one does not, so the affordance would promise what the page
  cannot do.
- Command palette first: it makes the empty page the default state, and the
  empty state is already a state the journey has to show honestly.
`;

const piece = (heading, body) => `## ${heading}\n\n${body}\n`;
const base = (overrides = {}) => {
  const parts = {
    User: "Someone with a dozen small tasks.",
    Journey: "1. Open the page.\n2. Read the list.",
    Directions:
      "### Ledger\n\nOne column.\n\n- Critique: it gets long.\n- Fit: fits\n\n" +
      "### Grid\n\nTwo columns.\n\n- Critique: wastes space.\n- Fit: strains",
    Chosen: "Ledger.",
    "Rejected (with reasons)": "- Grid: it promises drag that the page cannot do.",
  };
  return Object.entries({ ...parts, ...overrides }).map(([h, b]) => piece(h, b)).join("\n");
};

console.log("factory-design shape check");

const golden = checkDirections(GOLDEN);
check("the golden directions file passes", golden.ok, JSON.stringify(golden.problems));

const missingUser = checkDirections(base({ User: "" }));
check("an empty User section is refused by name",
  !missingUser.ok && missingUser.problems.some((p) => p.includes("User")),
  JSON.stringify(missingUser.problems));

const noDirections = checkDirections(base().replace(/## Directions[\s\S]*?(?=## Chosen)/, "## Directions\n\n"));
check("no named direction is refused by name",
  !noDirections.ok && noDirections.problems.some((p) => p.includes("Directions")),
  JSON.stringify(noDirections.problems));

const oneDirection = checkDirections(base({
  Directions: "### Ledger\n\nOne column.\n\n- Critique: it gets long.\n- Fit: fits",
}));
check("a single direction is refused: two or more are required",
  !oneDirection.ok && oneDirection.problems.some((p) => p.includes("at least") || p.includes("two")),
  JSON.stringify(oneDirection.problems));

const noCritique = checkDirections(base({
  Directions:
    "### Ledger\n\nOne column.\n\n- Fit: fits\n\n" +
    "### Grid\n\nTwo columns.\n\n- Critique: wastes space.\n- Fit: strains",
}));
check("a direction with no critique is refused by name",
  !noCritique.ok && noCritique.problems.some((p) => p.includes("Ledger") && p.includes("critique")),
  JSON.stringify(noCritique.problems));

const badFit = checkDirections(base({
  Directions:
    "### Ledger\n\nOne column.\n\n- Critique: it gets long.\n- Fit: maybe\n\n" +
    "### Grid\n\nTwo columns.\n\n- Critique: wastes space.\n- Fit: strains",
}));
check("a fit verdict outside fits|strains|rejects is refused",
  !badFit.ok && badFit.problems.some((p) => p.includes("Ledger") && p.includes("fits")),
  JSON.stringify(badFit.problems));

const chosenUnnamed = checkDirections(base({ Chosen: "The obvious one." }));
check("a Chosen section that names no direction is refused",
  !chosenUnnamed.ok && chosenUnnamed.problems.some((p) => p.includes("Chosen")),
  JSON.stringify(chosenUnnamed.problems));

const noRejected = checkDirections(base({ "Rejected (with reasons)": "" }));
check("no rejected direction is refused",
  !noRejected.ok && noRejected.problems.some((p) => p.includes("Rejected")),
  JSON.stringify(noRejected.problems));

const adjectiveReason = checkDirections(base({ "Rejected (with reasons)": "- Grid: uglier." }));
check("a rejection reason that is one adjective is refused",
  !adjectiveReason.ok && adjectiveReason.problems.some((p) => p.includes("rejected")),
  JSON.stringify(adjectiveReason.problems));

// The CLI: a bead, a path, and the same file on disk.
const bead = "b-design";
const dir = join(SANDBOX, ".factory", bead, "design");
mkdirSync(dir, { recursive: true });
const goldenPath = join(dir, "directions.md");
writeFileSync(goldenPath, GOLDEN, "utf8");

const okRun = runCli(["check", bead, goldenPath]);
check("the CLI exits 0 on the golden file and names the path",
  okRun.code === 0 && okRun.out.includes("directions ok ->"), okRun.out);

const refusal = runCli(["check", bead, join(dir, "missing.md")]);
check("the CLI names a missing file rather than crashing",
  refusal.code === 1 && refusal.out.includes("missing.md") && refusal.out.includes("does not exist"),
  refusal.out);

const usage = runCli(["check"]);
check("the CLI without a path prints usage",
  usage.code === 1 && usage.out.includes("factory-design.mjs check <bead> <path"), usage.out);

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} design tests passed.`);
process.exit(fail ? 1 : 0);
