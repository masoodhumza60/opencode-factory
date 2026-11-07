# Threat model - testapp

## Assets

- The task list rendered in the browser.
- The user's session, carried by the browser and not by the fixture.

## Entry points

- The static page at `/`.
- The `state` query parameter, which is the fixture's only input.

## Threats

- Script injected through the `state` query parameter could execute in the page.
- A state the fixture does not implement could leave the page in an unknown visual state.

## Mitigations

- The fixture reads only a fixed allowlist of state names and writes text nodes.
- An unknown state sets `data-state="unknown"` and throws, so a capture fails loudly.
