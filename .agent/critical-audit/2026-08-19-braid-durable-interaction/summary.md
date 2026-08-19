# Audit: Braid durable interaction and TUI architecture — e3ed3d1..e3ed3d1 — n=70 files, 8 findings

**Verdict:** REQUEST_CHANGES — one P1 dependency boundary remains · 0 CRITICAL / 1 HIGH open / 6 HIGH fixed / 1 MEDIUM open
**Worst:** #7 `src/adapters/runtime/tangle-retained-interactive-contract.ts:42` — the released Runtime cannot answer structured native interactions.
**Next:** release the canonical native response operation, then rerun coordination and contract suites.

## Scope

| Field | Value |
|---|---|
| Files | n=70 source paths reviewed: 63 tracked changes plus 7 untracked paths; 3 audit files are excluded |
| Base..head | `e3ed3d16f178839560ae4809c8c4df2914bab32e..e3ed3d16f178839560ae4809c8c4df2914bab32e` |
| Project type | Node.js ESM package |
| Review focus | durable identity, restart recovery, interaction normalization, cancellation, control races, routing, ownership, TUI behavior |
| Not inspected | Provider changes not present in this worktree; package manifests were intentionally not edited. |

## Findings — 8 total, ranked

| # | Priority | file:line | Defect | Failure scenario | Status | Evidence | Fix | Verification | Cost if shipped | Saved if fixed |
|---:|---|---|---|---|---|---|---|---|---|---|
| 1 | P1 | `src/adapters/runtime/retained-execution-state.ts:15` | Retained key omitted the canonical interaction map. | Changed plan interactions reused incompatible prepared state. | fixed | key regression test | Derive the map from plan capabilities. | focused 42/42 | 1 incompatible preparation can reuse wrong state | 1/1 regression cases pass |
| 2 | P1 | `src/app/production-composition.ts:192` | Restart recovery dropped persisted identity data. | Recovery could not attach to the exact admitted provider run. | fixed | restart test | Preserve receipt, admission, session, and workspace. | focused 42/42 | 1 restart can lose exact attachment | 1/1 restart case passes |
| 3 | P1 | `src/adapters/runtime/production-backend-common.ts:105` | Opaque provider IDs could collide after normalization. | Lookup or cleanup could address the wrong environment. | fixed | identity and long-session tests | Use bounded readable IDs with a digest. | focused 42/42 | 1 collision can redirect control | 2/2 identity checks pass |
| 4 | P1 | `src/adapters/runtime/tangle-retained-interactive-execution.ts:106` | Cancellation races used stale signals or materialized late work. | Stop overlapped start or restart recovery could fail or create work after cancel. | fixed | cancellation and stop-signal tests | Coalesce start, recheck cancel, and strip expired signals. | focused 42/42 | 1 process or failed call per race | 4/4 regression cases pass |
| 5 | P1 | `src/adapters/runtime/retained-execution.ts:114` | Restarted controls did not fully validate saved identity. | A stale reference could target another retained process. | fixed | control identity tests | Validate session and exact persisted references. | focused 42/42 | 1 stale request can target wrong identity | 3/3 checks pass |
| 6 | P1 | `src/adapters/runtime/tangle-retained-interactive-execution.ts:240` | Partial native detach materialized provider work. | Detaching an intent after restart could start a process. | fixed | no-materialization test | Detach partial admission without recovery. | focused 42/42 | 1 unintended process per case | 1/1 case passes |
| 7 | P1 | `src/adapters/runtime/tangle-retained-interactive-contract.ts:42` | Native structured responses are unsupported by the released Runtime. | Plan, question, or approval response has no canonical provider operation. | open dependency | coordination 66/67 and contract 195/196 share one installed-Runtime failure | Hide unsupported actions until the Runtime release adds the operation. | local fail-closed tests pass | 1 native structured response cannot complete | 1 false action path hidden |
| 8 | P2 | `src/adapters/runtime/tangle-retained-interactive-projection.ts:42` | Native PTY bytes are outside the durable logical journal. | Restart replay returns synthetic envelopes, not every prior terminal byte. | open design | projection source and virtual-terminal 147/147 | Requires a provider-level transcript contract; no duplicate local terminal protocol. | supported synthetic boundary passes | 1 byte transcript is unavailable after restart | none claimed locally |

No P0 defect was confirmed.
No TUI mode-specific execution path or duplicate provider execution was confirmed.

## Proof

- `pnpm run typecheck` passed.
- Biome checked 54 changed TypeScript files and passed.
- Focused retained, interactive, identity, restart, and cancellation tests passed 42/42.
- `pnpm run test:virtual-terminal` passed 147/147.
- `pnpm run boundaries` passed with zero cyclic strongly connected components.
- `pnpm run dependencies:check` passed with no high or critical vulnerability finding.
- `git diff --check` passed.
- No `package.json` or `pnpm-lock.yaml` path changed.
- No commit or push was performed.

The coordination and contract suites each retain one dependency-only failure.
The installed Runtime rejects the fixture interaction map `permission, question, plan` for provider `cli-bridge`.

## Self-gate

9/9 passed — verdict has a number; every finding has file and line; every finding has a scenario; every finding has status; every finding has evidence; every finding has a fix or explicit dependency boundary; every finding has verification; every finding has cost on both sides; no P0 claim lacks a check.
