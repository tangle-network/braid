# Semantic judge reference-leak autopsy

## Verdict

The calibration failure was a judge design flaw.

The judge credited facts from hidden reference data when the visible answer omitted those facts.

## Run

- Command: `BRAID_EVAL_MODEL=glm-5.2 BRAID_EVAL_MAX_COST_USD=1 pnpm test:eval`.
- Commit: `078c6131ffd7f060c6d618f20eb8d2070a59240e` plus uncommitted release work.
- Record: `/tmp/braid-semantic-eval-0b1bQc/semantic-evaluation-record.json`.
- Raw calibration data: `/tmp/braid-semantic-eval-0b1bQc/calibration.json`.
- Provider: Tangle Router through Runtime `profileChatClient`.
- Model: `glm-5.2` with thinking disabled and a 2,048 total completion-token cap.

## Verified findings

- Raw cell recomputation found 18 good preferences from 18 independent good-versus-bad pairs.
- Raw cell recomputation found zero ties and zero reversals.
- Six of 18 trivial answers scored at or above the 0.70 release threshold.
- `EVAL-01`, `EVAL-02`, and `EVAL-04` failed their per-category trivial checks.
- The global trivial mean was 0.491 against a good mean of 0.935.
- `Fork plan received.` scored 0.725 because the judge credited fork facts present only in `semanticOutput`.
- `Comparison complete.` scored 0.975 because the judge credited comparison fields present only in `semanticOutput`.
- The request renderer placed complete `semanticOutput` beside `userFacingAnswer` without an explicit credit boundary.

The ground-truth check was `jq` over every calibration cell in the raw record.

The code check was a direct read of `semanticJudge()` in `src/eval/calibration.ts`.

## Disproven hypotheses

- The provider route was not broken because the pilot passed and all 54 calibration calls returned scores.
- GLM thinking was not active because completed calls reported zero reasoning tokens after the provider-specific fix.
- The good and bad fixtures were not identical because all 18 paired comparisons preferred the good answer.
- The release threshold was not the defect because several generic answers received near-perfect dimension scores.

## Permanent correction

The judge input now separates `candidate` from `referenceOnly`.

The shared judge contract says that only facts explicit in `candidate.userFacingAnswer` can earn credit.

The contract says that hidden reference facts and `productPath` cannot fill candidate omissions.

The judge version is now `braid-semantic-quality-v3-*`.

A focused test executes the real judge request builder and verifies this evidence boundary.

## Smallest discriminating rerun

The exact previously failing sentence `Fork plan received.` was rescored through Runtime and GLM-5.2.

It scored 0.000 on all four dimensions with zero reasoning tokens.

This result rejects the reference-leak mechanism before another full paid run.

## Next action

Run the complete paid calibration and release suite with the corrected judge contract.
