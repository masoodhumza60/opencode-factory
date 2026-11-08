# Real delivery: the factory bundle drill

M3 makes "set up my factory from <repo>" a verifiable local act on this machine
instead of a promise. It does not deploy software; it delivers the factory.

## What it does

    node scripts/factory-delivery.mjs drill --backup <dir>

1. Records HEAD (`git rev-parse --short HEAD`) and backs up `~/.config/opencode`
   and `~/.agents/skills` into `<dir>`: `opencode/` and `agents-skills/`
   subdirectories, plus a SHA256 manifest of every backed-up file at
   `<dir>/manifest.json`, keyed by root-relative path.
2. Re-installs from this repo (`install.ps1`, run via PowerShell).
3. Verifies the install: the installed `factory-selfcheck.mjs` must exit 0, and
   `~/.agents/skills/factory/install-manifest.json` must parse, name this repo's
   HEAD as its `bundle_commit`, and hash-match every file it lists.
4. Rolls the machine back to the backup: every backed-up file is restored
   byte-identically, and files that exist after install but are not in the
   backup manifest are deleted. Your own files taken before the backup survive;
   only files the install itself added are removed.
5. Verifies the rollback by re-hashing every live file against the backup
   manifest.
6. Writes a transcript to `out/delivery/<timestamp>-drill.md`.

Any failure before the rollback step completes restores the machine
automatically from the backup before exiting non-zero. `--no-auto-rollback`
disables that. A failure in the rollback verification itself means the
restore ran but did not verify; the transcript records exactly which files
missing, modified, or unmanifested caused it.

Useful flags: `--no-auto-rollback` (skip the automatic restore on failure) and
`--home <dir>` (run every step against a sandboxed home instead of your real
one — that is what the test suite does).

## The ceiling (read this)

- One machine, one operator, one moment. It proves byte-equality of two trees
  and the invariants the installer itself records.
- It does not prove another machine, a clean VM, a different user, or cloud
  delivery. No target product is exercised.
- A green drill means the bundle delivers here, once. It is the floor of real
  delivery, not the ceiling.
- The drill overwrites your live install twice. The backup is your recovery.
- The test suite never touches your real install; it drives a sandboxed
  `--home`.
- This file, like every doc in this repo, is prose and is never attested as
  evidence. The drill's record is its transcript under `out/delivery/`,
  nothing else.
