# Comparison

## Job

Comparison shows every captured field and asymmetry across analysis or run arms before it presents a verdict.

## Best simple implementation

Build one canonical comparison result outside the renderer.

Project complete arm, field, missing-data, termination, usage, cost, timing, and provenance values into `ComparisonView`.

Render the same ordered fields through `ComparisonViewPanel`, plain output, and headless output.

Do not drop zero, null, failure, or unequal sample counts to make a table cleaner.

## Component map

| Component | Responsibility |
| --- | --- |
| `ComparisonViewPanel` | Navigate arms, measured fields, asymmetries, threats, and verdict evidence. |

## Inputs and outputs

Each arm names its source, profile, runner, model, environment, sample count, status, and measured values.

Each field records a value for every arm or an explicit missing reason.

Asymmetries appear before the verdict.

Selection changes presentation only and emits no mutation.

## Ordering

The header shows provenance and arm counts first.

Blocking asymmetries follow.

Measured fields follow in canonical order.

Distribution summaries include count, minimum, median, p90, and maximum when the input supports them.

The verdict appears only after the evidence it depends on.

## Failure and safety

Unequal counts, different termination, missing telemetry, and different model or environment inputs remain visible.

Unknown values never become zero.

An invalid comparison result fails closed before rendering a verdict.

All labels and evidence excerpts are sanitized and bounded.

## Responsive behavior

Narrow mode shows one field with all arm values and explicit next or previous navigation.

Standard mode shows a compact field table.

Wide mode adds provenance and distribution detail.

No mode hides an asymmetry.

## Performance

The comparison result is immutable and precomputed.

The panel renders a bounded viewport and selected detail only.

## Proof

Tests cover zero and null values, unequal arms, missing telemetry, different termination, field ordering, narrow navigation, and honest verdict suppression.

## Non-goals

The component does not run an evaluation or choose a winner from incomplete evidence.

It does not summarize away fields captured by the source result.
