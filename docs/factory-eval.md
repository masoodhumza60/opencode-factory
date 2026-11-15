# factory-eval: the cheap regression for the factory itself

`scripts/factory-eval.mjs` proves the factory's test-app seeds still mean
something: that their hidden acceptance tests discriminate, that a correct
implementation passes them, and that a plausible wrong one fails them. It is
the deterministic floor. The judgment ceiling is a human running the real
pipeline per the seed, scored by the same hidden tests.

## What it checks

`node scripts/factory-eval.mjs check` copies each seed to a fresh temp
directory (never mutates the repo) and runs four proofs per web/api seed:

1. **own** — the seed's own suite passes on the bare tree.
2. **fail-bare** — the hidden tests fail on the bare tree (they are not vacuous).
3. **pass-golden** — `golden.patch` satisfies them.
4. **fail-broken** — `broken.patch` satisfies the surface request but fails them.

The CLI seed (`orderboard-cli`) shipped its feature at birth, so its three
discrimination proofs are NOT APPLICABLE; only its own suite is run. Not
applicable is not a pass.

A machine record is appended as `out/eval/<timestamp>.jsonl` (rows:
`{at, seed, proof, ok}`). It is evidence, never attested.

## Verified on this machine

```
$ node scripts/factory-eval.mjs check
ok orderboard own
ok orderboard fail-bare
ok orderboard pass-golden
ok orderboard fail-broken
ok orderboard-api own
ok orderboard-api fail-bare
ok orderboard-api pass-golden
ok orderboard-api fail-broken
ok orderboard-cli fail-bare — NOT APPLICABLE (the seed ships its feature; no discrimination signal)
ok orderboard-cli pass-golden — NOT APPLICABLE (the seed ships its feature; no discrimination signal)
ok orderboard-cli fail-broken — NOT APPLICABLE (the seed ships its feature; no discrimination signal)
ok orderboard-cli own

12/12 proofs passed.
machine record: out/eval/<timestamp>.jsonl
```

## When to run it

- After changing any factory rule that touches how work gets built or verified.
- Before a release.
- As part of the acceptance gate for factory-level changes; it is not run by
  the ship pipeline itself.

## The honest ceiling

The cheap eval proves the seeds and their tests discriminate; it says nothing
about a human's judgment, a model's taste, or an outcome in production. A
passing 12/12 does not mean the product or the pipeline was good.

The ceiling is the human-run pipeline per seed, on a fresh copy:

1. `factory-workspace/eval-<seed>-<date>/` holds transcripts.
2. Run the factory against the seed (`factory <feature>`), human gates included.
3. Score the result with the hidden tests under `testapps/<seed>/hidden/`.
4. Record the outcome in `.factory/<bead>/outcome.md` (verdict line, per the
   phase-8 G4 gate) — it lands in `docs/outcomes.jsonl` and the ledger.

## The do-not-read rule

`testapps/<seed>/hidden/` contains acceptance tests. A builder, or an agent
acting as a builder, must not read them. This is by convention and
instruction, not enforcement; the machine cannot verify it. That is stated,
not hidden.
