# Run stream sanitizer

The application ingestion boundary owns one incremental sanitizer for every active run stream.
Each input is a trusted-boundary candidate containing untrusted provider text and an application stream name.
Each output is safe text that may be committed to the local event journal and projected to any client surface.
The sanitizer carries terminal-control, credential-candidate, and split-Unicode state between input calls.
The sanitizer keeps stream state separate for text, reasoning, and message-part delta streams.
The sanitizer rejects terminal control payloads after the bounded control length instead of reopening visible output.
The sanitizer replaces credential assignments, bearer values, known token forms, unsafe URLs, and bidirectional controls.
The sanitizer preserves printable text and safe URLs after complete stream finalization.
The application resets all stream state after an accepted terminal event or a terminal recovery transition.
Duplicate provider events are rejected before they reach the sanitizer, so retries cannot duplicate output or advance state.
Sequence gaps are recorded without feeding the missing event placeholder into the sanitizer.
The registry refuses new streams after its bounded active-stream limit, which fails closed under orphaned provider runs.
The incremental scanner bounds candidate state while allowing the reducer's existing content budget to bound durable output.
The terminal event uses append mode for a small finalized suffix so previously committed output does not pass through a large journal payload.
The implementation does not parse provider-native protocols, launch runners, or own provider session state.
The implementation does not persist raw candidate text, sanitizer state, terminal frames, or credential values.
Focused tests cover split controls, credentials, duplicate events, replay, disconnect, cancellation, finalization, isolation, Unicode, and long safe output.
The complete local test suite remains the required proof for reducer, journal, TUI, and headless projections.
