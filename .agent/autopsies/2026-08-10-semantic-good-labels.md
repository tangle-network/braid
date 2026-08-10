# Semantic calibration good-label autopsy

## Verdict

The corrected judge exposed a second calibration design flaw.

Several outputs labeled `good` described what an answer should contain instead of containing that evidence.

## Run

- Command: `BRAID_EVAL_MODEL=glm-5.2 BRAID_EVAL_MAX_COST_USD=1 pnpm test:eval`.
- Record: `/tmp/braid-semantic-eval-3FziXO/semantic-evaluation-record.json`.
- Raw calibration data: `/tmp/braid-semantic-eval-3FziXO/calibration.json`.
- Judge version: `braid-semantic-quality-v3-*`.

## Verified findings

- The judge rejected all 18 trivial answers.
- Good answers won 16 of 18 pairs, with two ties and no reversals.
- `cal-analysis-failed` scored 0.000 because it gave instructions without a citation or finding.
- `cal-comparison-outcome` scored 0.000 because it asked for fields without showing them.
- Five additional good labels scored below the 0.70 release threshold.
- The calibration code required pairwise preference but did not require a good label to pass the release threshold.

The ground-truth check selected every good cell and both tied pairs from `calibration.json` with `jq`.

## Permanent correction

Analysis references now state the finding, exact event citation, confidence, source status, limitation, and next action.

Comparison references now show both outcomes, cost provenance, every captured field, every paired measurement, and the one-pair limit.

Reconnect references now distinguish all six states and give state-specific actions.

Calibration now requires all 18 good examples to meet the release threshold.

The summary and release measurements expose good examples and accepted good examples separately.

## Smallest discriminating rerun

One corrected example from each affected category ran through Runtime and GLM-5.2.

`EVAL-03`, `EVAL-04`, and `EVAL-05` each scored 1.000 on every dimension.

All three calls reported zero reasoning tokens.

## Next action

Run the complete paid calibration and held-out release suite.
