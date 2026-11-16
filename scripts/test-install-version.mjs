import { readFileSync } from "node:fs";
import assert from "node:assert";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(pkg.version, "1.0.0", `package.json version must be 1.0.0, got ${pkg.version}`);

const ps1 = readFileSync("install.ps1", "utf8");
const sh  = readFileSync("install.sh", "utf8");
const sel = readFileSync("scripts/factory-selfcheck.mjs", "utf8");
// Runtime echo comes from package.json, not a hard-coded string.
assert.match(ps1, /package\.json/, 'install.ps1 must read package.json');
assert.match(sh,  /package\.json/, 'install.sh must read package.json');
assert.match(sel, /package\.json/, 'selfcheck must read package.json for its version line');
// The version is echoed to the user/installer transcript:
assert.match(ps1, /version/i, 'install.ps1 must print the version');
assert.match(sh,  /version/i, 'install.sh must print the version');
// Selfcheck prints the version alongside its verdicts:
assert.match(sel, /version/i, 'selfcheck must print the version');
console.log("versions: ok");
