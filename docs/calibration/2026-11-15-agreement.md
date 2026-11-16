# Calibration agreement - 2026-11-15

Harness: scripts/factory-calibrate.mjs (calls no model). Labels: C:\Users\Humza\Desktop\projects\opencode-factory\docs\calibration\labels (human-written). Missing labels are excluded and counted.

## Reviewer: blind-agent-2026-11-16

### synthetic
- labeled split: 20 / 20 (0 unlabeled)
- agreement: 19/20 (95.0%)
- false-accepts (human: changes -> reviewer: pass): 1
- false-rejects (human: pass -> reviewer: changes): 0

disagreements:
- syn-19 (stale-comment) human=changes reviewer=pass

### real-history
- labeled split: 10 / 10 (0 unlabeled)
- agreement: 10/10 (100.0%)
- false-accepts (human: changes -> reviewer: pass): 0
- false-rejects (human: pass -> reviewer: changes): 0

**MIRROR-RISK: 100.0% agreement on 10 labeled real-history cases.** A reviewer that never disagrees with this human is not a gate; it is a mirror. Use a different reviewer before trusting this one.
