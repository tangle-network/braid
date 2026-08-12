# Audit: Braid retained Tangle Sandbox lifecycle and proof — 8f066cc20c750579015bf47589d3d742d6bb0bc5..8f066cc20c750579015bf47589d3d742d6bb0bc5 — n=65 files, 7 findings

**Verdict:** APPROVE — 7 of 7 measured defects resolved · 0 CRITICAL / 2 HIGH / 4 MEDIUM / 1 LOW
**Worst:** #1 `scripts/live-required/tangle-sandbox-braid-stress.mjs:594` — public proof disclosed two account identifiers · cost if shipped 2 identifiers per artifact
**Next:** `/verify`

## Scope

| Field | Value |
|---|---|
| Files | n=65 via current working-tree diff |
| Base..head | `8f066cc20c750579015bf47589d3d742d6bb0bc5..8f066cc20c750579015bf47589d3d742d6bb0bc5` |
| Project type | Node.js ESM package |
| Reviewers | A,B,C · serial |
| Not inspected | Provider implementation outside Braid; live retained execution remains blocked by tracked upstream issues. |

## Findings — 7 of 7, ranked

| # | Sev | file:line | Defect | Failure scenario (input/state → wrong result) | Status | Evidence | Fix | Verification | Cost if shipped | Saved if fixed |
|---:|---|---|---|---|---|---|---|---|---:|---:|
| 1 | HIGH | `scripts/live-required/tangle-sandbox-braid-stress.mjs:594` | Public proof emitted raw account identity. | Authenticated proof → two identifiers published. | measured · resolved | actual artifacts: 5/5 have zero raw identity keys | Emit one digest. | public scans 5/5 pass | 2 identifiers/artifact | 2/2 removed |
| 2 | HIGH | `src/adapters/runtime/retained-execution.ts:75` | Pending detach reopened the event reader. | Detach before start resolves → detached run streams locally. | measured · resolved | `test/retained-execution-lifecycle.test.ts:206` | Stop after start when detached. | `pnpm check` test passed | 1 reader/run | 1/1 prevented |
| 3 | MEDIUM | `src/adapters/runtime/tangle-sandbox-retention.ts:53` | Wrapper dropped account methods. | Wrap client → identity, usage, and subscription become unknown. | measured · resolved | `test/tangle-retained-lifecycle.test.ts:142` | Preserve bound methods. | `pnpm check` test passed | 3 methods/client | 3/3 preserved |
| 4 | MEDIUM | `scripts/live-required/tangle-sandbox-braid-stress.mjs:926` | Shutdown error hid cleanup proof. | Lost acknowledgement → descendants remain unverified. | measured · resolved | `test/tangle-sandbox-braid-stress-runtime.test.mjs:123` | Verify close before rethrow. | live-required 26/26 | 1 tree/failure | 1/1 verified |
| 5 | MEDIUM | `src/app/run-replay.ts:53` | Recovery dropped the typed cause. | Failed dispatch plus no status → generic error. | measured · resolved | `test/w8-runs.test.ts:251` | Carry safe prior detail. | `pnpm check` test passed | 1 diagnostic/run | 1/1 retained |
| 6 | MEDIUM | `src/domain/invariants-profile.ts:140` | Other connections accepted Sandbox lifecycle fields. | CLI Bridge plus retained TTL → invalid configuration accepted. | measured · resolved | `test/domain-invariants.test.ts:199` | Restrict fields by kind. | `pnpm check` test passed | 2 fields/config | 2/2 rejected |
| 7 | LOW | `docs/05-profiles-and-connections.md:275` | Docs claimed a missing editor action. | User follows setup text → no retained control exists. | measured · resolved | `src/views/tui/connection-metadata-editor-model.ts:15` | State configuration boundary. | editor field inspection | 1 claim/reader | 1/1 removed |

0 dropped (no reproducible failure scenario / no actionable fix).

## Assumptions & unverified

| Assumption | Finding it would flip | Check that settles it |
|---|---|---|
| The provider will add exact retained-run lookup without changing the six-field control reference. | The current adapter contract could require a new shared field. | Resolve upstream runtime issue 800 and provider issue 146, then rerun the retained stress command. |
| The current Sandbox authorization regression is external to Braid. | A Braid credential-routing defect could be present. | Resolve ADC issue 5277, then rerun both direct SDK and Braid canaries with one new key. |

## Self-gate

9/9 passed — failed: none.
1 verdict = decision + 1 number · 2 every finding has file:line · 3 concrete failure scenario · 4 status label · 5 evidence is a pointer · 6 cost both sides · 7 fix + verification per row · 8 zero adjectives standing in for counts · 9 148 words ≤600 outside tables.
