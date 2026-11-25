# Changelog

## 1.0.0 - 2026-11-16
- **M0 STOP THE LYING** (2026-09): attestation machinery, real verify, no more asserted-as-verified.
- **M1a mechanical attestation** (2026-10): signed acceptance, protected review paths, phase machine v2.
- **M1b independence** (2026-10): reviewer/builder separation, record-on-machine ledger (shipped 2026-10-27, 60c61dd).
- **M1c canonical gates** (2026-10): G1/G2a/G2b/G3, outcome gate (shipped 2026-10-30, 44b60ea).
- **M2a discipline ledger** (2026-11): per-profile checklists, evidence kinds, skills resolving (2026-11-03, e5ec28b).
- **M2b human surfaces** (2026-11): directions shape-check, web capture adapter, axe/directions kinds (2026-11-06, d712b02).
- **M2c security/QA/SRE** (2026-11): compliance attestation catalog (2026-11-07, 81c4a80); consolidated and merged via PR #1 (813ee63, 2026-11-07).
- **M3 bundle drill** (2026-11): backup-before-install, verify, rollback proven; merges PR #2 (3141ab2, 2026-11-09).
- **M4 outcome loop** (2026-11): outcomes.jsonl, negative-results, eval harness (12/12), calibration harness; merged via PR #3 (ad82dc1, 2026-11-15) and PR #4 (ff27acd, 2026-11-15); calibration labels + blind-reviewer verdicts merged via PR #5 (572bb66, 2026-11-16); syn-19 ruling (pass) merged via PR #6 (e38f2fc, 2026-11-16); DORA deliberately out of scope.
- **M5 release identity** (2026-11): versioned install (1.0.0), changelog, fresh-machine CI check on ubuntu-latest and windows-latest, docs point at the v1 tag.

Honest ceilings: one machine, one operator, no second user; no npm registry distribution;
calibration reviewer flagged MIRROR-RISK (20/20 agreement with its human, 10/10 on real-history);
blind dogfood not performed. Installable from the git tag only.
