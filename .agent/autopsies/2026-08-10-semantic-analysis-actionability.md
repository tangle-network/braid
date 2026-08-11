# Semantic analysis actionability autopsy

## Verdict

The held-out failure was a real product presentation defect.

Braid showed valid evidence and uncertainty but gave no next diagnostic action.

The shared analysis presenter now gives one status-aware next action after every terminal result.

## Failed run

- Command: `BRAID_EVAL_MAX_COST_USD=1 pnpm test:eval`.
- Record: `/tmp/braid-semantic-eval-H3BGZq/semantic-evaluation-record.json`.
- Case: `EVAL-03`.
- Fixture: `release-eval-03-3`.
- Status: failed analysis over a complete frozen source.
- Composite score: 0.6875 against a 0.70 requirement.
- Actionability: 0.0.
- Citation integrity: 1.0.
- Uncertainty: 0.85.
- Causal discipline: 0.90.

The judge found no concrete next diagnostic action after the analyst failure.

Both successful held-out analysis fixtures also lost actionability credit.

This pattern rejects random judge variance as the primary explanation.

## Permanent correction

`analysisDocument` now appends a next action for completed, failed, and cancelled results.

The action uses only existing Braid commands.

Failed analysis recommends a narrower `/ask` or `/activity` inspection.

Completed analysis recommends narrower analysis or a frozen `/compare`.

Running analysis does not show a premature next action.

TUI, plain output, saved results, and release evaluation all use this presenter.

The correction does not add a second analysis state or command path.

## Verification

The virtual-terminal scope passed 109 of 109 tests.

The exact previously failing installed-package fixture ran through Runtime and GLM-5.2.

It scored 0.925, above the 0.70 requirement.

- Actionability: 0.80.
- Citation integrity: 1.00.
- Uncertainty: 0.90.
- Causal discipline: 1.00.
- Input tokens: 846 billable plus 576 cached.
- Output tokens: 82.
- Reasoning tokens: 0.
- Cost: $0.0010336 estimated.
- Wall time: 3,420 ms.

The focused rerun used the packed Braid package and exact held-out semantic source.

## Next action

Run the complete paid calibration and held-out release suite against the corrected package.
