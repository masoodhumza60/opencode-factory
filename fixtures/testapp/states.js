// The fixture's only logic: read ?state= and put the page in that state.
// A capture run must find the DOM hook for the state it asked for, so every
// state is observable, not just a colour change.
const STATES = ["default", "loading", "empty", "error", "disabled", "console-error"];

const state = new URLSearchParams(location.search).get("state") ?? "default";
if (!STATES.includes(state)) {
  document.body.dataset.state = "unknown";
  throw new Error(`unknown state "${state}"; the fixture has: ${STATES.join(", ")}`);
}

const skeleton = document.querySelector('[data-testid="skeleton"]');
const empty = document.querySelector('[data-testid="empty-state"]');
const error = document.querySelector('[data-testid="error-state"]');
const primary = document.querySelector('[data-testid="primary-action"]');
const list = document.querySelector("#list");

const show = (el, on) => { el.hidden = !on; };

skeleton.hidden = state !== "loading";
empty.hidden = state !== "empty";
error.hidden = state !== "error";
primary.disabled = state === "disabled";

if (state === "default") {
  for (const title of ["Draft the spec", "Review the plan", "Ship it"]) {
    const li = document.createElement("li");
    li.textContent = title;
    list.append(li);
  }
}

// Probe used only by test-factory-capture.mjs: a console error the capture
// adapter must refuse to ignore. It is not one of the five captured states.
if (state === "console-error") {
  console.error("fixture probe: console errors must fail the capture run");
}

document.body.dataset.state = state;
