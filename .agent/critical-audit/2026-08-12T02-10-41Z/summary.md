# Audit: Tangle sandbox stress and worker scripts — 8cce4c6e8aade3b1fc51f558d65a823ac12a5e1a..8cce4c6e8aade3b1fc51f558d65a823ac12a5e1a — n=3 files, 4 findings

**Verdict:** APPROVE — 4 measured defects resolved · 0 CRITICAL / 2 HIGH / 2 MEDIUM / 0 LOW
**Worst:** #1 `scripts/live-required/tangle-sandbox-worker.mjs:212` — foreign replay identity could pass · cost if shipped 1 false proof pass per occurrence
**Next:** stop

## Scope

| Field | Value |
|---|---|
| Files | n=3 via explicit target scope |
| Base..head | `8cce4c6e8aade3b1fc51f558d65a823ac12a5e1a..8cce4c6e8aade3b1fc51f558d65a823ac12a5e1a` |
| Project type | Node.js ESM package |
| Reviewers | A,B,C · serial |
| Not inspected | Runtime adapters and live network behavior; both were outside the requested scope and tests used fakes |

## Findings — 4 of 5, ranked

| # | Sev | file:line | Defect | Failure scenario (input/state → wrong result) | Status | Evidence | Fix | Verification | Cost if shipped | Saved if fixed |
|---:|---|---|---|---|---|---|---|---|---:|---:|
| 1 | HIGH | `scripts/live-required/tangle-sandbox-worker.mjs:212` | Replay projection discarded event execution identity. | Cursor event for execution-1 plus result event for execution-2 → foreign result accepted. | measured; resolved | Independent probe; final regression `scripts/live-required.test.mjs:1259` | Preserve event identity and reject foreign IDs. | `node --test scripts/live-required.test.mjs` → 19/19 | 1 false pass/occurrence | 1 false pass rejected/occurrence |
| 2 | HIGH | `scripts/live-required/tangle-sandbox-stress.mjs:86` | Cancellation proof ignored terminal state. | Matching acknowledgements with `sessionStatus=running` → cancellation proof accepted. | measured; resolved | Independent probe; final regression `scripts/live-required.test.mjs:973` | Require `sessionStatus=cancelled`. | `node --test scripts/live-required.test.mjs` → 19/19 | 1 false pass/occurrence | 1 false pass rejected/occurrence |
| 3 | MEDIUM | `scripts/live-required/tangle-sandbox-stress.mjs:243` | Cleanup stopped at page one. | Exact tag at offset 100 → sandbox remains while cleanup reports success. | measured; resolved | Independent probe; final regression `scripts/live-required.test.mjs:1129` | Page every result and verify every page after deletion. | `node --test scripts/live-required.test.mjs` → 19/19 | 1 leaked sandbox/hidden tag | 1 leak prevented/hidden tag |
| 4 | MEDIUM | `scripts/live-required/tangle-sandbox-stress.mjs:384` | Concurrent failure could omit a received admission. | Admission emitted before cursor error → partial artifact has no admission receipt. | measured; resolved | Independent probe; final regression `scripts/live-required.test.mjs:1073` | Store each successful wait before `Promise.all`. | `node --test scripts/live-required.test.mjs` → 19/19 | 1 missing receipt/failure | 1 receipt retained/failure |

1 dropped (an external fake counter changed despite a receipt saying `dispatched=false`; it did not describe a production-visible failure).

## Assumptions & unverified

| Assumption | Finding it would flip | Check that settles it |
|---|---|---|
| The SDK keeps `SessionStatus` values aligned with `completed` and `cancelled`. | Terminal-state checks could reject a valid live result. | SDK declaration `types-C7mxmAil.d.ts:3094` and live proof run. |
| The account list API honors `limit` and `offset`. | Pagination could miss or repeat cleanup records. | SDK declaration `client-BCwkh2kj.d.ts:382` and live cleanup run. |

## Self-gate

9/9 passed — failed: none.
1 verdict = decision + 1 number · 2 every finding has file:line · 3 concrete failure scenario · 4 status label · 5 evidence is a pointer · 6 cost both sides · 7 fix + verification per row · 8 zero adjectives standing in for counts · 9 185 words outside tables ≤600.
