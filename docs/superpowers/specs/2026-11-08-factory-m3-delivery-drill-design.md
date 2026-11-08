# M3 — Real delivery: the factory bundle drill

Spec: 2026-11-08
Branch: `feat/mcp-registry` (merged via PR #1 to `master`; this milestone starts a new line)

## Vision anchor

From `docs/superpowers/specs/2026-09-22-opencode-factory-design.md`, "1. Vision":

> A single, portable "software factory" for OpenCode: one bundle that turns a
> feature request … brainstorm → spec → plan → tasks → implement → debug →
> verify → review → ship. … "repeatable and portable":

The delivery proof for that bundle is the line the vision already draws:
"Setting up a new machine is 'set up my factory from `<repo>`'." M3 makes that
line real on one machine, with evidence, instead of leaving it as prose.

The roadmap's M3 text ("deploy step with a real target: environment, secrets,
migrations, post-deploy smoke test. … the ship gate requires a deployed URL and
a rollback record") describes delivered **software** with a network target. That
is out of scope here for the same reason the factory does not host anything in
the cloud: the factory is a local, single-operator bundle. This milestone
proves the **bundle itself** delivers — installs, works, and can be rolled
back — with the same evidence discipline the rest of the factory applies to
its produced software.

## Scope

- The OpenCode factory bundle only. Not cloud hosting, not a produced target
  product, not every project that uses the factory.
- This machine only. Not a clean VM, not another operator.
- The drill mutates the live install twice (re-install, then restore) and is
  opt-in. Purely additive to the bundle: one unpinned script, one new test
  suite, three doc updates. No new dependencies, no new evidence kinds, no
  pinned-script changes, no gate/protected-list changes.

## Deliverables

1. `scripts/factory-delivery.mjs` — unpinned, stdlib-only, same refusal-first
   conventions as `factory-compliance.mjs`.
2. `scripts/test-factory-delivery.mjs` — suite that drives the logic against a
   **sandboxed fake home** (`--home <dir>`), never the real one.
3. `docs/factory-delivery.md` — what the drill is, how to run it, the ceiling.
4. Rollback section in `docs/HOW-INSTALL.md` — backup locations, manual restore.
5. `docs/factory-roadmap.md` — M3 rewritten for the bundle.
6. `out/delivery/*.md` — gitignored drill transcripts. `out/` is already ignored.

## The drill

Invocation:

```
node scripts/factory-delivery.mjs drill --backup <dir> [--no-auto-rollback]
```

Steps, in order:

1. **Record.** `HEAD` = `git rev-parse --short HEAD`. Create the backup
   directory `<dir>` if absent.
2. **Backup.** Copy `~/.config/opencode` → `<backup>/opencode` and
   `~/.agents/skills` → `<backup>/agents-skills` (full recursive copy, no
   exclusions). Write `<backup>/manifest.json`: one entry per file, keyed by
   root-relative path, with SHA256 and byte size, plus:
   `head`, `created_at` (ISO), `home` (the root that was backed up).
3. **Install.** Run `install.ps1` in the repository root:
   `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`.
   Capture combined output to the transcript; also print it.
4. **Verify install.** Two checks, both must pass:
   a. `node scripts/factory-selfcheck.mjs` exits 0.
   b. `~/.agents/skills/factory/install-manifest.json` parses; its
      `bundle_commit` equals the recorded `HEAD`; for every `files[path]` entry
      in it, the byte size and SHA256 of the live file match the manifest entry.
   A failure prints which check failed and why.
5. **Rollback.** For each root in the backup: overwrite every backup file back
   into the root (`fs.cpSync` overwrite). Then delete every file under the
   root that is **not** in the backup manifest (i.e. an install artifact).
   Directories left empty by that deletion are pruned; the root itself is never
   removed. Deletion is never recursive over unmanifested directories.
6. **Verify rollback.** Re-hash every live file under both roots and compare
   against the backup manifest: identical set, identical hashes. Selfcheck is
   recorded as informational only and does not gate this step.
7. **Transcript.** Write `out/delivery/<iso-timestamp>-drill.md`: HEAD, steps
   with exit codes and durations, both verification results, auto-rollback
   outcome if triggered. Missing/failed step writes a transcript too, so a
   failure still produces its record.

### Auto-rollback

Any failure before step 6 passes triggers the same rollback as step 5, then
exits non-zero with the transcript path printed. `--no-auto-rollback` disables
the automatic restore and prints the manual restore instructions instead.

## Honest ceilings (must appear in `docs/factory-delivery.md`)

- The verification proves this machine, this HEAD, this moment: byte-equality
  of two trees and the invariants the installer itself records.
- It does not prove another machine, another user, or a clean environment.
- It does not prove cloud deployment; no target product is exercised.
- A green drill says the bundle delivers for one operator once. It is the
  floor of "real delivery", not its ceiling.

## Testing

`test-factory-delivery.mjs` uses a temp `--home` and a temp `--backup`:

- backup creates the manifest, hashes are correct, file count correct.
- a file modified after backup is caught by rollback verification.
- an added (unmanifested) file is removed by rollback.
- a forced install-verification failure (wrong `bundle_commit`) triggers
  auto-rollback and exits non-zero, leaving the fake home restored.
- the transcript is written and names the failure.
- `--no-auto-rollback` prints instructions instead of restoring.
- backup root missing/unsupported layout is refused by name.
- CLI usage error without `--backup`.

No test touches the real `~/.config/opencode` or `~/.agents/skills`.

## Explicitly not in this milestone

- No change to any gate, protected list, pinned script, or `FACTORY_ROLE`.
- No new kind. The drill transcript is a normal file; if a project wants to
  attest it later, `transcript` already exists.
- No fresh-VM run, no other milestone-merge integration, no CI.

## Exit

The drill, run by the human on this machine, prints `delivery ok` and leaves
the machine restored to the pre-drill state with a transcript that says so.
"It installs" is no longer sufficient; "the drill ran and rolled back cleanly"
is.
