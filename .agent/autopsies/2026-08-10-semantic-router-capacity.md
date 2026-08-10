# Semantic Router capacity autopsy

## Verdict

The release run failed because of a transient infrastructure error.

The Router returned HTTP 503 before charging or producing judge output.

Braid allowed only one transport attempt, so one unavailable call stopped the complete calibration.

## Run

- Command: `BRAID_EVAL_MODEL=glm-5.2 BRAID_EVAL_MAX_COST_USD=1 pnpm test:eval`.
- Commit: `078c6131ffd7f060c6d618f20eb8d2070a59240e` plus uncommitted release work.
- Record: `/tmp/braid-semantic-eval-hDApGK/semantic-evaluation-record.json`.
- Raw failure: `/tmp/braid-semantic-eval-hDApGK/campaigns/calibration/EVAL-04/good/EVAL-04-calibration-1_0/failure-receipt.json`.
- Provider: Tangle Router through Runtime `profileChatClient`.
- Model: `glm-5.2` with thinking disabled and a 2,048 total completion-token cap.
- Expected result: all 18 good calibration answers meet their release threshold.

## Verified findings

- The route probe was ready and advertised `glm-5.2`.
- The installed package proof was ready with tarball digest `sha256:0333e88ee130a7540a2f95f0fd31dc44f612e69b494f45017de1fb83ccc3e271`.
- The failed cell was `EVAL-04` fixture `cal-comparison-cost` with judge stage `braid-EVAL-04-semantic-quality`.
- The raw response was HTTP 503 with code `upstream_unavailable` and an upstream-capacity message.
- The failure receipt recorded zero input, output, reasoning, and cached tokens.
- The failure receipt recorded zero cost and one call with unknown usage.
- The other 17 good calibration answers all met their thresholds.
- Recomputing `goodAccepted` from the six category rows produced 17, equal to the record.

The ground-truth checks read the raw failure receipt, route probe, package proof, and six category rows.

## Disproven hypotheses

- The candidate package was not unavailable because its installed-package proof was ready.
- The model route was not misconfigured because discovery advertised the exact model.
- The fixture was not mislabeled because the corrected answer later scored 1.000 on all four dimensions.
- The judge did not reject the answer because the provider returned no completion or token usage.
- The call was not billable work because the recorded token and cost totals were zero.

## Permanent correction

`src/eval/execution.ts` now sets Runtime `maxAttempts` to two.

Runtime owns transient-status classification and performs at most one retry.

The profile uses a fixed 500 millisecond delay and preserves the same request identity across attempts.

A focused test proves that HTTP 503 retries with the same idempotency key.

A second focused test proves that HTTP 400 does not retry.

## Smallest discriminating rerun

The exact `cal-comparison-cost` answer was rescored through Runtime and Tangle Router.

It scored 1.000 on all four dimensions in 4.719 seconds with one successful call.

This result rejects a fixture or judge-quality failure before another complete paid run.

## Next action

Run the complete paid calibration and release suite with the bounded Runtime retry policy.
