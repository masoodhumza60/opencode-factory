// Task 1's completion check: the fixture is servable as plain static files and
// every state it documents has a DOM hook. No browser is needed for this; the
// capture adapter's own suite (Task 3) is what proves the browser path.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "testapp");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ok ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};

const html = readFileSync(join(ROOT, "index.html"), "utf8");
const js = readFileSync(join(ROOT, "states.js"), "utf8");
const css = readFileSync(join(ROOT, "app.css"), "utf8");

check("index.html loads the state driver and the stylesheet",
  html.includes('src="states.js"') && html.includes('href="app.css"'));
check("index.html starts in the loading state so nothing renders unmasked",
  html.includes('data-state="loading"'));
for (const hook of ["skeleton", "empty-state", "error-state", "primary-action"]) {
  check(`the state hook data-testid="${hook}" exists`, html.includes(`data-testid="${hook}"`));
}
check("the error state is announced", html.includes('data-testid="error-state" role="alert"'));
check("the loading state is busy and announced",
  html.includes('data-testid="skeleton" aria-busy="true"'));

for (const state of ["default", "loading", "empty", "error", "disabled", "console-error"]) {
  check(`states.js implements "${state}"`, js.includes(`"${state}"`));
}
check("states.js writes body[data-state] so a capture can wait for it",
  js.includes("document.body.dataset.state = state"));
check("states.js refuses a state it does not implement",
  js.includes("unknown state"));
check("the console-error probe logs to console.error",
  js.includes("console.error("));
check("the fixture reaches no network: no fetch, no import",
  !/\bfetch\s*\(/.test(js) && !/\bimport\s/.test(js) && !/https?:\/\//.test(html));
check("the stylesheet is real, not a stub", css.length > 400);
check("the disabled state is a real disabled attribute, not only a colour",
  js.includes("primary.disabled"));

console.log(`\n${pass}/${pass + fail} fixture tests passed.`);
process.exit(fail ? 1 : 0);
