# Semantic token telemetry redaction autopsy

## Verdict

The semantic release summary emitted false zero token totals.

The eval redactor matched numeric telemetry fields because their names contain `token`.

The redactor now preserves allowlisted finite numeric telemetry and still masks token-shaped strings.

## Failed observation

- Record: `/tmp/braid-semantic-eval-9QYHiV/semantic-evaluation-record.json`.
- Judge calls: 73.
- Successful calls: 73.
- Cost receipts: 73.
- Reported cost: $0.104827.
- Exported input tokens: 0.
- Exported output tokens: 0.
- Exported cached tokens: 0.

Every receipt stored `[REDACTED]` for numeric input, output, reasoning, and cache counts.

The measurement exporter accepted those strings as zero.

The zero values therefore described redaction loss, not measured usage.

## Root cause

`SECRET_KEY` intentionally matches credential fields that contain `token`.

`redactEvalValue` applied that match before checking the value type or telemetry field name.

It therefore treated `inputTokens`, `outputTokens`, and related numeric fields as credentials.

## Permanent correction

The shared structured redaction allowlist now covers standard input, output, reasoning, completion, total, and cache counters.

It also accepts an exact numeric `{ input, output }` token-usage record.

The eval redactor uses that allowlist before masking a sensitive field name.

String-valued token fields remain redacted.

Tests cover numeric preservation, string rejection, and aggregate release measurements.

## Exact rerun

- Record: `/tmp/braid-semantic-eval-3g6B0v/semantic-evaluation-record.json`.
- Semantic categories passed: 6 of 6.
- Held-out fixtures passed: 18 of 18.
- Judge calls: 73 of 73 successful.
- Input tokens: 122,410.
- Output tokens: 6,043.
- Reasoning tokens: 0.
- Cached tokens: 30,144.
- Cost: $0.104827.
- Wall time: 30,797 ms.
- Unit tests: 210 of 210 passed.

The rerun proves that secret masking and numeric observability coexist on the packed release path.
