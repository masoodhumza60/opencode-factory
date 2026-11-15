# Review-model calibration — how to use the corpus

## What this is

`docs/calibration/` holds 30 frozen diffs and a scorer. It measures how a
**reviewer** agrees with a **human** on verdicts — pass or changes.
It does not call any model. It does not sign anything. It reports.

## What it is not

- Not git-apply-able patches. Cases are review artifacts: a diff to look at, not one to apply.
- Not a correctness oracle. Agreement with one human's labels is not correctness.
- Not a gate. Nothing in the factory refuses or promotes on calibration numbers.
  The reviewer advises; G3 signs; this measures how often a chosen reviewer
  matches a labeler.

## The corpus

- `cases/syn-01..20.diff` — synthetic: 4 base defect classes x2 (`wrong-condition`, `missing-validation`, `contract-break`, `dropped-error-path`) plus 12 variations of four mixed classes (`off-by-one`, `silent-swallow`, `over-broad-delete`, `stale-comment`).
- `cases/real-01..10.diff` — ten real commits from this repository's history (M1b–M3), pinned in `scripts/factory-calibrate.mjs` and in `manifest.json`.
- `labels/<id>.md` — one file per case. Empty `Verdict:` means unlabeled.
- `manifest.json` — id, corpus, class, sha256 per case.

## The pipeline

1. **Label** — `labels/<id>.md`: what the reviewer should conclude and why, one or two lines.
   - `pass` = the change stands as written.
   - `changes` = the change needs fixing before merge.
   - `unlabelable` = no honest verdict; excluded from the score, counted as unlabeled.
2. **Record** — any reviewer, any provider, run by hand against `cases/<id>.diff`:

   ```powershell
   node scripts/factory-calibrate.mjs record --case syn-03 --reviewer <model-id> --verdict changes --note "short line"
   ```

   (case, reviewer) is an upsert — recording the same pair again overwrites.
3. **Score** —

   ```powershell
   node scripts/factory-calibrate.mjs score --reviewer <model-id>
   ```

   Writes `docs/calibration/<date>-agreement.md`. Refuses to overwrite;
   refuses with zero recorded verdicts; excludes unlabeled cases and counts them.

4. **Read** — agreement %, false-accepts (human said `changes`, reviewer said `pass`), false-rejects, and every disagreement listed. 100% agreement on ≥10 labeled split is flagged MIRROR-RISK.

## Honest ceilings

- Small n. Thirty cases do not establish a model; they establish a signal for this repo's review style.
- Synthetic selection bias. The synthetic defects are injected into two seeds and their neighbourhoods; a reviewer that is great there may be generic elsewhere.
- Real-history contamination. Ten of the thirty pins are public commits this model may have seen in training; a flattering agreement on those says less.
- One human labeler. Agreement is with that labeler, full stop. Another labeler may reasonably disagree; the labels are the anchor, not the truth.
- Mirrors are possible. A 100%-agreement reviewer on a split in which the human hovers over `pass` (or is simply not doing critical work) is useless. The MIRROR-RISK flag is a question, not an answer.
- This corpus cannot measure taste, judgment, taste-adjacent quality, or the cost of a miss. False-accepts decay slowly; false-rejects (rework, stall) bite differently in different teams.
