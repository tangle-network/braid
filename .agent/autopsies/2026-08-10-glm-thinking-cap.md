# GLM semantic judge thinking-cap autopsy

## Verdict

The paid semantic run found a model-specific control mismatch.

GLM-5.2 ignored `reasoning_effort: none` and enabled hidden thinking by default.

Two of 26 completed attempts consumed all 2,048 allowed completion tokens before visible output.

## Evidence

- Interrupted run: `/tmp/braid-semantic-eval-xHWh6S`.
- Both failures occurred in `EVAL-01` trivial-baseline calibration cells.
- Router returned HTTP 503 with `finish_reason=length` and 2,048 hidden reasoning tokens.
- The first pilot completed before calibration, so credentials and routing were healthy.
- Z.AI documents `thinking: { "type": "disabled" }` as the switch for direct output.

## Root cause

Runtime forwards the provider-neutral effort as `reasoning_effort`.

GLM uses its own `thinking` object and defaults that mode to enabled.

The total cap worked, but it could not reserve visible output inside that total.

## Permanent correction

The release adapter now adds `thinking.type: disabled` only for GLM model identifiers.

It retains the 2,048-token hard completion cap and one-attempt policy.

Non-GLM model overrides do not receive the provider-specific field.

Focused tests assert both request shapes before provider spend.

## Remaining proof

Run the paid pilot and calibrated semantic suite again through the exact Runtime profile.

Every successful call must contain visible structured output and measured usage.
