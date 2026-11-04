# testapp

The one proof surface for M2b: what `scripts/factory-capture.mjs` captures.

Static HTML, CSS and one script. No framework, no build, no network.

- `?state=default` - three tasks listed
- `?state=loading` - skeleton with `aria-busy`
- `?state=empty` - the empty state
- `?state=error` - a `role="alert"` error state
- `?state=disabled` - the primary action disabled
- `?state=console-error` - test-only probe; a capture over it must fail

`location.search` is the only input. `document.body[data-state]` is set once
the page has settled, which is what the capture adapter waits for.
