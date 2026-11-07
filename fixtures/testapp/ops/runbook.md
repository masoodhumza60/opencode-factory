# Runbook - testapp

## Purpose

Serve the static task list and keep its capture path working.

## Ownership

The factory team owns the fixture and the capture adapter.

## Detection

- A capture run exits non-zero with a named state.
- The static host returns a 5xx.

## Response

- Re-run `node scripts/factory-capture.mjs --fixture fixtures/testapp`.
- Check that the fixture files and the pinned toolchain are intact.

## Escalation

Page the on-call engineer if the host is down or the fixture cannot be served.
