# Tangle retained-run diagnostic

Verdict: PARTIAL. The diagnostic capture bug is confirmed. The cause of the missing cloud tool event remains INSUFFICIENT_DATA.

Expected: a provider-bound workspace tool event within 180 seconds, then process restart, replay, a follow-up turn, cancellation, and exact resource cleanup. Both cloud attempts failed before restart. There are zero complete passes, two failures, and no recovery result.

| Attempt | Runtime / Provider / Sandbox | Outcome |
| --- | --- | --- |
| `run-dec2465f-ec24-4653-b647-da23b9081305` | 0.308.0 / 3.6.5 / 0.60.22 | Admission succeeded; no public tool event within 180 seconds. |
| `run-9e3263e8-bd36-4c5b-b73d-904a62f9b61a` | 0.309.0 / 3.6.5 / 0.60.22 | Admission succeeded in 13.31 seconds; no public tool event within 180.05 seconds. |

Both ran packed Braid through Tangle Sandbox with OpenCode and `tangle-router/glm-5.3`. The second ran on Beelink2 from 23:33:38 to 23:40:57 UTC. Its raw receipt SHA-256 is `e6c0d8d30afd59a4994e33f5bbdc72e654baf30f228f862b9f0c4f72d77c9ddd`. Private artifacts remain at `/Users/drew/.local/state/agent-work/braid/runtime-refresh-diagnostic-20261007/artifacts`. The [safe summary](../../artifacts/verification/runtime-refresh/tangle-retained-diagnostic-20261007.summary.json) retains versions, timing, and cleanup evidence without account identities or balances.

The second receipt has 55 RPC responses and a 30-event tail with distinct provider identities. The earlier interpretation that provider envelopes were empty was wrong. `projectSemanticEvent` exposes canonical events in `payload.unknown`, or session updates in `payload.harnessSession`. The diagnostic read an internal `payload.envelope` that does not exist on the public boundary. Native raw events remain intentionally redacted. Their content cannot be inferred from this receipt.

The displayed `starting` status and cursor 4 came from the admission state response at 23:34:01.653 UTC. The script did not refresh state while waiting for tools. This is not evidence of backend status at the deadline. The old timeline's `sequence` is the RPC transport sequence, not the journal sequence.

A regression through production `providerEventFor` and `toEvent` failed against the old reader because it lost canonical type and phase. The corrected reader passed that regression and a stale-snapshot check. It records bounded canonical fields, hashed source identities, and journal sequence separately from transport sequence. `lastObservedRun` records the source state sequence, revision, and run update timestamp. On Beelink2, `node --test test/tangle-live07-wiring.test.mjs test/tangle-sandbox-braid-stress-script.test.mjs` passed all 88 tests with zero skips. No timeout or success criterion changed. The prepared diagnostic fix awaits the runtime refresh's final package gate before merging.

Both exact owned sandboxes were deleted through the SDK and confirmed absent. Shutdown acknowledgement timed out; SIGTERM cleanup verified process exit and descendants. Shared account resource deltas are unattributed and do not prove leaked resources from these attempts.

Next deciding check: adopt the published SDK/provider fixes, pass the registry-backed Braid gate, and run the original cloud proof with the corrected diagnostic. If it fails, use canonical event evidence to locate the responsible provider or runtime boundary. No backend stall, event-normalization defect, or successful cloud durability claim is established here.
